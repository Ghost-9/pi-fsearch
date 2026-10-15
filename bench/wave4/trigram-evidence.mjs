#!/usr/bin/env node
// bench/wave4/trigram-evidence.mjs — parse two `node --test` logs into the
// trigram-test evidence artifact. Called by bench/wave4/check-trigram-test.sh.

import * as fs from "node:fs";
import * as path from "node:path";

const [aLog, aDir, bLog, bDir, out] = process.argv.slice(2);
const parse = (logPath, dir, label) => {
  const s = fs.readFileSync(logPath, "utf8");
  const num = (re) => {
    const m = s.match(re);
    return m ? Number(m[1]) : null;
  };
  const skippedReason = (s.match(/# daemon has no content index[^\n]*/) ?? [null])[0];
  const outcome = /# daemon has no content index/.test(s) ? "skipped:source=scan" : /✔ UltraSearchClient grep with trigram index/.test(s) ? "passed_with_full_assertion" : "failed_or_unknown";
  return { case: label, cwd: dir, outcome, tests: num(/^ℹ tests (\d+)/m), pass: num(/^ℹ pass (\d+)/m), fail: num(/^ℹ fail (\d+)/m), skipped: num(/^ℹ skipped (\d+)/m), skip_reason: skippedReason };
};
const a = parse(aLog, aDir, "fresh-worktree");
const b = parse(bLog, bDir, "indexed-checkout");
const artifact = {
  suite: "wave4-trigram-test-evidence",
  generated_at: new Date().toISOString(),
  test: "test/client.test.ts > UltraSearchClient grep with trigram index",
  why: "a fresh worktree is not covered by the live daemon content index, so grep answers source=scan; the assertion is about the indexed path, so it is skipped there with the reason instead of being weakened",
  case_a_fresh_worktree: a,
  case_b_indexed_checkout: b,
  verdict: a.outcome === "skipped:source=scan" && b.outcome === "passed_with_full_assertion" && b.fail === 0 ? "fixed_deterministically" : "REVIEW",
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify(artifact, null, 2));
