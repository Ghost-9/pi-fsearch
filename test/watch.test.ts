process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient } from "../src/client.ts";
import { WatchSession, formatWatchEvent, parseWatchArgs, type WatchEvent } from "../src/watch.ts";
import { MockDaemon } from "./helpers/mock-daemon.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-watch-"));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 4000, intervalMs = 10): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value as T;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(intervalMs);
  }
}

interface Fixture {
  daemon: MockDaemon;
  client: UltraSearchClient;
  dir: string;
  events: WatchEvent[];
  hits: Array<{ path: string }>;
  session: WatchSession;
}

async function fixture(options: { once?: boolean; statusStale?: () => number } = {}): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(tmp, "dir-"));
  const hits: Array<{ path: string }> = [];
  const daemon = new MockDaemon({
    reply: (req: any) => {
      if (req.op === "search") {
        return {
          ok: true,
          took_us: 42,
          hits: hits.map((h) => ({ kind: "file", mtime: 0, path: h.path, score: 1, size: 10 })),
        };
      }
      if (req.op === "status") {
        return { ok: true, stale_ms: options.statusStale ? options.statusStale() : 0, entries: hits.length };
      }
      return { ok: true };
    },
  });
  await daemon.listen();
  const client = new UltraSearchClient({ socketPath: daemon.socketPath, autoSpawnDaemon: false, enableFallback: false });
  const events: WatchEvent[] = [];
  const session = new WatchSession({
    query: "*.ts",
    dir,
    client,
    debounceMs: 25,
    settleTimeoutMs: 300,
    once: options.once,
    installSignalHandlers: false,
    closeClientOnStop: true,
    onEvent: (event) => events.push(event),
  });
  return { daemon, client, dir, events, hits, session };
}

/**
 * Run a body against a fixture with unconditional teardown. A failing
 * assertion must not leave an `fs.watch` handle or a mock server behind: node
 * would never exit and the whole suite would hang (the leak this helper
 * exists to prevent).
 */
