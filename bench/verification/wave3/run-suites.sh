#!/usr/bin/env bash
# bench/verification/wave3/run-suites.sh — re-measure every gate suite on the
# current head. Logs under bench/verification/wave3/rerun/suite-*.log.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
OUT=bench/verification/wave3/rerun
mkdir -p "$OUT"
export PI_ULTRASEARCH_TEST=1

run() {
  local name="$1"; shift
  echo "########## $name"
  ( "$@" ) > "$OUT/suite-$name.log" 2>&1
  local rc=$?
  echo "$name rc=$rc"
  grep -E '^# (pass|fail|tests|skipped|todo|cancelled)|not ok|^ok [0-9]+ - ' "$OUT/suite-$name.log" | tail -12
  echo "--- first failures ---"
  grep -E '^not ok ' "$OUT/suite-$name.log" | head -8
}

run typecheck npm run typecheck
run build npm run build
run test npm test
run test-engine npm run test:engine
run test-gate npm run test:gate
run cargo-test cargo test --release --manifest-path engine/Cargo.toml
echo "########## done"
