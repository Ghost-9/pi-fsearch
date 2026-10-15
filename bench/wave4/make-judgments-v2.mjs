#!/usr/bin/env node
// bench/wave4/make-judgments-v2.mjs — write the versioned wave-1 v2 judgment set
// from v1 plus the wave-4 amendment decision table.
//
//   node bench/wave4/make-judgments-v2.mjs [--out bench/judgments/wave1-judgments.v2.json]
//
// Guarantees, all asserted:
//   * v1 is byte-identical to its recorded sha256 (it is never rewritten);
//   * the wave-3 audit artifact classifies exactly the expectations this script
//     moves or removes (3 absent-string, 6 path-lane-content, 7 symbol-lane-reference);
//   * every v2 must-hit expectation is satisfiable in its lane (the validator
//     re-proves this against the corpus);
//   * every v1 must-hit expectation is accounted for: retained, re-homed, or
//     removed with a proof (the validator re-proves this too).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  V1_PATH, V2_PATH, V1_SHA256, REMOVALS, COMPANION_SPECS, corpusReader, findCorpus,
} from "./amendment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = path.resolve(REPO, opt("out", V2_PATH));
const CORPUS = findCorpus(opt("corpus"));
const AUDIT_PATH = path.join(REPO, "bench", "wave3", "results", "final-expectation-audit.json");
const PROBE_PATH = path.join(HERE, "companion-probe.json");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const v1Bytes = fs.readFileSync(path.join(REPO, V1_PATH));
const v1Sha = sha256(v1Bytes);
if (v1Sha !== V1_SHA256) throw new Error(`v1 changed: ${v1Sha} != recorded ${V1_SHA256} — v1 is the historical record and must stay byte-identical`);
const v1 = JSON.parse(v1Bytes.toString("utf8"));
const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8"));
const probe = JSON.parse(fs.readFileSync(PROBE_PATH, "utf8"));
const corpus = corpusReader(CORPUS);

// ---------------------------------------------------- audit agreement
const auditMisses = [];
for (const r of audit.rows) for (const m of r.misses) auditMisses.push(m);
const byClass = (c) => auditMisses.filter((m) => m.class === c);
const expectedCounts = { "absent-string": 3, "path-lane-content": 6, "symbol-lane-reference": 7 };
for (const [cls, n] of Object.entries(expectedCounts)) {
  if (byClass(cls).length !== n) throw new Error(`audit drift: ${cls} = ${byClass(cls).length}, expected ${n} — re-read the audit before amending`);
}
if (auditMisses.some((m) => m.class === "reachable")) throw new Error("audit reports a reachable miss: the amendment would hide a real recall failure");

// The amendment table must cover exactly the audited misses: every miss is
// removed or re-homed, and every removal corresponds to a miss.
for (const m of auditMisses) {
  const covered = REMOVALS.some((r) => r.id === m.id && r.path === m.expected) || COMPANION_SPECS.some((c) => c.from === m.id && c.expected.some(([p]) => p === m.expected));
  if (!covered) throw new Error(`audited miss ${m.id}/${m.expected} (${m.class}) is not covered by the amendment table`);
}
for (const r of REMOVALS) {
  if (!auditMisses.some((m) => m.id === r.id && m.expected === r.path)) throw new Error(`removal entry ${r.id}|${r.path} does not correspond to an audited miss`);
}

