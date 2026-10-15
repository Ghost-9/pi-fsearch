#!/usr/bin/env node
/**
 * Nightly real-session summary (issue #31).
 *
 * Reads the production audit log and the isolated test/bench log, separates
 * organic rows from synthetic ones, and writes a dated artifact with real-only
 * percentiles plus the fallback and zero-hit rates. No environment gate: this
 * summarises existing rows, it does not measure the machine.
 *
 * Usage: node bench/nightly-summary.mjs [--limit 5000] [--out bench/results]
 * Cron:  0 3 * * *  cd <repo> && npm run metrics:nightly
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllAudit, summarizeAuditViews, formatAuditSummary, getTestAuditFilePath } from "../src/telemetry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { limit: 5000, out: path.join(HERE, "results"), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--json") args.json = true;
  }
  return args;
}

function rates(summary) {
  const total = summary.totalCalls;
  const fallback = summary.toolStats.reduce((acc, s) => acc + s.fallbackCount, 0);
  const zeroHit = summary.toolStats.reduce((acc, s) => {
    const calls = s.calls;
    return acc + (calls > 0 ? (s.emptyRate / 100) * calls : 0);
  }, 0);
  return {
    calls: total,
    fallbackCount: fallback,
    fallbackRate: total > 0 ? fallback / total : 0,
    zeroHitCount: Math.round(zeroHit),
    zeroHitRate: total > 0 ? zeroHit / total : 0,
    tokensSavedEstimate: summary.totalTokensSaved,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadAllAudit(args.limit, { includeProduction: true, includeTest: true });
  const views = summarizeAuditViews(rows);

  const date = new Date().toISOString().slice(0, 10);
  const report = {
    schema: "ultrasearch.telemetry.nightly/v1",
    date,
    generatedAt: new Date().toISOString(),
    source: {
      productionFile: path.join(process.env.HOME ?? "", ".pi/agent/cache/pi-ultrasearch/audit.jsonl"),
      testFile: getTestAuditFilePath(),
      testLogNote: "per-process since F7; set PI_ULTRASEARCH_TEST_LOG to read a specific run",
      rowsLoaded: rows.length,
    },
    note: "tokensSaved is the 150+75×hits ESTIMATE, not a measurement",
    real: { originCounts: views.real.originCounts, ...rates(views.real), perTool: views.real.toolStats },
    synthetic: { originCounts: views.synthetic.originCounts, ...rates(views.synthetic), perTool: views.synthetic.toolStats },
    all: { originCounts: views.all.originCounts, ...rates(views.all) },
  };

  fs.mkdirSync(args.out, { recursive: true });
  const jsonPath = path.join(args.out, `nightly-${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    `# Nightly audit summary — ${date}`,
    "",
    `Rows loaded: ${rows.length} · production + isolated test log`,
    "",
    "| view | calls | fallback rate | zero-hit rate | tokens saved (ESTIMATE) |",
    "| --- | --- | --- | --- | --- |",
    `| real (organic) | ${report.real.calls} | ${(report.real.fallbackRate * 100).toFixed(1)}% | ${(report.real.zeroHitRate * 100).toFixed(1)}% | ${report.real.tokensSavedEstimate} |`,
    `| synthetic (gate/bench) | ${report.synthetic.calls} | ${(report.synthetic.fallbackRate * 100).toFixed(1)}% | ${(report.synthetic.zeroHitRate * 100).toFixed(1)}% | ${report.synthetic.tokensSavedEstimate} |`,
    `| all | ${report.all.calls} | | | |`,
    "",
    "## Real-session tools",
    "",
    "| tool | calls | p50 | p95 | fallbacks | zero-hit |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.real.perTool.map((s) => `| ${s.tool} | ${s.calls} | ${s.p50Ms.toFixed(2)}ms | ${s.p95Ms.toFixed(2)}ms | ${s.fallbackCount} | ${s.emptyRate.toFixed(1)}% |`),
    "",
    "Raw JSON: `bench/results/" + path.basename(jsonPath) + "`",
    "",
  ].join("\n");
  const mdPath = path.join(args.out, `nightly-${date}.md`);
  fs.writeFileSync(mdPath, md);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(formatAuditSummary(views.real));
    console.log(`\nsynthetic rows excluded from the default view: ${report.synthetic.calls}`);
    console.log(`wrote ${jsonPath} and ${mdPath}`);
  }
}

main();
