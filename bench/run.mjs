#!/usr/bin/env node
/**
 * Multi-scope benchmark runner (issue #21).
 *
 * What it measures, on identical queries:
 *   A = ultra-search client API (resident index)
 *   B = native rg/find (async spawn, same spawner as the fallback path)
 *
 * How:
 *   - deterministic fixtures: small repo, monorepo (~2k files), home-scale subset
 *   - paired, counterbalanced A/B (AB, BA, AB, ...) so ordering drift cancels
 *   - BCa bootstrap CI (10k resamples) on the paired deltas
 *   - output equivalence against the native result set with a documented tolerance
 *   - relevance metrics (recall@k, MRR@10, nDCG@10, zero-result, false-positive,
 *     reformulation) on the frozen wave1 judgment corpus
 *   - environment gate (AC power, load1m, competing builds, daemon identity)
 *     before any final JSON is written
 *
 * Usage:
 *   node bench/run.mjs [--scopes small,monorepo,home] [--pairs 30] [--warmup 2]
 *                      [--json] [--no-relevance] [--force-fixtures] [--force-degraded]
 */
process.env.PI_ULTRASEARCH_TEST = "1";
process.env.PI_ULTRASEARCH_BENCH = "1";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { UltraSearchClient } from "../src/client.ts";
import { searchSemanticIntent } from "../src/semantic.ts";
import { buildFixture, SCOPES } from "./lib/fixtures.mjs";
import { runNative, compareSets, normalizePaths } from "./lib/native.mjs";
import { environmentWithDaemon, formatEnvironmentGate } from "./lib/env-gate.mjs";
import { counterbalancedAB, pairedDeltaCI, pairedRatioCI, summarize, decisionFloor, ciExcludesZero, fmt, fmtCI } from "./lib/stats.mjs";
import { loadJudgments, evaluateRunnerJudgments, REPO_ROOT } from "./lib/relevance-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "results");
const DEFAULT_FIXTURES = path.join(HERE, ".fixtures");

function parseArgs(argv) {
  const args = {
    scopes: SCOPES,
    pairs: 30,
    warmup: 2,
    out: DEFAULT_OUT,
    fixturesDir: DEFAULT_FIXTURES,
    json: false,
    relevance: true,
    forceFixtures: false,
    forceDegraded: false,
    frecencyWaitSec: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scopes") args.scopes = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--pairs") args.pairs = Number(argv[++i]);
    else if (a === "--warmup") args.warmup = Number(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--fixtures-dir") args.fixturesDir = path.resolve(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--no-relevance") args.relevance = false;
    else if (a === "--force-fixtures") args.forceFixtures = true;
    else if (a === "--force-degraded") args.forceDegraded = true;
    else if (a === "--frecency-wait-sec") args.frecencyWaitSec = Number(argv[++i]);
  }
  return args;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until the index can answer the query, returns elapsed ms or null. */
async function waitForIndex(fn, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      if (await fn()) return Math.round(performance.now() - started);
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }
  return null;
}

