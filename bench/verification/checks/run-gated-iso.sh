#!/usr/bin/env bash
# bench/verification/checks/run-gated-iso.sh — measure CURRENT MAIN on ISOLATED daemons.
#
# The installed live daemon is the wave-1 binary, so it is not the system under test.
# This runs the freshly built engine (engine/target/release/ultrasearch) over the two
# frozen corpora, on its own socket and index dir, and never touches the live daemon:
#
#   1. wave-1 30-query judgment set  -> after/judgments-baseline.json        (task 2)
#   2. wave-2 38-query set, new engine -> after/wave2-baseline.json          (task 3, arm B)
#   3. wave-2 38-query set, live wave-1 daemon (same client) -> arm A        (task 3 control)
#   4. regenerate wave1-summary.json                                        (task 4)
#
#   MAX_WAIT=1200 ATTEMPTS=3 bash bench/verification/checks/run-gated-iso.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export PI_ULTRASEARCH_TEST=1
export ULTRASEARCH_ENGINE_BIN="${ULTRASEARCH_ENGINE_BIN:-$REPO/engine/target/release/ultrasearch}"

MAX_WAIT="${MAX_WAIT:-1200}"
ATTEMPTS="${ATTEMPTS:-3}"
WORK=/tmp/us-verify-work
AFTER=bench/verification/after
ISO=/Users/batra/.cache/us-verify
W1_CORPUS=/Users/batra/.cache/pi-ultrasearch-bench/corpus-0a16e50
W2_CORPUS=/Users/batra/.cache/pi-ultrasearch-bench/corpus-8d1419d-clean
GOLDEN=bench/baseline/results/judgments-baseline.json
GOLDEN_SHA=ab4e4ac731fcc05f05feb3f3c3d8b5a90ad9f725f206fabdbe495415ab3d12c9
mkdir -p "$WORK" "$AFTER" "$ISO"

gate_wait() {
  local deadline=$(( $(date +%s) + MAX_WAIT ))
  while ! node bench/baseline/gate-check.mjs >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "provisional"; return; fi
    sleep 15
  done
  node bench/baseline/gate-check.mjs > "$WORK/gate-iso.json" 2>&1 || true
  python3 -c "import json;print(json.load(open('$WORK/gate-iso.json'))['status'])" 2>/dev/null || echo "?"
}

echo "=== engine: $ULTRASEARCH_ENGINE_BIN"
[ -x "$ULTRASEARCH_ENGINE_BIN" ] || { echo "engine binary missing — cargo build --release --manifest-path engine/Cargo.toml"; exit 1; }

# ---------------------------------------------------------------- 1. wave-1 judgments, isolated
echo "=== [1/4] wave-1 judgments on an isolated daemon over corpus-0a16e50 $(date -u +%H:%M:%SZ)"
node bench/verification/checks/isolated-daemon.mjs stop --dir "$ISO/iso-w1" >/dev/null 2>&1 || true
ISO_W1=$(node bench/verification/checks/isolated-daemon.mjs start --dir "$ISO/iso-w1" --corpus "$W1_CORPUS" --warm --timeout 180000) || { echo "!! isolated wave-1 daemon failed to start"; ISO_W1=""; }
echo "   $ISO_W1"
if [ -n "$ISO_W1" ]; then
  W1_SOCK=$(echo "$ISO_W1" | python3 -c "import json,sys;print(json.load(sys.stdin)['socket'])")
  for attempt in $(seq 1 "$ATTEMPTS"); do
    gate=$(gate_wait); echo "   gate: $gate"
    PI_ULTRASEARCH_SOCKET="$W1_SOCK" node bench/verification/checks/daemon-block.mjs \
      --out "$AFTER/judgments-daemon-block.json" --gate "$WORK/gate-iso.json" || { echo "   provenance failed"; continue; }
    t0=$(date +%s)
    PI_ULTRASEARCH_SOCKET="$W1_SOCK" JUDGMENTS_ROOT="$W1_CORPUS" node bench/baseline/judgments.mjs > "$WORK/judgments-iso.log" 2>&1
    rc=$?
    echo "   scorer exit=$rc in $(( $(date +%s) - t0 ))s"
    [ $rc -eq 0 ] || { tail -3 "$WORK/judgments-iso.log"; continue; }
    cp "$GOLDEN" "$AFTER/judgments-baseline.json"
    PI_ULTRASEARCH_SOCKET="$W1_SOCK" node bench/verification/checks/daemon-block.mjs --stamp "$AFTER/judgments-baseline.json" >/dev/null
    hash=$(shasum -a 256 "$AFTER/judgments-baseline.json" | cut -d' ' -f1)
    echo "   artifact ${hash:0:16} (gate=$gate)"
    if [ "$hash" = "$GOLDEN_SHA" ]; then echo "   REFUSED: identical to the golden (F10)"; continue; fi
    git show "HEAD:$GOLDEN" > "$GOLDEN"
    git show "HEAD:bench/baseline/results/judgments-input.json" > bench/baseline/results/judgments-input.json 2>/dev/null || true
    echo "   accepted; golden restored $(shasum -a 256 "$GOLDEN" | cut -c1-16)"
    break
  done
  node bench/verification/checks/isolated-daemon.mjs stop --dir "$ISO/iso-w1" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 2. wave-2 baseline, isolated (arm B)
