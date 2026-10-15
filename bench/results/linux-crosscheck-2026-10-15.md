# Linux cross-check: precise error grouping (issue #32)

Date: 2026-10-15 · Apple Silicon macOS · `rustc 1.98.1` · target
`x86_64-unknown-linux-gnu` · worktree `wave5/telemetry-packaging` @ `a1f4f1d` + slice.

## Command

```bash
rustup target add x86_64-unknown-linux-gnu
cargo check --release --target x86_64-unknown-linux-gnu \
  --manifest-path engine/Cargo.toml --all-targets --keep-going
```

## Toolchain caveat (measured, must be read with the numbers)

On this machine the plain command stops **before Rust analysis**:

```
error occurred in cc-rs: failed to find tool "x86_64-linux-gnu-gcc": No such file or directory
```

`tree-sitter-{javascript,rust,typescript}` compile generated C through `cc-rs`;
there is no cross C compiler or Linux sysroot installed. The Rust grouping below
was produced with a diagnostic stub (`CC_x86_64_unknown_linux_gnu=<script that
copies a real Mach-O object to the `-o`/`-Fo` target>`). `cargo check` never
links, so this proves Rust name resolution and nothing else — it is **not** a
Linux build. CI's `linux-daemon-blockers` job (ubuntu-latest, native compiler,
`continue-on-error: true`) is the real Linux compile; it runs the same crate and
uploads its log. No Linux daemon pass is claimed anywhere.

## Baseline before the portable slice: 48 primary errors

Primary error = one `error[EXXXX]` block, counted once at its first `-->` span.

| File | Errors | Codes | Darwin-only API |
|:---|--:|:---|:---|
| `engine/src/walk.rs` | 32 | E0425 ×32 | `getattrlistbulk`/`getattrlist`/`getattrlistat`, `attrlist`, the `ATTR_*` bits, `FSOPT_NOFOLLOW`, `UF_HIDDEN`, `O_NOFOLLOW_ANY` |
| `engine/src/engine.rs` | 10 | E0433 ×5, E0425 ×5 | `pthread_set_qos_class_self_np` / `qos_class_t` |
| `engine/src/content.rs` | 5 | E0425 ×3, E0433 ×1, E0422 ×1 | QoS, `sysctlbyname("hw.perflevel*")`, `F_RDADVISE`/`radvisory` |
| `engine/src/fsevents.rs` | 1 | E0433 ×1 | QoS class for the dispatch-queue attribute (CoreServices stream) |

The earlier table in `docs/linux-daemon-blockers.md` listed 7 for `content.rs`
because it counted `-->` spans, not error blocks (two blocks reference
`content.rs` twice); its rows summed to 50 against the compiler's 48. Corrected
here with the counting method stated.

Binary target (`main.rs`, `server.rs`): not reached while the lib fails. By
inspection its only Darwin-only libc use was the same QoS call (4 sites:
`server.rs:106`, `main.rs:150`, one error each for the function and the class);
all other libc use there is portable POSIX (`getuid`, `flock`, `kill`, `recv`,
`setsid`, `signal`, `setpriority`).

## Safe slice landed

| Hint | Sites | Portable path |
|:---|:---|:---|
| Thread QoS | `engine.rs` (6), `content.rs` (1), `fsevents.rs` (1), `server.rs` (1), `main.rs` (1) | `engine/src/qos.rs`: same call on macOS, no-op elsewhere |
| `hw.perflevel*` core split | `content.rs::readers_more` | `READERS` baseline (the value the macOS probe uses when the sysctl is absent) |
| `F_RDADVISE` read-ahead | `content.rs::open_ahead_sized` | hint omitted (checklist item 4) |
| `set/getiopolicy_np` iCloud | `engine.rs::no_materialize`, `content.rs::without_materializing` | no-op (checklist item 4) |

Verified on macOS: `cargo test --release` → 38 + 9 tests, 0 failed. The macOS
path executes the identical syscalls (no behavioural change).

## After the slice: 32 primary errors, all in `walk.rs`

```
error: could not compile `ultrasearch` (lib) due to 32 previous errors; 2 warnings emitted
```

Remaining unresolved `libc` names in `walk.rs` (source inventory): `attrlist`,
`ATTR_CMN_{NAME,OBJTYPE,MODTIME,FLAGS,RETURNED_ATTRS}`, `ATTR_FILE_DATALENGTH`,
`ATTR_DIR_{ENTRYCOUNT,MOUNTSTATUS}`, `ATTR_BIT_MAP_COUNT`, `DIR_MNTSTATUS_MNTPOINT`,
`FSOPT_NOFOLLOW`, `UF_HIDDEN`, `O_NOFOLLOW_ANY`, `getattrlist`, `getattrlistat`,
`getattrlistbulk`. Portable in the same file: `open/openat/close`, `rlimit`,
`setrlimit/getrlimit`, `c_void`, `O_RDONLY`.

## Verdict

Not a Linux build. The whole remaining blocker is the enumerator in
`walk.rs` (checklist item 1); the change stream (item 2) is the next port and
is now the only other Darwin-specific module that compiles. Do not stub either
one: a listing that returns nothing is worse than an honest `cargo check`
failure.
