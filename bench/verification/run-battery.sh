#!/usr/bin/env bash
# bench/verification/run-battery.sh — FINAL VERIFIER battery runner (wave1/verify-final).
#
# Runs the frozen verifier baseline scripts in the worktree it is pointed at,
# recording the environment gate before and after and copying every raw JSON.
#
#   bash bench/verification/run-battery.sh <mode> <worktree> <outdir> [HOME_OVERRIDE]
#     mode     before | after        (label recorded in the manifest)
#     worktree path to the checkout to measure (its own src/ + bench/baseline/)
#     outdir   where results are copied (bench/verification/<mode>)
#     HOME     optional HOME override (BEFORE isolation)
#
# PI_ULTRASEARCH_TEST=1 is always exported: the production audit log is never written.
set -uo pipefail

MODE="$1"; WORKTREE="$2"; OUT="$3"; HOME_OVERRIDE="${4:-}"
export PI_ULTRASEARCH_TEST=1
if [ -n "$HOME_OVERRIDE" ]; then export HOME="$HOME_OVERRIDE"; fi
cd "$WORKTREE"
mkdir -p "$OUT"

STEPS="make-fixture latency equivalence tokens zeroresult make-corpus judgments"
MANIFEST="$OUT/manifest.json"
{
  echo "{"
  echo "  \"mode\": \"$MODE\","
  echo "  \"worktree\": \"$WORKTREE\","
  echo "  \"home\": \"$HOME\","
  echo "  \"commit\": \"$(git rev-parse HEAD 2>/dev/null)\","
  echo "  \"branch\": \"$(git branch --show-current 2>/dev/null)\","
  echo "  \"started_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"steps\": ["
} > "$MANIFEST"

node bench/baseline/gate-check.mjs > "$OUT/gate-pre.json" 2>&1 || true
echo "== gate(pre) $(node -e 'const g=require("'"$OUT"'/gate-pre.json");console.log(g.status, "load1="+g.load1, "ac="+g.ac_power)')"

first=1
for step in $STEPS; do
  echo "== $step $(date -u +%H:%M:%SZ)"
  t0=$(date +%s)
  node "bench/baseline/$step.mjs" > "$OUT/log-$step.txt" 2>&1
  rc=$?
  t1=$(date +%s)
  [ $first -eq 1 ] || echo "    ," >> "$MANIFEST"
  first=0
  printf '    {"step": "%s", "exit": %s, "seconds": %s}' "$step" "$rc" "$((t1 - t0))" >> "$MANIFEST"
  [ $rc -eq 0 ] || echo "STEP_FAILED $step (exit $rc); see $OUT/log-$step.txt" >&2
done
{
  echo ""
  echo "  ],"
  echo "  \"finished_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  echo "}"
} >> "$MANIFEST"

node bench/baseline/gate-check.mjs > "$OUT/gate-post.json" 2>&1 || true
cp bench/baseline/results/*.json "$OUT/" 2>/dev/null || true
ls -1 "$OUT"/*.json | sed 's|.*/||' | sort
