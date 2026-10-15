#!/usr/bin/env node
// bench/verification/checks/compare-wave2.mjs — independent verdicts on the wave-2
// relevance claims, with the attribution the claims need (engine vs client).
//
// Arms (all measured with this verification's scorers; only the daemon or the client
// differs, never both at once):
//
//   engine_only A/B   before = current client + installed wave-1 daemon
//                     after  = current client + isolated daemon from this tree
//   wave A/B          before = pre-relevance client (91e7832) + wave-1 daemon
//                     after  = current client + wave-1 daemon
//
//   node bench/verification/checks/compare-wave2.mjs [--boot 10000]
//
// Emits after/wave2-claims.json: per-lane metric blocks on both bases (all must-hit
// rows / Tier-L gated rows), paired per-query ΔnDCG@10 with a BCa bootstrap CI, and a
// verdict plus attribution for every published claim.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const AFTER_DIR = path.join(HERE, "..", "after");
const OUT = opt("out", path.join(AFTER_DIR, "wave2-claims.json"));
const B = Number(opt("boot", 10000));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const load = (p) => ({ path: p, sha256: sha(p), data: JSON.parse(fs.readFileSync(p, "utf8")) });

const engineBefore = load(path.join(AFTER_DIR, "wave2-livewave1daemon.json"));
const engineAfter = load(path.join(AFTER_DIR, "wave2-baseline.json"));
const waveBefore = load(path.join(AFTER_DIR, "wave2-baseline-prewave2engine.json"));
const waveAfter = engineBefore;

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
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
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
/** BCa bootstrap CI for the mean of paired differences. */
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
  const jk = values.map((_, i) => mean(values.filter((_, k) => k !== i)));
  const jkMean = mean(jk);
  const num = jk.reduce((x, v) => x + Math.pow(jkMean - v, 3), 0);
  const den = 6 * Math.pow(jk.reduce((x, v) => x + Math.pow(jkMean - v, 2), 0), 1.5);
  const a = den === 0 ? 0 : num / den;
  const adj = (alpha) => ncdf(z0 + (z0 + nquantile(alpha)) / (1 - a * (z0 + nquantile(alpha))));
  return [percentile(sorted, 100 * adj(0.025)), percentile(sorted, 100 * adj(0.975))];
}

// ---------------------------------------------------------------- comparison
const mustHit = (r) => r.must_hit && !r.negative;
const answerable = (r) => mustHit(r) && !r.requires_feature && !r.known_fail;

function comparison(before, after) {
  const lanes = ["symbol-ast", "semantic-paraphrase", "ranking-signal", "control"];
  const perLane = {};
  for (const lane of lanes) {
    const pair = (pick, key) => {
      const b = new Map(before.data.rows.filter((r) => r.lane === lane && pick(r)).map((r) => [r.id, r]));
      const detail = [];
      for (const r of after.data.rows.filter((r) => r.lane === lane && pick(r))) {
        const rb = b.get(r.id);
        if (!rb) continue;
        const vb = key === "ndcg_at_10" ? rb.score.ndcg_at_10 : rb.score.recall_at_10;
        const va = key === "ndcg_at_10" ? r.score.ndcg_at_10 : r.score.recall_at_10;
        if (vb === null || va === null) continue;
        detail.push({ id: r.id, before: vb, after: va, delta: va - vb });
      }
      const deltas = detail.map((d) => d.delta);
      return { n: deltas.length, mean_delta: deltas.length ? mean(deltas) : null, ci95_bca: bcaCI(deltas), detail };
    };
    const ab = before.data.aggregates[lane] ?? {};
    const aa = after.data.aggregates[lane] ?? {};
    perLane[lane] = {
      all_before: ab.all ?? null,
      all_after: aa.all ?? null,
      gated_before: ab.gated ?? null,
      gated_after: aa.gated ?? null,
      fp_before: ab.fp_rate ?? null,
      fp_after: aa.fp_rate ?? null,
      paired_ndcg10_answerable: pair(answerable, "ndcg_at_10"),
      paired_ndcg10_all: pair(mustHit, "ndcg_at_10"),
      paired_recall10_all: pair(mustHit, "recall_at_10"),
      bars_after: (after.data.bars?.[lane] ?? []).map((x) => ({ bar: x.bar, expected: x.expected, observed: x.observed, pass: x.pass })),
    };
  }
  return {
    arms: {
      before: { path: path.relative(REPO, before.path), sha256: before.sha256, head: before.data.meta?.head_commit ?? null, daemon: before.data.meta?.daemon_provenance ?? null, status: before.data.meta?.status ?? null },
      after: { path: path.relative(REPO, after.path), sha256: after.sha256, head: after.data.meta?.head_commit ?? null, daemon: after.data.meta?.daemon_provenance ?? null, status: after.data.meta?.status ?? null },
    },
    lanes: perLane,
  };
}

const engineOnly = comparison(engineBefore, engineAfter);
const wave = comparison(waveBefore, waveAfter);