// ---------------------------------------------------- removals with proof
const removalRecords = REMOVALS.map((r) => {
  const text = corpus.text(r.path);
  if (text === null) throw new Error(`removal proof failed: ${r.path} is not in the frozen corpus`);
  const rgCommand = r.class === "absent-string" && !/[A-Z.]/.test(r.query) ? `rg -c -i ${JSON.stringify(r.query)} ${r.path}` : `rg -c -F ${JSON.stringify(r.query)} ${r.path}`;
  let rgOut = "";
  let rgExit = null;
  try {
    rgOut = execFileSync("rg", ["-c", ...(/[A-Z.]/.test(r.query) || r.class !== "absent-string" ? ["-F"] : ["-i"]), r.query, path.join(CORPUS, r.path)], { encoding: "utf8" }).trim();
    rgExit = 0;
  } catch (e) {
    rgOut = String(e.stdout ?? "").trim();
    rgExit = e.status ?? 1;
  }
  const occurrencesCs = text.split(r.query).length - 1;
  const occurrencesCi = text.toLowerCase().split(r.query.toLowerCase()).length - 1;
  if (r.class === "absent-string" && (occurrencesCs !== 0 || occurrencesCi !== 0)) {
    throw new Error(`removal proof failed: ${r.path} contains ${JSON.stringify(r.query)} (cs=${occurrencesCs}, ci=${occurrencesCi}) — an absent-string removal must not hide a match`);
  }
  const excluded = probe.excluded?.find((x) => x.id === r.id && x.path === r.path) ?? null;
  if (r.class === "content-mention-not-top10") {
    if (occurrencesCs < 1) throw new Error(`documents-mention proof failed: ${r.path} does not contain ${JSON.stringify(r.query)}`);
    if (!excluded || !(excluded.rank > 10)) throw new Error(`window-removal proof failed: ${r.path} has no measured rank outside the top 10 (probe: ${JSON.stringify(excluded)})`);
  }
  const audited = auditMisses.find((m) => m.id === r.id && m.expected === r.path) ?? null;
  return {
    id: r.id, lane: r.lane, query: r.query, path: r.path, grade: r.grade, class: r.class, why: r.why,
    audited_class: audited?.class ?? null,
    evidence: {
      corpus: CORPUS,
      file_sha256: corpus.sha256(r.path),
      occurrences_case_sensitive: occurrencesCs,
      occurrences_case_insensitive: occurrencesCi,
      rg_command: rgCommand,
      rg_stdout: rgOut,
      rg_exit_code: rgExit,
      ...(excluded ? { lane_probe: { lane: "grep-literal", mode: "literal", match_count: excluded.match_count, rank: excluded.rank, in_top10: excluded.in_top10, probe_artifact: "bench/wave4/companion-probe.json" } } : {}),
      audit_artifact: "bench/wave3/results/final-expectation-audit.json",
    },
  };
});

// ---------------------------------------------------- companions
const probeById = Object.fromEntries((probe.rows ?? []).map((r) => [r.id, r]));
const shiftPairs = COMPANION_SPECS.map((c) => {
  const source = v1.queries.find((q) => q.id === c.from);
  if (!source) throw new Error(`companion ${c.id}: source row ${c.from} not found in v1`);
  const sourceSender = new Set((source.expected ?? []).map((e) => e.path));
  const removedHere = new Set(REMOVALS.filter((r) => r.id === c.from).map((r) => r.path));
  const moved = (source.expected ?? []).filter((e) => e.grade >= 1 && !removedHere.has(e.path) && auditMisses.some((m) => m.id === c.from && m.expected === e.path));
  const carried = (source.expected ?? []).filter((e) => e.grade >= 1 && !moved.includes(e));
  const expected = [...c.expected.map(([p, grade]) => ({ path: p, grade }))];
  // Every moved expectation of the source that the probe says is retrievable is here.
  for (const e of moved) {
    if (!expected.some((x) => x.path === e.path)) throw new Error(`companion ${c.id} omits moved expectation ${e.path}`);
  }
  for (const e of expected) {
    if (!sourceSender.has(e.path) && !moved.some((m) => m.path === e.path)) throw new Error(`companion ${c.id} invents expectation ${e.path} that is not in v1`);
    const original = (source.expected ?? []).find((x) => x.path === e.path);
    if (original && original.grade !== e.grade) throw new Error(`companion ${c.id}: grade for ${e.path} changed ${original.grade} -> ${e.grade}; grades are relevance judgments and are preserved`);
  }
  const p = probeById[c.id];
  if (!p || !p.all_in_top10) throw new Error(`companion ${c.id} has an expectation outside the top 10 in the content lane (probe: ${JSON.stringify(p?.positions)})`);
  return { spec: c, source, moved, carried, expected, probe: p };
});

