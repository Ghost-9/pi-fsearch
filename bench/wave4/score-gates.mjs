#!/usr/bin/env node
// bench/wave4/score-gates.mjs — score the seven advisor gates on the v2 judgment
// set with the shared scorer, side-by-side with v1, and write the evidence file.
//
//   node bench/wave4/score-gates.mjs --v1 <artifact.json> --v2 <artifact.json> \
//        [--out bench/wave4/gates-v2.json]
//
// Both artifacts are measured on the SAME isolated daemon over the frozen
// wave-1 corpus (bench/wave4/run-gates.sh does the orchestration). Everything
// here is re-derived from the raw `retrieved` arrays with
// bench/verification/checks/scoring.mjs — the same definitions the wave-3
// verifier re-scored with — and the re-score must agree with the values the
// measurement wrote; a mismatch is a hard error, not a rounding note.
//
// Gates (docs/wave1 acceptance, as confirmed by the wave-3 verifier):
//   1 recall@10 == 1.00 (all must-hit rows)
//   2 nDCG@10 >= 0.75 overall
//   3 nDCG@10 >= 0.60 semantic lane
//   4 zero-result rate == 0.00 (must-hit rows)
//   5 false-positive rate == 0.00 (negative rows)
//   6 reformulation overall <= 0.20 (share of rows whose top-1 grade < 2)
//   7 reformulation <= 0.35 per lane

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeScoreQuery } from "../verification/checks/scoring.mjs";
import { bca63, pctBootCI, signTest } from "../verification/wave3/lib-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = path.resolve(REPO, opt("out", "bench/wave4/gates-v2.json"));
const V1_ART = path.resolve(REPO, opt("v1", "bench/wave4/results/v1.json"));
const V2_ART = path.resolve(REPO, opt("v2", "bench/wave4/results/v2.json"));

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const sha256Text = (s) => crypto.createHash("sha256").update(s).digest("hex");
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (x, n = 6) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(n)) : x);

const v1Art = load(V1_ART);
const v2Art = load(V2_ART);
const v1SetPath = path.join(REPO, "bench", "judgments", "wave1-judgments.json");
const v2SetPath = path.join(REPO, "bench", "judgments", "wave1-judgments.v2.json");
const v1Set = load(v1SetPath);
const v2Set = load(v2SetPath);

// ------------------------------------------------------- integrity checks
const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
};
for (const [name, art, setPath] of [["v1", v1Art, v1SetPath], ["v2", v2Art, v2SetPath]]) {
  const actual = sha256(setPath);
  if (art.meta?.judgments?.sha256 !== actual) fail(`${name} artifact was measured against a different judgment set (${art.meta?.judgments?.sha256} != ${actual})`);
}
if (v1Art.meta?.engine?.sha256 !== v2Art.meta?.engine?.sha256) fail("the two arms used different engines; the side-by-side would not be one arm");
if (v1Art.meta?.corpus?.tree_sha256 !== v2Art.meta?.corpus?.tree_sha256) fail("the two arms used different corpora");

// ------------------------------------------------------- re-score
const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
const scoreQuery = makeScoreQuery(norm);
const scoreArtifact = (art, set) => {
  const byId = Object.fromEntries(set.queries.map((q) => [q.id, q]));
  const mismatches = [];
  const rows = art.rows.map((r) => {
    const q = byId[r.id];
    const expected = (q?.expected ?? []).map((e) => ({ path: norm(e.path), grade: e.grade }));
    const score = scoreQuery(r.retrieved.map(norm), expected);
    for (const key of ["recall_at_10", "ndcg_at_10", "mrr_at_10_rel1", "success_recall_at_10"]) {
      const stored = r.score?.[key] ?? null;
      const mine = score[key] ?? null;
      if (stored === null ? mine !== null : Math.abs(stored - mine) > 1e-9) mismatches.push({ id: r.id, key, stored, rescored: mine });
    }
    return { id: r.id, lane: r.lane, query: r.query, must_hit: r.must_hit === true, negative: r.negative === true, retrieved: r.retrieved.map(norm), call: r.call, source: r.source, ms: r.ms, zero_result: r.retrieved.length === 0, score };
  });
  if (mismatches.length) fail(`${art === v1Art ? "v1" : "v2"} re-score disagrees with the stored scores: ${JSON.stringify(mismatches.slice(0, 5))}`);
  return { rows, byId, mismatches: 0 };
};
const v1 = scoreArtifact(v1Art, v1Set);
const v2 = scoreArtifact(v2Art, v2Set);

