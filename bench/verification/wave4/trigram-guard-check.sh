#!/usr/bin/env bash
# bench/verification/wave4/trigram-guard-check.sh — the verifier's own check of
# the wave-4 test/client.test.ts change.
#
# Three isolated scopes, each served by the verifier's own daemon (the live
# daemon is never queried):
#
#   case A  cwd = an UNINDEXED copy: under the daemon's scan root, outside its
#           content index -> grep answers source=scan -> the trigram assertion is
#           skipped WITH a reason (the guard). Must show source=scan with files.
#   case B  cwd = an INDEXED copy built from `git archive HEAD`: source=index, so
#           the full assertion runs. Recorded separately because the small-limit
#           literal ranking is index-composition-sensitive (see case C).
#   case C  cwd = the real main checkout, indexed by a FRESH isolated daemon:
#           source=index and the full assertion must pass (the author's case B
#           claim, re-measured without the live daemon). The checkout must be
#           clean before and after; the test writes only under $HOME/.pi/agent/cache.
#
#   bash bench/verification/wave4/trigram-guard-check.sh [--out <json>] [--main <dir>]

set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$REPO/bench/verification/wave4/results/trigram-guard.json"
MAIN="${PI_ULTRASEARCH_MAIN:-/Users/batra/.pi/agent/extensions/pi-ultrasearch}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --main) MAIN="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ENGINE="$REPO/engine/target/release/ultrasearch"
[ -x "$ENGINE" ] || { echo "engine missing: $ENGINE (cargo build --release --manifest-path engine/Cargo.toml)" >&2; exit 2; }

WORK="$(mktemp -d /tmp/usw4.XXXXXX)"
WORK="$(cd "$WORK" && pwd -P)"   # canonical; short path (macOS SUN_LEN socket limit)
IDX="$WORK/indexed"
UNIDX="$WORK/unindexed"
DIR="$WORK/daemon"
mkdir -p "$IDX" "$UNIDX" "$DIR"
git -C "$REPO" archive HEAD | tar -x -C "$IDX"
git -C "$REPO" archive HEAD | tar -x -C "$UNIDX"

export PI_ULTRASEARCH_TEST=1

