# Building the vendored engine

The engine is the upstream `fsearch` v0.2.1 Rust daemon (MIT © Noah Dunnagan,
see `NOTICE` and `LICENSE`), vendored under `engine/` so engine behaviour can be
changed and tested in-tree.

## Requirements

- macOS (the daemon uses `getattrlistbulk(2)`, FSEvents and `libc` APIs that
  only exist on Darwin; there is no Linux build today)
- Rust 1.98.1 or newer (`edition = "2024"`; tested with `rustc 1.98.1`)
- No other toolchain: the only dependencies are `libc`, `rayon`, `memchr`,
  `memmap2`, `regex`, `regex-syntax`, `serde`, `serde_json`.

## Build

```bash
cd engine
cargo build --release          # ~26 s warm, ~1 min cold on an M-series Mac
cargo test --release           # unit tests (no daemon required)
```

The binary lands at `engine/target/release/fsearch`. Build output is **not**
committed (`.gitignore`: `engine/target/`).

## Install (optional, replaces the system daemon)

```bash
cd engine
cargo build --release
./target/release/fsearch install --login
```

`install` copies the binary to `~/.local/bin/fsearch`, writes the
`mt.nd.fsearch` LaunchAgent and stops the previously running daemon so the next
one is the new binary. It needs Full Disk Access granted to that path for a
whole-disk index. Do not run this unless you mean to replace the daemon that is
serving your live index.

## Running an isolated instance (recommended for tests and benchmarks)

The daemon writes its index to `~/Library/Application Support/FSearch` by
default. Every part of that is overridable so a test can run its own daemon
without touching the live index or walking the whole disk:

| Variable | Effect |
|---|---|
| `ULTRASEARCH_DIR` | index directory (holds `index.bin`, `content/`, `fsearch.sock`, `socket.lock`). Default: `$HOME/Library/Application Support/FSearch`. |
| `ULTRASEARCH_HOME` | the "home" paths are compared against for content scope. Default: `$HOME`. |
| `ULTRASEARCH_SCAN_ROOT` | the directory the first full crawl lists instead of `/`. Default: `/`. |
| `ULTRASEARCH_DENY` | colon/comma-separated absolute path prefixes never returned (see `docs/security-deny-list.md`). |
| `FSEARCH_RESTRICT=1` | force the consent-gated folder skip list (the default without Full Disk Access). |

Example — a fully isolated daemon over a fixture tree:

```bash
FIX=/tmp/us-fix
mkdir -p $FIX/data $FIX/root
ULTRASEARCH_DIR=$FIX/data ULTRASEARCH_HOME=$FIX/root ULTRASEARCH_SCAN_ROOT=$FIX/root \
  ./target/release/fsearch serve &
# talk to it directly (the socket lives in the index dir)
printf '{"op":"ping"}\n' | nc -U $FIX/data/fsearch.sock
```

`test/engine/harness.mjs` in the repository root does exactly this and is what
the engine integration tests use.

## Upstream sync policy

`engine/` tracks upstream v0.2.1 plus local behavioural patches. When syncing a
newer upstream release, re-apply the local patches listed in
`docs/engine-changes.md`; do not merge upstream naming back over the
`ultrasearch_*` rebrand applied by `engine/rebrand.sh`.
