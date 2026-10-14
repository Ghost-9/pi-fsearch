#!/usr/bin/env node
/**
 * IPC lane benchmark (issue #18).
 *
 * Treatment: client with 3 connection lanes. Control: the legacy single socket.
 * Each pair launches 3 large greps with Promise.all and times the batch.
 * Also reports the concurrency shape: parallel / single-median (≈1 means
 * max(t), ≈3 means sum(t)) so "no head-of-line blocking" is a number, not a claim.
 *
 * Usage: node bench/lanes.mjs [--pairs 30] [--limit 300] [--scope DIR] [--json]
 */
process.env.PI_ULTRASEARCH_TEST = "1";
process.env.PI_ULTRASEARCH_BENCH = "1";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UltraSearchClient } from "../src/client.ts";
import { counterbalancedAB, pairedDeltaCI, pairedRatioCI, summarize, decisionFloor, ciExcludesZero, fmt, fmtCI } from "./lib/stats.mjs";
import { environmentWithDaemon, formatEnvironmentGate } from "./lib/env-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results");

function parseArgs(argv) {
  const args = {
    pairs: 30,
    limit: 300,
    pattern: "function",
    scope: path.join(os.homedir(), ".pi"),
    json: false,
    forceDegraded: false,
    concurrent: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pairs") args.pairs = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--pattern") args.pattern = argv[++i];
    else if (a === "--scope") args.scope = path.resolve(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--force-degraded") args.forceDegraded = true;
    else if (a === "--concurrent") args.concurrent = Number(argv[++i]);
  }
  return args;
}

function bytesOf(res) {
  try {
    return JSON.stringify(res).length;
  } catch {
    return 0;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pooled = new UltraSearchClient({ lanes: 3, autoSpawnDaemon: false });
  const single = new UltraSearchClient({ lanes: 1, autoSpawnDaemon: false });
  if (!(await pooled.ping())) {
    console.error("REFUSED: daemon not running; the lane benchmark needs the live daemon.");
    process.exit(2);
  }
  const gate = await environmentWithDaemon(pooled);
  console.log(formatEnvironmentGate(gate));
  if (!gate.ok && !args.forceDegraded) {
    console.error("REFUSED: environment gate failed (--force-degraded writes a degraded record only).");
    pooled.close();
    single.close();
    process.exit(3);
  }

  const opts = { in: args.scope, limit: args.limit, budget_ms: 15000, skipAudit: true };
  const launch = async (client) => {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: args.concurrent }, () => client.grep(args.pattern, opts)));
    return { ms: performance.now() - started, bytes: results.reduce((acc, r) => acc + bytesOf(r), 0), sources: results.map((r) => r.source) };
  };

  console.log(`scope=${args.scope} pattern='${args.pattern}' limit=${args.limit} concurrent=${args.concurrent} pairs=${args.pairs}`);

  // Warm both clients and measure a single-call median for the concurrency shape.
  for (let i = 0; i < 3; i++) {
    await pooled.grep(args.pattern, opts);
    await single.grep(args.pattern, opts);
  }
  const singlePooled = [];
  const singleSingle = [];
  for (let i = 0; i < 15; i++) {
    let t = performance.now();
    await pooled.grep(args.pattern, opts);
    singlePooled.push(performance.now() - t);
    t = performance.now();
    await single.grep(args.pattern, opts);
    singleSingle.push(performance.now() - t);
  }

  const { a, b } = await counterbalancedAB({
    pairs: args.pairs,
    warmupPairs: 1,
    runA: async () => (await launch(pooled)).ms,
    runB: async () => (await launch(single)).ms,
  });

  const pooledSummary = summarize(a);
  const singleSummary = summarize(b);
  const deltaCI = pairedDeltaCI(a, b, { resamples: 10000, alpha: 0.05, seed: 0x1a11 });
  const ratioCI = pairedRatioCI(a, b, { resamples: 10000, alpha: 0.05, seed: 0x1a12 });
  const baseline = singleSummary.median;
  const floor = decisionFloor(baseline);

  const singleMedian = summarize(singlePooled).median;
  const singleSingleMedian = summarize(singleSingle).median;

  const report = {
    schema: "ultrasearch.bench.lanes/v1",
    status: gate.ok ? "final" : "degraded",
    date: new Date().toISOString().slice(0, 10),
    startedAt: new Date().toISOString(),
    method: {
      treatment: "client with lanes: 3",
      control: "client with lanes: 1 (legacy single socket)",
      workload: `Promise.all of ${args.concurrent} grep(limit=${args.limit}) on ${args.scope}`,
      design: "counterbalanced paired A/B, warmup excluded",
      ci: "BCa bootstrap, 10000 resamples, alpha=0.05, on paired deltas",
      statistic: "median",
      decisionFloor: "max(0.2 ms, 5% of control median)",
    },
    environment: gate.info,
    environmentGate: { ok: gate.ok, reasons: gate.reasons },
    scope: args.scope,
    pattern: args.pattern,
    limit: args.limit,
    concurrent: args.concurrent,
    pairs: args.pairs,
    pooled: { ...pooledSummary, pool: pooled.poolStats() },
    single: { ...singleSummary, pool: single.poolStats() },
    pairedDeltaMs: deltaCI,
    pairedRatio: ratioCI,
    decisionFloorMs: floor,
    significant: ciExcludesZero(deltaCI) && Math.abs(deltaCI.point) >= floor,
    concurrencyShape: {
      treatmentParallelMedianMs: pooledSummary.median,
      treatmentSingleMedianMs: singleMedian,
      controlParallelMedianMs: singleSummary.median,
      controlSingleMedianMs: singleSingleMedian,
      treatmentRatioToSingle: pooledSummary.median / Math.max(0.0001, singleMedian),
      controlRatioToSingle: singleSummary.median / Math.max(0.0001, singleSingleMedian),
      interpretation: "ratio ~1 => batch time equals one call (max, no head-of-line blocking); ~N => serialized (sum)",
    },
    finishedAt: new Date().toISOString(),
  };

  fs.mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, `lanes-${report.date}${report.status === "final" ? "" : "-degraded"}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\n=== IPC lanes: ${args.pairs} paired rounds ===`);
    console.log(`lanes:3  median ${fmt(pooledSummary.median)}ms  p95 ${fmt(pooledSummary.p95)} ms`);
    console.log(`lanes:1  median ${fmt(singleSummary.median)}ms  p95 ${fmt(singleSummary.p95)} ms`);
    console.log(`paired delta (3-1): ${fmtCI(deltaCI)} ms | ratio ${fmtCI(ratioCI, 3)}`);
    console.log(`single-call medians: lanes:3 ${fmt(singleMedian)}ms, lanes:1 ${fmt(singleSingleMedian)}ms`);
    console.log(`concurrency shape (batch/one-call): lanes:3 ${fmt(report.concurrencyShape.treatmentRatioToSingle)} vs lanes:1 ${fmt(report.concurrencyShape.controlRatioToSingle)}`);
    console.log(`wrote ${jsonPath}`);
  }

  pooled.close();
  single.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