cleanup() {
  node "$REPO/bench/verification/wave4/isolated-scope-daemon.mjs" stop --dir "$DIR" >/dev/null 2>&1 || true
  node "$REPO/bench/verification/wave4/isolated-scope-daemon.mjs" stop --dir "$WORK/daemon-main" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

node "$REPO/bench/verification/wave4/isolated-scope-daemon.mjs" start --dir "$DIR" --home "$IDX" --scan "$WORK" --expect-docs 1 --engine "$ENGINE" > "$WORK/daemon.json" || { echo "daemon failed to start" >&2; cat "$WORK/daemon.json" >&2; exit 1; }
export PI_ULTRASEARCH_SOCKET="$DIR/ultrasearch.sock"

( cd "$UNIDX" && node --test "$REPO/test/client.test.ts" > "$WORK/caseA.log" 2>&1 )
A_EXIT=$?
( cd "$IDX" && node --test "$REPO/test/client.test.ts" > "$WORK/caseB.log" 2>&1 )
B_EXIT=$?

# Case C: the real main checkout against a fresh isolated daemon over it.
# The engine also binds a process-global legacy socket, so the first daemon is
# stopped before this one starts.
node "$REPO/bench/verification/wave4/isolated-scope-daemon.mjs" stop --dir "$DIR" >/dev/null 2>&1 || true
MAIN_STATE="not-run"
C_EXIT=""
if [ -d "$MAIN" ] && [ -z "$(git -C "$MAIN" status --porcelain 2>/dev/null)" ]; then
  MAIN_HEAD_BEFORE=$(git -C "$MAIN" rev-parse HEAD 2>/dev/null)
  # Do not leak the first daemon's socket into the second engine's environment.
  unset PI_ULTRASEARCH_SOCKET
  node "$REPO/bench/verification/wave4/isolated-scope-daemon.mjs" start --dir "$WORK/daemon-main" --home "$MAIN" --scan "$MAIN" --expect-docs 1 --engine "$ENGINE" > "$WORK/daemon-main.json" 2> "$WORK/daemon-main.err"
  C_START_RC=$?
  if [ $C_START_RC -eq 0 ]; then
    export PI_ULTRASEARCH_SOCKET="$WORK/daemon-main/ultrasearch.sock"
    ( cd "$MAIN" && node --test "$REPO/test/client.test.ts" > "$WORK/caseC.log" 2>&1 )
    C_EXIT=$?
    node "$REPO/bench/verification/wave4/isolated-scope-daemon.mjs" stop --dir "$WORK/daemon-main" >/dev/null 2>&1 || true
    MAIN_AFTER=$(git -C "$MAIN" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    MAIN_STATE="head=$(git -C "$MAIN" rev-parse HEAD 2>/dev/null) head_before=${MAIN_HEAD_BEFORE} dirty_files_after=${MAIN_AFTER}"
    export PI_ULTRASEARCH_SOCKET="$DIR/ultrasearch.sock"
  else
    MAIN_STATE="isolated-daemon-failed rc=$C_START_RC err=$(head -c 300 "$WORK/daemon-main.err" 2>/dev/null | tr '\n' ' ') log=$(tail -c 400 "$WORK/daemon-main/scope-daemon.log" 2>/dev/null | tr '\n' ' ')"
  fi
else
  MAIN_STATE="main-checkout-absent-or-dirty"
fi

node - "$WORK" "$OUT" "$REPO" "$ENGINE" "$A_EXIT" "$B_EXIT" "$C_EXIT" "$MAIN_STATE" "$MAIN" <<'EOF'
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const [work, out, repo, engine, aExit, bExit, cExit, mainState, main] = process.argv.slice(2);
const num = (s, re) => { const m = s.match(re); return m ? Number(m[1]) : null; };
const parse = (p, dir, exit, label) => {
  const s = fs.readFileSync(p, "utf8");
  const reason = (s.match(/# daemon has no content index[^\n]*/) ?? [null])[0];
  const trigramPassed = /✔ UltraSearchClient grep with trigram index/.test(s);
  const trigramSkipped = /﹣ UltraSearchClient grep with trigram index/.test(s) || /# daemon has no content index/.test(s);
  return { case: label, cwd: dir, exit: Number(exit), tests: num(s, /^ℹ tests (\d+)/m), pass: num(s, /^ℹ pass (\d+)/m), fail: num(s, /^ℹ fail (\d+)/m), skipped: num(s, /^ℹ skipped (\d+)/m),
    trigram_outcome: trigramPassed ? "passed_full_assertion" : trigramSkipped ? "skipped_source_scan" : "failed",
    skip_reason: reason };
};
const a = parse(`${work}/caseA.log`, `${work}/unindexed`, aExit, "unindexed-scope");
const b = parse(`${work}/caseB.log`, `${work}/indexed`, bExit, "indexed-git-archive-scope");
const c = fs.existsSync(`${work}/caseC.log`) ? parse(`${work}/caseC.log`, main, cExit, "indexed-main-checkout-scope") : null;
const artifact = {
  suite: "wave4-trigram-guard-independent",
  generated_at: new Date().toISOString(),
  engine_sha256: crypto.createHash("sha256").update(fs.readFileSync(engine)).digest("hex"),
  isolated: true,
  daemon: JSON.parse(fs.readFileSync(`${work}/daemon.json`, "utf8")),
  case_a_unindexed_scope: a,
  case_b_indexed_git_archive_scope: b,
  case_c_indexed_main_checkout_scope: c,
  main_checkout_state: mainState,
  assertions: {
    a_skips_with_reason_and_scan_found_files: a.trigram_outcome === "skipped_source_scan" && !!a.skip_reason && /source=scan, [1-9][0-9]* files/.test(a.skip_reason ?? "") && a.fail === 0,
    b_full_assertion_on_archive_scope: b.trigram_outcome === "passed_full_assertion" && b.fail === 0,
    c_full_assertion_on_main_checkout: !!c && c.trigram_outcome === "passed_full_assertion" && c.fail === 0 && c.tests === 25 && c.skipped === 0,
  },
  verdict:
    a.trigram_outcome === "skipped_source_scan" && a.fail === 0 && c && c.trigram_outcome === "passed_full_assertion" && c.fail === 0
      ? b.trigram_outcome === "passed_full_assertion"
        ? "guard_is_honest"
        : "guard_is_honest_scope_sensitive"
      : "REVIEW",
  note: "case B (a git-archive fixture) is an index-composition sensitivity of the small-limit literal ordering, not a weakening by the guard: the assertion code is identical, and case C shows it passes on the real indexed main checkout with a fresh isolated index.",
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify(artifact, null, 2));
EOF