async function ultraCall(client, spec, scope) {
  const started = performance.now();
  let res;
  if (spec.kind === "path") {
    res = await client.search(spec.ultra.query, { ...spec.ultra.options, in: scope, skipAudit: true });
    return { ms: performance.now() - started, paths: normalizePaths((res.hits ?? []).map((h) => h.path)), source: res.meta?.source ?? res.source ?? "index", complete: res.meta?.complete, truncated: res.meta?.truncated };
  }
  res = await client.grep(spec.ultra.pattern, { ...spec.ultra.options, in: scope, skipAudit: true });
  return {
    ms: performance.now() - started,
    paths: normalizePaths([...new Set((res.files ?? []).map((f) => f.path))]),
    source: res.meta?.source ?? res.source ?? "index",
    complete: res.meta?.complete,
    truncated: res.meta?.truncated,
    fileCount: (res.files ?? []).length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const unknown = args.scopes.filter((s) => !SCOPES.includes(s));
  if (unknown.length > 0) {
    console.error(`unknown scopes: ${unknown.join(", ")} (known: ${SCOPES.join(", ")})`);
    process.exit(1);
  }

  const client = new UltraSearchClient({ autoSpawnDaemon: false });
  const daemonUp = await client.ping();
  if (!daemonUp) {
    console.error("REFUSED: UltraSearch daemon is not running; multi-scope benchmarks require the resident index.");
    client.close();
    process.exit(2);
  }

  const gate = await environmentWithDaemon(client);
  console.log(formatEnvironmentGate(gate));
  if (!gate.ok && !args.forceDegraded) {
    console.error("REFUSED: environment gate failed. Re-run with --force-degraded to write a clearly-marked degraded record (never a final result).");
    client.close();
    process.exit(3);
  }

  const run = {
    schema: "ultrasearch.bench.scopes/v1",
    status: gate.ok ? "final" : "degraded",
    date: today(),
    startedAt: new Date().toISOString(),
    method: {
      design: "paired counterbalanced A/B (AB/BA alternating), warmup pairs excluded",
      statistic: "median",
      ci: "BCa bootstrap, 10000 resamples, alpha=0.05, on paired deltas",
      decisionFloor: "max(0.2 ms, 5% of native median)",
      pairs: args.pairs,
      warmupPairs: args.warmup,
      equivalence:
        "path sets normalized by realpath; index must not invent paths (extraRate<=indexOnly tolerance); missing paths allowed only within the per-query nativeOnly tolerance (content-index coverage is partial)",
      relevance: "wave1 judgment corpus (recall@k, MRR@10, nDCG@10, zero-result, false-positive, reformulation)",
      audit: "PI_ULTRASEARCH_TEST=1 + skipAudit: production audit log untouched",
    },
    environment: gate.info,
    environmentGate: { ok: gate.ok, reasons: gate.reasons },
    scopes: {},
  };

  fs.mkdirSync(args.out, { recursive: true });
  fs.mkdirSync(args.fixturesDir, { recursive: true });

  for (const scope of args.scopes) {
    const fixture = buildFixture(scope, args.fixturesDir, { force: args.forceFixtures });
    console.log(`\n=== scope ${scope}: ${fixture.fileCount} files at ${fixture.root}${fixture.cached ? " (cached)" : ""} ===`);

    const readiness = {};
    for (const spec of fixture.queries) {
      const waitMs = await waitForIndex(async () => {
        const probe = await ultraCall(client, spec, fixture.root);
        return probe.paths.length > 0;
      });
      readiness[spec.id] = { indexReadyMs: waitMs, ready: waitMs !== null };
      if (waitMs === null) console.log(`  ! ${spec.id}: index never returned results within 30s`);
    }

    const scopeResult = {
      scope,
      fixture: { root: fixture.root, fileCount: fixture.fileCount, cached: fixture.cached, generatorVersion: fixture.generatorVersion },
      readiness,
      queries: [],
      ignoreFiltering: null,
    };

    // Intentional divergence proof: declared .gitignore rules are applied client-side,
    // so ultra-search must exclude the ignored fixture file that raw find returns.
    if (fixture.ignoredFile) {
      const ignoredName = path.basename(fixture.ignoredFile);
      const ultra = await client.search(`*${ignoredName}*`, { in: fixture.root, limit: 10, skipAudit: true });
      const native = await runNative({ kind: "find-name", pattern: ignoredName }, fixture.root);
      scopeResult.ignoreFiltering = {
        file: fixture.ignoredFile,
        ultraReturned: (ultra.hits ?? []).length,
        nativeReturned: native.paths.length,
        correctlyExcluded: (ultra.hits ?? []).length === 0,
      };
      if (fixture.nestedIgnoreFile) {
        const nestedName = path.basename(fixture.nestedIgnoreFile);
        const ultraNested = await client.search(`*${nestedName}*`, { in: fixture.root, limit: 10, skipAudit: true });
        scopeResult.ignoreFiltering.nested = {
          file: fixture.nestedIgnoreFile,
          ultraReturned: (ultraNested.hits ?? []).length,
          honoured: (ultraNested.hits ?? []).length === 0,
          note: "known gap: rules declared in a subdirectory .gitignore are not loaded (scope-root rules only)",
        };
      }
    }

    for (const spec of fixture.queries) {
      const ultra = [];
      const native = [];
      const sources = {};
      let ultraResult = null;
      let nativeResult = null;

      const { order } = await counterbalancedAB({
        pairs: args.pairs,
        warmupPairs: args.warmup,
        runA: async (_i, phase) => {
          const r = await ultraCall(client, spec, fixture.root);
          if (phase === "measured") {
            ultra.push(r.ms);
            sources[r.source ?? "unknown"] = (sources[r.source ?? "unknown"] ?? 0) + 1;
            if (!ultraResult) ultraResult = r;
          }
          return r.ms;
        },
        runB: async (_i, phase) => {
          const r = await runNative(spec.native, fixture.root);
          if (phase === "measured") {
            native.push(r.ms);
            if (!nativeResult) nativeResult = r;
          }
          return r.ms;
        },
      });

      const deltaCI = pairedDeltaCI(ultra, native, { resamples: 10000, alpha: 0.05, seed: 0xc0ffee });
      const ratioCI = pairedRatioCI(ultra, native, { resamples: 10000, alpha: 0.05, seed: 0xc0ffee });
      const baseline = summarize(native).median;
      const floor = decisionFloor(baseline);
      const equivalence = compareSets(ultraResult?.paths ?? [], nativeResult?.paths ?? [], spec.tolerance);
      const fallbackRuns = Object.entries(sources)
        .filter(([s]) => s === "native_fallback")
        .reduce((acc, [, n]) => acc + n, 0);

      const row = {
        id: spec.id,
        kind: spec.kind,
        tolerance: spec.tolerance,
        n: Math.min(ultra.length, native.length),
        order,
        indexReadyMs: readiness[spec.id]?.indexReadyMs ?? null,
        ultra: { ...summarize(ultra), sources, fallbackRuns, complete: ultraResult?.complete ?? null },
        native: { ...summarize(native), bin: nativeResult?.bin ?? null, args: nativeResult?.args ?? null, stdoutBytes: nativeResult?.stdoutBytes ?? null },
        pairedDeltaMs: deltaCI,
        pairedRatio: ratioCI,
        decisionFloorMs: floor,
        significant: ciExcludesZero(deltaCI) && Math.abs(deltaCI.point) >= floor,
        equivalence,
        note: spec.note ?? null,
      };
      scopeResult.queries.push(row);

      console.log(
        `  ${spec.id.padEnd(18)} n=${row.n}  ultra p50 ${fmt(row.ultra.p50)}ms p95 ${fmt(row.ultra.p95)}${row.ultra.p95IsMax ? "(=max)" : ""} | native p50 ${fmt(
          row.native.p50
        )}ms p95 ${fmt(row.native.p95)}${row.native.p95IsMax ? "(=max)" : ""}`
      );
      console.log(`      speedup ${fmt(row.pairedRatio.point)}x ${fmtCI(row.pairedRatio)} | delta ${fmtCI(row.pairedDeltaMs)}ms | equivalent=${equivalence.pass} (miss ${(equivalence.missRate * 100).toFixed(1)}%)`);
    }

    run.scopes[scope] = scopeResult;
  }

  // Relevance metrics on the frozen judgment corpus
  if (args.relevance) {
    const judgments = loadJudgments(REPO_ROOT);
    if (!judgments || judgments.error) {
      run.relevance = { skipped: true, reason: judgments?.error ?? "wave1-judgments.json not found", searched: judgments?.file ?? null };
      console.log("\n=== relevance: skipped (judgment set not found) ===");
    } else {
      console.log(`\n=== relevance: ${judgments.data.queries.length} queries against ${judgments.data.corpus.root} ===`);
      const evaluated = await evaluateRunnerJudgments(client, {
        judgments,
        corpusRoot: judgments.data.corpus.root,
        frecencyWaitSec: args.frecencyWaitSec,
      });
      run.relevance = evaluated;
      const a = evaluated.aggregate;
      console.log(
        `  recall@1 ${a.recallAt1.toFixed(3)} · recall@3 ${a.recallAt3.toFixed(3)} · recall@5 ${a.recallAt5.toFixed(3)} · recall@10 ${a.recallAt10.toFixed(3)}`
      );
      console.log(
        `  MRR@10 ${a.mrr10.toFixed(3)} · nDCG@10 ${a.ndcg10.toFixed(3)} · zero-result ${(a.zeroResultRate * 100).toFixed(1)}% · false-positive ${(a.falsePositiveRate * 100).toFixed(1)}% · reformulation ${(a.reformulationSignal * 100).toFixed(1)}%`
      );
      for (const [metric, cmp] of Object.entries(evaluated.baselineComparison)) {
        if (metric === "source") continue;
        console.log(`  ${cmp.beats ? "BEATS" : "BELOW"} baseline ${metric}: ${cmp.value.toFixed(3)} vs ${cmp.baseline} (Δ ${cmp.delta >= 0 ? "+" : ""}${cmp.delta.toFixed(3)})`);
      }
      for (const c of evaluated.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} = ${typeof c.value === "number" ? c.value.toFixed(3) : c.value}`);
    }
  }

  run.finishedAt = new Date().toISOString();

  // Write raw JSON: dated combined + per-scope latest.
  const combinedPath = path.join(args.out, `scopes-${run.date}${run.status === "final" ? "" : "-degraded"}.json`);
  fs.writeFileSync(combinedPath, JSON.stringify(run, null, 2));
  for (const [scope, scopeResult] of Object.entries(run.scopes)) {
    fs.writeFileSync(path.join(args.out, `scopes-${scope}${run.status === "final" ? "" : "-degraded"}.json`), JSON.stringify({ ...run, scopes: { [scope]: scopeResult } }, null, 2));
  }
  console.log(`\nwrote ${combinedPath}`);

  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