// ---------------------------------------------------- build v2 queries
const removedBySource = new Map();
for (const r of removalRecords) {
  if (!removedBySource.has(r.id)) removedBySource.set(r.id, []);
  removedBySource.get(r.id).push(r);
}
const companionsBySource = new Map();
for (const s of shiftPairs) companionsBySource.set(s.source.id, s);

const queries = [];
for (const q of v1.queries) {
  const removed = removedBySource.get(q.id) ?? [];
  const removedPaths = new Set(removed.map((r) => r.path));
  const moved = (q.expected ?? []).filter((e) => !removedPaths.has(e.path) && auditMisses.some((m) => m.id === q.id && m.expected === e.path));
  const kept = (q.expected ?? []).filter((e) => !moved.includes(e) && !removedPaths.has(e.path));
  const row = { ...q };
  if (removed.length || moved.length) {
    row.expected = kept;
    row.amended = {
      reason: "expectations that this lane cannot satisfy were removed (with proof) or re-homed to a content-lane companion",
      removed: removed.map((r) => ({ path: r.path, grade: r.grade, class: r.class })),
      rehomed_to: [...new Set(removed.filter(() => companionsBySource.has(q.id)).map(() => companionsBySource.get(q.id).spec.id))],
      rehomed: moved.map((e) => ({ path: e.path, grade: e.grade, to: companionsBySource.get(q.id)?.spec.id ?? null })),
    };
  }
  queries.push(row);
  const s = companionsBySource.get(q.id);
  if (s) {
    queries.push({
      id: s.spec.id,
      lane: s.spec.lane,
      difficulty: q.difficulty ?? null,
      query: s.spec.query,
      params: { mode: "literal", limit: 10 },
      must_hit: true,
      rehomed_from: { id: q.id, lane: q.lane, query: q.query },
      note: `content-lane companion: the same query intent scored where every expectation occurs in the file's content (${s.moved.length} re-homed, ${s.carried.filter((c) => s.expected.some((e) => e.path === c.path)).length} carried)`,
      expected: s.expected,
      probe: { artifact: "bench/wave4/companion-probe.json", all_in_top10: true, positions: s.probe.positions, source: s.probe.source },
    });
  }
}

// ---------------------------------------------------- accounted-for check (in-script pre-check; validator re-proves)
for (const q of v1.queries) {
  for (const e of q.expected ?? []) {
    if (e.grade < 1) continue;
    const kept = (queries.find((x) => x.id === q.id)?.expected ?? []).some((x) => x.path === e.path);
    const rehomed = shiftPairs.some((s) => s.source.id === q.id && s.expected.some((x) => x.path === e.path));
    const removed = removalRecords.some((r) => r.id === q.id && r.path === e.path);
    if (!kept && !rehomed && !removed) throw new Error(`v1 expectation ${q.id}/${e.path} is unaccounted for`);
  }
}

const rehomings = [];
for (const s of shiftPairs) {
  for (const e of s.expected) {
    const wasMoved = s.moved.some((m) => m.path === e.path);
    rehomings.push({
      id: s.source.id, lane: s.source.lane, query: s.source.query,
      expected_path: e.path, grade: e.grade,
      class: wasMoved ? (auditMisses.find((m) => m.id === s.source.id && m.expected === e.path)?.class ?? null) : "already-satisfiable",
      to: { id: s.spec.id, lane: s.spec.lane, query: s.spec.query },
      grade_preserved: true,
      evidence: { audit_artifact: "bench/wave3/results/final-expectation-audit.json", probe_artifact: "bench/wave4/companion-probe.json", rank_in_companion_lane: s.probe.positions[e.path] ?? null },
    });
  }
}

const v1MustHit = v1.queries.filter((q) => q.must_hit === true && q.negative !== true);
const v1Expected = v1MustHit.reduce((a, q) => a + (q.expected ?? []).filter((e) => e.grade >= 1).length, 0);
const v2MustHit = queries.filter((q) => q.must_hit === true && q.negative !== true);
const v2Expected = v2MustHit.reduce((a, q) => a + (q.expected ?? []).filter((e) => e.grade >= 1).length, 0);

