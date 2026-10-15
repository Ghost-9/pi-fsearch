// bench/wave3/lib/stats.mjs — paired statistics for the wave-3 relevance work.
//
// The BCa implementation is the verifier's own (`bench/verification/checks/
// compare-wave2.mjs`): mulberry32 PRNG, `--boot` resamples (default 10000),
// seed 20261015, percentile-of-sorted-bootstrap interval with the
// bias/skewness correction. Copied rather than re-derived so a wave-3 number
// and a wave-2 number are the same statistic.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const sortNum = (a) => [...a].sort((x, y) => x - y);

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
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
export function bcaCI(values, iters = 10000, seed = 20261015) {
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

/** Does the CI exclude zero? `true` only when the whole interval is one sign. */
export function excludesZero([lo, hi]) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return lo > 0 || hi < 0;
}
