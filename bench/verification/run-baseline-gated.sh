#!/usr/bin/env bash
# bench/verification/run-baseline-gated.sh — run each baseline script in its OWN gate window.
#
#   bash bench/verification/run-baseline-gated.sh <worktree> <outdir> <home|-> <max_wait> <script...>
#
# Each script is a separate measurement window: the gate is polled until it passes
# (AC + load1 < 1.5 + no cargo/rustc), then exactly one script runs, then the loop
# waits again for the load average to decay. A script whose own pre-gate fails is
# re-run (up to ATTEMPTS) so every JSON gets its best chance at status="final";
# the final JSON is copied to <outdir> whatever its status, and the status is echoed.
set -uo pipefail

WORKTREE="$1"; OUT="$2"; HOME_OVERRIDE="$3"; MAX_WAIT="$4"; shift 4
STEPS=("$@")
ATTEMPTS="${ATTEMPTS:-3}"

export PI_ULTRASEARCH_TEST=1
if [ "$HOME_OVERRIDE" != "-" ]; then export HOME="$HOME_OVERRIDE"; fi
mkdir -p "$OUT"
cd "$WORKTREE"

for step in "${STEPS[@]}"; do
  best=""
  for attempt in $(seq 1 "$ATTEMPTS"); do
    # --- wait for a passing gate
    deadline=$(( $(date +%s) + MAX_WAIT ))
    while :; do
      if node bench/baseline/gate-check.mjs >/dev/null 2>&1; then break; fi
      if [ "$(date +%s)" -ge "$deadline" ]; then echo "== [$step] gate still failing; running anyway"; break; fi
      sleep 8
    done
    t0=$(date +%s)
    node "bench/baseline/$step.mjs" > "$OUT/log-$step.txt" 2>&1
    rc=$?
    secs=$(( $(date +%s) - t0 ))
    # status is writen by the script itself into its result JSON
    raw=$(ls -t bench/baseline/results/*.json 2>/dev/null | head -1)
    st=$(python3 -c "import json,sys;print(json.load(open('$raw')).get('meta',{}).get('status','?'))" 2>/dev/null || echo "?")
    echo "== [$step] attempt $attempt exit=$rc ${secs}s status=$st"
    best="$st"
    if [ "$st" = "final" ]; then break; fi
    cp bench/baseline/results/*.json "$OUT/" 2>/dev/null || true
    echo "== [$step] not final — waiting for a quieter window"
  done
  cp bench/baseline/results/*.json "$OUT/" 2>/dev/null || true
  echo "== [$step] FINAL STATUS: $best"
done