// ------------------------------------------------------- gate evaluation
const mustHit = (rs) => rs.filter((r) => r.must_hit && !r.negative);
const negatives = (rs) => rs.filter((r) => r.negative === true);
const ci = (values) => (values.length >= 3 ? { bca: bca63(values).ci.map((v) => round(v)), pct: pctBootCI(values).map((v) => round(v)) } : null);
const rate = (rows, pred) => (rows.length ? rows.filter(pred).length / rows.length : null);

/** One gate, scored identically on both sets. */
function gatesFor(rows, label, set) {
  const mh = mustHit(rows);
  const neg = negatives(rows);
  const expectedById = Object.fromEntries(set.queries.map((q) => [q.id, (q.expected ?? []).map((e) => ({ path: norm(e.path), grade: e.grade }))]));
  const recall = mh.map((r) => r.score.recall_at_10).filter((v) => v !== null);
  const ndcg = mh.map((r) => r.score.ndcg_at_10).filter((v) => v !== null);
  const sem = mh.filter((r) => r.lane === "semantic");
  const reform = mh.map((r) => (r.score.reformulation_signal ? 1 : 0));
  const lanes = [...new Set(mh.map((r) => r.lane))];
  return {
    label,
    n_must_hit: mh.length,
    n_negative: neg.length,
    g1_recall10: {
      threshold: "== 1.00", observed: round(mean(recall)), pass: recall.length > 0 && recall.every((v) => v === 1),
      n: recall.length, failing_rows: mh.filter((r) => r.score.recall_at_10 !== 1).map((r) => ({ id: r.id, lane: r.lane, recall_at_10: round(r.score.recall_at_10), missing: (expectedById[r.id] ?? []).filter((e) => !r.score.top10.some((t) => t.path === e.path)).map((e) => `${e.path}:${e.grade}`) })),
    },
    g2_ndcg10_overall: { threshold: ">= 0.75", observed: round(mean(ndcg)), pass: mean(ndcg) !== null && mean(ndcg) >= 0.75, n: ndcg.length, ci95_over_rows: ci(ndcg) },
    g3_ndcg10_semantic: { threshold: ">= 0.60", observed: round(mean(sem.map((r) => r.score.ndcg_at_10))), pass: sem.length > 0 && sem.every((r) => r.score.ndcg_at_10 !== null) && mean(sem.map((r) => r.score.ndcg_at_10)) >= 0.6, n: sem.length, ci95_over_rows: ci(sem.map((r) => r.score.ndcg_at_10)) },
    g4_zero_result_rate: { threshold: "== 0.00", observed: round(rate(mh, (r) => r.zero_result)), pass: mh.length > 0 && mh.every((r) => !r.zero_result), n: mh.length, failing_rows: mh.filter((r) => r.zero_result).map((r) => r.id) },
    g5_false_positive_rate: { threshold: "== 0.00", observed: round(rate(neg, (r) => r.retrieved.length > 0)), pass: neg.length > 0 && neg.every((r) => r.retrieved.length === 0), n: neg.length, failing_rows: neg.filter((r) => r.retrieved.length > 0).map((r) => r.id) },
    g6_reformulation_overall: { threshold: "<= 0.20", observed: round(mean(reform)), pass: reform.length > 0 && mean(reform) <= 0.2, n: reform.length, ci95_over_rows: ci(reform), failing_rows: mh.filter((r) => r.score.reformulation_signal).map((r) => r.id) },
    g7_reformulation_per_lane: {
      threshold: "<= 0.35 per lane",
      pass: lanes.every((l) => rate(mh.filter((r) => r.lane === l), (r) => r.score.reformulation_signal) <= 0.35),
      lanes: Object.fromEntries(lanes.map((l) => {
        const rs = mh.filter((r) => r.lane === l);
        const vals = rs.map((r) => (r.score.reformulation_signal ? 1 : 0));
        return [l, { n: rs.length, observed: round(mean(vals)), pass: mean(vals) <= 0.35, ci95_over_rows: vals.length >= 5 ? ci(vals) : null, rows: rs.filter((r) => r.score.reformulation_signal).map((r) => r.id) }];
      })),
    },
  };
}

