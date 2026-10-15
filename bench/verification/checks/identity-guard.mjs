// bench/verification/checks/identity-guard.mjs — F10 repair: artifact-provenance guard.
//
// F10: the twelve `judgments.*` rows in wave1-summary.json were `verified` while
// bench/verification/after/judgments-baseline.json was byte-identical to the
// pristine 0a16e50 golden (sha256 ab4e4ac7…). The "after" numbers had never been
// measured on main, so those rows compared the old system with itself.
//
// A row that claims a before/after measurement may only be `verified` when its
// two sides are *demonstrably distinct measurements of the two refs under test*.
// This module enforces that mechanically:
//
//   G1 identical artifacts   — any before sha256 equals any after sha256
//   G2 stale after           — the after artifact is older than the before artifact
//   G3 same ref on both sides — the two artifacts record the same commit (two runs of
//                               one system, which is what F10 turned out to be)
//   G4 missing artifact      — a claimed artifact does not exist
//
// Any violation forces status `needs-re-run`. The guard never upgrades a status;
// it only downgrades `verified` (a `failed` row stays failed).

import * as crypto from "node:crypto";
import * as fs from "node:fs";

/** sha256 of a file's bytes, or null when it does not exist. */
export function sha256File(p) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** First ISO-ish timestamp found in an artifact (meta.generated_at, meta.date, …). */
function generatedAt(obj) {
  if (!obj || typeof obj !== "object") return null;
  const m = obj.meta ?? {};
  return (
    m.generated_at ??
    m.generatedAt ??
    m.finished_at ??
    m.checked_at ??
    obj.generated_at ??
    obj.generatedAt ??
    obj.finished_at ??
    obj.checked_at ??
    obj.gate?.checked_at ??
    null
  );
}

/** Commit recorded inside an artifact, if any. */
function recordedCommit(obj) {
  if (!obj || typeof obj !== "object") return null;
  const m = obj.meta ?? {};
  return m.commit ?? m.repo_commit ?? obj.commit ?? m.repo?.commit ?? null;
}

/** Everything the guard needs to know about one artifact. */
export function artifactMeta(p) {
  const exists = fs.existsSync(p);
  const obj = exists ? readJSON(p) : null;
  let mtime = null;
  try {
    mtime = fs.statSync(p).mtime.toISOString();
  } catch {
    mtime = null;
  }
  return {
    path: p,
    exists,
    sha256: exists ? sha256File(p) : null,
    mtime,
    generated_at: generatedAt(obj),
    commit: recordedCommit(obj),
  };
}

const newest = (a, b) => (a && b ? (a > b ? a : b) : (a ?? b));

/**
 * Apply the provenance guard to one summary row.
 *
 * @param {object} row            the row about to be recorded
 * @param {object} opts
 * @param {string[]} opts.beforePaths  artifacts backing the `before` side
 * @param {string[]} opts.afterPaths   artifacts backing the `after` side
 * @param {string|null} opts.headCommit commit the `after` side must have been measured at
 * @returns {object} the row, with `evidence_hashes` added and `status` downgraded
 *                   to `needs-re-run` when a guard fires
 */
export function applyIdentityGuard(row, { beforePaths = [], afterPaths = [], headCommit = null } = {}) {
  if (beforePaths.length === 0 && afterPaths.length === 0) return row;

  const before = beforePaths.map(artifactMeta);
  const after = afterPaths.map(artifactMeta);
  const reasons = [];

  // G4 — a claimed artifact must exist.
  for (const a of [...before, ...after]) {
    if (!a.exists) reasons.push(`G4 missing artifact: ${a.path}`);
  }

  // G1 — identical bytes on both sides (the F10 case).
  const beforeHashes = new Set(before.map((a) => a.sha256).filter(Boolean));
  const identical = after.filter((a) => a.sha256 && beforeHashes.has(a.sha256)).map((a) => a.path);
  if (identical.length) {
    reasons.push(
      `G1 before and after artifacts are byte-identical (sha256 ${sha256File(identical[0])?.slice(0, 16)}…): ${identical.join(", ")} — not a before/after measurement`,
    );
  }

  // G2 — the after side must be a newer observation than the before side.
  const bTime = before.map((a) => a.generated_at ?? a.mtime).filter(Boolean).sort().pop() ?? null;
  const aTime = after.map((a) => a.generated_at ?? a.mtime).filter(Boolean).sort().shift() ?? null;
  if (bTime && aTime && aTime < bTime) {
    reasons.push(`G2 stale after artifact: newest before side is ${bTime} but the after side is ${aTime}`);
  }

  // G3 — the two sides must be different refs. Two artifacts from the same commit
  // are two runs of one system: that is not a before/after measurement (F10's
  // before and after were both produced at 0a16e50, even though the files differed).
  const afterCommits = [...new Set(after.map((a) => a.commit).filter(Boolean))];
  const beforeCommits = [...new Set(before.map((a) => a.commit).filter(Boolean))];
  const sameRef = afterCommits.filter((c) => beforeCommits.includes(c));
  if (sameRef.length) {
    reasons.push(
      `G3 both sides record commit ${sameRef.join(", ")}: the after artifact was produced at the before ref, so this is not a before/after measurement`,
    );
  }

  // Informational: does the after side's recorded ref match the head under test?
  // (A later commit that only touches docs/bench must not invalidate a measurement,
  // so this is recorded, never enforced.)
  const head = headCommit ? String(headCommit).slice(0, 8) : null;
  const afterRefMatchesHead = !head || afterCommits.length === 0
    ? null
    : afterCommits.some((c) => String(c).startsWith(head) || head.startsWith(String(c).slice(0, 8)));

  row.evidence_hashes = {
    before: before.map(({ path, sha256, generated_at, commit }) => ({ path, sha256, generated_at, commit })),
    after: after.map(({ path, sha256, generated_at, commit }) => ({ path, sha256, generated_at, commit })),
    head_commit: headCommit ?? null,
    after_ref_matches_head: afterRefMatchesHead,
    identical_artifacts: identical.length > 0,
  };

  if (reasons.length && row.status === "verified") {
    row.status = "needs-re-run";
    row.status_reason = [row.status_reason, ...reasons].filter(Boolean).join(" | ");
    row.guard = { fired: reasons.map((r) => r.split(" ")[0]), detail: reasons };
  } else if (reasons.length) {
    row.guard = { fired: reasons.map((r) => r.split(" ")[0]), detail: reasons, note: "status left as-is (not `verified`)" };
  }
  return row;
}

/** Self-check used by summarize.mjs before writing: no verified row may be byte-identical. */
export function assertNoVerifiedIdentical(rows) {
  const bad = rows.filter((r) => r.status === "verified" && r.evidence_hashes?.identical_artifacts);
  if (bad.length) {
    throw new Error(
      `identity guard violated: ${bad.length} verified row(s) compare byte-identical artifacts: ${bad.map((r) => r.id).join(", ")}`,
    );
  }
  return true;
}
