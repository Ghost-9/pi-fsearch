#!/usr/bin/env node
/**
 * Prompt-token A/B harness (issue #20).
 *
 * Compares the tokens the model actually receives from the ultra-search tool
 * path against the raw output of the equivalent native `rg`/`find` command for
 * a fixed task set. Token counts are ESTIMATES from a documented estimator
 * (ceil(chars / 4), the same one src/formatter.ts uses) — never measurements of
 * a specific tokenizer.
 *
 * Also computes the legacy `150 + 75 × hits` heuristic for the same runs so the
 * estimate can be compared against measured output on identical results.
 *
 * Usage: node bench/tokens.mjs [--pairs 30] [--json] [--force-degraded]
 */
process.env.PI_ULTRASEARCH_TEST = "1";
process.env.PI_ULTRASEARCH_BENCH = "1";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FSearchClient } from "../src/client.ts";
import { spawnCapture } from "../src/spawn.ts";
import { loadPiTools } from "./lib/pi-tools.mjs";
import { pairedDeltaCI, pairedRatioCI, summarize, fmt, fmtCI } from "./lib/stats.mjs";
import { environmentWithDaemon, formatEnvironmentGate } from "./lib/env-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT = path.join(HERE, "results");

/** Documented estimator: 4 characters per token, matching src/formatter.ts. */
export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

/** Sensitivity estimator: whitespace/punctuation-aware, reported alongside. */
export function estimateTokensAlt(chars) {
  return Math.ceil(chars / 3.5);
}

/** The legacy heuristic from src/telemetry.ts (an estimate, not a measurement). */
export function legacyHeuristic(tool, hits) {
  if (tool === "fsearch_grep") return hits > 0 ? 150 + hits * 75 : 50;
  return hits > 0 ? 100 + hits * 30 : 25;
}

const TASKS = [
  { id: "find-file", tool: "query", params: { query: "package.json", limit: 10 }, native: { bin: "find", args: [".", "-name", "package.json"] } },
  { id: "find-definition", tool: "grep", params: { pattern: "applyProximityRanking", mode: "literal", limit: 10 }, native: { bin: "rg", args: ["-n", "--no-heading", "applyProximityRanking", "src"] }, heuristic: "fsearch_grep" },
  { id: "locate-config", tool: "query", params: { query: ".gitignore", limit: 10 }, native: { bin: "find", args: [".", "-name", ".gitignore"] } },
  { id: "grep-literal", tool: "grep", params: { pattern: "estimateTokensSaved", mode: "literal", limit: 10 }, native: { bin: "rg", args: ["-n", "--no-heading", "estimateTokensSaved", "."] }, heuristic: "fsearch_grep" },
  { id: "find-config", tool: "query", params: { query: "tsconfig.json", limit: 10 }, native: { bin: "find", args: [".", "-name", "tsconfig.json"] } },
  { id: "grep-symbol", tool: "grep", params: { pattern: "FSearchClient", mode: "literal", limit: 10 }, native: { bin: "rg", args: ["-n", "--no-heading", "FSearchClient", "."] }, heuristic: "fsearch_grep" },
];

