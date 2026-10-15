#!/bin/bash
# Rollback for the Wave 3 ops daemon promotion (2026-10-15).
#
# Restores the wave-1 installed daemon (app bundle + ~/.local/bin copy), the
# LaunchAgent and restarts the job, then verifies the daemon answers again.
# State directory is NOT moved or modified by this promotion, so nothing to
# restore there.
#
# Usage: bash bench/results/wave3/rollback-wave3-ops.sh
set -euo pipefail

STAMP=20261015-wave3ops
APP=/Applications/UltraSearch.app
APP_BAK="/Applications/UltraSearch.app.bak-$STAMP"
BIN="$HOME/.local/bin/ultrasearch-daemon"
BIN_BAK="$HOME/.local/bin/ultrasearch-daemon.bak-$STAMP"
PLIST="$HOME/Library/LaunchAgents/com.pi.ultrasearch.plist"
PLIST_BAK="$HOME/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-$STAMP"
SOCKET="$HOME/Library/Application Support/UltraSearch/ultrasearch.sock"
DOMAIN="gui/$(id -u)"

echo "== rollback: stopping promoted daemon =="
launchctl bootout "$DOMAIN/com.pi.ultrasearch" 2>/dev/null || true

for f in "$APP_BAK" "$BIN_BAK" "$PLIST_BAK"; do
  [ -e "$f" ] || { echo "FATAL: missing backup $f" >&2; exit 1; }
done

echo "== rollback: restoring app bundle, binary and LaunchAgent =="
rm -rf "$APP"
cp -R "$APP_BAK" "$APP"
cp -p "$BIN_BAK" "$BIN"
cp -p "$PLIST_BAK" "$PLIST"

echo "== rollback: restarting =="
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "== rollback: waiting for socket =="
for i in $(seq 1 60); do
  if printf '{"op":"ping","id":1}\n' | nc -U "$SOCKET" 2>/dev/null | grep -q '"ok":true'; then
    echo "daemon answered after ${i} polls"
    printf '{"op":"status","id":2}\n' | nc -U "$SOCKET" | head -c 600; echo
    echo "legacy socket: $(printf '{"op":"ping","id":3}\n' | nc -U "$HOME/Library/Application Support/FSearch/fsearch.sock")"
    echo "ROLLBACK OK"
    exit 0
  fi
  sleep 1
done

echo "FATAL: daemon did not answer after rollback" >&2
exit 1