// ---------------------------------------------------------------- claims
const author = {
  semantic: { delta: 0.606, ci: [0.242, 0.781] },
  symbol: { zero_before: 0.222, zero_after: 0.0, recall_before: 0.778, recall_after: 1.0, categorical: "9/9" },
};
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
const semEngine = engineOnly.lanes["semantic-paraphrase"].paired_ndcg10_answerable;
const semWave = wave.lanes["semantic-paraphrase"].paired_ndcg10_answerable;
const symEngine = engineOnly.lanes["symbol-ast"];
const symAllAfter = symEngine.all_after;
const symAllBefore = symEngine.all_before;
const symbolCategorical = (art) => {
  const rows = art.data.rows.filter((r) => r.lane === "symbol-ast" && mustHit(r));
  return `${rows.filter((r) => r.score.recall_at_10 === 1).length}/${rows.length}`;
};
const fpLanes = Object.fromEntries(
  ["symbol-ast", "semantic-paraphrase", "ranking-signal"].map((l) => [
    l,
    { engine_before: engineOnly.lanes[l].fp_before, engine_after: engineOnly.lanes[l].fp_after, wave_before: wave.lanes[l].fp_before },
  ]),
);
const tierL = Object.fromEntries(Object.entries(engineOnly.lanes).map(([l, v]) => [l, v.bars_after.filter((b) => b.pass === false).map((b) => b.bar)]));

const claims = [
  {
    id: "semantic-dndcg",
    claim: `semantic ΔnDCG@10 ${author.semantic.delta} [${author.semantic.ci.join(", ")}]`,
    attribution: "client-side relevance work (engine A/B is ~0)",
    engine_only: { mean_delta: semEngine.mean_delta, ci95_bca: semEngine.ci95_bca, n: semEngine.n },
    wave_as_whole: { mean_delta: semWave.mean_delta, ci95_bca: semWave.ci95_bca, n: semWave.n },
    verdict: near(semWave.mean_delta, author.semantic.delta, 0.05) ? "reproduced" : "different",
    note:
      "The claim reproduces as the relevance wave's total effect (pre-relevance client vs current client, same daemon): point estimate and CI nearly identical to the published ones. It does NOT reproduce as an engine/daemon effect: with the current client on both daemons the semantic lane moves -0.002 [-0.013, 0.000]. Confound: the pre-relevance arm ran before corpus hygiene (.corpus-meta.json was still inside the corpus root, 98 files vs 97).",
  },
  {
    id: "symbol-zero-result",
    claim: `symbol-ast zero_result_rate ${author.symbol.zero_before} → ${author.symbol.zero_after}`,
    attribution: "engine-side (symbol ranking)",
    engine_only: { before: symAllBefore?.zero_result_rate ?? null, after: symAllAfter?.zero_result_rate ?? null },
    verdict: symAllAfter?.zero_result_rate === 0 ? "reproduced" : "refuted",
  },
  {
    id: "symbol-recall10",
    claim: `symbol-ast recall@10 ${author.symbol.recall_before} → ${author.symbol.recall_after} (${author.symbol.categorical} categorical)`,
    attribution: "engine-side (symbol ranking)",
    engine_only: { before: symAllBefore?.recall10 ?? null, after: symAllAfter?.recall10 ?? null, categorical_before: symbolCategorical(engineBefore), categorical_after: symbolCategorical(engineAfter) },
    verdict: symAllAfter?.recall10 === 1 && symbolCategorical(engineAfter) === "9/9" ? "reproduced" : "refuted",
  },
  {
    id: "fp-zero-everywhere",
    claim: "false-positive rate 0 in every lane",
    attribution: "current system; the engine A/B is 0→0, so the residual FP the wave-1 corpus showed was already gone before the engine change",
    observed: fpLanes,
    verdict: Object.values(fpLanes).every((v) => v.engine_after === 0) ? "reproduced" : "refuted",
    note: "negatives: SY10-12 (symbol), SE11-12 (semantic), RS10 (ranking). The wave-1 set's false_positive_rate chain is separate: 0.50 (stale golden) → 0.25 (91e7832) → 0.00 (current).",
  },
  {
    id: "tier-l-bars",
    claim: "every Tier-L floor in wave2-bars.json",
    attribution: "current system, isolated daemon",
    observed: tierL,
    verdict: Object.values(tierL).every((f) => f.length === 0) ? "reproduced" : "not-all-pass",
    note: "ranking-signal/glob_set_completeness = 0.714: RS02 (`src/**/*.ts`, expected 14 files) returns 10. Not claimed by the relevance wave; recorded as the remaining Tier-L gap.",
  },
];

const out = {
  meta: {
    suite: "wave2-claims",
    generated_at: new Date().toISOString(),
    method:
      "two independent A/Bs with the same scorers: engine_only = current client on both daemons (installed wave-1 daemon vs isolated daemon built from this tree); wave = pre-relevance client (91e7832) vs current client on the SAME wave-1 daemon. Paired per-query deltas, BCa bootstrap CI, 10000 resamples, seeded.",
    boot: B,
  },
  comparisons: { engine_only: engineOnly, relevance_wave: wave },
  claims,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      out: OUT,
      claims: claims.map((c) => ({
        id: c.id,
        verdict: c.verdict,
        attribution: c.attribution,
        engine_only: c.engine_only ?? null,
        wave: c.wave_as_whole ?? null,
      })),
    },
    null,
    1,
  ),
);