async function withFixture(options: Parameters<typeof fixture>[0], body: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture(options);
  try {
    await body(f);
  } finally {
    f.session.stop();
    await f.daemon.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// streaming behaviour
// ---------------------------------------------------------------------------

test("watch: baseline matches are emitted, then a file change streams the new match", async () => {
  await withFixture({}, async (f) => {
    const a = path.join(f.dir, "a.ts");
    fs.writeFileSync(a, "export const a = 1;\n");
    f.hits.push({ path: a });

    await f.session.start();
    await waitFor(() => f.events.find((e) => e.type === "baseline" && e.path === a));
    await waitFor(() => f.events.find((e) => e.type === "ready"));

    const b = path.join(f.dir, "b.ts");
    const started = Date.now();
    fs.writeFileSync(b, "export const b = 1;\n");
    f.hits.push({ path: b });
    const added = await waitFor(() => f.events.find((e) => e.type === "add" && e.path === b));
    const elapsed = Date.now() - started;

    assert.equal(added.realPath, fs.realpathSync(b));
    assert.ok(elapsed < 500, `a new match must appear promptly after the write (took ${elapsed}ms)`);
    assert.ok(f.daemon.countOps("status") >= 1, "watch must consult daemon status before answering a change");
  });
});

test("watch: a repeated write does not re-emit an already-seen match", async () => {
  await withFixture({}, async (f) => {
    const a = path.join(f.dir, "a.ts");
    fs.writeFileSync(a, "x\n");
    f.hits.push({ path: a });
    await f.session.start();
    await waitFor(() => f.events.find((e) => e.type === "baseline"));

    fs.writeFileSync(a, "x changed\n");
    await delay(150);
    fs.writeFileSync(a, "x changed again\n");
    await delay(150);

    const adds = f.events.filter((e) => e.type === "add" && e.path === a);
    assert.equal(adds.length, 0, "an already-known path must not be streamed again");
  });
});

test("watch: a file that stops matching is emitted once as a removal", async () => {
  await withFixture({}, async (f) => {
    const a = path.join(f.dir, "a.ts");
    fs.writeFileSync(a, "x\n");
    f.hits.push({ path: a });
    await f.session.start();
    await waitFor(() => f.events.find((e) => e.type === "baseline" && e.path === a));

    f.hits.splice(0, f.hits.length);
    fs.writeFileSync(a, "x removed\n");
    await waitFor(() => f.events.find((e) => e.type === "remove" && e.path === a));
    const removals = f.events.filter((e) => e.type === "remove");
    assert.equal(removals.length, 1);
  });
});

test("watch: stale index annotations ride along on the change event", async () => {
  let stale = 40;
  await withFixture({ statusStale: () => stale }, async (f) => {
    await f.session.start();
    await waitFor(() => f.events.find((e) => e.type === "ready"));

    const b = path.join(f.dir, "b.ts");
    fs.writeFileSync(b, "x\n");
    f.hits.push({ path: b });
    stale = 0; // the daemon catches up during the settle wait
    const added = await waitFor(() => f.events.find((e) => e.type === "add" && e.path === b));
    assert.equal(typeof added.staleMs, "number");
    assert.equal(added.staleMs, 0, "the event reports the freshness observed when it answered");
  });
});

// ---------------------------------------------------------------------------
// shutdown / leaks
// ---------------------------------------------------------------------------

test("watch: stop() closes the watcher and every daemon socket, and no event follows", async () => {
  await withFixture({}, async (f) => {
    const a = path.join(f.dir, "a.ts");
    fs.writeFileSync(a, "x\n");
    f.hits.push({ path: a });
    await f.session.start();
    await waitFor(() => f.events.find((e) => e.type === "baseline"));

    const stats = f.session.stop();
    assert.equal(stats.stopped, true);
    // Socket close is asynchronous on the server side: poll rather than
    // asserting on the same tick.
    await waitFor(() => f.daemon.openConnections === 0, 2000);
    assert.equal(f.daemon.openConnections, 0, "stop() must not leave a socket open");

    const before = f.events.length;
    fs.writeFileSync(path.join(f.dir, "after-stop.ts"), "x\n");
    await delay(200);
    assert.equal(f.events.length, before, "a stopped session must not keep watching");
    f.session.stop(); // idempotent
  });
});

test("watch: --once emits the baseline, creates no watcher and exits cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "once-"));
  const daemon = new MockDaemon({
    reply: (req: any) => (req.op === "search" ? { ok: true, hits: [{ kind: "file", mtime: 0, path: path.join(dir, "one.ts"), score: 1, size: 1 }] } : { ok: true }),
  });
  await daemon.listen();
  const client = new UltraSearchClient({ socketPath: daemon.socketPath, autoSpawnDaemon: false, enableFallback: false });
  const events: WatchEvent[] = [];
  let watcherFactoryCalls = 0;
  const session = new WatchSession({
    query: "*.ts",
    dir,
    client,
    once: true,
    installSignalHandlers: false,
    closeClientOnStop: true,
    onEvent: (e) => events.push(e),
    watcherFactory: () => {
      watcherFactoryCalls++;
      return { close: () => {} };
    },
  });
  try {
    await session.start();
    const stats = await session.wait();
    assert.equal(stats.stopped, true);
    assert.equal(stats.baseline, 1);
    assert.equal(watcherFactoryCalls, 0, "--once must not arm a directory watcher");
    assert.ok(events.some((e) => e.type === "baseline"));
    await waitFor(() => daemon.openConnections === 0, 2000);
    assert.equal(daemon.openConnections, 0);
  } finally {
    session.stop();
    await daemon.close().catch(() => {});
  }
});

test("watch: a missing directory surfaces an error event instead of throwing", async () => {
  const dir = path.join(tmp, "definitely-missing-dir");
  const daemon = new MockDaemon({ reply: () => ({ ok: true, hits: [] }) });
  await daemon.listen();
  const client = new UltraSearchClient({ socketPath: daemon.socketPath, autoSpawnDaemon: false, enableFallback: false });
  const events: WatchEvent[] = [];
  const session = new WatchSession({
    query: "q",
    dir,
    client,
    once: false,
    installSignalHandlers: false,
    closeClientOnStop: true,
    onEvent: (e) => events.push(e),
  });
  try {
    await session.start();
    const error = events.find((e) => e.type === "error");
    assert.ok(error, `expected an error event, got ${JSON.stringify(events)}`);
    assert.match(error!.message ?? "", /cannot watch/);
    assert.equal(session.getStats().stopped, true);
  } finally {
    session.stop();
    await daemon.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// argument parsing and formatting
// ---------------------------------------------------------------------------

test("watch: parseWatchArgs accepts the documented flags and rejects a missing query", () => {
  const parsed = parseWatchArgs(["needle", "--in", "src", "--limit", "5", "--debounce", "30", "--duration", "100", "--json"], "/work");
  assert.equal(parsed.query, "needle");
  assert.equal(parsed.dir, path.resolve("/work", "src"));
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.debounceMs, 30);
  assert.equal(parsed.durationMs, 100);
  assert.equal(parsed.json, true);
  assert.equal(parsed.once, false);
  assert.throws(() => parseWatchArgs(["--json"]), /Usage: ultrasearch watch/);
});

test("watch: formatWatchEvent renders human and JSON lines", () => {
  const event: WatchEvent = { type: "add", path: "/w/src/a.ts", kind: "file", score: 3, at: 1 };
  const human = formatWatchEvent(event, "/w");
  assert.match(human, /^\+ /);
  assert.match(human, /src\/a\.ts/);
  const json = formatWatchEvent(event, "/w", true);
  assert.deepEqual(JSON.parse(json).path, "/w/src/a.ts");
});
