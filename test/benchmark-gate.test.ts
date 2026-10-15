process.env.PI_ULTRASEARCH_TEST = "1";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient, resolveDefaultSocketPath } from "../src/client.ts";

/**
 * Two gates.
 *
 * **Hermetic (strict, CI everywhere):** a mock line-JSON daemon on a temp
 * socket measures the real client IPC path with no daemon installed. The
 * thresholds are absolute and stay strict because the mock's service time is
 * fixed.
 *
 * **Live (state-sensitive, floor-derived):** the 5 ms absolute grep threshold
 * of wave 1 sat *below this machine's own floor*. Wave-1 final verification
 * measured the raw daemon socket (no client) at p50 7.17 ms / p95 7.65 ms
 * (n=60), while the client leg was p50 7.88 / p95 8.59 — so `test:gate` could
 * never pass here, and a threshold that low tells us nothing about the client.
 *
 * The live gate therefore calibrates itself against the same daemon in the
 * same run:
 *
 *   rawP95     = p95 of the bare socket round-trip (the machine+daemon floor)
 *   clientP95  = p95 through UltraSearchClient
 *   ceiling    = max(minimum, rawP95 * 2 + 1 ms)
 *
 * and asserts the client overhead (`clientP50 - rawP50`) directly. The
 * relative assertion runs unconditionally, so a state-based excuse (index
 * replaying/stale, cold start) can relax only the absolute ceiling — and a
 * hard 4x blow-up cap still fails. This is what stops a "skip when cold" rule
 * from masking a real regression.
 *
 * Both client instances set `autoSpawnDaemon: false`: a gate must never start
 * a daemon mid-measurement (wave-2 #45).
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

const hermetic = new UltraSearchClient({ socketPath: sockPath, autoSpawnDaemon: false, lanes: 1 });
const live = new UltraSearchClient({ autoSpawnDaemon: false, lanes: 1 });
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

// ---------------------------------------------------------------------------
// Hermetic gate (strict; no daemon needed)
// ---------------------------------------------------------------------------

test("Hermetic CI Gate: client round-trip p95 search < 10ms (mock socket, no daemon)", async () => {
  await hermetic.ping(); // warm connection
  const iterations = 50;
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    // skipAudit: this gate measures the client/IPC path, not telemetry file
    // I/O. A per-call audit append caused runner-tail spikes (CI macOS:
    // p50 1.41 ms, p95 13.16 ms) that are unrelated to the claim under test.
    const res = await hermetic.search("package.json", { in: process.cwd(), limit: 10, respectIgnore: false, skipAudit: true });
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
    const res = await hermetic.grep("UltraSearchClient", { in: process.cwd(), limit: 10, respectIgnore: false, skipAudit: true });
    latencies.push(performance.now() - start);
    assert.equal(res.ok, true);
    assert.ok((res.files?.length ?? 0) > 0);
  }
  const { p50, p95 } = p95Of(latencies);
  assert.ok(p95 < 5.0, `Expected hermetic p95 grep < 5.0ms, got ${p95.toFixed(2)}ms (p50: ${p50.toFixed(2)}ms)`);
});

// ---------------------------------------------------------------------------
// Live gate: raw floor calibration + client overhead
// ---------------------------------------------------------------------------

const LIVE_N = Number(process.env.LIVE_GATE_N ?? 60);
/** The smallest absolute ceiling the live gate accepts, even on a fast box. */
const GREP_MIN_MS = 12;
const SEARCH_MIN_MS = 12;
/** Client wrap/parse/queue overhead budget over the bare socket leg. */
const CLIENT_OVERHEAD_MS = 3;
/** Nothing excuses a blow-up past this multiple of the raw floor. */
const HARD_BLOWUP = 4;

