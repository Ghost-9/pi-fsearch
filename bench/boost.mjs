#!/usr/bin/env node
/**
 * boost on/off A/B on the judgment corpus (advisor finding #5).
 *
 * `boost:true` (frecency + git history + mtime) is sent on every client search
 * and had never been measured. This runs paired, counterbalanced search calls
 * with boost on (treatment) and off (control), scores both arms with the wave1
 * judgment set (nDCG@10 / MRR@10 / recall@10) and reports the paired ΔnDCG CI.
 *
 * Decision rule published with the result: keep boost only when the CI excludes
 * 0 and the point delta is >= +0.05 nDCG@10 (the judgment set's ranking-claim bar).
 *
 * Usage: node bench/boost.mjs [--pairs 30] [--json] [--force-degraded]
 */
process.env.PI_ULTRASEARCH_TEST = "1";
process.env.PI_ULTRASEARCH_BENCH = "1";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FSearchClient } from "../src/client.ts";
import { loadJudgments, scoreQuery, toRepoRelative } from "./lib/judgments.mjs";
import { pairedDeltaCI, ciExcludesZero, summarize, fmt, fmtCI } from "./lib/stats.mjs";
import { environmentWithDaemon, formatEnvironmentGate } from "./lib/env-gate.mjs";
import { REPO_ROOT } from "./lib/relevance-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results");
const BOOST_LANES = new Set(["path", "ranking-boost-ab", "ranking-proximity", "ranking-frecency"]);

