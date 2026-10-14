#!/usr/bin/env bash
# bench/baseline/run-all.sh — reproduce the full wave1/baseline suite.
#
# Usage:
#   bash bench/baseline/run-all.sh                 # full run (n=30)
#   GATE_WAIT_SECONDS=1200 bash bench/baseline/run-all.sh
#   PILOT_N=3 bash bench/baseline/run-all.sh       # quick smoke run
#
# Environment gate (advisor directive): AC power, 1-min load < 1.5, no cargo/rustc.
# When the gate fails, all JSON is still written but with status="provisional";
# re-run after the gate passes to overwrite with status="final".
#
# Always exports PI_ULTRASEARCH_TEST=1 so the production audit log is untouched.
set -euo pipefail

export PI_ULTRASEARCH_TEST=1
cd "$(dirname "$0")/../.."

echo "== repo: $(pwd)"
echo "== commit: $(git rev-parse HEAD)"
echo "== PI_ULTRASEARCH_TEST=${PI_ULTRASEARCH_TEST}"

if [ "${GATE_WAIT_SECONDS:-0}" -gt 0 ]; then
  deadline=$(( $(date +%s) + GATE_WAIT_SECONDS ))
  while ! node bench/baseline/gate-check.mjs >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "== gate still failing after ${GATE_WAIT_SECONDS}s — proceeding; results will be provisional"
      break
    fi
    echo "== gate failing; waiting 60s ($(node -e 'process.stdout.write(new Date().toISOString())'))"
    sleep 60
  done
fi

echo "== gate:"
node bench/baseline/gate-check.mjs || true

node bench/baseline/make-fixture.mjs
node bench/baseline/latency.mjs
node bench/baseline/equivalence.mjs
node bench/baseline/tokens.mjs
node bench/baseline/zeroresult.mjs
node bench/baseline/make-corpus.mjs
node bench/baseline/judgments.mjs

echo "== done. Raw JSON in bench/baseline/results/"
