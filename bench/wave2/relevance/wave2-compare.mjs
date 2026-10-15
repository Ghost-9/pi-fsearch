// bench/wave2/relevance/wave2-compare.mjs
// Paired before/after analysis for the wave-2 judgment set: per-lane ΔnDCG@10
// with a seeded BCa bootstrap CI (10k), Tier-L gate evaluation (excluding
// known_fail / feature-gated rows as the bars specify), and the Tier-C claim
// test (Δ >= +0.05, CI excludes 0, no lane regressing > 0.02).
//
//   node bench/wave2/relevance/wave2-compare.mjs \
//     bench/results/wave2/relevance/wave2-wave2-before.json \
//     bench/results/wave2/relevance/wave2-wave2-after.json
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT_DIR = path.join(REPO, "bench/results/wave2/relevance");
const beforePath = process.argv[2] ?? path.join(OUT_DIR, "wave2-wave2-before.json");
const afterPath = process.argv[3] ?? path.join(OUT_DIR, "wave2-wave2-after.json");

const KNOWN_FAIL = new Set(["SY03", "SY04", "RS09"]);
const FEATURE_GATED = new Set(["RS05", "RS06", "RS07"]); // frecency/git precondition (F12)
const EXCLUDED_TIER_L = new Set([...KNOWN_FAIL, ...FEATURE_GATED]);

const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
const q = (doc) => new Map(doc.queries.map((r) => [r.id, r]));

// ------------------------------------------------------------- statistics
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Acklam's inverse normal CDF. */
function qnorm(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) {
    const t = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1);
  }
  if (p > 1 - pl) return -qnorm(1 - p);
  const t = p - 0.5;
  const r = t * t;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * t) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function erf(x) {
  const s = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}
function pnorm(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Seeded BCa bootstrap CI of the mean of paired differences. */
function bcaCI(deltas, { iters = 10000, seed = 20261015 } = {}) {
  const n = deltas.length;
  if (n < 2) return { mean: mean(deltas), ci95: [NaN, NaN], n };
  const theta = mean(deltas);
  const rng = mulberry32(seed);
  const boot = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += deltas[Math.floor(rng() * n)];
    boot[i] = s / n;
  }
  boot.sort((a, b) => a - b);
  const below = boot.filter((x) => x < theta).length;
  const z0 = qnorm(Math.min(1 - 1e-9, Math.max(1e-9, below / iters)));
  const jk = deltas.map((_, i) => mean(deltas.filter((_, j) => j !== i)));
  const jkMean = mean(jk);
  const num = jk.reduce((s, x) => s + (jkMean - x) ** 3, 0);
  const den = 6 * Math.sqrt(jk.reduce((s, x) => s + (jkMean - x) ** 2, 0) ** 3);
  const acc = den === 0 ? 0 : num / den;
  const zl = qnorm(0.025);
  const zu = qnorm(0.975);
  const adj = (z) => pnorm(z0 + (z0 + z) / (1 - acc * (z0 + z)));
  const clamp = (i) => Math.max(0, Math.min(iters - 1, i));
  const lo = boot[clamp(Math.floor(adj(zl) * iters))];
  const hi = boot[clamp(Math.floor(adj(zu) * iters))];
  return { mean: theta, ci95: [lo, hi], n };
}

// --------------------------------------------------------------- pairing
const mb = q(before);
const ma = q(after);
const lanes = [...new Set(after.queries.map((r) => r.lane))];
const report = { schema: "ultrasearch.wave2-compare/v1", created: new Date().toISOString(), before: { file: beforePath, label: before.meta.label, status: before.meta.status }, after: { file: afterPath, label: after.meta.label, status: after.meta.status }, lanes: {} };

