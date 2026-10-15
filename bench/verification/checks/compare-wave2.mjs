#!/usr/bin/env node
// bench/verification/checks/compare-wave2.mjs — independent verdicts on the wave-2
// relevance claims, from two wave-2 baseline artifacts measured with the same scorer
// and the same client (only the daemon differs).
//
//   node bench/verification/checks/compare-wave2.mjs \
//     --before after/wave2-livewave1daemon.json \
//     --after  after/wave2-baseline.json \
//     --out    after/wave2-claims.json
//
// Computes, per lane: the Tier-L metric blocks on both bases (gated / all must-hit),
// the paired per-query ΔnDCG@10 with a BCa bootstrap CI (10 000 resamples, seeded),
// and a verdict for every claim the relevance wave published.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const AFTER_DIR = path.join(HERE, "..", "after");
const BEFORE = opt("before", path.join(AFTER_DIR, "wave2-livewave1daemon.json"));
const AFTER = opt("after", path.join(AFTER_DIR, "wave2-baseline.json"));
const OUT = opt("out", path.join(AFTER_DIR, "wave2-claims.json"));
const B = Number(opt("boot", 10000));

const before = JSON.parse(fs.readFileSync(BEFORE, "utf8"));
const after = JSON.parse(fs.readFileSync(AFTER, "utf8"));

