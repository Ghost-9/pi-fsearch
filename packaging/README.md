# Packaging

| Path | What |
|:---|:---|
| `../scripts/install.sh` | macOS daemon installer: engine binary + LaunchAgent, FDA steps, `--dry-run`, `--uninstall` |
| `homebrew/ultrasearch.rb` | Homebrew formula **template** for the client surfaces (tap not published) |
| `systemd/ultrasearch.service` | systemd **user** unit template for a Linux daemon |
| `../docs/engine-rebrand.md` | macOS install/replace/rollback of the live daemon (app bundle, signature, LaunchAgent) |
| `../docs/linux-daemon-blockers.md` | exactly why the daemon does not build on Linux yet, and the port checklist |
| `../engine/BUILD.md` | building the vendored engine, isolated instances, upstream sync |

## macOS: `scripts/install.sh`

```bash
engine/rebrand.sh ~/.cache/fsearch /Users/batra/ultrasearch-engine   # once
(cd /Users/batra/ultrasearch-engine && cargo build --release)
./scripts/install.sh --dry-run --bin /Users/batra/ultrasearch-engine/target/release/ultrasearch
./scripts/install.sh         --bin /Users/batra/ultrasearch-engine/target/release/ultrasearch
```

It installs `~/.local/bin/ultrasearch-daemon` and the app-bundle binary at
`/Applications/UltraSearch.app/Contents/MacOS/UltraSearch`, re-signs both with
the identifier-only designated requirement (`com.pi.ultrasearch`) that keeps the
Full Disk Access grant valid, writes
`~/Library/LaunchAgents/com.pi.ultrasearch.plist`, and bootstraps the job. It is
idempotent: unchanged files are reported and skipped, and a replaced app bundle
is copied to `UltraSearch.app.bak-<stamp>` first. `--uninstall` moves the job,
binaries and bundle to `.uninstalled-<stamp>` (reversible) and never touches
`~/Library/Application Support/UltraSearch`.

The script prints the FDA steps and the next step (`ultrasearch init --list`,
the phase-1 harness registration). Do not reinstall the daemon while another
measurement window is open (wave-2 advisor directive); record pid/entries/
event_id in every artifact.

The older `ultrasearch install` CLI command remains for installing the CLI/TUI
shims into `~/.local/bin`; it is not a substitute for this script (it does not
install or sign the engine binary from a chosen source).

## Homebrew (template, not published)

`homebrew/ultrasearch.rb` installs the client surfaces from the release tarball
(`ultrasearch`, `ultrasearch-tui`, `ultrasearch-mcp`); it deliberately does not
install the daemon, because a formula cannot express the Full Disk Access grant
or the bundle identity the grant is stored against. The tap is **not
published** — the header comment documents the checksum-fill and local
`brew install --build-from-source` path. Do not advertise a tap URL until it
exists.

## Linux (template, not yet runnable)

The client half works on Linux today (`$XDG_RUNTIME_DIR/ultrasearch.sock`, else
`~/.local/share/ultrasearch/ultrasearch.sock`), and CI runs typecheck, unit
tests, the package smoke test and the hermetic gate on `ubuntu-latest`. The
daemon itself is macOS-only until the checklist in
`docs/linux-daemon-blockers.md` is done. The unit file is committed so the
packaging shape is reviewed now, not on port day.

## macOS

`docs/engine-rebrand.md` is the authority: build, install both binaries, re-sign
with the identifier-only designated requirement (`com.pi.ultrasearch`, which is
what the Full Disk Access grant is stored against), restart the LaunchAgent, and
keep the backups for rollback. The install paths are
`~/.local/bin/ultrasearch-daemon` and
`/Applications/UltraSearch.app/Contents/MacOS/UltraSearch`.

Do not reinstall the daemon while another measurement window is open
(wave-2 advisor directive); record pid/entries/event_id in every artifact.
