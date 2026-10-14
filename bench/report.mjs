#!/usr/bin/env node
/**
 * Renders bench/results/SCOPES.md from the latest multi-scope JSON.
 * Reproducible: re-run after any bench/run.mjs invocation.
 *
 * Usage: node bench/report.mjs [--input bench/results/scopes-<date>.json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");

function parseArgs(argv) {
  const args = { input: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = path.resolve(argv[++i]);
  }
  return args;
}

function latestScopesFile() {
  const files = fs
    .readdirSync(RESULTS)
    .filter((f) => /^scopes-\d{4}-\d{2}-\d{2}(-degraded)?\.json$/.test(f))
    .sort();
  return files.length ? path.join(RESULTS, files[files.length - 1]) : null;
}

const f = (x, d = 2) => (Number.isFinite(x) ? Number(x).toFixed(d) : "n/a");
const ci = (c, d = 2) => (c && Number.isFinite(c.point) ? `${f(c.point, d)} [${f(c.lo, d)}, ${f(c.hi, d)}]` : "n/a");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input ?? latestScopesFile();
  if (!input || !fs.existsSync(input)) {
    console.error("no scopes JSON found; run `npm run bench:scopes` first");
    process.exit(2);
  }
  const run = JSON.parse(fs.readFileSync(input, "utf-8"));
  const lines = [];
  lines.push("# Multi-scope benchmark — ultra-search vs rg/find");
  lines.push("");
  lines.push(`Source: \`${path.relative(process.cwd(), input)}\` · status: **${run.status}** · date: ${run.date}`);
  lines.push("");
  if (run.status !== "final") {
    lines.push("> **Degraded run.** The environment gate refused a final result for these reasons:");
    lines.push(`> ${(run.environmentGate?.reasons ?? []).map((r) => `\`${r}\``).join(" · ")}`);
    lines.push("> Numbers below are directional and must not be quoted as final.");
    lines.push("");
  }
  lines.push("## Method");
  lines.push("");
  for (const [k, v] of Object.entries(run.method ?? {})) lines.push(`- **${k}**: ${v}`);
  lines.push(`- **environment**: power=${run.environment?.powerSource ?? "?"} · load1m=${run.environment?.load1m ?? "?"} · daemon pid=${run.environment?.daemon?.pid ?? "?"} · index_bytes=${run.environment?.daemon?.index_bytes ?? "?"}`);
  lines.push("");
  lines.push("## Latency and equivalence");
  lines.push("");
  lines.push("| scope | query | n | ultra p50 | ultra p95 | native p50 | native p95 | speedup (ratio CI) | Δms (CI) | equivalent |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [scope, data] of Object.entries(run.scopes ?? {})) {
    for (const q of data.queries ?? []) {
      lines.push(
        `| ${scope} | ${q.id} | ${q.n} | ${f(q.ultra.p50)}ms | ${f(q.ultra.p95)}ms${q.ultra.p95IsMax ? " (max)" : ""} | ${f(q.native.p50)}ms | ${f(q.native.p95)}ms | ${ci(q.pairedRatio)} | ${ci(q.pairedDeltaMs)} | ${q.equivalence?.pass ? "yes" : "NO"} (index-only ${q.equivalence?.indexOnlyCount ?? "?"}, native-only ${q.equivalence?.nativeOnlyCount ?? "?"}) |`
      );
    }
  }
  lines.push("");
  lines.push("Intentional divergence (declared `.gitignore` rules):");
  for (const [scope, data] of Object.entries(run.scopes ?? {})) {
    if (data.ignoreFiltering) {
      lines.push(
        `- ${scope}: \`${data.ignoreFiltering.file}\` — ultra returned ${data.ignoreFiltering.ultraReturned}, raw find returned ${data.ignoreFiltering.nativeReturned} → correctlyExcluded=${data.ignoreFiltering.correctlyExcluded}`
      );
      if (data.ignoreFiltering.nested) {
        lines.push(
          `  - nested-rule probe (known gap): \`${data.ignoreFiltering.nested.file}\` → ultra returned ${data.ignoreFiltering.nested.ultraReturned} (honoured=${data.ignoreFiltering.nested.honoured})`
        );
      }
    }
  }
  lines.push("");
  if (run.relevance) {
    if (run.relevance.skipped) {
      lines.push(`## Relevance\n\nSkipped: ${run.relevance.reason}`);
    } else {
      const a = run.relevance.aggregate;
      lines.push("## Relevance (wave1 judgment corpus)");
      lines.push("");
      lines.push(`- recall@1/3/5/10: ${f(a.recallAt1, 3)} / ${f(a.recallAt3, 3)} / ${f(a.recallAt5, 3)} / ${f(a.recallAt10, 3)}`);
      lines.push(`- MRR@10: ${f(a.mrr10, 3)} · nDCG@10: ${f(a.ndcg10, 3)}`);
      lines.push(`- zero-result rate: ${f(a.zeroResultRate * 100, 1)}% · false-positive rate: ${f(a.falsePositiveRate * 100, 1)}% · reformulation: ${f(a.reformulationSignal * 100, 1)}%`);
      lines.push("");
      lines.push("| gate | value | threshold | pass |");
      lines.push("| --- | --- | --- | --- |");
      for (const c of run.relevance.checks) lines.push(`| ${c.name} | ${f(c.value, 3)} | ${c.threshold} | ${c.pass ? "PASS" : "FAIL"} |`);
      lines.push("");
      lines.push("| baseline | value | baseline | Δ | beats |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const [k, v] of Object.entries(run.relevance.baselineComparison ?? {})) {
        if (k === "source") continue;
        lines.push(`| ${k} | ${f(v.value, 3)} | ${v.baseline} | ${v.delta >= 0 ? "+" : ""}${f(v.delta, 3)} | ${v.beats ? "yes" : "no"} |`);
      }
      lines.push("");
      lines.push("| lane | queries | recall@10 | MRR@10 | nDCG@10 | zero-result | FP | reformulation |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const [lane, s] of Object.entries(a.perLane ?? {})) {
        lines.push(`| ${lane} | ${s.queries} | ${f(s.recallAt10, 3)} | ${f(s.mrr10, 3)} | ${f(s.ndcg10, 3)} | ${f(s.zeroResultRate * 100, 1)}% | ${f(s.falsePositiveRate * 100, 1)}% | ${f(s.reformulationSignal * 100, 1)}% |`);
      }
    }
  }
  lines.push("");
  const outPath = path.join(RESULTS, "SCOPES.md");
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`wrote ${outPath}`);
}

main();
