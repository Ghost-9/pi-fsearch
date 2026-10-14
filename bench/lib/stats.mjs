/**
 * Statistics for the pi-ultrasearch benchmark harness.
 *
 * Rules encoded here (advisor findings, 2026-10-15):
 *  - nearest-rank percentiles; p95 is never silently the maximum
 *  - median over mean
 *  - BCa bootstrap CI, 10k resamples, on *paired* deltas
 *  - a decision floor of max(0.2 ms, 5% of the baseline) before a delta is called real
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile (p in 0..100). Returns NaN for an empty sample. */
export function percentile(values, p) {
  if (!values || values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function median(values) {
  return percentile(values, 50);
}

export function mean(values) {
  if (!values || values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values) {
  if (!values || values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Summary of a latency sample. `p95IsMax` is true when the sample is too small
 * for the p95 rank to differ from the maximum — never report such a p95 as a tail.
 */
export function summarize(values) {
  const n = values.length;
  const p95 = percentile(values, 95);
  const max = n ? Math.max(...values) : NaN;
  return {
    n,
    median: median(values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95,
    p95IsMax: n > 0 && p95 === max,
    min: n ? Math.min(...values) : NaN,
    max,
    stdev: stdev(values),
  };
}

// --- normal distribution helpers -------------------------------------------

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Acklam's inverse normal CDF. */
export function normalInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * BCa bootstrap over index selections. `compute(indices)` evaluates the
 * statistic for a selection of indices into the paired sample.
 */
export function bcaFromIndices(n, compute, options = {}) {
  const resamples = options.resamples ?? 10000;
  const alpha = options.alpha ?? 0.05;
  const seed = options.seed ?? 12345;
  if (n < 2) {
    return { n, point: compute([0]), lo: NaN, hi: NaN, method: "bca", resamples: 0, alpha, note: "n<2" };
  }

  const all = Array.from({ length: n }, (_, i) => i);
  const point = compute(all);

  // Jackknife for the acceleration term.
  const jk = new Array(n);
  for (let i = 0; i < n; i++) {
    jk[i] = compute(all.filter((k) => k !== i));
  }
  const jkMean = mean(jk);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = jkMean - jk[i];
    num += d ** 3;
    den += d ** 2;
  }
  const acceleration = den === 0 ? 0 : num / (6 * Math.pow(den, 1.5));

  const rand = mulberry32(seed);
  const stats = new Array(resamples);
  let less = 0;
  for (let b = 0; b < resamples; b++) {
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rand() * n);
    const t = compute(idx);
    stats[b] = t;
    if (t < point) less++;
  }
  stats.sort((a, b) => a - b);

  const prop = Math.min(Math.max(less / resamples, 1 / (resamples + 1)), resamples / (resamples + 1));
  const z0 = normalInv(prop);
  const zLo = normalInv(alpha / 2);
  const zHi = normalInv(1 - alpha / 2);
  const adjust = (z) => {
    const d = 1 - acceleration * (z0 + z);
    if (d === 0) return z0 + (z0 + z) / 1e-9;
    return normalCdf(z0 + (z0 + z) / d);
  };
  let loP = clamp01(adjust(zLo));
  let hiP = clamp01(adjust(zHi));
  if (loP > hiP) [loP, hiP] = [hiP, loP];
  const quantile = (p) => stats[Math.min(stats.length - 1, Math.max(0, Math.ceil(p * stats.length) - 1))];

  return {
    n,
    point,
    lo: quantile(loP),
    hi: quantile(hiP),
    method: "bca",
    resamples,
    alpha,
    biasCorrection: z0,
    acceleration,
  };
}

/** BCa CI for a single-sample statistic (e.g. the median). */
export function bcaCI(samples, stat = median, options = {}) {
  const n = samples.length;
  const v = (idx) => stat(idx.map((i) => samples[i]));
  return bcaFromIndices(n, v, options);
}

/**
 * Paired BCa CI. Sign convention: delta = a - b (A minus B). The point estimate
 * for "delta" is the median paired difference; for "ratio" it is median(b)/median(a)
 * (i.e. how many times faster A is than B).
 */
function pairedInternal(a, b, quantity, options) {
  const n = Math.min(a.length, b.length);
  const stat = (idx, sel) => {
    const va = idx.map((i) => a[i]);
    const vb = idx.map((i) => b[i]);
    return quantity === "ratio" ? median(vb) / median(va) : median(va) - median(vb);
  };
  return bcaFromIndices(n, (idx) => stat(idx), options);
}

export function pairedDeltaCI(a, b, options = {}) {
  return { ...pairedInternal(a, b, "delta", options), quantity: "delta(a - b)" };
}

export function pairedRatioCI(a, b, options = {}) {
  return { ...pairedInternal(a, b, "ratio", options), quantity: "ratio(medianB / medianA)" };
}

/**
 * Decision floor: a change is only actionable when it clears
 * max(absFloorMs, relFloor × |baseline|).
 */
export function decisionFloor(baseline, options = {}) {
  const relFloor = options.relFloor ?? 0.05;
  const absFloor = options.absFloorMs ?? 0.2;
  return Math.max(absFloor, relFloor * Math.abs(baseline ?? 0));
}

/**
 * Counterbalanced paired A/B runner. Every pair runs A then B, and the next
 * pair runs B then A, so ordering drift cancels across pairs.
 */
export async function counterbalancedAB({ pairs, runA, runB, warmupPairs = 2, gapMs = 0 }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < warmupPairs; i++) {
    await runA(i, "warmup");
    await runB(i, "warmup");
  }
  const a = [];
  const b = [];
  const order = [];
  for (let i = 0; i < pairs; i++) {
    const aFirst = i % 2 === 0;
    order.push(aFirst ? "AB" : "BA");
    if (aFirst) {
      a.push(await runA(i, "measured"));
      b.push(await runB(i, "measured"));
    } else {
      b.push(await runB(i, "measured"));
      a.push(await runA(i, "measured"));
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  return { a, b, order, pairs };
}

/** Format a CI compactly for markdown tables. */
export function fmt(x, digits = 2) {
  if (!Number.isFinite(x)) return "n/a";
  return Number(x).toFixed(digits);
}

export function fmtCI(ci, digits = 2) {
  if (!ci || !Number.isFinite(ci.point)) return "n/a";
  return `${fmt(ci.point, digits)} [${fmt(ci.lo, digits)}, ${fmt(ci.hi, digits)}]`;
}

export function ciExcludesZero(ci) {
  return Number.isFinite(ci?.lo) && Number.isFinite(ci?.hi) && (ci.lo > 0 || ci.hi < 0);
}
