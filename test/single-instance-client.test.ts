process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient } from "../src/client.ts";

/**
 * Wave-2 #45 — client-side single-instance hardening.
 *
 *  1. "Connect before spawn": a daemon that is already answering (or still
 *     binding) must stop a spawn, not race it.
 *  2. `status()` reports duplicate/stale daemon signals: socket owner pids,
 *     a `socket.lock` pid that disagrees with the answering pid.
 *
 * The spawn test injects a marker script as the only candidate binary, so no
 * real daemon is ever launched.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "us-instance-"));
const marker = path.join(tmp, "spawned");
const script = path.join(tmp, "fake-daemon.sh");
fs.writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
fs.chmodSync(script, 0o755);

/** A minimal line-JSON daemon on `socketPath`, answering `status` with `pid`. */
function mockDaemon(socketPath: string, status: Record<string, unknown>): Promise<net.Server> {
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const req = JSON.parse(line);
          const reply = req.op === "status" ? { ok: true, id: req.id, entries: 1, ...status } : { ok: true, id: req.id };
          sock.write(JSON.stringify(reply) + "\n");
        } catch {}
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("connect before spawn: an answering daemon stops the spawn", async (t) => {
  const sock = path.join(tmp, "guard.sock");
  const server = await mockDaemon(sock, { pid: process.pid, lock_pid: process.pid, socket: sock });
  t.after(() => server.close());
  const client = new UltraSearchClient({
    socketPath: sock,
    autoSpawnDaemon: true,
    daemonBinaries: [script],
    timeoutMs: 800,
    lanes: 1,
  });
  t.after(() => client.close());
  assert.equal(await client.ping(), true);
  await sleep(1500);
  assert.equal(fs.existsSync(marker), false, "a live daemon must not be spawned over");
});

test("connect before spawn: an absent daemon is spawned after the grace window", async (t) => {
  const sock = path.join(tmp, "empty.sock");
  const client = new UltraSearchClient({
    socketPath: sock,
    autoSpawnDaemon: true,
    daemonBinaries: [script],
    timeoutMs: 250,
    maxReconnectRetries: 1,
    lanes: 1,
  });
  t.after(() => client.close());
  await client.ping().catch(() => false);
  const deadline = Date.now() + 6000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(50);
  assert.ok(fs.existsSync(marker), "with no daemon answering, the guard must spawn one");
});

test("status(): healthy single daemon reports no duplicate signal", async (t) => {
  const sock = path.join(tmp, "healthy.sock");
  const server = await mockDaemon(sock, { pid: process.pid, lock_pid: process.pid, socket: sock, uptime_ms: 42 });
  t.after(() => server.close());
  const client = new UltraSearchClient({ socketPath: sock, autoSpawnDaemon: false, lanes: 1 });
  t.after(() => client.close());
  const st = await client.status();
  assert.equal(st.daemon_health?.pid, process.pid);
  assert.equal(st.daemon_health?.uptime_ms, 42);
  assert.equal(st.daemon_health?.duplicate_suspected, false, JSON.stringify(st.daemon_health));
  // lsof may be unavailable in a sandbox: only assert the owner list when it is.
  if ((st.daemon_health?.socket_owners ?? []).length > 0) {
    assert.ok(st.daemon_health!.socket_owners.includes(process.pid), "the mock daemon owns its socket");
  }
});

test("status(): a lock pid that disagrees with the answering pid is flagged", async (t) => {
  const sock = path.join(tmp, "mismatch.sock");
  const server = await mockDaemon(sock, { pid: process.pid, lock_pid: 99999, socket: sock });
  t.after(() => server.close());
  const client = new UltraSearchClient({ socketPath: sock, autoSpawnDaemon: false, lanes: 1 });
  t.after(() => client.close());
  const st = await client.status();
  assert.equal(st.daemon_health?.duplicate_suspected, true);
  assert.ok(
    st.daemon_health?.duplicates.some((d) => d.reason.includes("socket.lock")),
    `expected a lock mismatch: ${JSON.stringify(st.daemon_health)}`,
  );
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
