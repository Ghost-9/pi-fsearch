process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrefetchController, probeToken } from "../src/prefetch.ts";
import { UltraSearchClient } from "../src/client.ts";
import { MockDaemon } from "./helpers/mock-daemon.ts";
import { loadPiHarness, waitFor } from "./helpers/pi-harness.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-prefetch-"));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// debounce and batching
// ---------------------------------------------------------------------------

test("prefetch: rapid edits coalesce into one warm-up (debounce prevents thrash)", async () => {
  const calls: string[][] = [];
  const controller = new PrefetchController({
    client: {},
    debounceMs: 25,
    warm: async (paths) => {
      calls.push(paths);
      return { warmed: paths.length, fallback: false };
    },
  });
  for (let i = 0; i < 10; i++) {
    controller.touch(path.join(tmp, `rapid-${i}.ts`));
    await delay(2);
  }
  await delay(80);
  assert.equal(calls.length, 1, `expected one warm-up, got ${calls.length}`);
  assert.equal(calls[0].length, 10);
  assert.equal(controller.getStats().coalesced, 0);
  controller.stop();
});

test("prefetch: re-touching the same file inside the window coalesces it", async () => {
  const calls: string[][] = [];
  const controller = new PrefetchController({
    client: {},
    debounceMs: 30,
    warm: async (paths) => {
      calls.push(paths);
      return { warmed: paths.length, fallback: false };
    },
  });
  const file = path.join(tmp, "same-file.ts");
  controller.touch(file);
  controller.touch(file);
  controller.touch(file);
  await delay(70);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [file]);
  assert.equal(controller.getStats().coalesced, 2);
  controller.stop();
});

test("prefetch: maxBatch bounds a request and the remainder flushes afterwards", async () => {
  const batches: string[][] = [];
  const controller = new PrefetchController({
    client: {},
    debounceMs: 10,
    maxBatch: 3,
    warm: async (paths) => {
      batches.push(paths);
      return { warmed: paths.length, fallback: false };
    },
  });
  controller.touch(path.join(tmp, "b1.ts"));
  controller.touch(path.join(tmp, "b2.ts"));
  controller.touch(path.join(tmp, "b3.ts"));
  controller.touch(path.join(tmp, "b4.ts"));
  controller.touch(path.join(tmp, "b5.ts"));
  await delay(120);
  assert.deepEqual(
    batches.map((b) => b.length),
    [3, 2]
  );
  assert.equal(controller.getStats().pending, 0);
  controller.stop();
});

test("prefetch: stop() before the window fires warms nothing", async () => {
  let calls = 0;
  const controller = new PrefetchController({
    client: {},
    debounceMs: 20,
    warm: async (paths) => {
      calls++;
      return { warmed: paths.length, fallback: false };
    },
  });
  controller.touch(path.join(tmp, "stopped.ts"));
  controller.stop();
  await delay(60);
  assert.equal(calls, 0);
  assert.deepEqual(controller.getStats(), { touched: 1, coalesced: 0, flushed: 0, warmed: 0, fallbackFlushes: 0, failures: 0, pending: 0 });
});

test("prefetch: a failing warm is counted, never thrown", async () => {
  const controller = new PrefetchController({
    client: {},
    debounceMs: 10,
    warm: async () => {
      throw new Error("daemon gone");
    },
  });
  controller.touch(path.join(tmp, "boom.ts"));
  await delay(50);
  assert.equal(controller.getStats().failures, 1);
  assert.equal(controller.getStats().pending, 0);
  controller.stop();
});

// ---------------------------------------------------------------------------
// default warm path: prefetch op, then a content probe fallback
// ---------------------------------------------------------------------------

test("prefetch: the daemon prefetch op is used when the engine supports it", async () => {
  const prefetchCalls: string[][] = [];
  const client = {
    prefetch: async (paths: string[]) => {
      prefetchCalls.push(paths);
      return true;
    },
  };
  const controller = new PrefetchController({ client, debounceMs: 10 });
  const file = path.join(tmp, "supported.ts");
  fs.writeFileSync(file, "export function supportedToken() {}\n");
  controller.touch(file);
  await delay(60);
  assert.deepEqual(prefetchCalls, [[file]]);
  assert.equal(controller.getStats().warmed, 1);
  assert.equal(controller.getStats().fallbackFlushes, 0);
  controller.stop();
});

test("prefetch: an engine without the op falls back to a real content probe", async () => {
  const grepCalls: Array<{ pattern: string; options: Record<string, unknown> }> = [];
  const client = {
    prefetch: async () => false,
    grep: async (pattern: string, options: Record<string, unknown>) => {
      grepCalls.push({ pattern, options });
      return { ok: true, files: [] };
    },
  };
  const file = path.join(tmp, "fallback.ts");
  fs.writeFileSync(file, "export function fallbackProbe() { return 1; }\n");
  const controller = new PrefetchController({ client, debounceMs: 10 });
  controller.touch(file);
  await delay(60);
  assert.equal(grepCalls.length, 1, "one probe must reach the daemon");
  assert.equal(grepCalls[0].pattern, "fallbackProbe");
  assert.equal(grepCalls[0].options.skipAudit, true, "warm-up is not a user query");
  assert.equal(controller.getStats().fallbackFlushes, 1);
  controller.stop();
});

test("prefetch: probeToken picks a trigram-sized literal and rejects short text", () => {
  assert.equal(probeToken("export function ultraSearchWarmup() {}"), "ultraSearchWarmup");
  assert.equal(probeToken("x=1"), null);
  assert.equal(probeToken(""), null);
});

// ---------------------------------------------------------------------------
// Pi integration: tool_execution_end -> daemon
// ---------------------------------------------------------------------------

test("prefetch: tool_execution_end on edit/write sends a daemon prefetch request", async () => {
  const daemon = new MockDaemon({ reply: () => ({ ok: true }) });
  await daemon.listen();
  const client = new UltraSearchClient({ socketPath: daemon.socketPath, autoSpawnDaemon: false });
  try {
    const harness = await loadPiHarness({ socketPath: daemon.socketPath });
    // One listener owns the hook: frecency and prefetch share a single
    // `pi.on("tool_execution_end")` registration, so ordering is defined and
    // no sibling can double-register the same side effect.
    assert.equal((harness.handlers.get("tool_execution_end") ?? []).length, 1, "exactly one tool_execution_end listener must be registered");
    const file = path.join(tmp, "edited.ts");
    fs.writeFileSync(file, "export function editedSymbol() {}\n");
    await harness.emit("tool_execution_end", { toolName: "edit", params: { path: file } });
    const op = await waitFor(() => daemon.lastOp("prefetch"), 3000);
    assert.ok(op, "an edit must warm the file; no prefetch op reached the daemon");
    assert.deepEqual(op.paths, [file]);
  } finally {
    client.close();
    await daemon.close();
  }
});

test("prefetch: a read does not trigger a prefetch (frecency only)", async () => {
  const daemon = new MockDaemon({ reply: () => ({ ok: true }) });
  await daemon.listen();
  try {
    const harness = await loadPiHarness({ socketPath: daemon.socketPath });
    await harness.emit("tool_execution_end", { toolName: "read", params: { path: path.join(tmp, "read-only.ts") } });
    const open = await waitFor(() => daemon.lastOp("open"), 2000);
    assert.ok(open, "read still records frecency");
    assert.equal(daemon.countOps("prefetch"), 0, "a read does not warm content");
  } finally {
    await daemon.close();
  }
});