function parseArgs(argv) {
  const args = { pairs: 30, json: false, forceDegraded: false, out: OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pairs") args.pairs = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--force-degraded") args.forceDegraded = true;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new FSearchClient();
  if (!(await client.ping())) {
    console.error("REFUSED: daemon not running; token A/B needs the live tool path.");
    client.close();
    process.exit(2);
  }
  const gate = await environmentWithDaemon(client);
  console.log(formatEnvironmentGate(gate));
  if (!gate.ok && !args.forceDegraded) {
    console.error("REFUSED: environment gate failed (--force-degraded writes a degraded record only).");
    client.close();
    process.exit(3);
  }

  const originalCwd = process.cwd();
  process.chdir(REPO_ROOT);
  const harness = await loadPiTools();

  const perTask = new Map();
  for (const task of TASKS) perTask.set(task.id, { ultraChars: [], nativeChars: [], rows: [] });

  const observations = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roundFor = (i) => TASKS[i % TASKS.length];
  const maxRounds = Math.max(1, Math.ceil(args.pairs / TASKS.length));

  const runUltra = async (task) => {
    const result = await harness.callTool(task.tool === "query" ? "_query" : task.tool === "grep" ? "_grep" : "_multi_grep", task.params);
    const text = result.content?.[0]?.text ?? "";
    return { chars: text.length, details: result.details ?? null, text };
  };
  const runNative = async (task) => {
    const res = await spawnCapture(task.native.bin, task.native.args, { cwd: REPO_ROOT, timeoutMs: 30000, maxBuffer: 64 * 1024 * 1024 });
    const chars = res.stdout.length;
    return { chars, hits: res.stdout.split("\n").filter(Boolean).length };
  };

  for (let round = 0; round < maxRounds; round++) {
    const task = roundFor(round);
    const bucket = perTask.get(task.id);
    let ultra = null;
    let native = null;
    if (round % 2 === 0) {
      ultra = await runUltra(task);
      native = await runNative(task);
    } else {
      native = await runNative(task);
      ultra = await runUltra(task);
    }
    bucket.ultraChars.push(ultra.chars);
    bucket.nativeChars.push(native.chars);
    bucket.rows.push({ round, ultraChars: ultra.chars, nativeChars: native.chars, ultraTokens: estimateTokens(ultra.chars), nativeTokens: estimateTokens(native.chars), hits: native.hits, details: ultra.details });
    observations.push({ task: task.id, ultraChars: ultra.chars, nativeChars: native.chars, ultraTokens: estimateTokens(ultra.chars), nativeTokens: estimateTokens(native.chars) });
    await sleep(2);
  }

  process.chdir(originalCwd);

  const pairs = observations.length;
  const ultraTokens = observations.map((o) => o.ultraTokens);
  const nativeTokens = observations.map((o) => o.nativeTokens);

  const nativeMinusUltra = observations.map((o) => o.nativeTokens - o.ultraTokens);
  const tokenDelta = pairedDeltaCI(nativeTokens, ultraTokens, { resamples: 10000, alpha: 0.05, seed: 0x70c3 });
  const tokenRatio = pairedRatioCI(nativeTokens, ultraTokens, { resamples: 10000, alpha: 0.05, seed: 0x70c4 });
  const savingsRatio = {
    ...tokenRatio,
    point: 1 - tokenRatio.point,
    lo: 1 - tokenRatio.hi,
    hi: 1 - tokenRatio.lo,
    quantity: "fraction of tokens saved (1 - ultra/native)",
  };

  const report = {
    schema: "ultrasearch.bench.tokens/v1",
    status: gate.ok ? "final" : "degraded",
    date: new Date().toISOString().slice(0, 10),
    startedAt: new Date().toISOString(),
    method: {
      estimator: "ceil(chars / 4) — documented ESTIMATE, same as src/formatter.ts; sensitivity estimator ceil(chars/3.5) also reported",
      design: `counterbalanced A/B alternating arm order; ${pairs} paired observations across ${TASKS.length} tasks`,
      statistic: "median",
      ci: "BCa bootstrap, 10000 resamples, alpha=0.05, on paired deltas",
      ultraArm: "Pi tool formatting path (index.ts -> formatGrepFiles / path listing)",
      nativeArm: "raw stdout of the equivalent rg/find command in the same workspace",
      heuristic: "legacy 150 + 75×hits (grep) / 100 + 30×hits (path) comparison; labelled an ESTIMATE everywhere",
    },
    environment: gate.info,
    environmentGate: { ok: gate.ok, reasons: gate.reasons },
    corpus: REPO_ROOT,
    pairs,
    ultraTokens: summarize(ultraTokens),
    nativeTokens: summarize(nativeTokens),
    tokenDelta,
    savingsRatio,
    perTask: Object.fromEntries(
      [...perTask.entries()].map(([id, b]) => [
        id,
        {
          n: b.rows.length,
          ultraChars: summarize(b.ultraChars),
          nativeChars: summarize(b.nativeChars),
          ultraTokens: summarize(b.ultraChars.map(estimateTokens)),
          nativeTokens: summarize(b.nativeChars.map(estimateTokens)),
          medianSavingsFraction: 1 - summarize(b.ultraChars).median / Math.max(1, summarize(b.nativeChars).median),
        },
      ])
    ),
    heuristicComparison: [...perTask.entries()].map(([id, b]) => {
      const hits = b.rows.map((r) => r.hits);
      const maxHits = hits.length ? Math.max(...hits) : 0;
      const tool = TASKS.find((t) => t.id === id)?.heuristic;
      const predicted = tool ? legacyHeuristic(tool, maxHits) : null;
      const measuredNative = summarize(b.nativeChars).median ? estimateTokens(summarize(b.nativeChars).median) : 0;
      const measuredUltra = summarize(b.ultraChars).median ? estimateTokens(summarize(b.ultraChars).median) : 0;
      const heuristicSaved = typeof predicted === "number" ? predicted : null;
      return {
        task: id,
        hitsUsedForHeuristic: maxHits,
        heuristicSavedTokens: heuristicSaved,
        measuredOutputSavedTokens: Math.round(measuredNative - measuredUltra),
        heuristicOverstates: heuristicSaved !== null && measuredNative > 0 ? heuristicSaved > measuredNative - measuredUltra : null,
      };
    }),
    observations,
    finishedAt: new Date().toISOString(),
  };

  fs.mkdirSync(args.out, { recursive: true });
  const jsonPath = path.join(args.out, `tokens-${report.date}${report.status === "final" ? "" : "-degraded"}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    "# Prompt-token A/B — measured output vs native tools (issue #20)",
    "",
    `Generated ${report.date} · ${pairs} paired observations · status: ${report.status}`,
    "",
    "## Method (and what is an estimate)",
    "",
    "- Token counts are **estimates** from `ceil(chars / 4)` — the same estimator `src/formatter.ts` uses. This is NOT a specific tokenizer's measurement. A sensitivity estimator `ceil(chars / 3.5)` is also recorded in the JSON.",
    "- Treatment: the Pi tool formatting path (`index.ts` → `formatGrepFiles` / path listing). Control: the raw stdout of the equivalent `rg`/`find` command in the same workspace, i.e. what a bash tool call would put in context.",
    "- Design: counterbalanced alternating A/B; median over mean; BCa bootstrap CI, 10k resamples, on paired deltas.",
    "- The legacy TUI number `150 + 75 × hits` is kept as an **estimate** and compared against measured output below.",
    "",
    "## Result",
    "",
    `- ultra-search median: **${fmt(report.ultraTokens.median, 1)} estimated tokens** (p95 ${fmt(report.ultraTokens.p95, 1)})`,
    `- native median: **${fmt(report.nativeTokens.median, 1)} estimated tokens** (p95 ${fmt(report.nativeTokens.p95, 1)})`,
    `- saved fraction (1 − ultra/native): **${fmtCI(report.savingsRatio, 3)}**`,
    `- paired delta (native − ultra): **${fmtCI(report.tokenDelta, 1)} estimated tokens**`,
    "",
    "| task | n | ultra (est. tokens) | native (est. tokens) | median savings |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(report.perTask).map(
      ([id, t]) => `| ${id} | ${t.n} | ${fmt(t.ultraTokens.median, 1)} | ${fmt(t.nativeTokens.median, 1)} | ${(t.medianSavingsFraction * 100).toFixed(1)}% |`
    ),
    "",
    "## Heuristic vs measurement",
    "",
    "The `150 + 75 × hits` formula remains an estimate. On identical runs:",
    "",
    "| task | hits used | heuristic saved (est.) | measured output saved (est.) | heuristic overstates |",
    "| --- | --- | --- | --- | --- |",
    ...report.heuristicComparison.map(
      (h) => `| ${h.task} | ${h.hitsUsedForHeuristic} | ${h.heuristicSavedTokens ?? "n/a"} | ${h.measuredOutputSavedTokens} | ${h.heuristicOverstates === null ? "n/a" : h.heuristicOverstates} |`
    ),
    "",
    `Raw JSON: \`bench/results/${path.basename(jsonPath)}\``,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(args.out, "TOKENS.md"), md);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\n=== prompt-token A/B (${pairs} paired observations, ESTIMATED tokens, chars/4) ===`);
    console.log(`ultra  median ${fmt(report.ultraTokens.median, 1)} tokens  p95 ${fmt(report.ultraTokens.p95, 1)}`);
    console.log(`native median ${fmt(report.nativeTokens.median, 1)} tokens  p95 ${fmt(report.nativeTokens.p95, 1)}`);
    console.log(`saved fraction: ${fmtCI(report.savingsRatio, 3)} (median ratio)`);
    console.log(`paired delta (native - ultra): ${fmtCI(report.tokenDelta, 1)} tokens`);
    for (const [id, t] of Object.entries(report.perTask)) {
      console.log(`  ${id.padEnd(16)} n=${t.n} ultra ${fmt(t.ultraTokens.median, 1)}t vs native ${fmt(t.nativeTokens.median, 1)}t -> ${(t.medianSavingsFraction * 100).toFixed(1)}% smaller`);
    }
    console.log(`wrote ${jsonPath}`);
  }
  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