function parseArgs(argv) {
  const args = { pairs: 30, json: false, forceDegraded: false, frecencyWaitSec: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pairs") args.pairs = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--force-degraded") args.forceDegraded = true;
    else if (a === "--frecency-wait-sec") args.frecencyWaitSec = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new FSearchClient();
  if (!(await client.ping())) {
    console.error("REFUSED: daemon not running; the boost A/B needs the live ranking engine.");
    process.exit(2);
  }
  const gate = await environmentWithDaemon(client);
  console.log(formatEnvironmentGate(gate));
  if (!gate.ok && !args.forceDegraded) {
    console.error("REFUSED: environment gate failed (--force-degraded writes a degraded record only).");
    client.close();
    process.exit(3);
  }

  const judgments = loadJudgments(REPO_ROOT);
  if (!judgments || judgments.error) {
    console.error(`REFUSED: judgment set unavailable (${judgments?.error ?? "not found"})`);
    client.close();
    process.exit(2);
  }
  const corpusRoot = judgments.data.corpus.root;
  const queries = judgments.data.queries.filter((q) => BOOST_LANES.has(q.lane) && q.must_hit !== false);
  if (queries.length === 0) {
    console.error("REFUSED: no boost-relevant must-hit queries in the judgment set.");
    client.close();
    process.exit(2);
  }

  // The frecency judgment expects an open to have happened; do it once.
  await client.open(path.join(corpusRoot, "README.md"));
  if (args.frecencyWaitSec > 0) await new Promise((r) => setTimeout(r, args.frecencyWaitSec * 1000));

  const observations = [];
  const rounds = Math.max(1, Math.ceil(args.pairs / queries.length));
  for (let round = 0; round < rounds; round++) {
    for (const q of queries) {
      const limit = q.params?.limit ?? 10;
      const baseOptions = { in: corpusRoot, limit, skipAudit: true };
      if (q.params?.near) baseOptions.near = path.join(corpusRoot, q.params.near);
      const runArm = async (boost) => {
        const res = await client.search(q.query, { ...baseOptions, boost });
        const paths = (res.hits ?? []).map((h) => toRepoRelative(corpusRoot, h.path));
        return { paths, score: scoreQuery(q, paths) };
      };
      let on;
      let off;
      if (round % 2 === 0) {
        on = await runArm(true);
        off = await runArm(false);
      } else {
        off = await runArm(false);
        on = await runArm(true);
      }
      observations.push({
        id: q.id,
        round,
        ndcgOn: on.score.ndcg10,
        ndcgOff: off.score.ndcg10,
        mrrOn: on.score.mrr10,
        mrrOff: off.score.mrr10,
        recallOn: on.score.recallAt[10],
        recallOff: off.score.recallAt[10],
        top1On: on.paths[0] ?? null,
        top1Off: off.paths[0] ?? null,
        top5On: on.paths.slice(0, 5),
        top5Off: off.paths.slice(0, 5),
        rankChanges: on.paths.slice(0, 5).filter((p, i) => off.paths[i] !== p).length,
      });
    }
  }

  const ndcgOn = observations.map((o) => o.ndcgOn);
  const ndcgOff = observations.map((o) => o.ndcgOff);
  const deltaCI = pairedDeltaCI(ndcgOn, ndcgOff, { resamples: 10000, alpha: 0.05, seed: 0xb0057 });
  const recallOn = observations.map((o) => o.recallOn);
  const recallOff = observations.map((o) => o.recallOff);
  const recallDelta = pairedDeltaCI(recallOn, recallOff, { resamples: 10000, alpha: 0.05, seed: 0xb0058 });

  // Per-query summary with rank diffs
  const perQuery = [...new Set(observations.map((o) => o.id))].map((id) => {
    const rows = observations.filter((o) => o.id === id);
    return {
      id,
      observations: rows.length,
      ndcgOn: summarize(rows.map((r) => r.ndcgOn)),
      ndcgOff: summarize(rows.map((r) => r.ndcgOff)),
      meanRankChanges: rows.reduce((a, r) => a + r.rankChanges, 0) / rows.length,
      top1On: rows[0]?.top1On ?? null,
      top1Off: rows[0]?.top1Off ?? null,
      top5On: rows[0]?.top5On ?? null,
      top5Off: rows[0]?.top5Off ?? null,
    };
  });

  const decision = {
    quantify: "paired delta of nDCG@10 (boost on - boost off)",
    ciExcludesZero: ciExcludesZero(deltaCI),
    point: deltaCI.point,
    meetsJudgmentBar: deltaCI.point >= 0.05,
    keepBoost: ciExcludesZero(deltaCI) && deltaCI.point >= 0.05,
  };

  const report = {
    schema: "ultrasearch.bench.boost/v1",
    status: gate.ok ? "final" : "degraded",
    date: new Date().toISOString().slice(0, 10),
    startedAt: new Date().toISOString(),
    method: {
      treatment: "search boost:true (frecency + git history + mtime)",
      control: "search boost:false",
      corpus: corpusRoot,
      judgmentSource: judgments.file,
      design: `counterbalanced paired observations across ${queries.length} queries, ${rounds} rounds, ${observations.length} pairs`,
      ci: "BCa bootstrap, 10000 resamples, alpha=0.05, on paired deltas of per-query nDCG@10",
      decisionRule: "keep boost only if CI excludes 0 and point delta >= +0.05 nDCG@10",
    },
    environment: gate.info,
    environmentGate: { ok: gate.ok, reasons: gate.reasons },
    pairs: observations.length,
    ndcgOn: summarize(ndcgOn),
    ndcgOff: summarize(ndcgOff),
    deltaNdCG10: deltaCI,
    deltaRecall10: recallDelta,
    decision,
    perQuery,
    observations,
    finishedAt: new Date().toISOString(),
  };

  fs.mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, `boost-${report.date}${report.status === "final" ? "" : "-degraded"}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = [
    "# boost on/off A/B (wave1/measure)",
    "",
    `- corpus: \`${corpusRoot}\` · judgment set: \`${judgments.file}\``,
    `- pairs: ${observations.length} (counterbalanced) · CI: BCa, 10k resamples on paired ΔnDCG@10`,
    `- decision rule: ${report.method.decisionRule}`,
    "",
    "| arm | median nDCG@10 | p95 |",
    "| --- | --- | --- |",
    `| boost:true | ${fmt(report.ndcgOn.median, 3)} | ${fmt(report.ndcgOn.p95, 3)} |`,
    `| boost:false | ${fmt(report.ndcgOff.median, 3)} | ${fmt(report.ndcgOff.p95, 3)} |`,
    "",
    `**ΔnDCG@10 (on − off): ${fmtCI(deltaCI, 3)}** · CI excludes 0: ${decision.ciExcludesZero} · keep boost: **${decision.keepBoost}**`,
    "",
    "| query | obs | nDCG on | nDCG off | mean rank changes (top-5) |",
    "| --- | --- | --- | --- | --- |",
    ...perQuery.map((p) => `| ${p.id} | ${p.observations} | ${fmt(p.ndcgOn.median, 3)} | ${fmt(p.ndcgOff.median, 3)} | ${fmt(p.meanRankChanges)} |`),
    "",
    "Raw JSON: `bench/results/" + path.basename(jsonPath) + "`",
    "",
  ].join("\n");
  const mdPath = path.join(OUT, "BOOST.md");
  fs.writeFileSync(mdPath, md);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`\n=== boost on/off, ${observations.length} paired observations ===`);
    console.log(`nDCG@10 on  median ${fmt(report.ndcgOn.median, 3)}  off median ${fmt(report.ndcgOff.median, 3)}`);
    console.log(`ΔnDCG@10 ${fmtCI(deltaCI, 3)} | CI excludes 0: ${decision.ciExcludesZero} | keep boost: ${decision.keepBoost}`);
    console.log(`wrote ${jsonPath} and ${mdPath}`);
  }
  client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
