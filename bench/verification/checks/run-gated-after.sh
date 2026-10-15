#!/usr/bin/env bash
# bench/verification/checks/run-gated-after.sh — chain the F10 repair measurements.
#
#   1. wave-1 judgments re-run on the current head, gated, provenance-stamped  (task b)
#   2. wave-2 baseline (38-query set) on the frozen corpus, gated             (task c)
#   3. regenerate bench/verification/wave1-summary.json                       (task d)
#
# Each step waits for its own gate window; a step that cannot get one records a
# provisional artifact and says so. Nothing is claimed as final without the gate.
#
#   MAX_WAIT=1800 ATTEMPTS=4 bash bench/verification/checks/run-gated-after.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export MAX_WAIT="${MAX_WAIT:-1800}"
export ATTEMPTS="${ATTEMPTS:-4}"
export PI_ULTRASEARCH_TEST=1

echo "=== [1/3] wave-1 judgments re-run $(date -u +%H:%M:%SZ)"
bash bench/verification/checks/rerun-wave1-judgments.sh || echo "!! wave-1 re-run did not get a clean window"

echo "=== [2/3] wave-2 baseline $(date -u +%H:%M:%SZ)"
bash bench/verification/checks/run-wave2-baseline.sh || echo "!! wave-2 baseline failed"

echo "=== [3/3] regenerate the summary $(date -u +%H:%M:%SZ)"
node bench/verification/summarize.mjs || echo "!! summarize failed"

echo "=== done $(date -u +%H:%M:%SZ)"
