// bench/verification/wave3/lib-verify.mjs
//
// The VERIFIER's own metric + statistics implementations for wave 3. Written
// from the documented definitions (docs/wave3/W3-01, W3-02, W3-03 and
// bench/judgments/wave2-bars.json), NOT imported from the author's scorer, so
// that an author arithmetic error cannot reproduce itself in the check.
//
// Deliberate implementation differences from bench/wave3/lib/stats.mjs:
//   * PRNG: splitmix64, not mulberry32 (an independent resample stream)
//   * a percentile bootstrap CI is computed alongside the BCa CI, and an exact
//     paired sign/permutation p-value for sparse delta vectors
//   * `recall_at_limit_clamped` re-derives the PRE-FIX formula literally:
//     top is sliced to kMax first and only then indexed by k
//
// Both CI methods are reported. The author's claim is about the BCa interval,
// so BCa is the adjudicating statistic; the second method exists to show how
// sensitive the claim is to the choice of statistic.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
export const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const i = ((s.length - 1) * p) / 100;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
export const rel = (root) => (p) =>
  path.isAbsolute(p) ? path.relative(root, p).replace(/\\/g, "/") : p;

// ------------------------------------------------------------------ scorer
// Frozen wave-1/wave-2 metric definitions. `expected` = [{path, grade}].
export function scoreQuery(retrieved, expected, kMax = 10) {
  const grades = new Map(expected.map((e) => [e.path, e.grade]));
  const top = retrieved.slice(0, kMax).map((p, i) => ({ rank: i + 1, path: p, grade: grades.get(p) ?? 0 }));
  const rel1 = expected.filter((e) => e.grade >= 1).map((e) => e.path);
  const rel2 = expected.filter((e) => e.grade >= 2).map((e) => e.path);
  const set1 = new Set(rel1);
  const set2 = new Set(rel2);
  const inTop = (k, set) => top.slice(0, k).filter((r) => set.has(r.path)).length;
  const firstRank = (min) => top.find((x) => x.grade >= min)?.rank ?? null;
  const gain = (g) => Math.pow(2, g) - 1;
  const dcg = (list) => list.reduce((a, r, i) => a + gain(r.grade) / Math.log2(i + 2), 0);
  const ideal = [...expected.map((e) => e.grade)].sort((a, b) => b - a).map((g) => ({ grade: g }));
  const idcg = dcg(ideal);
  return {
    recall_at_1: rel1.length ? inTop(1, set1) / rel1.length : null,
    recall_at_3: rel1.length ? inTop(3, set1) / rel1.length : null,
    recall_at_5: rel1.length ? inTop(5, set1) / rel1.length : null,
    recall_at_10: rel1.length ? inTop(10, set1) / rel1.length : null,
    success_recall_at_10: rel2.length ? inTop(10, set2) / rel2.length : null,
    mrr_at_10_rel1: firstRank(1) ? 1 / firstRank(1) : 0,
    mrr_at_10_rel2: firstRank(2) ? 1 / firstRank(2) : 0,
    ndcg_at_10: idcg > 0 ? dcg(top) / idcg : null,
    top1_grade: top[0]?.grade ?? 0,
    reformulation_signal: (top[0]?.grade ?? 0) < 2,
    // FIXED (#47): the whole returned list.
    recall_at_limit: rel1.length ? retrieved.filter((p) => set1.has(p)).length / rel1.length : null,
    // PRE-FIX (#47) formula re-derived literally: slice to kMax, then "up to
    // retrieved.length" (a no-op on the already-sliced list).
    recall_at_limit_clamped: rel1.length
      ? top.slice(0, retrieved.length).filter((r) => set1.has(r.path)).length / rel1.length
      : null,
    missing_expected: [...set1].filter((p) => !retrieved.includes(p)),
  };
}

// ------------------------------------------------------------- aggregates
export function laneAgg(rows, lane) {
  const g = rows.filter((r) => r.lane === lane && r.must_hit && !r.negative && !r.excluded_from_tier_l);
  const m = (fn) => mean(g.map(fn).filter((v) => v !== null && v !== undefined));
  return {
    n: g.length,
    recall10: m((r) => r.score.recall_at_10),
    recall3: m((r) => r.score.recall_at_3),
    success3: m((r) => r.score.recall_at_3), // frozen scorer spells success3 = recall@3 (same rel set)
    success10: m((r) => r.score.success_recall_at_10),
    mrr10: m((r) => r.score.mrr_at_10_rel1),
    ndcg10: m((r) => r.score.ndcg_at_10),
    zero_result_rate: g.length ? g.filter((r) => r.retrieved.length === 0).length / g.length : null,
    fp_rate: (() => {
      const neg = rows.filter((r) => r.lane === lane && r.negative);
      return neg.length ? neg.filter((r) => r.retrieved.length > 0).length / neg.length : null;
    })(),
  };
}

