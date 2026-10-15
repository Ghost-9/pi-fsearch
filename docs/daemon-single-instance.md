# One daemon per index: the lock, the spawn guard and duplicate detection

Status: implemented and verified 2026-10-15 (wave 2, issue #45).
Owner: platform/quality-gates wave.

Wave 1 observed **two daemons resident at once** (PIDs 19684 and 77206): a stale
pre-rename app bundle at `~/Applications/UltraSearch.app` was spawned while the
rebuilt one served. Each bound its own socket path, so neither errored; during the
takeover grep p50 went **3.3 ms → 128 ms** and every benchmark in that window was
contaminated. This document describes the three layers that prevent it and how to
check each one.

---

## 1. Engine: flock on `socket.lock`

`ultrasearch serve` (`engine/src/server.rs`) creates `<index dir>/socket.lock` and
takes an exclusive, non-blocking `flock` on it **before** it opens the index or
binds the socket. A loser prints

```
<ts> another ultrasearch daemon is running
```

and exits without touching the index, the socket or the owner's pid. The file is
opened without truncation so a loser cannot wipe the owner's pid, and the winner
writes its own pid into it (`lock_pid` in `status`). The lock dies with the process.

`daemon.lock` (`engine/src/engine.rs`) is a second, separate lock: it decides who
*writes the index files*. A daemon that does not own it follows the owner's index.

## 2. Client: connect before spawn

`UltraSearchClient` used to spawn a daemon the moment a connect attempt failed.
A daemon that is still binding its socket produces exactly that failure, so a
second spawn (rejected by the lock, but still a churn storm) followed.

`spawnDaemonIfNoServer()` now probes the socket directly first:

* up to **4 probes × 250 ms**, 150 ms apart (~1.15 s grace);
* a probe is a bounded `net.connect` + `{"op":"ping"}` and counts only an actual
  successful reply;
* only when nothing answers for the whole window does it try the install paths,
  in order: `/Applications/UltraSearch.app/...`, `~/.local/bin/ultrasearch-daemon`,
  `/usr/local/bin/ultrasearch-daemon`, `/opt/homebrew/bin/ultrasearch-daemon`.

`~/Applications/UltraSearch.app` is deliberately **not** a candidate (it held the
stale build in the wave-1 incident). `spawnAttempted` is set before the first
await, so concurrent lanes cannot each start a spawn. The probe is injectable for
tests (`daemonBinaries`) so no test launches a real daemon.

## 3. Engine `status`: identity a duplicate can be caught from

| Field | Meaning |
|:---|:---|
| `pid` | the serving process |
| `uptime_ms` | milliseconds since the engine started (the cold-start window) |
| `socket` | the socket path it serves |
| `socket_dev`, `socket_ino` | `stat` of that socket file — a later replacement at the same path is visible |
| `lock_pid` | the pid recorded in `socket.lock`; must equal `pid` |

## 4. Client `status()`: duplicate/stale signals

`client.status()` adds `daemon_health` (and emits a
`ULTRASEARCH_DUPLICATE_DAEMON` process warning when any signal fires):

* **socket owners** — `lsof -t <socket>` (bounded, skipped if `lsof` is absent);
  more than one owner, or an owner that is not the answering `pid`, is a signal;
* **lock mismatch** — `lock_pid != pid` means a second `serve` wrote, or a stale
  lock file names a different process;
* **legacy socket** — on macOS, when the *default* socket is in use, the
  pre-rename `~/Library/Application Support/FSearch/fsearch.sock` is probed
  (bounded 500 ms); a daemon answering there with a different pid is a duplicate.
  A symlink to the same file is not.

```bash
# by hand: identity + owners
node --input-type=module -e '
const { UltraSearchClient } = await import("./src/client.ts");
const c = new UltraSearchClient({ autoSpawnDaemon: false });
console.log(JSON.stringify((await c.status()).daemon_health, null, 2));
c.close();
'
lsof -t "$HOME/Library/Application Support/UltraSearch/ultrasearch.sock"
```

`PI_ULTRASEARCH_NO_SPAWN=1` disables the client-side spawn entirely (a
measurement or CI process that must never start a daemon).

The benchmark environment gate (`bench/lib/env-gate.mjs`) records the socket owner
pid in every artifact and warns when more than one daemon matches; it refuses a
measurement window where the daemon block moves. Keep the daemon frozen across a
measurement window (advisor wave-2 directive) — rebuilding/reinstalling it
mid-window invalidates every sibling measurement.

## 5. Tests

| Test | Proves |
|:---|:---|
| `test/engine/single-instance.test.mjs` | identity fields agree with `stat` and the lock; a second `serve` exits with "another ... daemon is running"; the first keeps serving on the same socket inode; `lsof` shows one owner |
| `test/single-instance-client.test.ts` | an answering daemon stops the spawn; with nothing answering, the spawn happens after the grace window; a healthy `status` has no duplicate signal; a `lock_pid` mismatch is flagged |

## 6. Rollback / known limits

* If `lsof` is unavailable, owner detection degrades to the `lock_pid` and
  legacy-probe checks; the identity fields are still reported.
* The legacy-socket probe runs only when the client is talking to the default
  socket; a client explicitly pointed at another path does not probe it.
* `flock` is advisory: a forged binary that skips `serve` can still bind the
  same path, but the socket file must be removed first, and the next `serve`
  loses the lock and refuses to start — the intended failure mode.
