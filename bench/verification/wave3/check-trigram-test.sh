#!/usr/bin/env bash
# bench/verification/wave3/check-trigram-test.sh — reproduce the doc's claim for
# test/client.test.ts:53 in isolated daemons over THIS worktree.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"
export PI_ULTRASEARCH_TEST=1
if [ ! -d "${CORPUS_ROOT:-}" ] && [ -n "${CORPUS_ROOT:-}" ]; then mkdir -p "$CORPUS_ROOT" && git archive HEAD | tar -x -C "$CORPUS_ROOT"; fi
OUT=bench/verification/wave3/rerun
for spec in "base:/tmp/rf-bins/base/ultrasearch" "main:$REPO/engine/target/release/ultrasearch"; do
  arm="${spec%%:*}"; bin="${spec#*:}"
  dir="$OUT/daemon-trigram-$arm"; rm -rf "$dir"; mkdir -p "$dir"
  export ULTRASEARCH_ENGINE_BIN="$bin"
  node bench/verification/checks/isolated-daemon.mjs start --dir "$dir" --corpus "${CORPUS_ROOT:-$REPO}" --warm --timeout 180000 >/dev/null
  docs=$(node bench/verification/wave3/warm-poll.mjs "$dir/ultrasearch.sock")
  export PI_ULTRASEARCH_SOCKET="$dir/ultrasearch.sock"
  ARM="$arm" DOCS="$docs" IN_ROOT="${CORPUS_ROOT:-$REPO}" node --input-type=module -e '
const m = await import("./src/client.ts");
const c = new m.UltraSearchClient({ timeoutMs: 20000 });
const res = await c.grep("UltraSearchClient", { in: process.env.IN_ROOT, limit: 30, budget_ms: 2500, context: 0 });
const paths = (res.files ?? []).map((f) => f.path.replace(process.env.IN_ROOT + "/", ""));
const out = { arm: process.env.ARM, content_docs: Number(process.env.DOCS), ok: res.ok, source: res.source, read: res.read, candidates: res.candidates, n: paths.length, has_client_ts: paths.some((p) => p.endsWith("src/client.ts")), has_test: paths.some((p) => p.endsWith("test/client.test.ts")), top6: paths.slice(0, 6) };
console.log(JSON.stringify(out, null, 0));
c.close();
'
  node bench/verification/checks/isolated-daemon.mjs stop --dir "$dir" >/dev/null
done