const gV1 = gatesFor(v1.rows, "v1-as-written", v1Set);
const gV2 = gatesFor(v2.rows, "v2-amended", v2Set);

// ------------------------------------------------------- amendment neutrality
const v2ById = Object.fromEntries(v2.rows.map((r) => [r.id, r]));
const shared = v1.rows.filter((r) => v2ById[r.id]);
const neutrality = {
  shared_rows: shared.length,
  retrieved_identical: shared.every((r) => JSON.stringify(r.retrieved) === JSON.stringify(v2ById[r.id].retrieved)),
  calls_identical: shared.every((r) => r.call === v2ById[r.id].call),
  sources_identical: shared.every((r) => r.source === v2ById[r.id].source),
  changed_rows: shared.filter((r) => JSON.stringify(r.retrieved) !== JSON.stringify(v2ById[r.id].retrieved)).map((r) => r.id),
  note: "the amendment changes expectations only: every shared row's call, source and retrieved list must be bit-identical between the two arms",
};

// ------------------------------------------------------- paired v1 -> v2 (per query id)
const pairedById = (key, mapper) => {
  const vals = [];
  for (const r1 of v1.rows) {
    const r2 = v2ById[r1.id];
    if (!r2 || !(r1.must_hit && !r1.negative) || !(r2.must_hit && !r2.negative)) continue;
    const a = mapper(r1.score);
    const b = mapper(r2.score);
    if (a === null || b === null) continue;
    vals.push({ id: r1.id, v1: a, v2: b, delta: b - a });
  }
  const deltas = vals.map((v) => v.delta);
  const unchangedIds = new Set(Object.keys(v1.byId).filter((id) => {
    const q1 = v1Set.queries.find((q) => q.id === id);
    const q2 = v2Set.queries.find((q) => q.id === id);
    return q1 && q2 && JSON.stringify(q1.expected ?? []) === JSON.stringify(q2.expected ?? []);
  }));
  const unchanged = vals.filter((v) => unchangedIds.has(v.id)).map((v) => v.delta);
  return {
    n: vals.length, v1: round(mean(vals.map((v) => v.v1))), v2: round(mean(vals.map((v) => v.v2))), delta: round(mean(deltas)),
    ci95_bca_delta: deltas.length >= 3 ? bca63(deltas).ci.map((v) => round(v)) : null,
    ci95_pct_delta: deltas.length >= 3 ? pctBootCI(deltas).map((v) => round(v)) : null,
    sign_test: signTest(deltas),
    unchanged_rows: { n: unchanged.length, delta_max_abs: round(Math.max(0, ...unchanged.map((d) => Math.abs(d))), 12) },
    moved: vals.filter((v) => Math.abs(v.delta) > 1e-12).map((v) => ({ id: v.id, v1: round(v.v1), v2: round(v.v2), delta: round(v.delta) })),
    method: "paired by query id; the row is scored under its own set's expectations in each arm, so for the 9 amended rows the delta is the amendment effect and for the unchanged rows it must be exactly 0",
  };
};
const paired = {
  ndcg_at_10: pairedById("ndcg_at_10", (s) => s.ndcg_at_10),
  recall_at_10: pairedById("recall_at_10", (s) => s.recall_at_10),
  reformulation_signal: pairedById("reformulation_signal", (s) => (s.reformulation_signal ? 1 : 0)),
};

