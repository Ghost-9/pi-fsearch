#!/usr/bin/env node
// bench/wave3/compare.mjs — paired before/after for the wave-3 relevance work.
//
//   node bench/wave3/compare.mjs --before <artifact.json> --after <artifact.json> [--out <f>]
//
// Every metric is a paired per-row delta with a BCa bootstrap CI (seeded, the
// verifier's own parameters). Rows are paired by judgment id, so the two arms
// must have been measured with the same judgment set.
//
// A lane with fewer than 3 rows reports its deltas and no CI: a bootstrap
// interval over two points is not a statistic, and the lane bound it feeds
// (reformulation <= 0.35) is a point condition, not a sample.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bcaCI, mean, percentile, excludesZero } from "./lib/stats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const load = (p) => ({ path: p, sha256: sha(p), data: JSON.parse(fs.readFileSync(p, "utf8")) });

const B = Number(opt("boot", 10000));
const before = load(opt("before"));
const after = load(opt("after"));
const OUT = opt("out", path.join(REPO, "bench", "wave3", "results", "compare.json"));

const mustHit = (r) => r.must_hit && !r.negative;
const pick = (d, id) => d.rows.find((r) => r.id === id);
const pairIds = before.data.rows.filter((r) => after.data.rows.some((a) => a.id === r.id)).map((r) => r.id);

const METRICS = [
  ["recall_at_10", "recall@10"],
  ["recall_at_3", "recall@3"],
  ["success_recall_at_10", "success_recall@10 (grade>=2)"],
  ["ndcg_at_10", "nDCG@10"],
  ["recall_at_limit", "recall@limit (whole set)"],
];

function metricRow(key, ids, pred) {
  const vals = [];
  for (const id of ids) {
    const b = pick(before.data, id);
    const a = pick(after.data, id);
    if (!b || !a) continue;
    if (!pred(b) || !pred(a)) continue;
    const vb = b.score[key];
    const va = a.score[key];
    if (vb === null || va === null || vb === undefined || va === undefined) continue;
    vals.push({ id, before: vb, after: va, delta: va - vb });
  }
  const deltas = vals.map((v) => v.delta);
  return {
    n: vals.length,
    before: mean(vals.map((v) => v.before)),
    after: mean(vals.map((v) => v.after)),
    delta: mean(deltas),
    ci95_bca: vals.length >= 3 ? bcaCI(deltas, B) : null,
    ci_note: vals.length >= 3 ? null : `n=${vals.length}: a BCa interval needs >= 3 paired rows`,
    excludes_zero: vals.length >= 3 ? excludesZero(bcaCI(deltas, B)) : null,
    improved: deltas.filter((d) => d > 1e-12).length,
    regressed: deltas.filter((d) => d < -1e-12).length,
    detail: vals.filter((v) => Math.abs(v.delta) > 1e-12),
  };
}

function rateRow(key, ids, pred) {
  const vals = [];
  for (const id of ids) {
    const b = pick(before.data, id);
    const a = pick(after.data, id);
    if (!b || !a || !pred(b) || !pred(a)) continue;
    const vb = b[key] ? 1 : 0;
    const va = a[key] ? 1 : 0;
    vals.push({ id, before: vb, after: va, delta: va - vb });
  }
  const deltas = vals.map((v) => v.delta);
  return {
    n: vals.length,
    before: mean(vals.map((v) => v.before)),
    after: mean(vals.map((v) => v.after)),
    delta: mean(deltas),
    ci95_bca: vals.length >= 3 ? bcaCI(deltas, B) : null,
    ci_note: vals.length >= 3 ? null : `n=${vals.length}: a BCa interval needs >= 3 paired rows`,
    excludes_zero: vals.length >= 3 ? excludesZero(bcaCI(deltas, B)) : null,
    detail: vals.filter((v) => Math.abs(v.delta) > 1e-12),
  };
}

function latencyRow(ids, pred) {
  const vals = [];
  for (const id of ids) {
    const b = pick(before.data, id);
    const a = pick(after.data, id);
    if (!b || !a || !pred(b) || !pred(a)) continue;
    vals.push({ id, before: b.ms, after: a.ms, delta: a.ms - b.ms });
  }
  const deltas = vals.map((v) => v.delta);
  const bms = vals.map((v) => v.before);
  const ams = vals.map((v) => v.after);
  return {
    n: vals.length,
    before_p50: percentile([...bms].sort((x, y) => x - y), 50),
    after_p50: percentile([...ams].sort((x, y) => x - y), 50),
    before_p95: percentile([...bms].sort((x, y) => x - y), 95),
    after_p95: percentile([...ams].sort((x, y) => x - y), 95),
    delta_p50: percentile([...ams].sort((x, y) => x - y), 50) - percentile([...bms].sort((x, y) => x - y), 50),
    delta_p95: percentile([...ams].sort((x, y) => x - y), 95) - percentile([...bms].sort((x, y) => x - y), 95),
    median_delta: percentile([...deltas].sort((x, y) => x - y), 50),
    ci95_bca_median_delta: vals.length >= 3 ? bcaCI(deltas, B) : null,
  };
}

const ids = pairIds.filter((id) => {
  const r = pick(before.data, id);
  return mustHit(r);
});
const lanes = [...new Set(ids.map((id) => pick(before.data, id).lane))];

