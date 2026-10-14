#!/usr/bin/env node
/**
 * Native-fallback benchmark (issue #24).
 *
 * Before: the 0.3.1 fallback executed `find` with execFileSync inside the
 * request path — measured here with an inline execFileSync reference so the
 * comparison is apples to apples.
 * After: the same search through FSearchClient with an unreachable socket,
 * which forces the async spawn fallback.
 *
 * Both arms are timed over n paired rounds; event-loop delay is sampled with
 * perf_hooks.monitorEventLoopDelay during each round.
 *
 * Usage: node bench/fallback.mjs [--n 200] [--json] [--force-degraded]
 */
process.env.PI_ULTRASEARCH_TEST = "1";
process.env.PI_ULTRASEARCH_BENCH = "1";

import { execFileSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FSearchClient } from "../src/client.ts";
import { activeChildCount } from "../src/spawn.ts";
import { buildFixture } from "./lib/fixtures.mjs";
import { pairedDeltaCI, pairedRatioCI, summarize, fmt, fmtCI } from "./lib/stats.mjs";
import { checkEnvironment, formatEnvironmentGate } from "./lib/env-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results");
const FIXTURES = path.join(HERE, ".fixtures");

function parseArgs(argv) {
  const args = { n: 200, json: false, forceDegraded: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--n") args.n = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--force-degraded") args.forceDegraded = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gate = checkEnvironment();
  console.log(formatEnvironmentGate(gate));
  if (!gate.ok && !args.forceDegraded) {
    console.error("REFUSED: environment gate failed (--force-degraded writes a degraded record only).");
    process.exit(3);
  }

  const fixture = buildFixture("small", FIXTURES);

  // The old synchronous fallback, exactly as it was: find + execFileSync, no async.
  const syncFallback = () => {
    const argsFind = [
      fixture.root,
      "-not",
      "-path",
      "*/.*",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/target/*",
      "-not",
      "-path",
      "*/dist/*",
      "-not",
      "-path",
      "*/build/*",
      "-iname",
      "*mod-001*",
      "-print",
    ];
    try {
      execFileSync("find", argsFind, { encoding: "utf-8", timeout: 4000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // non-zero exit is fine for the latency reference
    }
  };

  const asyncClient = new FSearchClient({ socketPath: path.join(OUT, "does-not-exist.sock"), maxReconnectRetries: 0, enableFallback: true, lanes: 1 });
  const asyncFallback = async () => {
    const res = await asyncClient.search("*mod-001*", { in: fixture.root, limit: 20, skipAudit: true });
    if (!res.ok) throw new Error(res.error ?? "async fallback failed");
    return res;
  };

  // Warmup
  syncFallback();
  await asyncFallback();

  const loop = monitorEventLoopDelay({ resolution: 5 });
  const syncLatency = [];
  const asyncLatency = [];
  const syncLag = [];
  const asyncLag = [];
  const order = [];

  for (let i = 0; i < args.n; i++) {
    const syncFirst = i % 2 === 0;
    order.push(syncFirst ? "sync-async" : "async-sync");

    const timeSync = () => {
      loop.reset();
      loop.enable();
      const t = performance.now();
      syncFallback();
      const ms = performance.now() - t;
      loop.disable();
      syncLatency.push(ms);
      syncLag.push({ meanMs: loop.mean / 1e6, maxMs: loop.max / 1e6 });
    };
    const timeAsync = async () => {
      loop.reset();
      loop.enable();
      const t = performance.now();
      await asyncFallback();
      const ms = performance.now() - t;
      loop.disable();
      asyncLatency.push(ms);
      asyncLag.push({ meanMs: loop.mean / 1e6, maxMs: loop.max / 1e6 });
    };

    if (syncFirst) {
      timeSync();
      await timeAsync();
    } else {
      await timeAsync();
      timeSync();
    }
  }

  const deltaCI = pairedDeltaCI(asyncLatency, syncLatency, { resamples: 10000, alpha: 0.05, seed: 0xf00d });
  const ratioCI = pairedRatioCI(asyncLatency, syncLatency, { resamples: 10000, alpha: 0.05, seed: 0xf00e });
  const syncLagMax = syncLag.map((l) => l.maxMs);
  const asyncLagMax = asyncLag.map((l) => l.maxMs);
  const lagDeltaCI = pairedDeltaCI(asyncLagMax, syncLagMax, { resamples: 10000, alpha: 0.05, seed: 0xf00f });

  const report = {
    schema: "ultrasearch.bench.fallback/v1",
    status: gate.ok ? "final" : "degraded",
    date: new Date().toISOString().slice(0, 10),
    startedAt: new Date().toISOString(),
    method: {
      workload: `find '*mod-001*' over the small fixture (${fixture.fileCount} files)`,
      before: "inline execFileSync reference of the 0.3.1 fallback (request-path blocking)",
      after: "FSearchClient async spawn fallback (socket unreachable, lanes:1)",
      design: `counterbalanced paired rounds, n=${args.n}`,
      ci: "BCa bootstrap, 10000 resamples, alpha=0.05, on paired deltas",
      eventLoop: "perf_hooks.monitorEventLoopDelay({resolution:5}) sampled per round; mean/max in ms",
    },
    environment: gate.info,
    environmentGate: { ok: gate.ok, reasons: gate.reasons },
    n: args.n,
    order,
    sync: {
      latency: summarize(syncLatency),
      eventLoopMeanMs: summarize(syncLag.map((l) => l.meanMs)),
      eventLoopMaxMs: summarize(syncLagMax),
    },
    async: {
      latency: summarize(asyncLatency),
      eventLoopMeanMs: summarize(asyncLag.map((l) => l.meanMs)),
      eventLoopMaxMs: summarize(asyncLagMax),
      activeChildCountAfterRun: activeChildCount(),
    },
    pairedDeltaMs: deltaCI,
    pairedRatio: ratioCI,
    eventLoopMaxDeltaMs: lagDeltaCI,
    noLeakedChildren: activeChildCount() === 0,
    finishedAt: new Date().toISOString(),
  };

  fs.mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, `fallback-${report.date}${report.status === "final" ? "" : "-degraded"}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\n=== async vs sync fallback (n=${args.n} paired) ===`);
    console.log(`sync  median ${fmt(report.sync.latency.median)}ms  p95 ${fmt(report.sync.latency.p95)}ms  loop max p95 ${fmt(report.sync.eventLoopMaxMs.p95)}ms`);
    console.log(`async median ${fmt(report.async.latency.median)}ms  p95 ${fmt(report.async.latency.p95)}ms  loop max p95 ${fmt(report.async.eventLoopMaxMs.p95)}ms`);
    console.log(`latency delta (async - sync): ${fmtCI(deltaCI)} ms | ratio ${fmtCI(ratioCI, 3)}`);
    console.log(`event-loop max delta: ${fmtCI(lagDeltaCI)} ms | leaked children: ${report.async.activeChildCountAfterRun}`);
    console.log(`wrote ${jsonPath}`);
  }
  asyncClient.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