// ------------------------------------------------------- strict alternative
// Restore every `content-mention-not-top10` removal to the companion that
// re-homes its source query and re-score. This is the number a reader gets by
// treating the window removal as a must-hit; it is reported so the gate cannot
// be read without it.
const strictRestorations = [];
const strictRows = v2.rows.map((r) => {
  const q = v2Set.queries.find((x) => x.id === r.id);
  // Restore only to the companion that re-homes the source query; the source
  // row's lane cannot match the file (that is why it was moved).
  const removedForSource = (v2Set.removed ?? []).filter((x) => x.class === "content-mention-not-top10" && q?.rehomed_from?.id === x.id);
  if (!removedForSource.length) return { ...r, score: r.score, strictScore: r.score };
  const expected = [...(q.expected ?? []), ...removedForSource.map((x) => ({ path: x.path, grade: x.grade }))];
  const strictScore = scoreQuery(r.retrieved, expected.map((e) => ({ path: norm(e.path), grade: e.grade })));
  strictRestorations.push({ row: r.id, restored: removedForSource.map((x) => `${x.path}:${x.grade}`), recall_at_10: round(strictScore.recall_at_10), missing: expected.filter((e) => !strictScore.top10.some((t) => t.path === norm(e.path))).map((e) => `${e.path}:${e.grade}`) });
  return { ...r, score: strictScore, strictScore };
});
const strictRecall = mean(mustHit(strictRows).map((r) => r.score.recall_at_10).filter((v) => v !== null));
const strictAlternative = {
  definition: "v2 with every `content-mention-not-top10` removal restored to the must-hit set",
  restored: strictRestorations,
  recall10: round(strictRecall),
  gate1_passes: mustHit(strictRows).every((r) => r.score.recall_at_10 === 1),
  note: "reported so the seventh gate is never read without it; it does not change the v2 gate value",
};

// ------------------------------------------------------- environment + evidence
const gateOf = (art) => ({ status: art.meta?.status ?? null, gate_pass: art.meta?.gate?.gate_pass ?? null, load1: art.meta?.gate?.load1 ?? null, on_ac: art.meta?.gate?.on_ac ?? null, competing: art.meta?.gate?.competing_processes ?? null, measured_at: art.meta?.generated_at ?? null });
const environment = {
  status: v1Art.meta?.status === "final" && v2Art.meta?.status === "final" ? "final" : "provisional",
  rule: "each arm records AC + load1 < 1.5 + no cargo/rustc; anything else is provisional and the claims are provisional until the independent verifier round",
  arms: { v1: gateOf(v1Art), v2: gateOf(v2Art) },
  isolated_daemon: { v1: v1Art.meta?.daemon_provenance?.socket ?? null, v2: v2Art.meta?.daemon_provenance?.socket ?? null, single_socket_owner: { v1: v1Art.meta?.daemon_provenance?.single_socket_owner ?? null, v2: v2Art.meta?.daemon_provenance?.single_socket_owner ?? null } },
  host_loadavg_at_score: os.loadavg().map((v) => round(v, 2)),
  PI_ULTRASEARCH_TEST: process.env.PI_ULTRASEARCH_TEST ?? null,
};
const evidence = {
  v1_judgments: { path: "bench/judgments/wave1-judgments.json", sha256: sha256(v1SetPath), byte_identical_to_recorded: sha256(v1SetPath) === v2Set.supersedes.sha256 },
  v2_judgments: { path: "bench/judgments/wave1-judgments.v2.json", sha256: sha256(v2SetPath) },
  v1_artifact: { path: path.relative(REPO, V1_ART), sha256: sha256(V1_ART), engine: v1Art.meta?.engine?.sha256 ?? null, head: v1Art.meta?.head_commit ?? null },
  v2_artifact: { path: path.relative(REPO, V2_ART), sha256: sha256(V2_ART), engine: v2Art.meta?.engine?.sha256 ?? null, head: v2Art.meta?.head_commit ?? null },
  corpus: { root: v1Art.meta?.corpus?.root ?? null, tree_sha256: v1Art.meta?.corpus?.tree_sha256 ?? null, files: v1Art.meta?.corpus?.files ?? null },
  scorer: { path: "bench/verification/checks/scoring.mjs", sha256: sha256(path.join(REPO, "bench", "verification", "checks", "scoring.mjs")) },
  validator: { path: "bench/wave4/validate-judgments.mjs", sha256: sha256(path.join(HERE, "validate-judgments.mjs")) },
  amendment_table: { path: "bench/wave4/amendment.mjs", sha256: sha256(path.join(HERE, "amendment.mjs")) },
  companion_probe: { path: "bench/wave4/companion-probe.json", sha256: sha256(path.join(HERE, "companion-probe.json")) },
  audit: { path: "bench/wave3/results/final-expectation-audit.json", sha256: sha256(path.join(REPO, "bench", "wave3", "results", "final-expectation-audit.json")) },
};
void sha256Text;