const result = {
  meta: {
    suite: "wave3-compare",
    generated_at: new Date().toISOString(),
    boot: B,
    method: "paired per-row deltas, BCa bootstrap CI (mulberry32, seed 20261015), rows paired by judgment id",
    before: { path: path.relative(REPO, before.path), sha256: before.sha256, label: before.data.meta.label, engine: before.data.meta.engine, status: before.data.meta.status, gate: before.data.meta.gate.status },
    after: { path: path.relative(REPO, after.path), sha256: after.sha256, label: after.data.meta.label, engine: after.data.meta.engine, status: after.data.meta.status, gate: after.data.meta.gate.status },
    corpus_identical: before.data.meta.corpus.tree_sha256 === after.data.meta.corpus.tree_sha256,
    judgments_identical: before.data.meta.judgments.sha256 === after.data.meta.judgments.sha256,
    client_tree_dirty: { before: before.data.meta.client_tree_dirty, after: after.data.meta.client_tree_dirty },
  },
  overall: {
    must_hit_rows: ids.length,
    ...Object.fromEntries(METRICS.map(([k, label]) => [k, { label, ...metricRow(k, ids, () => true) }])),
    reformulation_signal: { label: "reformulation (top-1 grade < 2)", ...rateRow("score.reformulation_signal", ids, () => true) },
  },
  by_lane: {},
  latency: latencyRow(ids, () => true),
};

// rateRow reads `r[key]`, so the nested score flag needs its own form.
result.overall.reformulation_signal = {
  label: "reformulation (top-1 grade < 2)",
  ...(() => {
    const vals = [];
    for (const id of ids) {
      const b = pick(before.data, id);
      const a = pick(after.data, id);
      vals.push({ id, before: b.score.reformulation_signal ? 1 : 0, after: a.score.reformulation_signal ? 1 : 0, delta: (a.score.reformulation_signal ? 1 : 0) - (b.score.reformulation_signal ? 1 : 0) });
    }
    const deltas = vals.map((v) => v.delta);
    return {
      n: vals.length,
      before: mean(vals.map((v) => v.before)),
      after: mean(vals.map((v) => v.after)),
      delta: mean(deltas),
      ci95_bca: bcaCI(deltas, B),
      excludes_zero: excludesZero(bcaCI(deltas, B)),
      detail: vals.filter((v) => v.delta !== 0),
    };
  })(),
};

for (const lane of lanes) {
  const lid = ids.filter((id) => pick(before.data, id).lane === lane);
  const rate = (() => {
    const vals = [];
    for (const id of lid) {
      const b = pick(before.data, id);
      const a = pick(after.data, id);
      const vb = b.score.reformulation_signal ? 1 : 0;
      const va = a.score.reformulation_signal ? 1 : 0;
      vals.push({ id, before: vb, after: va, delta: va - vb });
    }
    const deltas = vals.map((v) => v.delta);
    return {
      n: vals.length,
      before: mean(vals.map((v) => v.before)),
      after: mean(vals.map((v) => v.after)),
      delta: mean(deltas),
      bound: 0.35,
      before_pass: mean(vals.map((v) => v.before)) <= 0.35,
      after_pass: mean(vals.map((v) => v.after)) <= 0.35,
      ci95_bca: vals.length >= 3 ? bcaCI(deltas, B) : null,
      ci_note: vals.length >= 3 ? null : `n=${vals.length}: no CI (a 2-row lane is scored as a point condition)`,
      detail: vals.filter((v) => v.delta !== 0),
    };
  })();
  result.by_lane[lane] = {
    rows: lid.length,
    recall_at_10: metricRow("recall_at_10", lid, () => true),
    ndcg_at_10: metricRow("ndcg_at_10", lid, () => true),
    reformulation_signal: rate,
    latency: latencyRow(lid, () => true),
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");

const f = (x) => (x === null || x === undefined ? "-" : Number(x).toFixed(4));
console.log(`compare: ${result.meta.before.label} -> ${result.meta.after.label}`);
console.log(`engine  ${result.meta.before.engine?.sha256?.slice(0, 16)} -> ${result.meta.after.engine?.sha256?.slice(0, 16)}   corpus_identical=${result.meta.corpus_identical} judgments_identical=${result.meta.judgments_identical}`);
console.log(`n must-hit rows: ${ids.length}\n`);
console.log(`${"metric".padEnd(30)} ${"before".padStart(8)} ${"after".padStart(8)} ${"delta".padStart(9)} ${"95% BCa CI".padStart(24)}  n  imp/reg`);
for (const [k, v] of Object.entries(result.overall)) {
  if (!v || typeof v !== "object" || !("label" in v)) continue;
  const ci = v.ci95_bca ? `[${f(v.ci95_bca[0])}, ${f(v.ci95_bca[1])}]` : (v.ci_note ?? "-");
  console.log(`${v.label.padEnd(30)} ${f(v.before).padStart(8)} ${f(v.after).padStart(8)} ${f(v.delta).padStart(9)} ${ci.padStart(24)} ${String(v.n).padStart(2)}  ${v.improved ?? "-"}/${v.regressed ?? "-"}`);
}
console.log(`\nper lane`);
for (const [lane, v] of Object.entries(result.by_lane)) {
  console.log(
    `  ${lane.padEnd(22)} r@10 ${f(v.recall_at_10.before)} -> ${f(v.recall_at_10.after)}  ndcg ${f(v.ndcg_at_10.before)} -> ${f(v.ndcg_at_10.after)}  reform ${f(v.reformulation_signal.before)} -> ${f(v.reformulation_signal.after)} (bound 0.35: ${v.reformulation_signal.after_pass ? "PASS" : "FAIL"})  n=${v.rows}`
  );
}
console.log(`\nlatency (all must-hit rows, unpaired across runs)`);
console.log(`  p50 ${f(result.latency.before_p50)} -> ${f(result.latency.after_p50)} ms (delta ${f(result.latency.delta_p50)}); p95 ${f(result.latency.before_p95)} -> ${f(result.latency.after_p95)} ms (delta ${f(result.latency.delta_p95)})`);
console.log(`\nraw: ${OUT}`);