echo "=== [2/4] wave-2 baseline on an isolated daemon over corpus-8d1419d-clean $(date -u +%H:%M:%SZ)"
node bench/verification/checks/isolated-daemon.mjs stop --dir "$ISO/iso-w2" >/dev/null 2>&1 || true
ISO_W2=$(node bench/verification/checks/isolated-daemon.mjs start --dir "$ISO/iso-w2" --corpus "$W2_CORPUS" --warm --timeout 180000) || { echo "!! isolated wave-2 daemon failed to start"; ISO_W2=""; }
echo "   $ISO_W2"
if [ -n "$ISO_W2" ]; then
  W2_SOCK=$(echo "$ISO_W2" | python3 -c "import json,sys;print(json.load(sys.stdin)['socket'])")
  for attempt in $(seq 1 "$ATTEMPTS"); do
    gate=$(gate_wait); echo "   gate: $gate"
    PI_ULTRASEARCH_SOCKET="$W2_SOCK" node bench/verification/checks/daemon-block.mjs \
      --out "$WORK/daemon-wave2-iso.json" --gate "$WORK/gate-iso.json" || { echo "   provenance failed"; continue; }
    t0=$(date +%s)
    PI_ULTRASEARCH_SOCKET="$W2_SOCK" node bench/verification/checks/score-wave2.mjs \
      --gate "$WORK/gate-iso.json" --out "$AFTER/wave2-baseline.json" > "$WORK/wave2-iso.log" 2> "$WORK/wave2-iso-rows.log"
    rc=$?
    echo "   scorer exit=$rc in $(( $(date +%s) - t0 ))s"
    [ $rc -eq 0 ] || { tail -3 "$WORK/wave2-iso.log"; continue; }
    cp "$WORK/daemon-wave2-iso.json" "$AFTER/wave2-daemon-block.json"
    node bench/verification/checks/daemon-block.mjs --stamp "$AFTER/wave2-baseline.json" >/dev/null 2>&1 || true
    status=$(python3 -c "import json;print(json.load(open('$AFTER/wave2-baseline.json'))['meta']['status'])" 2>/dev/null || echo "?")
    echo "   artifact status=$status sha256=$(shasum -a 256 "$AFTER/wave2-baseline.json" | cut -c1-16)"
    [ "$status" = "final" ] && break
  done
  node bench/verification/checks/isolated-daemon.mjs stop --dir "$ISO/iso-w2" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 3. wave-2 control: same client, live wave-1 daemon
echo "=== [3/4] wave-2 control on the LIVE wave-1 daemon (same client) $(date -u +%H:%M:%SZ)"
gate=$(gate_wait); echo "   gate: $gate"
node bench/verification/checks/daemon-block.mjs --out "$WORK/daemon-wave2-live.json" --gate "$WORK/gate-iso.json" || echo "   (live provenance recorded anyway)"
node bench/verification/checks/score-wave2.mjs --gate "$WORK/gate-iso.json" \
  --out "$AFTER/wave2-livewave1daemon.json" > "$WORK/wave2-live.log" 2> "$WORK/wave2-live-rows.log" \
  && echo "   control artifact $(shasum -a 256 "$AFTER/wave2-livewave1daemon.json" | cut -c1-16)" \
  || echo "   !! control run failed"

# ---------------------------------------------------------------- 4. summary
echo "=== [4/4] regenerate the summary $(date -u +%H:%M:%SZ)"
node bench/verification/summarize.mjs || echo "!! summarize failed"
echo "=== done $(date -u +%H:%M:%SZ)"
