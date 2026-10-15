// Regression test for the wave-2 scorer's `recall_at_limit` correction.
//
// `glob_set_completeness` is the Tier-L bar that asked whether RS02
// (`src/**/*.ts`, limit 20) returned its whole expected set. It was computed
// from a `top` already truncated to kMax=10, so it reported 10/14 = 0.714 for
// a run whose `retrieved` array held all 14 files — the only unconceded Tier-L
// floor (17/18) was a reading of the instrument, not a dropped file.
//
// These cases fail against the old computation: the first asserts the value
// the bar is supposed to mean, the second keeps the old value visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScoreQuery } from "./scoring.mjs";

const norm = (p) => p;
const scoreQuery = makeScoreQuery(norm);

const FOURTEEN = Array.from({ length: 14 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);

test("recall_at_limit counts the whole returned list, not the top-10 page", () => {
  const expected = FOURTEEN.map((path) => ({ path, grade: 3 }));
  const s = scoreQuery(FOURTEEN, expected);
  assert.equal(s.recall_at_limit, 1, "a complete set is complete");
  assert.equal(s.recall_at_limit_kmax_clamped, 10 / 14, "the pre-correction value is still recorded");
  assert.equal(s.recall_at_10, 10 / 14, "recall@10 is capped by definition for a 14-file set and must not be used here");
});

test("recall_at_limit is a fraction of the expected set, over any list length", () => {
  const expected = FOURTEEN.map((path) => ({ path, grade: 3 }));
  const partial = FOURTEEN.slice(0, 12);
  const s = scoreQuery(partial, expected);
  assert.equal(s.recall_at_limit, 12 / 14);
  assert.equal(scoreQuery([], expected).recall_at_limit, 0);
  assert.equal(scoreQuery(["src/other.ts"], expected).recall_at_limit, 0);
});

test("recall_at_limit ignores grade-0 expectations and stays null with none", () => {
  const expected = [
    { path: "src/only.ts", grade: 3 },
    { path: "src/mention.ts", grade: 0 },
  ];
  const s = scoreQuery(["src/mention.ts"], expected);
  assert.equal(s.recall_at_limit, 0, "a grade-0 file is not part of the recall set");
  assert.equal(scoreQuery(["src/only.ts"], expected).recall_at_limit, 1);
  assert.equal(scoreQuery(["x"], [{ path: "x", grade: 0 }]).recall_at_limit, null);
});

test("a returned list longer than the expected set does not inflate recall", () => {
  const expected = [{ path: "src/a.ts", grade: 3 }];
  const noise = Array.from({ length: 200 }, (_, i) => `noise/${i}.ts`);
  const s = scoreQuery([...noise, "src/a.ts"], expected);
  assert.equal(s.recall_at_limit, 1);
  assert.equal(scoreQuery(noise, expected).recall_at_limit, 0);
});
