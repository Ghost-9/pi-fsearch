#!/usr/bin/env bash
# bench/verification/checks/run-wave2-baseline.sh — gated wave-2 baseline (task c).
#
# Publishes the pre-registered wave-2 reference from the CURRENT head:
#
#   bench/verification/after/wave2-baseline.json   (lanes, bars, assertions, provenance)
#
# Each attempt is its own environment-gate window; the artifact records the gate and
# a daemon block with a single socket owner. Nothing here writes src/, tests/ or the
# author harnesses.
#
#   MAX_WAIT=7200 ATTEMPTS=3 bash bench/verification/checks/run-wave2-baseline.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export PI_ULTRASEARCH_TEST=1

MAX_WAIT="${MAX_WAIT:-7200}"
ATTEMPTS="${ATTEMPTS:-3}"
OUT=bench/verification/after/wave2-baseline.json
WORK=/tmp/us-verify-work
mkdir -p "$WORK" bench/verification/after

echo "== head: $(git rev-parse HEAD)"
for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "== attempt $attempt — waiting for the gate (max ${MAX_WAIT}s)"
  deadline=$(( $(date +%s) + MAX_WAIT ))
  while ! node bench/baseline/gate-check.mjs >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "== gate still failing after ${MAX_WAIT}s"; break; fi
    sleep 15
  done
  node bench/baseline/gate-check.mjs > "$WORK/gate-wave2.json" 2>&1 || true
  gate_status=$(python3 -c "import json;print(json.load(open('$WORK/gate-wave2.json'))['status'])" 2>/dev/null || echo "?")
  echo "== gate: $gate_status"

  node bench/verification/checks/daemon-block.mjs --out "$WORK/daemon-wave2.json" --gate "$WORK/gate-wave2.json" || {
    echo "== provenance fails (not a single socket owner) — retrying"
    continue
  }

  t0=$(date +%s)
  node bench/verification/checks/score-wave2.mjs --gate "$WORK/gate-wave2.json" --out "$OUT" \
    > "$WORK/wave2-run.log" 2> "$WORK/wave2-rows.log"
  rc=$?
  echo "== scorer exit=$rc in $(( $(date +%s) - t0 ))s"
  [ $rc -eq 0 ] || { echo "== scorer failed"; tail -3 "$WORK/wave2-run.log"; continue; }

  node bench/verification/checks/daemon-block.mjs --stamp "$OUT" >/dev/null
  cp "$WORK/daemon-wave2.json" bench/verification/after/wave2-daemon-block.json 2>/dev/null || true
  status=$(python3 -c "import json;print(json.load(open('$OUT'))['meta']['status'])" 2>/dev/null || echo "?")
  hash=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
  echo "== artifact status=$status sha256=${hash:0:16}"
  if [ "$status" = "final" ]; then
    echo "== ACCEPTED (gate=final, single socket owner)"
    exit 0
  fi
  echo "== provisional run recorded; retrying for a final window"
done

echo "== last attempt was not gate-clean; the artifact stays provisional (documented)"
exit 0
