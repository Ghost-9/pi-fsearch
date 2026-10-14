process.env.PI_ULTRASEARCH_TEST = "1";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient } from "../src/client.ts";

/**
 * Hermetic mock daemon: line-delimited JSON over a temp UNIX socket.
 * This lets the CI gate run on a clean machine with no ultrasearch install,
 * while still measuring the real client IPC round-trip path.
 */
const sockPath = path.join(os.tmpdir(), `ults-gate-${process.pid}-${Date.now()}.sock`);
const mockServer = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req: any = {};
      try { req = JSON.parse(line); } catch { continue; }
      const cwd = process.cwd();
      let reply: any;
      switch (req.op) {
        case "ping":
          reply = { ok: true, id: req.id };
          break;
        case "search":
          reply = {
            ok: true,
            id: req.id,
            took_us: 80,
            source: "index",
            hits: [{ kind: "file", mtime: 0, path: path.join(cwd, "package.json"), score: 100, size: 0 }],
          };
          break;
        case "grep":
          reply = {
            ok: true,
            id: req.id,
            took_us: 90,
            source: "index",
            files: [{ path: path.join(cwd, "src", "client.ts"), matches: [{ line: 1, text: "export class UltraSearchClient {" }] }],
          };
          break;
        case "multi_grep":
          reply = {
            ok: true,
            id: req.id,
            took_us: 120,
            source: "index",
            patterns: req.patterns ?? [],
            files: [{ path: path.join(cwd, "src", "client.ts"), matches: [{ line: 1, text: "export class UltraSearchClient {" }] }],
          };
          break;
        case "recent":
          reply = {
            ok: true,
            id: req.id,
            took_us: 60,
            source: "index",
            hits: [{ kind: "file", mtime: 0, path: path.join(cwd, "package.json"), score: 1, size: 0 }],
          };
          break;
        case "status":
          reply = { ok: true, id: req.id, entries: 1, index_bytes: 1, content_segments: 1 };
          break;
        default:
          reply = { ok: true, id: req.id };
      }
      sock.write(JSON.stringify(reply) + "\n");
    }
  });
});

await new Promise<void>((resolve) => mockServer.listen(sockPath, resolve));

const hermetic = new UltraSearchClient({ socketPath: sockPath });
const live = new UltraSearchClient();
const daemonUp = await live.ping();
const liveOnly = daemonUp ? false : "ultrasearch daemon not running (live gate skipped)";

after(() => {
  hermetic.close();
  live.close();
  mockServer.close();
  try { fs.unlinkSync(sockPath); } catch {}
});

function p95Of(latencies: number[]): { p50: number; p95: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: at(50), p95: at(95) };
}

test("Hermetic CI Gate: client round-trip p95 search < 10ms (mock socket, no daemon)", async () => {
  await hermetic.ping(); // warm connection
  const iterations = 50;
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await hermetic.search("package.json", { in: process.cwd(), limit: 10, respectIgnore: false });
    latencies.push(performance.now() - start);
    assert.equal(res.ok, true);
  }
  const { p50, p95 } = p95Of(latencies);
  assert.ok(p95 < 10.0, `Expected hermetic p95 search < 10.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});

test("Hermetic CI Gate: client round-trip p95 grep < 5ms (mock socket, no daemon)", async () => {
  await hermetic.ping();
  const iterations = 50;
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await hermetic.grep("UltraSearchClient", { in: process.cwd(), limit: 10, respectIgnore: false });
    latencies.push(performance.now() - start);
    assert.equal(res.ok, true);
    assert.ok((res.files?.length ?? 0) > 0);
  }
  const { p50, p95 } = p95Of(latencies);
  assert.ok(p95 < 5.0, `Expected hermetic p95 grep < 5.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});

test("Live CI Gate: daemon-backed p95 search < 10ms", { skip: liveOnly }, async () => {
  await live.ping();
  const iterations = 50;
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await live.search("package.json", { in: process.cwd(), limit: 10 });
    const elapsed = performance.now() - start;
    assert.equal(res.ok, true);
    latencies.push(elapsed);
  }
  const { p50, p95 } = p95Of(latencies);
  assert.ok(p95 < 10.0, `Expected p95 latency < 10.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});

test("Live CI Gate: daemon-backed p95 trigram grep < 5ms", { skip: liveOnly }, async () => {
  await live.ping();
  const iterations = 50;
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const res = await live.grep("UltraSearchClient", { in: process.cwd(), limit: 10 });
    const elapsed = performance.now() - start;
    assert.equal(res.ok, true);
    latencies.push(elapsed);
  }
  const { p50, p95 } = p95Of(latencies);
  assert.ok(p95 < 5.0, `Expected p95 grep latency < 5.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});