// The 18 Tier-L bars, recomputed from rows with the documented predicates.
export function evaluateBars(rows) {
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const a = {};
  for (const lane of ["symbol-ast", "semantic-paraphrase", "ranking-signal", "control"]) {
    a[lane] = laneAgg(rows, lane);
  }
  const r03 = byId.RS03?.retrieved ?? [];
  const r04 = byId.RS04?.retrieved ?? [];
  const firstSrc = (list) => {
    const i = list.findIndex((p) => p.startsWith("src/"));
    return i < 0 ? null : i + 1;
  };
  const nearOrderDiffers = JSON.stringify(r03) !== JSON.stringify(r04);
  // Frozen predicate (score-wave2.mjs): RS03 only. RS04's `near` is a test file,
  // so its first src/ file is rank 3 by design; the bar is named for the pair
  // but its check is the primary-side one.
  const nearPeerRank1 = firstSrc(r03) === 1;
  const checks = {
    "symbol-ast": [
      ["zero_result_rate_max", "le", a["symbol-ast"].zero_result_rate, 0],
      ["false_positive_rate_max", "le", a["symbol-ast"].fp_rate, 0],
      ["recall10_min", "ge", a["symbol-ast"].recall10, 0.78],
      ["success3_min", "ge", a["symbol-ast"].success3, 0.78],
      ["mrr10_min", "ge", a["symbol-ast"].mrr10, 0.78],
    ],
    "semantic-paraphrase": [
      ["zero_result_rate_max", "le", a["semantic-paraphrase"].zero_result_rate, 0],
      ["false_positive_rate_max", "le", a["semantic-paraphrase"].fp_rate, 0],
      ["recall10_min", "ge", a["semantic-paraphrase"].recall10, 0.1],
      ["top3_doc_share_max", "le", null, 0.67], // computed separately below
    ],
    "ranking-signal": [
      ["exact_recall10", "is", byId.RS01?.score.recall_at_10, 1],
      ["glob_set_completeness", "is", byId.RS02?.score.recall_at_limit, 1],
      ["false_positive_rate_max", "le", a["ranking-signal"].fp_rate, 0],
      ["near_pair_order_differs", "is", nearOrderDiffers, true],
      ["near_same_folder_peer_rank1", "is", nearPeerRank1, true],
    ],
    control: [
      ["recall10", "is", a.control.recall10, 1],
      ["zero_result_rate", "is", a.control.zero_result_rate, 0],
      ["ndcg10_min", "ge", a.control.ndcg10, 0.9],
      ["mrr10_min", "ge", a.control.mrr10, 0.9],
    ],
  };
  // top3_doc_share: docs in top3 / min(3, results) over gated semantic rows.
  const semGated = rows.filter((r) => r.lane === "semantic-paraphrase" && r.must_hit && !r.negative && !r.excluded_from_tier_l);
  const isDoc = (p) => /(^|\/)(README|CHANGELOG|CONTRIBUTING|NOTICE)(\.|$)|^docs\//.test(p);
  const shares = semGated
    .filter((r) => r.retrieved.length > 0)
    .map((r) => r.retrieved.slice(0, 3).filter(isDoc).length / Math.min(3, r.retrieved.length));
  checks["semantic-paraphrase"][3][2] = mean(shares);
  const bars = [];
  for (const [lane, list] of Object.entries(checks)) {
    for (const [bar, op, observed, expected] of list) {
      const pass = observed === null || observed === undefined ? null : op === "le" ? observed <= expected : op === "ge" ? observed >= expected : observed === expected;
      bars.push({ lane, bar, op, expected, observed, pass });
    }
  }
  return bars;
}

// ------------------------------------------------------------ statistics
function splitmix64(seed) {
  let s = BigInt(seed >>> 0);
  const M = (1n << 64n) - 1n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    z = z ^ (z >> 31n);
    return Number(z >> 11n) / Number(1n << 53n);
  };
}

const ncdf = (x) => {
  // Abramowitz & Stegun 7.1.26 via erf, independent of the author's poly.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
};
const nquantile = (p) => {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - 0.02425) return -nquantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