/** One request on a bare socket, bypassing the client. */
function rawOnce(payload: Record<string, unknown>, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const sock = net.connect(resolveDefaultSocketPath());
    let buf = "";
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      err ? reject(err) : resolve(performance.now() - start);
    };
    const timer = setTimeout(() => done(new Error(`raw gate request timed out after ${timeoutMs}ms`)), timeoutMs);
    sock.once("connect", () => sock.write(JSON.stringify({ ...payload, id: 1 }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(buf.slice(0, buf.indexOf("\n")));
          msg.ok ? done() : done(new Error(`raw gate reply not ok: ${buf.slice(0, 200)}`));
        } catch (e) {
          done(e as Error);
        }
      }
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      done(e);
    });
  });
}

/** The daemon's own state (#19/#45), read on a bare socket. */
async function liveState(): Promise<{ staleness_ms?: number; replay_in_progress?: boolean; uptime_ms?: number; pid?: number; entries?: number; event_id?: number }> {
  return await new Promise((resolve, reject) => {
    const sock = net.connect(resolveDefaultSocketPath());
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("status timed out")); }, 5000);
    sock.once("connect", () => sock.write(JSON.stringify({ op: "status", id: 1 }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.destroy();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e as Error); }
    });
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Alternating raw/client samples for one payload, plus the daemon state.
 * Alternating keeps both legs under the same machine state.
 */
async function measureLive(payload: Record<string, unknown>) {
  const state = await liveState().catch(() => ({} as any));
  const raw: number[] = [];
  const client: number[] = [];
  for (let i = 0; i < LIVE_N; i++) {
    // Warm the scheduler/pool once per round on the client leg.
    const t0 = performance.now();
    const res: any = payload.op === "grep" ? await live.grep(String(payload.pattern), { in: process.cwd(), limit: 10, skipAudit: true }) : await live.search(String(payload.q), { in: process.cwd(), limit: 10, skipAudit: true });
    client.push(performance.now() - t0);
    assert.equal(res.ok, true);
    raw.push(await rawOnce(payload));
  }
  // The daemon block at the end of the window (pid, entries, event_id): a
  // mid-run restart or index swap invalidates the comparison.
  const stateEnd = await liveState().catch(() => ({} as any));
  return { raw: p95Of(raw), client: p95Of(client), state, stateEnd };
}

function evaluateLive(label: string, measured: Awaited<ReturnType<typeof measureLive>>, minimumMs: number) {
  const d = gateDecision({ ...measured, minimumMs });
  console.log(`[live gate] ${label}: ${d.ok ? "pass" : "fail"} | ${d.reason}`);
  assert.ok(d.ok, `${label}: ${d.reason}`);
}

/**
 * The live-gate decision, pure so it can be unit-tested (and reviewed):
 * `overhead` is unconditional; a cold/stale window may excuse the derived
 * ceiling only up to the hard blow-up cap; `ok` is false otherwise.
 * @returns `{ ok, reason, ceiling, hardCap, overhead }`
 */
