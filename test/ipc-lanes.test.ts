process.env.PI_ULTRASEARCH_TEST = "1";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { UltraSearchClient } from "../src/client.ts";
import { MockDaemon } from "./helpers/mock-daemon.ts";

const daemons: MockDaemon[] = [];
const clients: UltraSearchClient[] = [];

after(async () => {
  for (const c of clients) c.close();
  for (const d of daemons) await d.close();
});

async function newDaemon(options: ConstructorParameters<typeof MockDaemon>[0]): Promise<MockDaemon> {
  const daemon = new MockDaemon(options);
  daemons.push(daemon);
  await daemon.listen();
  return daemon;
}

function newClient(socketPath: string, extra: Record<string, unknown> = {}): UltraSearchClient {
  const client = new UltraSearchClient({ socketPath, autoSpawnDaemon: false, maxReconnectRetries: 0, ...extra });
  clients.push(client);
  return client;
}

const grepReply = () => ({ ok: true, complete: true, files: [{ path: "/tmp/lanes/a.ts", matches: [{ line: 1, text: "x" }] }] });

test("lanes: 3 concurrent greps fan out and complete in ~max(t), not sum(t)", async () => {
  const daemon = await newDaemon({ delayMs: 120, reply: grepReply });
  const client = newClient(daemon.socketPath, { lanes: 3 });

  const started = performance.now();
  const results = await Promise.all([1, 2, 3].map(() => client.grep("x", { in: "/tmp", limit: 5, skipAudit: true })));
  const elapsed = performance.now() - started;

  assert.ok(results.every((r) => r.ok));
  assert.equal(daemon.maxConcurrent, 3, "all three requests must be in flight at once");
  assert.ok(daemon.lanesSeen.size >= 2, "requests must be spread across sockets");
  // The deterministic proof is maxConcurrent === 3 above; the wall-clock check is
  // corroboration. A 2.5x margin still separates max(t) (~120ms) from sum(t)
  // (~360ms) while tolerating scheduler jitter on a loaded machine.
  assert.ok(elapsed < 120 * 2.5, `expected ~max(t) (120ms), got ${elapsed.toFixed(1)}ms (sum(t) would be ~360ms)`);
  assert.equal(client.poolStats().inFlight, 0);
});

test("lanes: 1 keeps the legacy single-socket path (no fan-out)", async () => {
  const daemon = await newDaemon({ delayMs: 60, reply: grepReply });
  const client = newClient(daemon.socketPath, { lanes: 1 });

  const results = await Promise.all([1, 2, 3].map(() => client.grep("x", { in: "/tmp", limit: 5, skipAudit: true })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(daemon.maxConcurrent, 1, "a single socket must not process concurrently in this mock");
  assert.equal(daemon.lanesSeen.size, 1);
});

test("lanes: sequential calls reuse one connection (single-socket fast path)", async () => {
  const daemon = await newDaemon({ reply: grepReply });
  const client = newClient(daemon.socketPath, { lanes: 3 });

  for (let i = 0; i < 3; i++) {
    const res = await client.grep("x", { in: "/tmp", limit: 5, skipAudit: true });
    assert.equal(res.ok, true);
  }
  assert.equal(client.poolStats().created, 1, "sequential traffic must not open extra lanes");
  assert.equal(daemon.lanesSeen.size, 1);
});

test("lanes: a failing lane degrades to an already-open lane instead of failing the call", async () => {
  const daemon = await newDaemon({ reply: grepReply });
  const client = newClient(daemon.socketPath, { lanes: 3 });

  const warm = await client.grep("x", { in: "/tmp", limit: 5, skipAudit: true });
  assert.equal(warm.ok, true);

  // Stop accepting new connections; the open lane stays usable.
  daemon.stopAccepting();

  const results = await Promise.all([1, 2, 3, 4].map(() => client.grep("x", { in: "/tmp", limit: 5, skipAudit: true })));
  assert.ok(results.every((r) => r.ok), "requests must fall back to the live lane");
  assert.equal(daemon.lanesSeen.size, 1, "no new lane could connect, so everything ran on lane 1");
});

test("lanes: close() leaves no open connections behind", async () => {
  const daemon = await newDaemon({ reply: grepReply });
  const client = newClient(daemon.socketPath, { lanes: 3 });

  await Promise.all([1, 2, 3].map(() => client.grep("x", { in: "/tmp", limit: 5, skipAudit: true })));
  assert.ok(daemon.openConnections >= 2);

  client.close();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(daemon.openConnections, 0, "client.close() must destroy every lane socket");
  assert.equal(client.poolStats().lanes, 0);
  assert.equal(client.poolStats().open, 0);
});