export function bca63(values, iters = 10000, seed = 20261015) {
  // The author's parameters (10k, seed) with my own PRNG: an independent draw.
  const n = values.length;
  if (n < 3) return { ci: [NaN, NaN], note: `n=${n}: BCa needs >=3` };
  const obs = mean(values);
  const rng = splitmix64(seed);
  const boots = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[Math.floor(rng() * n)];
    boots[i] = s / n;
  }
  const sorted = [...boots].sort((x, y) => x - y);
  const below = boots.filter((b) => b < obs).length / iters;
  const z0 = nquantile(Math.min(1 - 1e-9, Math.max(1e-9, below)));
  const jk = values.map((_, i) => mean(values.filter((_, k) => k !== i)));
  const jkMean = mean(jk);
  const num = jk.reduce((x, v) => x + Math.pow(jkMean - v, 3), 0);
  const den = 6 * Math.pow(jk.reduce((x, v) => x + Math.pow(jkMean - v, 2), 0), 1.5);
  const acc = den === 0 ? 0 : num / den;
  const adj = (alpha) => ncdf(z0 + (z0 + nquantile(alpha)) / (1 - acc * (z0 + nquantile(alpha))));
  return { ci: [pct(sorted, 100 * adj(0.025)), pct(sorted, 100 * adj(0.975))] };
}

/** Percentile bootstrap CI — reported next to BCa to expose statistic choice. */
export function pctBootCI(values, iters = 10000, seed = 20261015) {
  const n = values.length;
  if (n < 3) return [NaN, NaN];
  const rng = splitmix64(seed ^ 0x5eed);
  const boots = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[Math.floor(rng() * n)];
    boots[i] = s / n;
  }
  const sorted = [...boots].sort((x, y) => x - y);
  return [pct(sorted, 2.5), pct(sorted, 97.5)];
}

/** Exact two-sided paired sign test on the non-zero deltas. */
export function signTest(deltas) {
  const nz = deltas.filter((d) => Math.abs(d) > 1e-12);
  const pos = nz.filter((d) => d > 0).length;
  const neg = nz.length - pos;
  if (nz.length === 0) return { n: 0, pos, neg, p: 1 };
  const k = Math.min(pos, neg);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += combo(nz.length, i);
  const p = Math.min(1, (2 * tail) / Math.pow(2, nz.length));
  return { n: nz.length, pos, neg, p };
}
function combo(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

export function excludesZero([lo, hi]) {
  return Number.isFinite(lo) && Number.isFinite(hi) && (lo > 0 || hi < 0);
}

/** Paired metric comparison across two artifacts, scored by THIS file. */
export function pairedMetric(beforeRows, afterRows, key, label) {
  const afterById = Object.fromEntries(afterRows.map((r) => [r.id, r]));
  const vals = [];
  for (const b of beforeRows) {
    const a = afterById[b.id];
    if (!a) continue;
    if (!(b.must_hit && !b.negative && a.must_hit && !a.negative)) continue;
    const vb = b.score[key];
    const va = a.score[key];
    if (vb === null || va === null || vb === undefined || va === undefined) continue;
    vals.push({ id: b.id, before: vb, after: va, delta: va - vb });
  }
  const deltas = vals.map((v) => v.delta);
  const bca = bca63(deltas);
  const boot = pctBootCI(deltas);
  const sign = signTest(deltas);
  return {
    metric: key,
    label,
    n: vals.length,
    before: mean(vals.map((v) => v.before)),
    after: mean(vals.map((v) => v.after)),
    delta: mean(deltas),
    ci95_bca: bca.ci,
    ci95_pct_boot: boot,
    ci_method: "BCa, 10000 resamples, splitmix64 seed 20261015 (verifier PRNG)",
    sign_test: sign,
    excludes_zero_bca: excludesZero(bca.ci),
    excludes_zero_pct: excludesZero(boot),
    moved: vals.filter((v) => Math.abs(v.delta) > 1e-12),
  };
}

/** Rate-style metric (0/1 per row), e.g. reformulation_signal. */
export function pairedRate(beforeRows, afterRows, key, label) {
  const afterById = Object.fromEntries(afterRows.map((r) => [r.id, r]));
  const vals = [];
  for (const b of beforeRows) {
    const a = afterById[b.id];
    if (!a || !(b.must_hit && !b.negative && a.must_hit && !a.negative)) continue;
    const vb = b.score[key] ? 1 : 0;
    const va = a.score[key] ? 1 : 0;
    vals.push({ id: b.id, before: vb, after: va, delta: va - vb });
  }
  const deltas = vals.map((v) => v.delta);
  return {
    metric: key,
    label,
    n: vals.length,
    before: mean(vals.map((v) => v.before)),
    after: mean(vals.map((v) => v.after)),
    delta: mean(deltas),
    ci95_bca: bca63(deltas).ci,
    ci95_pct_boot: pctBootCI(deltas),
    sign_test: signTest(deltas),
    excludes_zero_bca: excludesZero(bca63(deltas).ci),
    excludes_zero_pct: excludesZero(pctBootCI(deltas)),
    moved: vals.filter((v) => Math.abs(v.delta) > 1e-12),
  };
}
