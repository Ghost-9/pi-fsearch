#!/usr/bin/env bash
# bench/verification/checks/rerun-wave1-judgments.sh — F10 repair, step (b).
#
# Re-runs the FROZEN wave-1 judgments scorer (bench/baseline/judgments.mjs, byte-identical
# to the committed harness) on the current head, in its own environment-gate window, and
# publishes the artifact with a daemon provenance block:
#
#   bench/verification/after/judgments-baseline.json   (the gated AFTER measurement)
#   bench/verification/after/judgments-daemon-block.json
#
# The pristine golden (bench/baseline/results/judgments-baseline.json, sha256 ab4e4ac7…)
# is restored afterwards, so this script leaves the author/verifier golden untouched.
#
#   MAX_WAIT=5400 ATTEMPTS=3 bash bench/verification/checks/rerun-wave1-judgments.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export PI_ULTRASEARCH_TEST=1

MAX_WAIT="${MAX_WAIT:-5400}"
ATTEMPTS="${ATTEMPTS:-3}"
AFTER=bench/verification/after
WORK=/tmp/us-verify-work
GOLDEN=bench/baseline/results/judgments-baseline.json
GOLDEN_SHA_EXPECTED="ab4e4ac731fcc05f05feb3f3c3d8b5a90ad9f725f206fabdbe495415ab3d12c9"
mkdir -p "$AFTER" "$WORK"

echo "== head: $(git rev-parse HEAD)"
echo "== golden before: $(shasum -a 256 "$GOLDEN" | cut -c1-16)"

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "== attempt $attempt — waiting for the gate (max ${MAX_WAIT}s)"
  deadline=$(( $(date +%s) + MAX_WAIT ))
  while ! node bench/baseline/gate-check.mjs >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "== gate still failing after ${MAX_WAIT}s"
      break
    fi
    sleep 15
  done
  node bench/baseline/gate-check.mjs > "$WORK/gate-judgments.json" 2>&1 || true
  gate_status=$(python3 -c "import json;print(json.load(open('$WORK/gate-judgments.json'))['status'])" 2>/dev/null || echo "?")
  echo "== gate: $gate_status"

  # Provenance first: a single socket owner is a precondition of a publishable artifact.
  node bench/verification/checks/daemon-block.mjs --out "$AFTER/judgments-daemon-block.json" --gate "$WORK/gate-judgments.json" || {
    echo "== provenance check failed (not a single socket owner) — retrying"
    continue
  }

  t0=$(date +%s)
  node bench/baseline/judgments.mjs > "$WORK/judgments-run.log" 2>&1
  rc=$?
  echo "== scorer exit=$rc in $(( $(date +%s) - t0 ))s"
  [ $rc -eq 0 ] || { echo "== scorer failed; see $WORK/judgments-run.log"; tail -3 "$WORK/judgments-run.log"; continue; }

  cp "$GOLDEN" "$AFTER/judgments-baseline.json"
  node bench/verification/checks/daemon-block.mjs --stamp "$AFTER/judgments-baseline.json" >/dev/null
  # keep the input copy in step with the new artifact
  cp bench/baseline/results/judgments-input.json "$AFTER/judgments-input.json" 2>/dev/null || true

  hash=$(shasum -a 256 "$AFTER/judgments-baseline.json" | cut -d' ' -f1)
  gen=$(python3 -c "import json;print(json.load(open('$AFTER/judgments-baseline.json'))['meta'].get('generated_at'))" 2>/dev/null)
  echo "== artifact: $hash (generated_at $gen)"
  if [ "$hash" = "$GOLDEN_SHA_EXPECTED" ]; then
    echo "== REFUSED: artifact is byte-identical to the pristine golden (F10)"
    continue
  fi

  # restore the committed golden + input so the worktree stays clean apart from bench/verification
  git show "HEAD:$GOLDEN" > "$GOLDEN"
  git show "HEAD:bench/baseline/results/judgments-input.json" > bench/baseline/results/judgments-input.json 2>/dev/null || true
  echo "== golden after restore: $(shasum -a 256 "$GOLDEN" | cut -c1-16)"
  echo "== ACCEPTED (gate=$gate_status) — pass the wave-1 judgments to summarize.mjs"
  exit 0
done

echo "== no acceptable window after ${ATTEMPTS} attempts; artifact left as-is"
exit 1
