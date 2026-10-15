#!/usr/bin/env bash
# bench/wave4/run-gates.sh — measure the v1 and v2 judgment sets on one isolated
# daemon over the frozen wave-1 corpus, validate v2, and score the seven gates.
#
#   npm run bench:wave4:gates
#
# Everything runs against an isolated daemon: ULTRASEARCH_DIR/HOME/SCAN_ROOT are
# inside a scratch dir and PI_ULTRASEARCH_SOCKET points at its socket, so the
# live daemon, its index and its socket are never touched.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

PY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
LABEL="${LABEL:-w4-$(date +%s)}"
DIR="${HOME}/.cache/us-w4g-${LABEL}"
CORPUS="${PI_ULTRASEARCH_CORPUS:-${HOME}/.cache/ultrasearch/corpus/wave1-0a16e50}"
RESULTS="${REPO}/bench/wave4/results"

if [ ! -d "$CORPUS" ]; then
  echo "frozen wave-1 corpus missing at $CORPUS" >&2
  echo "run: npm run bench:wave3:corpora" >&2
  exit 2
fi
export PI_ULTRASEARCH_TEST=1

# The engine is the one this tree builds; the measurement records its sha256.
if [ ! -x engine/target/release/ultrasearch ]; then
  cargo build --release --manifest-path engine/Cargo.toml >&2
fi
export ULTRASEARCH_ENGINE_BIN="${ULTRASEARCH_ENGINE_BIN:-${REPO}/engine/target/release/ultrasearch}"

mkdir -p "$RESULTS"
if [ -e "$DIR" ]; then mv "$DIR" "${DIR}.replaced.$(date +%s)"; fi

echo "[w4] isolated daemon over $CORPUS" >&2
node bench/verification/checks/isolated-daemon.mjs start --dir "$DIR" --corpus "$CORPUS" --warm >/dev/null
export PI_ULTRASEARCH_SOCKET="${DIR}/ultrasearch.sock"

cleanup() { node bench/verification/checks/isolated-daemon.mjs stop --dir "$DIR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

DOCS=$(find "$CORPUS" -type f -not -name '.corpus-meta.json' | wc -l | tr -d ' ')

echo "[w4] validate v2 against the corpus" >&2
node bench/wave4/validate-judgments.mjs --json > bench/wave4/validation-v2.json
node --test bench/wave4/validate-judgments.test.mjs > bench/wave4/validation-tests.log 2>&1 || { cat bench/wave4/validation-tests.log >&2; exit 1; }

echo "[w4] measure v1 ($DOCS content docs)" >&2
node bench/wave3/measure.mjs --label "${LABEL}-v1" --judgments bench/judgments/wave1-judgments.json --corpus "$CORPUS" --out "${RESULTS}/v1.json" --wait-docs "$DOCS"
echo "[w4] measure v2" >&2
node bench/wave3/measure.mjs --label "${LABEL}-v2" --judgments bench/judgments/wave1-judgments.v2.json --corpus "$CORPUS" --out "${RESULTS}/v2.json" --wait-docs "$DOCS"

echo "[w4] re-run the wave-3 expectation audit on the v1 arm" >&2
node bench/wave3/expectation-audit.mjs --results "${RESULTS}/v1.json" --out "${RESULTS}/v1-expectation-audit.json" >&2

echo "[w4] score the seven gates" >&2
node bench/wave4/score-gates.mjs --v1 "${RESULTS}/v1.json" --v2 "${RESULTS}/v2.json" --out bench/wave4/gates-v2.json
echo "[w4] wrote bench/wave4/gates-v2.json" >&2
