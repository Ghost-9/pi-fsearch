# Packaging

| Path | What |
|:---|:---|
| `systemd/ultrasearch.service` | systemd **user** unit template for a Linux daemon |
| `../docs/engine-rebrand.md` | macOS install/replace/rollback of the live daemon (app bundle, signature, LaunchAgent) |
| `../docs/linux-daemon-blockers.md` | exactly why the daemon does not build on Linux yet, and the port checklist |
| `../engine/BUILD.md` | building the vendored engine, isolated instances, upstream sync |

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
