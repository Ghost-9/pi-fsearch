// bench/verification/checks/identity-guard.test.mjs — F10 regression test.
//
// The bug: summarize.mjs marked 12 `judgments.*` rows `verified` while the
// before/after artifacts were byte-identical (the F10 case). This test feeds the
// guard exactly that shape — two identical files — and requires `needs-re-run`,
// plus a control (distinct, fresh, same-ref artifacts) that stays `verified`.
//
//   node --test bench/verification/checks/identity-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyIdentityGuard, assertNoVerifiedIdentical, sha256File } from "./identity-guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "us-identity-guard-"));
const write = (name, obj) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
};

// A minimal artifact shaped like bench/baseline/results/judgments-baseline.json.
const artifact = (commit, generated_at, extra = {}) => ({
  meta: { suite: "judgments", commit, generated_at, status: "final" },
  aggregates: { recall_at_10: 0.6737179487179487, ...extra },
});

test("F10: byte-identical before/after artifacts force needs-re-run", () => {
  // The exact F10 shape: the after artifact is a copy of the before artifact.
  const shared = artifact("0a16e50", "2026-10-14T20:38:50.603Z");
  const before = write("before-identical.json", shared);
  const after = write("after-identical.json", shared);
  assert.equal(sha256File(before), sha256File(after), "fixture must be byte-identical");

  const row = { id: "judgments.recall@10", lane: "judgments", status: "verified", before: 0.674, after: 0.674 };
  const guarded = applyIdentityGuard(row, { beforePaths: [before], afterPaths: [after], headCommit: "3135e28" });

  assert.equal(guarded.status, "needs-re-run", "identical artifacts must not be verifiable");
  assert.equal(guarded.evidence_hashes.identical_artifacts, true);
  assert.ok(guarded.guard.fired.includes("G1"), "G1 (identical) must fire");
  assert.match(guarded.status_reason, /byte-identical/);
});

test("control: distinct, fresh, same-ref artifacts stay verified", () => {
  const before = write("before-real.json", artifact("0a16e50", "2026-10-14T23:30:00.000Z"));
  const after = write("after-real.json", artifact("3135e28", "2026-10-15T05:10:00.000Z", { recall_at_10: 0.68 }));

  const row = { id: "judgments.recall@10", lane: "judgments", status: "verified", before: 0.674, after: 0.68 };
  const guarded = applyIdentityGuard(row, { beforePaths: [before], afterPaths: [after], headCommit: "3135e28" });

  assert.equal(guarded.status, "verified");
  assert.equal(guarded.evidence_hashes.identical_artifacts, false);
  assert.ok(guarded.evidence_hashes.after[0].sha256);
  assert.notEqual(guarded.evidence_hashes.before[0].sha256, guarded.evidence_hashes.after[0].sha256);
});

test("G2: an after artifact older than the before artifact is stale", () => {
  const before = write("before-new.json", artifact("0a16e50", "2026-10-14T23:30:00.000Z"));
  const after = write("after-old.json", artifact("3135e28", "2026-10-14T20:38:50.603Z"));
  const row = { id: "judgments.recall@10", status: "verified" };
  const guarded = applyIdentityGuard(row, { beforePaths: [before], afterPaths: [after], headCommit: "3135e28" });
  assert.equal(guarded.status, "needs-re-run");
  assert.ok(guarded.guard.fired.includes("G2"));
});

test("G3: two artifacts from the same ref are refused (the F10 shape without identical bytes)", () => {
  const before = write("before-sameref.json", artifact("0a16e50", "2026-10-14T20:00:00.000Z"));
  const after = write("after-sameref.json", artifact("0a16e50", "2026-10-15T05:10:00.000Z", { recall_at_10: 0.674 }));
  const row = { id: "judgments.recall@10", status: "verified" };
  const guarded = applyIdentityGuard(row, { beforePaths: [before], afterPaths: [after], headCommit: "3135e28" });
  assert.equal(guarded.status, "needs-re-run");
  assert.ok(guarded.guard.fired.includes("G3"), "distinct files that both record the before ref are not a measurement");
  assert.equal(guarded.evidence_hashes.identical_artifacts, false, "the bytes differ; the ref is what gives it away");
});

test("a later head must not invalidate a measurement: the ref check is informational", () => {
  const before = write("before-head.json", artifact("0a16e50", "2026-10-14T20:00:00.000Z"));
  const after = write("after-head.json", artifact("91e7832", "2026-10-15T05:10:00.000Z"));
  const guarded = applyIdentityGuard(
    { id: "judgments.recall@10", status: "verified" },
    { beforePaths: [before], afterPaths: [after], headCommit: "deadbee" },
  );
  assert.equal(guarded.status, "verified");
  assert.equal(guarded.evidence_hashes.after_ref_matches_head, false, "recorded for the reader");
  assert.equal(guarded.guard, undefined, "no guard may fire for a moved head");
});

test("G4: a missing claimed artifact is refused", () => {
  const before = write("before-missing.json", artifact("0a16e50", "2026-10-14T20:00:00.000Z"));
  const row = { id: "judgments.recall@10", status: "verified" };
  const guarded = applyIdentityGuard(row, {
    beforePaths: [before],
    afterPaths: [path.join(TMP, "does-not-exist.json")],
    headCommit: "3135e28",
  });
  assert.equal(guarded.status, "needs-re-run");
  assert.ok(guarded.guard.fired.includes("G4"));
});

test("the guard only downgrades: a failed row stays failed", () => {
  const shared = artifact("0a16e50", "2026-10-14T20:38:50.603Z");
  const before = write("failed-before.json", shared);
  const after = write("failed-after.json", shared);
  const row = { id: "check.readme_conflict_marker", status: "failed" };
  const guarded = applyIdentityGuard(row, { beforePaths: [before], afterPaths: [after], headCommit: "3135e28" });
  assert.equal(guarded.status, "failed");
  assert.ok(guarded.guard.fired.includes("G1"), "the violation is still recorded");
});

test("assertNoVerifiedIdentical is the generate-time tripwire", () => {
  const shared = artifact("0a16e50", "2026-10-14T20:38:50.603Z");
  const before = write("tripwire-before.json", shared);
  const after = write("tripwire-after.json", shared);
  const row = applyIdentityGuard({ id: "x", status: "verified" }, { beforePaths: [before], afterPaths: [after] });
  assert.equal(row.status, "needs-re-run");
  assert.equal(assertNoVerifiedIdentical([row]), true);
  // And a hand-built row that bypassed the guard must be caught.
  assert.throws(() => assertNoVerifiedIdentical([{ id: "bypassed", status: "verified", evidence_hashes: { identical_artifacts: true } }]), /identity guard violated/);
});
