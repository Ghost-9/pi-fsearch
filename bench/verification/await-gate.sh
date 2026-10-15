#!/usr/bin/env bash
# bench/verification/await-gate.sh — wait for the measurement gate, then run a command.
#
#   bash bench/verification/await-gate.sh <worktree> <max_wait_seconds> <cmd...>
#
# Polls the worktree's bench/baseline/gate-check.mjs until it exits 0
# (AC power AND 1-min load < 1.5 AND no cargo/rustc), then execs <cmd>.
# Prints PASS/FAIL of the pre-gate so the caller can label the window.
set -uo pipefail

WORKTREE="$1"; shift
MAX_WAIT="$1"; shift
cd "$WORKTREE"
deadline=$(( $(date +%s) + MAX_WAIT ))
while :; do
  if node bench/baseline/gate-check.mjs >/tmp/us-verify-work/gate-poll.json 2>&1; then
    echo "== gate PASS at $(date -u +%Y-%m-%dT%H:%M:%SZ) ($(grep -o '"load1": [0-9.]*' /tmp/us-verify-work/gate-poll.json | head -1))"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "== gate still FAILING after ${MAX_WAIT}s — proceeding; results will be provisional"
    break
  fi
  sleep 10
done
exec "$@"
