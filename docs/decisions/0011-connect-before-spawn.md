# 0011 — Connect before spawn, detect duplicates in status

**Choice.** The client probes the socket directly (4 × 250 ms) before trying any
binary to spawn, and `status()` reports `daemon_health` (socket owner pids,
`lock_pid` vs `pid`, a bounded probe of the pre-rename legacy socket) with a
`ULTRASEARCH_DUPLICATE_DAEMON` warning when any signal fires. The engine reports
`pid`, `uptime_ms`, `socket`, `socket_dev`/`socket_ino` and `lock_pid`.

**Reason.** Wave 1 had two daemons resident at once (a stale app bundle answered
on the legacy socket while the new one served); during the takeover grep p50 went
3.3 ms → 128 ms and every benchmark in the window was contaminated. The engine
flock prevents the same-index case; the client guard prevents spawn churn while a
daemon is still binding; `status` makes the cross-socket case visible.

**Rejected.**
- Relying on the flock alone: it only protects one index dir; the wave-1 incident
  was two binaries with two socket paths.
- Spawning on first connect failure: a binding daemon produces exactly that
  failure, so it raced.
- Blocking a request on a duplicate: detection is a warning the caller decides
  about, not a new failure mode for a working session.
