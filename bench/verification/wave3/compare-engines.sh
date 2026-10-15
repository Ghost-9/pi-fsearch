#!/usr/bin/env bash
# bench/verification/wave3/compare-engines.sh — behavioral fingerprint of each
# engine over the SAME clean archive corpus (page-order discriminator for #48).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export PI_ULTRASEARCH_TEST=1
CORPUS="${CORPUS:-/tmp/w3v-clean-head}"
# The clean archive corpus is rebuilt from HEAD if absent (no untracked files).
if [ ! -d "$CORPUS" ]; then mkdir -p "$CORPUS" && git archive HEAD | tar -x -C "$CORPUS"; fi
OUT=bench/verification/wave3/rerun
declare -a ENGINES=(
  "base:/tmp/rf-bins/base/ultrasearch"
  "rank:/tmp/rf-bins/rank/ultrasearch"
  "main:$REPO/engine/target/release/ultrasearch"
  "ops:/Users/batra/ultrasearch-waves3/ops/engine/target/release/ultrasearch"
  "installed:/Applications/UltraSearch.app/Contents/MacOS/UltraSearch"
)
for spec in "${ENGINES[@]}"; do
  arm="${spec%%:*}"; bin="${spec#*:}"
  [ -f "$bin" ] || { echo "{\"arm\":\"$arm\",\"missing\":true}"; continue; }
  dir="$OUT/daemon-fingerprint-$arm"; rm -rf "$dir"; mkdir -p "$dir"
  export ULTRASEARCH_ENGINE_BIN="$bin"
  node bench/verification/checks/isolated-daemon.mjs start --dir "$dir" --corpus "$CORPUS" --warm --timeout 180000 >/dev/null 2>&1
  docs=$(node bench/verification/wave3/warm-poll.mjs "$dir/ultrasearch.sock" 2>/dev/null || echo 0)
  export PI_ULTRASEARCH_SOCKET="$dir/ultrasearch.sock"
  ARM="$arm" DOCS="$docs" IN_ROOT="$CORPUS" node --input-type=module -e '
const m = await import("./src/client.ts");
const c = new m.UltraSearchClient({ timeoutMs: 30000 });
const res = await c.grep("UltraSearchClient", { in: process.env.IN_ROOT, limit: 30, budget_ms: 2500, context: 0 });
const paths = (res.files ?? []).map((f) => String(f.path).replace(process.env.IN_ROOT + "/", "").replace("private/tmp/w3v-clean-head/", ""));
console.log(JSON.stringify({ arm: process.env.ARM, docs: Number(process.env.DOCS), source: res.source, read: res.read, n: paths.length, has_client: paths.some((p) => p.endsWith("src/client.ts")), client_rank: (paths.findIndex((p) => p.endsWith("src/client.ts")) + 1) || null, top5: paths.slice(0, 5) }));
c.close();
' 2>&1 | tail -1
  node bench/verification/checks/isolated-daemon.mjs stop --dir "$dir" >/dev/null 2>&1
done
echo "--- live daemon (socket, same corpus) ---"
ARM=live DOCS=0 IN_ROOT="$CORPUS" node --input-type=module -e '
const m = await import("./src/client.ts");
const c = new m.UltraSearchClient({ timeoutMs: 30000 });
const res = await c.grep("UltraSearchClient", { in: process.env.IN_ROOT, limit: 30, budget_ms: 2500, context: 0 });
const paths = (res.files ?? []).map((f) => String(f.path).replace(process.env.IN_ROOT + "/", "").replace("private/tmp/w3v-clean-head/", ""));
console.log(JSON.stringify({ arm: "live", source: res.source, read: res.read, n: paths.length, has_client: paths.some((p) => p.endsWith("src/client.ts")), client_rank: (paths.findIndex((p) => p.endsWith("src/client.ts")) + 1) || null, top5: paths.slice(0, 5) }));
c.close();
' 2>&1 | tail -1