export function gateDecision(input: {
  raw: { p50: number; p95: number };
  client: { p50: number; p95: number };
  state: { staleness_ms?: number; replay_in_progress?: boolean; uptime_ms?: number; pid?: number; entries?: number; event_id?: number };
  stateEnd?: { pid?: number; entries?: number; event_id?: number };
  minimumMs: number;
}) {
  const { raw, client, state, stateEnd } = input;
  const ceiling = Math.max(input.minimumMs, raw.p95 * 2 + 1);
  const hardCap = raw.p95 * HARD_BLOWUP + 10;
  const overhead = client.p50 - raw.p50;
  const env = `n=${LIVE_N} raw p50 ${raw.p50.toFixed(2)}/p95 ${raw.p95.toFixed(2)} | client p50 ${client.p50.toFixed(2)}/p95 ${client.p95.toFixed(2)} | ceil ${ceiling.toFixed(2)} (min ${input.minimumMs}) | load1 ${os.loadavg()[0].toFixed(2)} | pid ${state.pid} uptime ${state.uptime_ms}ms stale ${state.staleness_ms} replaying ${state.replay_in_progress} | end pid ${stateEnd?.pid} entries ${stateEnd?.entries} event_id ${stateEnd?.event_id}`;
  if (!(overhead < CLIENT_OVERHEAD_MS)) {
    return { ok: false, ceiling, hardCap, overhead, reason: `client overhead ${overhead.toFixed(2)}ms >= ${CLIENT_OVERHEAD_MS}ms (${env})` };
  }
  const excluded = state.replay_in_progress === true || (state.staleness_ms ?? 0) > 0 || (state.uptime_ms ?? Number.MAX_SAFE_INTEGER) < 30_000;
  if (excluded) {
    return {
      ok: client.p95 < hardCap,
      ceiling,
      hardCap,
      overhead,
      reason: `cold/stale window: p95 ${client.p95.toFixed(2)}ms vs hard cap ${hardCap.toFixed(2)}ms (${env})`,
    };
  }
  return { ok: client.p95 < ceiling, ceiling, hardCap, overhead, reason: `p95 ${client.p95.toFixed(2)}ms vs derived ceiling ${ceiling.toFixed(2)}ms (${env})` };
}

test("Live CI Gate: grep p95 within the measured floor + client overhead", { skip: liveOnly }, async () => {
  evaluateLive("grep", await measureLive({ op: "grep", pattern: "UltraSearchClient" }), GREP_MIN_MS);
});

test("Live CI Gate: search p95 within the measured floor + client overhead", { skip: liveOnly }, async () => {
  evaluateLive("search", await measureLive({ op: "search", q: "package.json" }), SEARCH_MIN_MS);
});

// ---------------------------------------------------------------------------
// The decision is pure and unit-tested: a cold/stale window cannot mask a
// client regression, because the overhead assertion runs either way and the
// hard blow-up cap bounds the excuse.
// ---------------------------------------------------------------------------

test("Gate decision: the derived ceiling follows the measured floor", () => {
  // Wave-1 final verification, n=60: raw daemon p95 7.65, client p95 8.59.
  const d = gateDecision({ raw: { p50: 7.17, p95: 7.65 }, client: { p50: 7.88, p95: 8.59 }, state: { uptime_ms: 3_600_000, staleness_ms: 0 }, minimumMs: GREP_MIN_MS });
  assert.equal(d.ok, true, d.reason);
  assert.ok(d.ceiling > 7.65, "the old 5ms threshold was below the floor");
});

test("Gate decision: a wave-1-style takeover fails even when the window is stale", () => {
  const d = gateDecision({ raw: { p50: 7.17, p95: 7.65 }, client: { p50: 128, p95: 140 }, state: { uptime_ms: 1000, replay_in_progress: true }, minimumMs: GREP_MIN_MS });
  assert.equal(d.ok, false, "a cold window must not excuse a 128ms takeover");
  assert.match(d.reason, /hard cap|client overhead/);
});

test("Gate decision: a cold window is excused only under the hard cap", () => {
  const ok = gateDecision({ raw: { p50: 7.17, p95: 7.65 }, client: { p50: 8, p95: 20 }, state: { uptime_ms: 1000, replay_in_progress: true }, minimumMs: GREP_MIN_MS });
  assert.equal(ok.ok, true, ok.reason);
  const bad = gateDecision({ raw: { p50: 7.17, p95: 7.65 }, client: { p50: 8, p95: 200 }, state: { uptime_ms: 1000, replay_in_progress: true }, minimumMs: GREP_MIN_MS });
  assert.equal(bad.ok, false);
});

test("Gate decision: client overhead alone fails, stale or not", () => {
  const d = gateDecision({ raw: { p50: 7.17, p95: 7.65 }, client: { p50: 12, p95: 13 }, state: { uptime_ms: 1000, replay_in_progress: true }, minimumMs: GREP_MIN_MS });
  assert.equal(d.ok, false);
  assert.match(d.reason, /client overhead/);
});