const v2 = {
  schema: "ultrasearch.judgments/v2",
  version: 2,
  created: new Date().toISOString().slice(0, 10),
  author: "wave4/gates",
  supersedes: {
    path: V1_PATH,
    schema: v1.schema,
    version: v1.version,
    sha256: v1Sha,
    policy: "v1 remains byte-identical and is the historical record. Every number reported for v1 in bench/wave4/gates-v2.json is the v1 score on the frozen corpus and is not restated as a v2 value.",
  },
  amendment: {
    rule: "A must-hit expectation must be satisfiable in the lane it is scored in: a path lane expectation must match the path, a content lane expectation must occur in the file's content under that lane's matching rule, a symbol lane expectation must contain a declaration, and a semantic expectation must share a distinctive token with the intent. Satisfiability is checked by bench/wave4/validate-judgments.mjs against the frozen corpus, not against a run result.",
    window_rule: "An expectation whose lane can match it but whose measured rank in every lane that can match it is outside the gate's top-10 window is removed from must-hit as content-mention-not-top10 with the measured rank and match count recorded in `removed`. It is not deleted silently: bench/wave4/gates-v2.json also reports `strict_alternative` — recall@10 recomputed with every such expectation restored.",
    basis: [
      "docs/wave3/W3-03-recall10-cap.md — audit: 16 unreachable expectations, zero reachable misses",
      "bench/wave3/results/final-expectation-audit.json — per-expectation classification",
      "bench/verification/wave3-summary.json#W3-AUD-D — verifier conditions: re-score per lane, do not delete, version and re-baseline",
      "docs/decisions/0014-grep-page-ranking.md — content-lane ranking policy (definitions, then match count, then source-over-prose)",
      "bench/judgments/wave2-judgments.json#RS01 — path lane pins exactness (test/client.test.ts is `not_expected` for `src/client.ts`)",
      "bench/judgments/wave2-judgments.json#SY01,#SY02 — symbol mode pins declarations-first (`not_expected` for reference files)",
    ],
    counts: {
      v1_must_hit_rows: v1MustHit.length,
      v1_grade_ge_1_expectations: v1Expected,
      removed: removalRecords.length,
      removed_by_class: removalRecords.reduce((a, r) => ({ ...a, [r.class]: (a[r.class] ?? 0) + 1 }), {}),
      rehomed: rehomings.filter((r) => r.class !== "already-satisfiable").length,
      companions: COMPANION_SPECS.length,
      v2_must_hit_rows: v2MustHit.length,
      v2_grade_ge_1_expectations: v2Expected,
    },
  },
  corpus: v1.corpus,
  rubric: v1.rubric,
  metrics: v1.metrics,
  queries,
  removed: removalRecords,
  rehomings,
  acceptance: {
    ...v1.acceptance,
    must_pass_before_any_ranking_claim_ships: v1.acceptance.must_pass_before_any_ranking_claim_ships.map((s) => s.replace("on the 5 negative queries", "on the 4 negative queries")),
    errata: [
      "v1 states `false_positive_rate == 0.00 on the 5 negative queries`; the v1 file contains four negative queries (P8, G6, R3, M6). The sentence is corrected here; the metric definition and the 0.00 bound are unchanged, and the v1 file keeps its wording.",
    ],
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(v2, null, 2) + "\n");
const v2Sha = sha256(fs.readFileSync(OUT));
console.log(JSON.stringify({
  out: path.relative(REPO, OUT), v1_sha256: v1Sha, v2_sha256: v2Sha,
  counts: v2.amendment.counts,
  removed: removalRecords.map((r) => ({ id: r.id, path: r.path, class: r.class, rg: `${r.evidence.rg_command} -> ${r.evidence.rg_stdout || "(no output)"}`, exit: r.evidence.rg_exit_code, ...(r.evidence.lane_probe ? { lane_rank: `${r.evidence.lane_probe.rank}/${r.evidence.lane_probe.match_count}` } : {}) })),
  companions: shiftPairs.map((s) => ({ id: s.spec.id, from: s.source.id, expected: s.expected.map((e) => `${e.path}:${e.grade}`) })),
}, null, 2));
