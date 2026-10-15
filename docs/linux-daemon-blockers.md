# Linux daemon: exact blockers (issue #32)

Status: **the daemon does not build on Linux; the client does.** This file
records the precise blocker so it is a known, checkable fact rather than an
assumption, and so a future port has a checklist.

Reproduce (no Linux machine needed — a cross-target `cargo check` compiles
everything and reports the platform bindings):

```bash
rustup target add x86_64-unknown-linux-gnu
cargo check --release --target x86_64-unknown-linux-gnu --manifest-path engine/Cargo.toml
```

Observed 2026-10-15, `rustc 1.98.1`:

```
error: could not compile `ultrasearch` (lib) due to 48 previous errors; 2 warnings emitted
```

| File | Errors | macOS-only API |
|:---|--:|:---|
| `engine/src/walk.rs` | 32 | `getattrlistbulk(2)` / `getattrlist` and the `attrlist` attribute bits (`ATTR_CMN_*`, `ATTR_DIR_*`, `FSOPT_NOFOLLOW`, `UF_HIDDEN`) — the whole-disk enumerator has no Linux implementation; `libc` exposes none of these off Darwin |
| `engine/src/engine.rs` | 10 | `pthread_set_qos_class_self_np` / `qos_class_t` (QoS classes), `F_RDADVISE` + `struct radvisory`, `sysctlbyname` |
| `engine/src/content.rs` | 7 | `sysctlbyname("hw.perflevel*")` (performance/efficiency core counts), `pthread_set_qos_class_self_np`, `getiopolicy_np` (iCloud materialisation policy) |
| `engine/src/fsevents.rs` | 1 | the CoreServices event stream (the module exists to hold the stream; no inotify backend) |

The error classes are `E0425` (missing `libc` symbol), `E0433`/`E0422` (missing
`libc` type). CI captures the full compiler log in the
`linux-daemon-blockers` job artifact; that job is deliberately
`continue-on-error: true` because it documents a known failure, while
`test-linux` is the gating job.

## What already works on Linux

* `src/client.ts` resolves `$XDG_RUNTIME_DIR/ultrasearch.sock`, else
  `~/.local/share/ultrasearch/ultrasearch.sock` (`resolveDefaultSocketPath()`).
* The whole client surface, the hermetic mock gate and the unit tests run on
  Linux; the CI `test-linux` job proves it (integration tests skip cleanly
  without a daemon).
* The CLI fails with a clear message rather than hanging when no daemon answers
  (chain smoke test in CI; `PI_ULTRASEARCH_NO_SPAWN=1` forbids a spawn).

## Port checklist (what a Linux daemon needs)

1. **Enumeration.** Replace `getattrlistbulk` in `walk.rs` with a Linux path
   (e.g. `getdents64` + `fstatat`), keeping the same `RawEnt`/`Listing` shape and
   the mount/firmlink flags' Linux equivalents. This is the bulk of the port;
   everything else consumes the listing.
2. **Change stream.** Add an inotify backend behind `fsevents.rs`'s interface
   (`event id` becomes a monotonic counter; `staleness_ms`/`replay_in_progress`
   semantics stay as documented in `docs/engine-changes.md`).
3. **QoS / core topology.** Gate `pthread_set_qos_class_self_np` and
   `sysctlbyname("hw.perflevel*")` behind `cfg(target_os = "macos")` and use
   `sched_setaffinity`/`/sys/devices/system/cpu` (or just the default thread
   count) on Linux.
4. **`F_RDADVISE`** (read-ahead hint) and **`getiopolicy_np`** (iCloud) have no
   Linux equivalent; both are hints — drop them behind `cfg`.
5. **Packaging.** `packaging/systemd/ultrasearch.service` is the unit template;
   see `packaging/README.md` for the install path and the
   `$XDG_RUNTIME_DIR` socket layout.

Nothing here is attempted in wave 2: the recommendation was to land it last.
The client, the mock gate and the CI matrix are the parts that can be validated
on this machine and in CI today.
