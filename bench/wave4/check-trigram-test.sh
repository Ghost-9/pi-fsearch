#!/usr/bin/env bash
# bench/wave4/check-trigram-test.sh — evidence for the test/client.test.ts trigram fix.
#
# The wave-3 verifier proved the test's 175/176 was environmental: a fresh
# worktree's live-daemon grep answers `source: scan` because the daemon's content
# index does not cover that scope, so the trigram-index assertion cannot hold
# there. The fix skips (with the reason) on `scan` and keeps the full assertion
# everywhere else. This script runs both cases and records the outcome:
#
#   case A  cwd = THIS worktree, live daemon, expected source=scan  -> skipped
#   case B  cwd = an indexed checkout (--indexed, default the main checkout)
#           -> assertion runs, expected pass
#
#   bash bench/wave4/check-trigram-test.sh [--indexed <dir>] [--out <f>]

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
INDEXED="/Users/batra/.pi/agent/extensions/pi-ultrasearch"
OUT="bench/wave4/trigram-test-evidence.json"
while [ $# -gt 0 ]; do
  case "$1" in
    --indexed) INDEXED="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
export PI_ULTRASEARCH_TEST=1
TEST_FILE="$REPO/test/client.test.ts"
A_LOG="/tmp/w4-trigram-fresh.log"
B_LOG="/tmp/w4-trigram-indexed.log"

( cd "$REPO" && node --test "$TEST_FILE" > "$A_LOG" 2>&1 )
( cd "$INDEXED" && node --test "$TEST_FILE" > "$B_LOG" 2>&1 )

node "$REPO/bench/wave4/trigram-evidence.mjs" "$A_LOG" "$REPO" "$B_LOG" "$INDEXED" "$REPO/$OUT"