for (const lane of lanes) {
  const rowsAfter = after.queries.filter((r) => r.lane === lane);
  const rowsBefore = before.queries.filter((r) => r.lane === lane);
  const ids = rowsAfter.filter((r) => r.score).map((r) => r.id);
  const deltas = { ndcg: [], recall10: [], success3: [], mrr: [] };
  const perQuery = [];
  for (const id of ids) {
    const a = ma.get(id);
    const b = mb.get(id);
    if (!a?.score || !b?.score) continue;
    const d = {
      ndcg: a.score.ndcg_at_10 - b.score.ndcg_at_10,
      recall10: (a.score.recall_at_10 ?? 0) - (b.score.recall_at_10 ?? 0),
      success3: (a.score.success_recall_at_3 ?? 0) - (b.score.success_recall_at_3 ?? 0),
      mrr: a.score.mrr_at_10 - b.score.mrr_at_10,
    };
    for (const k of Object.keys(deltas)) deltas[k].push(d[k]);
    perQuery.push({ id, ...d, after_ndcg: a.score.ndcg_at_10, before_ndcg: b.score.ndcg_at_10 });
  }
  const tierL = rowsAfter.filter((r) => !EXCLUDED_TIER_L.has(r.id));
  const must = tierL.filter((r) => !r.negative && (r.must_hit || r.score));
  const negs = tierL.filter((r) => r.negative);
  const excludedZero = rowsAfter.filter((r) => EXCLUDED_TIER_L.has(r.id) && r.zero_result).map((r) => r.id);
  // Absolute per-lane estimates with n and seeded bootstrap CI of the mean.
  const ciMean = (vals) => {
    const clean = vals.filter((v) => v != null);
    if (clean.length < 2) return { n: clean.length, mean: mean(clean), ci95: [NaN, NaN] };
    const rng = mulberry32(20261015 + lane.length * 97);
    const B = 5000;
    const draws = new Array(B);
    for (let i = 0; i < B; i++) {
      let acc = 0;
      for (let j = 0; j < clean.length; j++) acc += clean[Math.floor(rng() * clean.length)];
      draws[i] = acc / clean.length;
    }
    draws.sort((a, b) => a - b);
    return { n: clean.length, mean: mean(clean), ci95: [draws[Math.floor(B * 0.025)], draws[Math.floor(B * 0.975)]] };
  };
  const binom = (k, n) => (n ? k / n : null);
  const laneMust = rowsAfter.filter((r) => !r.negative && (r.must_hit || r.score));
  const laneNeg = rowsAfter.filter((r) => r.negative);
  const zeroN = laneMust.length;
  const zeroK = laneMust.filter((r) => r.zero_result).length;
  report.lanes[lane] = {
    n: rowsAfter.length,
    absolute_after_ci: {
      recall_at_10: ciMean(rowsAfter.filter((r) => r.score).map((r) => r.score.recall_at_10)),
      ndcg_at_10: ciMean(rowsAfter.filter((r) => r.score).map((r) => r.score.ndcg_at_10)),
      success_recall_at_3: ciMean(rowsAfter.filter((r) => r.score).map((r) => r.score.success_recall_at_3)),
      zero_result_rate: { n: zeroN, rate: binom(zeroK, zeroN), ranged: [zeroK, zeroN] },
      false_positive_rate: { n: laneNeg.length, rate: binom(laneNeg.filter((r) => r.false_positive).length, laneNeg.length), ranged: [laneNeg.filter((r) => r.false_positive).length, laneNeg.length] },
    },
    paired_queries: deltas.ndcg.length,
    delta_ndcg: bcaCI(deltas.ndcg),
    delta_recall10: bcaCI(deltas.recall10),
    delta_success3: bcaCI(deltas.success3),
    delta_mrr: bcaCI(deltas.mrr),
    tier_l: {
      zero_result_rate: must.length ? must.filter((r) => r.zero_result).length / must.length : null,
      zero_result_excluded: excludedZero,
      false_positive_rate: negs.length ? negs.filter((r) => r.false_positive).length / negs.length : null,
      recall_at_10: mean(must.map((r) => r.score?.recall_at_10).filter((x) => x != null)),
      success_recall_at_3: mean(must.map((r) => r.score?.success_recall_at_3).filter((x) => x != null)),
    },
    after_metrics: after.aggregates.by_lane[lane],
    before_metrics: before.aggregates.by_lane[lane],
    per_query: perQuery,
  };
}

// ---------------------------------------------------------------- verdicts
const claim = {};
for (const [lane, r] of Object.entries(report.lanes)) {
  const d = r.delta_ndcg;
  const excludesZero = d.ci95[0] > 0 || d.ci95[1] < 0;
  const regress = d.mean <= -0.02;
  claim[lane] = {
    delta_ge_005: d.mean >= 0.05,
    ci_excludes_0: excludesZero,
    no_regression: !regress,
    claim_supported: d.mean >= 0.05 && excludesZero && !regress,
  };
}
report.tier_c = claim;

const outFile = path.join(OUT_DIR, "wave2-compare.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`compare written: ${outFile}\n`);
console.log("| lane | Δndcg [BCa 95%] | Δrecall@10 | Δsuccess@3 | Tier-L zero | Tier-L FP | claim |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
const f = (m) => `${m.mean >= 0 ? "+" : ""}${m.mean.toFixed(3)} [${m.ci95[0].toFixed(3)}, ${m.ci95[1].toFixed(3)}]`;
for (const [lane, r] of Object.entries(report.lanes)) {
  console.log(`| ${lane} | ${f(r.delta_ndcg)} | ${f(r.delta_recall10)} | ${f(r.delta_success3)} | ${r.tier_l.zero_result_rate} | ${r.tier_l.false_positive_rate} | ${claim[lane].claim_supported ? "supported" : "not met"} |`);
}
