// Single-instance hardening (#45): the engine's identity in `status`, the
// flock that keeps one daemon per index dir, and one socket owner.
//
// Wave 1 observed two daemons resident at once (different install paths, two
// socket paths, grep p50 3.3 -> 128 ms) because a stale pre-rename build was
// spawned while the new one served. The lock + identity fields are what a
// client needs to detect that state.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { EngineHarness, ENGINE_BIN, until } from "./harness.mjs";

test("status identity: pid, uptime, socket inode and the lock pid agree (#45)", async () => {
  const h = new EngineHarness({ files: 60 });
  await h.start();
  try {
    const s = await h.status();
    assert.ok(s.pid > 0, `pid must be reported: ${JSON.stringify(s)}`);
    assert.equal(typeof s.uptime_ms, "number");
    assert.ok(s.uptime_ms >= 0);
    assert.ok(s.socket.endsWith("ultrasearch.sock"), `socket path: ${s.socket}`);
    assert.ok(fs.existsSync(s.socket), "the reported socket must exist");
    assert.ok(s.socket_ino > 0, "the socket inode must be reported");
    assert.ok(s.socket_dev > 0, "the socket device must be reported");
    assert.equal(s.lock_pid, s.pid, "the single-instance lock holds the serving pid");

    // The socket file the daemon answers on is the one it reports.
    const st = fs.statSync(s.socket);
    assert.equal(st.ino, s.socket_ino);
  } finally {
    h.cleanup();
  }
});

test("a second daemon on the same index dir refuses and the first keeps serving (#45)", async () => {
  const h = new EngineHarness({ files: 60 });
  await h.start();
  try {
    const before = await h.status();
    const second = spawn(ENGINE_BIN, ["serve"], {
      env: { ...process.env, ULTRASEARCH_DIR: h.dir, ULTRASEARCH_HOME: h.root, ULTRASEARCH_SCAN_ROOT: h.root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    second.stderr.on("data", (b) => (stderr += b.toString()));
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => {
        second.kill("SIGKILL");
        resolve(null);
      }, 10_000);
      second.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    assert.notEqual(code, null, "a second daemon must exit, not serve alongside");
    assert.match(stderr, /another ultrasearch daemon is running/, `stderr: ${stderr}`);

    const after = await h.status();
    assert.equal(after.pid, before.pid, "the original daemon must still serve");
    assert.equal(after.socket_ino, before.socket_ino, "the socket must not be rebound");

    // Exactly one process may own the socket (lsof may be absent in a sandbox).
    let owners = [];
    try {
      owners = execFileSync("lsof", ["-t", before.socket], { encoding: "utf-8" })
        .split("\n")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      owners = [];
    }
    if (owners.length > 0) {
      assert.deepEqual([...new Set(owners)], [before.pid], `socket owners: ${owners.join(",")}`);
    }
  } finally {
    h.cleanup();
  }
});