const allGreen = [gV2.g1_recall10, gV2.g2_ndcg10_overall, gV2.g3_ndcg10_semantic, gV2.g4_zero_result_rate, gV2.g5_false_positive_rate, gV2.g6_reformulation_overall, gV2.g7_reformulation_per_lane].every((g) => g.pass === true);

const v1AuditPath = path.join(REPO, "bench", "wave4", "results", "v1-expectation-audit.json");
const v1Audited = fs.existsSync(v1AuditPath)
  ? (() => { const a = load(v1AuditPath); return { artifact: path.relative(REPO, v1AuditPath), sha256: sha256(v1AuditPath), reported_recall_at_10: round(a.summary.reported_recall_at_10), audited_recall_at_10: round(a.summary.audited_recall_at_10), unreachable_by_class: a.summary.by_class, note: "the wave-3 audit re-run against this run's v1 artifact: the v1 metric is reported unchanged and its 16 unreachable expectations are attributed" }; })()
  : null;

const out = {
  suite: "wave4-gates",
  generated_at: new Date().toISOString(),
  gates_version: 2,
  judgments: { v1: "bench/judgments/wave1-judgments.json", v2: "bench/judgments/wave1-judgments.v2.json" },
  arms: { v1: gV1, v2: gV2 },
  v1_audited: v1Audited,
  result: { all_seven_green_on_v2: allGreen, green_count_v2: [gV2.g1_recall10, gV2.g2_ndcg10_overall, gV2.g3_ndcg10_semantic, gV2.g4_zero_result_rate, gV2.g5_false_positive_rate, gV2.g6_reformulation_overall, gV2.g7_reformulation_per_lane].filter((g) => g.pass === true).length },
  paired_v1_v2: paired,
  strict_alternative: strictAlternative,
  amendment_neutrality: neutrality,
  environment,
  evidence,
  method: {
    scorer: "bench/verification/checks/scoring.mjs (makeScoreQuery) for both arms; the re-score must equal the measurement's stored scores and does",
    statistics: "BCa 10000 resamples, splitmix64 seed 20261015 (bench/verification/wave3/lib-verify.mjs); percentile bootstrap alongside; exact paired sign test",
    measurement: "bench/wave3/measure.mjs on an isolated daemon (ULTRASEARCH_DIR/HOME/SCAN_ROOT, own socket) over the frozen wave-1 corpus",
    no_tuning: "no threshold was changed and no engine behaviour was altered for this file: the only change is the judgment set, and the amendment is validated against the corpus before scoring",
  },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

const table = (g) => ({
  recall10: g.g1_recall10.observed, ndcg: g.g2_ndcg10_overall.observed, ndcg_sem: g.g3_ndcg10_semantic.observed,
  zero: g.g4_zero_result_rate.observed, fp: g.g5_false_positive_rate.observed, reform: g.g6_reformulation_overall.observed,
  per_lane: Object.fromEntries(Object.entries(g.g7_reformulation_per_lane.lanes).map(([l, v]) => [l, v.observed])),
  pass: { 1: g.g1_recall10.pass, 2: g.g2_ndcg10_overall.pass, 3: g.g3_ndcg10_semantic.pass, 4: g.g4_zero_result_rate.pass, 5: g.g5_false_positive_rate.pass, 6: g.g6_reformulation_overall.pass, 7: g.g7_reformulation_per_lane.pass },
});
console.log(JSON.stringify({ out: path.relative(REPO, OUT), v1: table(gV1), v2: table(gV2), all_seven_green_on_v2: allGreen, strict_alternative_recall10: strictAlternative.recall10, neutrality }, null, 2));
