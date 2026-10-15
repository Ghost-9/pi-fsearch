# 0013 — Promote the main engine to the live daemon; keep wave-3 timings provisional

**Choice.** Promote the engine built from `main` (`c64c62b`, sha256
`878e636c…`, Mach-O UUID `6E008204…`) to the live LaunchAgent daemon using
`docs/engine-rebrand.md` exactly — full backups, restore drill, install to the app
bundle and `~/.local/bin/ultrasearch-daemon`, ad-hoc re-sign with
`--requirements '=designated => identifier "com.pi.ultrasearch"'`, then
`launchctl bootout` + `bootstrap`. Wave-3 timing artifacts are committed under
`bench/results/wave3/` as **provisional**, with `final/` empty.

**Reason.** The wave-1 installed daemon predates the wave-2 status identity fields
(`pid`, `uptime_ms`, socket inode, `lock_pid`, `staleness_ms`, `compactions`,
`content_policy`), which `docs/daemon-single-instance.md` requires to detect a
duplicate daemon, so the live surface was behind `main`. The promotion verified
structurally: FDA preserved, legacy compat socket answering, index reused
(entries 6,999,615 → 7,030,442, never zero), `lock_pid == pid`, new socket inode,
launchd pid matches; `test:gate` 8/8 and `test:engine` 38/38 pass against the
promoted daemon. The measurements stay provisional because the environment gate
(AC + load1 < 1.5 + no cargo/rustc) never passed in a bounded 30-minute wait
(min load1 12.91, 0/60 samples) — a degraded artifact may not become `final`
because its delta "looks stable".

**Rejected.**
- Promoting without a restore drill: the drill proves the backup app bundle still
  serves before it is needed (`promotion/restore-drill-*`).
- Relabelling any degraded artifact `final`: violates `VERIFICATION-PROTOCOL.md` §2.
- Rolling back after the first `test:gate` failure (7/8, live grep): the failure
  was `client p50 78.88 ms` because the fresh worktree's content index was cold
  and the scoped grep fell back to `source=scan` over 7,734 on-disk files — the
  same condition wave 2 documented. The bare socket stayed at p50 2.49 ms, and
  after the daemon re-tracked the path the identical suite passed 8/8 with no
  code or daemon change. Rolling back would have discarded a verified promotion
  for an index-coverage artifact.
- Writing `coverage.json` with a `warm` root (persistent daemon config change) to
  force indexing: an mtime touch of tracked files woke the daemon's dirty
  tracking, which was enough; no standing config was added.