// ---------------------------------------------------------------- statistics
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sortNum = (a) => [...a].sort((x, y) => x - y);
function percentile(sorted, p) {
  const i = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// Standard normal CDF / inverse (Acklam's approximation) for BCa.
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function nquantile(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -nquantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** BCa bootstrap CI for the mean of `values` (paired differences). */
function bcaCI(values, iters = B, seed = 20261015) {
  const n = values.length;
  if (n < 3) return [NaN, NaN];
  const obs = mean(values);
  const rng = mulberry32(seed);
  const boots = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[Math.floor(rng() * n)];
    boots[i] = s / n;
  }
  const sorted = sortNum(boots);
  const below = boots.filter((b) => b < obs).length / iters;
  const z0 = nquantile(Math.min(1 - 1e-9, Math.max(1e-9, below)));
  const jk = [];
  for (let i = 0; i < n; i++) {
    const rest = values.filter((_, k) => k !== i);
    jk.push(mean(rest));
  }
  const jkMean = mean(jk);
  const num = jk.reduce((a, v) => a + Math.pow(jkMean - v, 3), 0);
  const den = 6 * Math.pow(jk.reduce((a, v) => a + Math.pow(jkMean - v, 2), 0), 1.5);
  const a = den === 0 ? 0 : num / den;
  const adj = (alpha) => {
    const z = nquantile(alpha);
    return ncdf(z0 + (z0 + z) / (1 - a * (z0 + z)));
  };
  return [percentile(sorted, 100 * adj(0.025)), percentile(sorted, 100 * adj(0.975))];
}

// ---------------------------------------------------------------- paired deltas
const rowsOf = (art, lane, pick) => art.rows.filter((r) => r.lane === lane && pick(r));
const metricOf = (r, key) => (key === "recall_at_10" ? r.score.recall_at_10 : r.score.ndcg_at_10);

function paired(lane, pick, key) {
  const b = new Map(rowsOf(before, lane, pick).map((r) => [r.id, r]));
  const deltas = [];
  const detail = [];
  for (const r of rowsOf(after, lane, pick)) {
    const rb = b.get(r.id);
    if (!rb) continue;
    const vb = metricOf(rb, key);
    const va = metricOf(r, key);
    if (vb === null || va === null) continue;
    deltas.push(va - vb);
    detail.push({ id: r.id, before: vb, after: va, delta: va - vb });
  }
  return { n: deltas.length, mean_delta: deltas.length ? mean(deltas) : null, ci95_bca: bcaCI(deltas), detail };
}

const mustHit = (r) => r.must_hit && !r.negative;
const mustHitAnswerable = (r) => mustHit(r) && !r.requires_feature && !r.known_fail;
const negatives = (r) => r.negative;

const lanes = ["symbol-ast", "semantic-paraphrase", "ranking-signal", "control"];
const perLane = {};
for (const lane of lanes) {
  perLane[lane] = {
    all_before: before.aggregates[lane]?.all ?? null,
    all_after: after.aggregates[lane]?.all ?? null,
    gated_before: before.aggregates[lane]?.gated ?? null,
    gated_after: after.aggregates[lane]?.gated ?? null,
    paired_ndcg10_answrable: paired(lane, mustHitAnswerable, "ndcg_at_10"),
    paired_ndcg10_all: paired(lane, mustHit, "ndcg_at_10"),
    paired_recall10_all: paired(lane, mustHit, "recall_at_10"),
    fp_before: before.aggregates[lane]?.fp_rate ?? null,
    fp_after: after.aggregates[lane]?.fp_rate ?? null,
    tier_l_bars_after: (after.bars?.[lane] ?? []).map((b) => ({ bar: b.bar, expected: b.expected, observed: b.observed, pass: b.pass })),
  };
}

// ---------------------------------------------------------------- claims
const SEM = perLane["semantic-paraphrase"];
const SYM = perLane["symbol-ast"];
const authorSemantic = { delta: 0.606, ci: [0.242, 0.781] };
const authorSymbol = { zero_before: 0.222, zero_after: 0.0, recall_before: 0.778, recall_after: 1.0, categorical: "9/9" };

const symbolAfterRows = rowsOf(after, "symbol-ast", mustHit);
const symbolBeforeRows = rowsOf(before, "symbol-ast", mustHit);
const symbolCategoricalAfter = `${symbolAfterRows.filter((r) => r.score.recall_at_10 === 1).length}/${symbolAfterRows.length}`;
const symbolCategoricalBefore = `${symbolBeforeRows.filter((r) => r.score.recall_at_10 === 1).length}/${symbolBeforeRows.length}`;

const fpLanes = Object.fromEntries(lanes.map((l) => [l, { before: perLane[l].fp_before, after: perLane[l].fp_after }]));
const fpAllZeroAfter = lanes.every((l) => perLane[l].fp_after === 0 || perLane[l].fp_after === null);

const close = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
const claims = [
  {
    id: "semantic-dndcg",
    claim: `semantic ΔnDCG@10 ${authorSemantic.delta} [${authorSemantic.ci.join(", ")}]`,
    observed: { mean_delta: SEM.paired_ndcg10_answrable.mean_delta, ci95_bca: SEM.paired_ndcg10_answrable.ci95_bca, n: SEM.paired_ndcg10_answrable.n, basis: "answerable must-hit rows (10)" },
    verdict: close(SEM.paired_ndcg10_answrable.mean_delta, authorSemantic.delta, 0.05) ? "reproduced" : "different",
    note: "independent paired A/B: same scorer, same client, live wave-1 daemon vs isolated daemon built from this tree",
  },
  {
    id: "symbol-zero-result",
    claim: `symbol-ast zero_result_rate ${authorSymbol.zero_before} → ${authorSymbol.zero_after}`,
    observed: { before: SYM.all_before?.zero_result_rate ?? null, after: SYM.all_after?.zero_result_rate ?? null },
    verdict: SYM.all_after?.zero_result_rate === 0 ? "reproduced" : "refuted",
  },
  {
    id: "symbol-recall10",
    claim: `symbol-ast recall@10 ${authorSymbol.recall_before} → ${authorSymbol.recall_after} (${authorSymbol.categorical} categorical)`,
    observed: { before: SYM.all_before?.recall10 ?? null, after: SYM.all_after?.recall10 ?? null, categorical_before: symbolCategoricalBefore, categorical_after: symbolCategoricalAfter },
    verdict: SYM.all_after?.recall10 === 1 && symbolCategoricalAfter === "9/9" ? "reproduced" : "refuted",
  },
  {
    id: "fp-zero-everywhere",
    claim: "false-positive rate 0 in every lane",
    observed: fpLanes,
    verdict: fpAllZeroAfter ? "reproduced" : "refuted",
    note: "negatives: SY10-12 (symbol), SE11-12 (semantic), RS10 (ranking)",
  },
  {
    id: "tier-l-bars",
    claim: "every Tier-L floor in wave2-bars.json",
    observed: Object.fromEntries(lanes.map((l) => [l, perLane[l].tier_l_bars_after.filter((b) => b.pass === false).map((b) => b.bar)])),
    verdict: lanes.every((l) => perLane[l].tier_l_bars_after.every((b) => b.pass !== false)) ? "reproduced" : "not-all-pass",
  },
];

const out = {
  meta: {
    suite: "wave2-claims",
    generated_at: new Date().toISOString(),
    before_artifact: { path: path.relative(path.join(HERE, "..", "..", ".."), BEFORE), sha256: after.meta ? undefined : undefined, meta: before.meta?.daemon_provenance ?? null, status: before.meta?.status ?? null, head: before.meta?.head_commit ?? null },
    after_artifact: { path: path.relative(path.join(HERE, "..", "..", ".."), AFTER), status: after.meta?.status ?? null, head: after.meta?.head_commit ?? null, daemon: after.meta?.daemon_provenance ?? null },
    method:
      "paired per-query deltas; BCa bootstrap CI, 10000 resamples, seeded; same scorer and same client on both arms, only the daemon differs (arm before = installed wave-1 daemon; arm after = isolated daemon built from the rebased tree)",
  },
  lanes: perLane,
  claims,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, claims: claims.map((c) => ({ id: c.id, verdict: c.verdict, observed: c.observed })) }, null, 1));
