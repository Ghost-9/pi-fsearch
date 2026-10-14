# Engine rebrand, daemon migration and rollback

Status: **performed on this machine 2026-10-15** (stamp `20261015-020331`).
Owners: Wave 1 foundation (naming/build/MCP/bootstrap). Engine *behaviour* patches belong to the engine wave.

The extension talks to a resident Rust daemon. That daemon is a **renamed fork** of the upstream
[`fsearch`](https://github.com/noahdunnagan/fsearch) engine (MIT, © Noah Dunnagan, v0.2.1). Upstream authorship,
copyright and licence text are never rewritten — see [`NOTICE`](../NOTICE).

---

## 1. What is where

| Thing | Path |
|:---|:---|
| Upstream engine checkout (untouched, attribution source) | `~/.cache/fsearch` (git tag `v0.2.1`, commit `88e63fd`) |
| UltraSearch engine working copy (rebranded, buildable) | `/Users/batra/ultrasearch-engine` |
| Rebrand script (deterministic, idempotent, in-repo) | `engine/rebrand.sh <src-dir> <dst-dir>` |
| Installed daemon binary | `~/.local/bin/ultrasearch-daemon` (signed `com.pi.ultrasearch.daemon`) |
| App-bundle daemon (what launchd runs; holds the FDA grant) | `/Applications/UltraSearch.app/Contents/MacOS/UltraSearch` |
| LaunchAgent | `~/Library/LaunchAgents/com.pi.ultrasearch.plist` |
| Live state: index, content index, locks, log, socket | `~/Library/Application Support/UltraSearch/` |
| Socket | `~/Library/Application Support/UltraSearch/ultrasearch.sock` |
| Back-compat socket for pre-rename clients | `~/Library/Application Support/FSearch/fsearch.sock` → symlink to the socket above |

Environment overrides are `PI_ULTRASEARCH_*` only. Default socket paths: macOS
`~/Library/Application Support/UltraSearch/ultrasearch.sock`; Linux `$XDG_RUNTIME_DIR/ultrasearch.sock` else
`~/.local/share/ultrasearch/ultrasearch.sock`; Windows `\\.\pipe\ultrasearch`.

---

## 2. Rebuilding the engine from scratch

```bash
# 1. rebrand an upstream checkout into the working copy (idempotent; safe to re-run)
cd /Users/batra/.pi/agent/extensions/pi-ultrasearch
engine/rebrand.sh ~/.cache/fsearch /Users/batra/ultrasearch-engine

# 2. build
cd /Users/batra/ultrasearch-engine
cargo build --release          # ~60 s on this machine (Apple Silicon)

# 3. install (daemon binary + app-bundle binary)
install -m 0755 target/release/ultrasearch ~/.local/bin/ultrasearch-daemon
install -m 0755 target/release/ultrasearch /Applications/UltraSearch.app/Contents/MacOS/UltraSearch

# 4. re-sign. The app's existing TCC (Full Disk Access) grant is stored as
#    `identifier "com.pi.ultrasearch"`, so the signature MUST keep that identifier
#    and an identifier-only designated requirement:
codesign --force --deep --sign - \
  --identifier com.pi.ultrasearch \
  --requirements '=designated => identifier "com.pi.ultrasearch"' \
  /Applications/UltraSearch.app
codesign --force --sign - --identifier com.pi.ultrasearch.daemon ~/.local/bin/ultrasearch-daemon

# 5. restart the LaunchAgent
launchctl bootout gui/$(id -u)/com.pi.ultrasearch 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi.ultrasearch.plist
```

`engine/rebrand.sh` rewrites `Cargo.toml`/`Cargo.lock`, every `.rs`/`.py`/workflow/text file, the CLI usage and
help text, the MCP `serverInfo` name, the LaunchAgent label (`mt.nd.ultrasearch`), the data dir
(`Library/Application Support/UltraSearch`), the socket name (`ultrasearch.sock`) and the install path
(`~/.local/bin/ultrasearch-daemon`). It skips `LICENSE`, masks the upstream project URL and the upstream release
asset name, and writes a `NOTICE`. Running it twice is a no-op (verified by comparing tree hashes).

---

## 3. Migration that was performed (2026-10-15)

```bash
STAMP=20261015-020331                       # see /tmp/ultrasearch-migration-stamp

# backups (kept)
/Applications/UltraSearch.app.bak-$STAMP
~/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-$STAMP

# old pre-rename daemon binary parked (cannot be spawned accidentally)
~/.local/bin/fsearch.bak-pre-ultrasearch    # was ~/.local/bin/fsearch

# state directory MOVED, not copied (index.bin 119 MB + content/ 136 MB preserved)
mv "~/Library/Application Support/FSearch" "~/Library/Application Support/UltraSearch"
mkdir -p "~/Library/Application Support/FSearch"
ln -sfn "~/Library/Application Support/UltraSearch/ultrasearch.sock" \
        "~/Library/Application Support/FSearch/fsearch.sock"
```

The back-compat symlink exists so a **pre-rename Pi session that is still loaded in memory** (it resolves
`.../FSearch/fsearch.sock`) keeps working until it restarts. Connecting through the symlink was verified with a
JSON-lines `{"op":"ping"}` → `{"ok":true}`. Remove the legacy directory once no pre-rename session is running:

```bash
rm -rf "~/Library/Application Support/FSearch"    # after all clients restarted
```

### MCP registries (same change window)

All registered MCP clients pointed at `.../pi-ultrasearch/bin/mcp-server.ts`. Because `npm run build` now emits
`dist/bin/mcp-server.js`, the registries were repointed to a stable launcher that prefers `dist/` and falls back to
the TypeScript source (`~/.local/bin/ultrasearch-mcp`), so the server keeps working before and after the build:

| Registry | File | Backup |
|:---|:---|:---|
| Antigravity (also symlinked at `~/.gemini/antigravity/mcp_config.json`) | `~/.gemini/config/mcp_config.json` | `.bak-20261015-020049` |
| VS Code user | `~/Library/Application Support/Code/User/mcp.json` | `.bak-20261015-020049` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `.bak-20261015-020049` |

Each entry became `{"command": "/Users/batra/.local/bin/ultrasearch-mcp", "args": []}`.

---

## 4. Verification (observed)

```bash
# socket exists and the job is running
launchctl print gui/$(id -u)/com.pi.ultrasearch | grep -E 'state|pid'
#   state = running ; program = /Applications/UltraSearch.app/Contents/MacOS/UltraSearch

# daemon answers on the new socket, with the moved index and FDA intact
printf '{"op":"status","id":1}\n' | nc -U "~/Library/Application Support/UltraSearch/ultrasearch.sock"
#   entries 3,919,306 · dirs 629,412 · content_docs 129,598 · index_bytes 124,870,784
#   full_disk_access true · owner true

# pre-rename clients still reach it through the symlink
printf '{"op":"ping","id":2}\n' | nc -U "~/Library/Application Support/FSearch/fsearch.sock"
#   {"id":2,"ok":true}

# suites (live daemon)
npm run typecheck   # pass
npm test            # 42/42 pass, 0 skipped
npm run test:gate   # 4/4 pass (hermetic mock + live daemon)
```

---

## 5. Rollback

Everything is reversible without rebuilding, as long as the backups above exist.

```bash
STAMP=20261015-020331

# --- 1. stop the rebranded daemon and remove its job -------------------------
launchctl bootout gui/$(id -u)/com.pi.ultrasearch

# --- 2. restore the LaunchAgent ---------------------------------------------
cp ~/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-$STAMP \
   ~/Library/LaunchAgents/com.pi.ultrasearch.plist

# --- 3. restore the app bundle (old binary + old signature) ------------------
rm -rf /Applications/UltraSearch.app
cp -R /Applications/UltraSearch.app.bak-$STAMP /Applications/UltraSearch.app

# --- 4. restore the pre-rename daemon binary --------------------------------
mv ~/.local/bin/fsearch.bak-pre-ultrasearch ~/.local/bin/fsearch

# --- 5. move the state directory back and drop the compat dir ---------------
mv "~/Library/Application Support/UltraSearch" "~/Library/Application Support/FSearch"
# the old plist logs to the FSearch directory, so the log lands in the right place

# --- 6. start the old daemon again ------------------------------------------
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi.ultrasearch.plist

# --- 7. restore the MCP registries (they must point back at the .ts entry) ---
cp ~/.gemini/config/mcp_config.json.bak-20261015-020049 ~/.gemini/config/mcp_config.json
cp "~/Library/Application Support/Code/User/mcp.json.bak-20261015-020049" \
   "~/Library/Application Support/Code/User/mcp.json"
cp "~/Library/Application Support/Claude/claude_desktop_config.json.bak-20261015-020049" \
   "~/Library/Application Support/Claude/claude_desktop_config.json"

# --- 8. (optional) revert the extension code --------------------------------
git -C /Users/batra/.pi/agent/extensions/pi-ultrasearch checkout <pre-rename-commit>
```

Notes:

* The index is **moved, never copied**; rollback moves it back. If it is ever lost, it is regenerable: start the
  daemon and it rebuilds `index.bin` from the filesystem (content index rebuild is slower — minutes on this machine).
* The app bundle backup is a full copy (`/Applications/UltraSearch.app.bak-$STAMP`, ~4.3 MB), so the original
  binary **and** its original signature/Info.plist are preserved.
* The upstream engine is untouched at `~/.cache/fsearch`, so the old daemon can also be rebuilt from source with
  `cargo build --release` if the parked binary is lost.
* If Full Disk Access is ever lost (status shows `full_disk_access: false`), grant it again to
  **UltraSearch** in System Settings → Privacy & Security → Full Disk Access, pointing at
  `/Applications/UltraSearch.app` (the daemon must be restarted after the toggle).
