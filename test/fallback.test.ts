process.env.PI_ULTRASEARCH_TEST = "1";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient } from "../src/client.ts";
import { spawnCapture, activeChildCount } from "../src/spawn.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-fallback-"));
const bogusSocket = path.join(os.tmpdir(), `ults-bogus-${process.pid}-${Date.now()}.sock`);
const clients: UltraSearchClient[] = [];

after(async () => {
  for (const c of clients) c.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fallbackClient(extra: Record<string, unknown> = {}): UltraSearchClient {
  const client = new UltraSearchClient({
    socketPath: bogusSocket,
    autoSpawnDaemon: false,
    maxReconnectRetries: 0,
    enableFallback: true,
    ...extra,
  });
  clients.push(client);
  return client;
}

function fixture(): string {
  const dir = path.join(tmp, "tree");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "mod-0017.ts"), 'export const marker = "FALLBACK_TOKEN_0017";\n');
  fs.writeFileSync(path.join(dir, "src", "mod-0018.ts"), "export const other = 1;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# tree\n");
  return dir;
}

// ---------------------------------------------------------------------------
// spawnCapture: timeout, cancellation, no leaked children
// ---------------------------------------------------------------------------

test("spawn: timeout kills the child and reports timedOut", async () => {
  const started = performance.now();
  const res = await spawnCapture("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 150 });
  const elapsed = performance.now() - started;
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
  assert.ok(elapsed < 1500, `timeout must kill promptly, took ${elapsed.toFixed(1)}ms`);
  assert.equal(activeChildCount(), 0);
});

test("spawn: AbortSignal cancels the child", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const pending = spawnCapture("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 10000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const res = await pending;
  assert.equal(res.cancelled, true);
  assert.equal(res.ok, false);
  assert.ok(performance.now() - started < 2000);
  assert.equal(activeChildCount(), 0);
});

test("spawn: already-aborted signal never spawns", async () => {
  const controller = new AbortController();
  controller.abort();
  const res = await spawnCapture("node", ["-e", "setTimeout(() => {}, 5000)"], { signal: controller.signal });
  assert.equal(res.cancelled, true);
  assert.equal(activeChildCount(), 0);
});

test("spawn: missing binary reports notFound, non-zero exit keeps the code", async () => {
  const missing = await spawnCapture("this-binary-does-not-exist-ults", [], { timeoutMs: 500 });
  assert.equal(missing.notFound, true);
  assert.equal(missing.ok, false);

  const nonZero = await spawnCapture("node", ["-e", "process.exit(3)"], { timeoutMs: 2000 });
  assert.equal(nonZero.ok, false);
  assert.equal(nonZero.code, 3);
  assert.equal(activeChildCount(), 0);
});

// ---------------------------------------------------------------------------
// Client fallback path is async and result-compatible
// ---------------------------------------------------------------------------

test("fallback search: async spawn returns the same shape as the daemon path", async () => {
  const dir = fixture();
  const client = fallbackClient();
  const res = await client.search("*mod-0017*", { in: dir, limit: 10, skipAudit: true });
  assert.equal(res.ok, true);
  assert.equal(res.source, "native_fallback");
  assert.equal(res.complete, true);
  assert.ok((res.hits ?? []).some((h) => h.path.endsWith("mod-0017.ts")));
  assert.equal(typeof res.meta?.tokenCount, "number");
  assert.equal(activeChildCount(), 0);
});

test("fallback grep: async spawn parses file:line:text into the daemon shape", async () => {
  const dir = fixture();
  const client = fallbackClient();
  const res = await client.grep("FALLBACK_TOKEN_0017", { in: dir, limit: 10, skipAudit: true });
  assert.equal(res.ok, true);
  assert.equal(res.source, "native_fallback");
  const files = res.files ?? [];
  assert.ok(files.some((f) => f.path.endsWith("mod-0017.ts")));
  const match = files.find((f) => f.path.endsWith("mod-0017.ts"))?.matches?.[0];
  assert.ok(match && match.line >= 1 && typeof match.text === "string");
  assert.equal(activeChildCount(), 0);
});

test("fallback cancellation: aborted signal produces a cancelled result and no children", async () => {
  const dir = fixture();
  const client = fallbackClient();
  const controller = new AbortController();
  controller.abort();
  const res = await client.search("*mod-0017*", { in: dir, limit: 10, skipAudit: true, signal: controller.signal });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cancel/i);
  assert.equal(activeChildCount(), 0);
});

test("no execFileSync in the request path (issue #24 acceptance)", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "client.ts"), "utf-8");
  assert.equal(/execFileSync/.test(source), false, "client.ts must not block the event loop with execFileSync");
  assert.equal(/execSync\s*\(/.test(source), false, "client.ts must not use execSync");
});
