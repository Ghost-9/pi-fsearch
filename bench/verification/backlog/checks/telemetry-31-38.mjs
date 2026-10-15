#!/usr/bin/env node
// bench/verification/backlog/checks/telemetry-31-38.mjs — issues #31, #38
//
// #31: real-vs-synthetic telemetry view (real-only default, origin tags) and a
//      nightly real-session summary produced without manual steps.
// #38: tool-description prompt tax — re-measure the estimator myself and state
//      the number I get, before and after the trim.
//
// Independent method: rows built by the verifier with explicit/absent origins;
// the real CLI `report` run against a temp audit log; the prompt tax measured
// by a verifier-owned serializer over HEAD and over the pre-trim commit
// (3d1268d~1) extracted with `git archive`, plus the shipped estimator script.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, gate, run, tmpdir, rmrf, writeArtifact, stableHash, sha256Text } from "../lib.mjs";

const CLI = path.join(REPO, "bin", "cli.ts");

/** Verifier-owned prompt-tax measurement: serialize what the model is charged. */
async function measureTax(root, label) {
  const { TOOL_SCHEMAS, toolJsonSchema } = await import(path.join(root, "src", "tool-schema.ts"));
  const mcpEntries = TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) }));
  const { loadPiTools } = await import(path.join(root, "bench", "lib", "pi-tools.mjs"));
  const harness = await loadPiTools();
  const piEntries = [...harness.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? {} }));
  const sum = (entries) => {
    const perTool = entries.map((e) => ({ name: e.name, chars: JSON.stringify(e).length }));
    const chars = perTool.reduce((n, r) => n + r.chars, 0);
    return { label, tools: perTool, chars, tokens_c4: Math.ceil(chars / 4), tokens_c35: Math.ceil(chars / 3.5) };
  };
  return { mcp: sum(mcpEntries), pi: sum(piEntries) };
}

export async function check() {
  const g = gate();
  const rows = [];
  const home = tmpdir("ults-tel-");
  const audit = path.join(home, "audit.jsonl");
  const testLog = path.join(home, "test-audit.jsonl");

  // ---- #31: rows with explicit origins, one unmarked legacy row ----
  const rowsIn = [
    { ts: 3, tool: "ultrasearch_query", query: "alpha-organic", ms: 5, ok: true, hitCount: 2, source: "index", origin: "organic", harness: "pi" },
    { ts: 2, tool: "ultrasearch_grep", pattern: "beta", ms: 20, ok: true, hitCount: 0, source: "native_fallback", origin: "synthetic", harness: "bench" },
    { ts: 1, tool: "ultrasearch_query", query: "gamma-unmarked", ms: 3, ok: true, hitCount: 1, source: "index" },
  ];
  const prodDir = path.join(home, ".pi", "agent", "cache", "pi-ultrasearch");
  fs.mkdirSync(prodDir, { recursive: true });
  const prodAudit = path.join(prodDir, "audit.jsonl");
  fs.writeFileSync(prodAudit, rowsIn.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(audit, "");

  const { summarizeAuditViews, summarizeAudit, loadAudit, recordAudit } = await import(path.join(REPO, "src", "telemetry.ts"));
  const views = summarizeAuditViews(rowsIn);
  const defaultSummary = summarizeAudit(100, { rows: rowsIn });

  // origin stamping: synthetic env -> synthetic; harness tag resolved
  rmrf(testLog);
  process.env.PI_ULTRASEARCH_TEST_LOG = testLog;
  process.env.PI_ULTRASEARCH_TEST = "1";
  const { recordAudit: rec2 } = await import(path.join(REPO, "src", "telemetry.ts"));
  rec2({ ts: Date.now(), tool: "ultrasearch_query", query: "stamp", ms: 1, ok: true, hitCount: 1, source: "index" });
  const stamped = loadAudit(10).filter((r) => r.query === "stamp").pop();

  // a real CLI report run must default to the real view
  const report = await run("node", [CLI, "report", "--json", "--limit", "50"], {
    cwd: REPO,
    env: { HOME: home, PI_ULTRASEARCH_TEST_LOG: audit, PI_ULTRASEARCH_TEST: "" },
    timeoutMs: 60000,
  });
  let reportJson = null;
  try {
    reportJson = JSON.parse(report.stdout);
  } catch {
    /* reported below */
  }

  // nightly artifact: does the repo wire it without a manual step?
  const nightlyScript = fs.readFileSync(path.join(REPO, "bench", "nightly-summary.mjs"), "utf-8");
  const nightlyArtifacts = fs.existsSync(path.join(REPO, "bench", "results"))
    ? fs.readdirSync(path.join(REPO, "bench", "results")).filter((f) => f.startsWith("nightly-"))
    : [];
  const ciWiring = await run("sh", ["-c", `cd ${REPO} && grep -rl "nightly" .github/workflows/ 2>/dev/null || true`]);
  const cronWiring = await run("sh", ["-c", "crontab -l 2>/dev/null | grep -i ultrasearch || true"]);

  const telDefects = [];
  if (!(views.real.totalCalls === 2 && views.synthetic.totalCalls === 1 && views.all.totalCalls === 3))
    telDefects.push(`view split wrong: real=${views.real.totalCalls} synthetic=${views.synthetic.totalCalls} all=${views.all.totalCalls}`);
  if (defaultSummary.view !== "real") telDefects.push(`default view is ${defaultSummary.view}, not real`);
  if (!(reportJson && reportJson.view === "real" && reportJson.totalCalls === 2 && reportJson.originCounts?.synthetic === 1 && reportJson.filteredOutRows === 1))
    telDefects.push(`CLI report default view/exclusion wrong: ${JSON.stringify(reportJson && { view: reportJson.view, totalCalls: reportJson.totalCalls, originCounts: reportJson.originCounts })}`);
  if (stamped?.origin !== "synthetic") telDefects.push(`recordAudit origin=${stamped?.origin}, expected synthetic`);
  if (!stamped?.harness) telDefects.push("recordAudit did not stamp a harness tag");
  if (ciWiring.stdout.trim() === "" && cronWiring.stdout.trim() === "")
    telDefects.push("nightly summary is not wired into CI or cron: acceptance says it is produced without manual steps");

  const telArtifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    views: { real: views.real.totalCalls, synthetic: views.synthetic.totalCalls, all: views.all.totalCalls, default_view: defaultSummary.view, filtered_out: defaultSummary.filteredOutRows },
    cli_report: reportJson ? { view: reportJson.view, totalCalls: reportJson.totalCalls, originCounts: reportJson.originCounts, filteredOutRows: reportJson.filteredOutRows } : { error: report.stderr.slice(-300) },
    stamped_row: stamped ?? null,
    nightly: { artifacts: nightlyArtifacts, ci_wiring: ciWiring.stdout.trim().split("\n").filter(Boolean), cron_lines: cronWiring.stdout.trim(), documented_cron: /Cron:\s*0 3 \* \* \*/.test(nightlyScript) },
    defects: telDefects,
  };
  const telWritten = writeArtifact("bench/verification/backlog/results/f31-telemetry.json", telArtifact);

  rows.push({
    issue: 31,
    claim: "real-vs-synthetic telemetry view: real-only percentiles by default, origin tags, and a nightly summary artifact produced without manual steps",
    verdict: telDefects.length ? "needs-work" : "verified",
    evidence:
      `views on a 3-row log (organic/synthetic/unmarked): real=${views.real.totalCalls}, synthetic=${views.synthetic.totalCalls}, all=${views.all.totalCalls}; default view=${defaultSummary.view}; ` +
      `real CLI \`report --json\` default: view=${reportJson?.view}, totalCalls=${reportJson?.totalCalls}, originCounts=${JSON.stringify(reportJson?.originCounts)}; ` +
      `recordAudit under PI_ULTRASEARCH_TEST stamped origin=${stamped?.origin} harness=${stamped?.harness}; ` +
      `nightly artifacts on disk=${JSON.stringify(nightlyArtifacts)}, CI wiring=${JSON.stringify(ciWiring.stdout.trim())}, cron wiring=${JSON.stringify(cronWiring.stdout.trim()) || '""'}`,
    method: "verifier-built audit log with explicit and absent origins; the real CLI report run against it; recordAudit observed under PI_ULTRASEARCH_TEST; CI/cron checked for the nightly job",
    n: 6,
    gate: g.status,
    artifact: "bench/verification/backlog/results/f31-telemetry.json",
    evidence_hashes: { artifact: telWritten.sha256, probe: stableHash(telArtifact) },
    notes: telDefects.length ? telDefects.join(" | ") : "view split, default, origin tags and nightly artifact reproduced",
  });

  // ---- #38: prompt tax, re-measured by the verifier ----
  const head = await measureTax(REPO, "head");
  const beforeDir = tmpdir("ults-desc-before-");
  const tar = path.join(beforeDir, "t.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "3d1268d~1"], { cwd: REPO });
  execFileSync("tar", ["-xf", tar, "-C", beforeDir]);
  fs.rmSync(tar, { force: true });
  fs.cpSync(path.join(REPO, "bench", "tool-descriptions.mjs"), path.join(beforeDir, "bench", "tool-descriptions.mjs"));
  const before = await measureTax(beforeDir, "pre-trim-3d1268d~1");

  // the shipped estimator, run by me, on both trees
  const shippedHead = await run("node", [path.join(REPO, "bench", "tool-descriptions.mjs"), "--json"], { cwd: REPO, timeoutMs: 60000 });
  let shippedHeadJson = null;
  try {
    shippedHeadJson = JSON.parse(shippedHead.stdout);
  } catch {
    /* ignore */
  }

  const published = { mcp_after: 938, pi_after: 667, mcp_before: 1056, pi_before: 1012 };
  const measured = {
    mcp_before: before.mcp.tokens_c4,
    mcp_after: head.mcp.tokens_c4,
    pi_before: before.pi.tokens_c4,
    pi_after: head.pi.tokens_c4,
  };

  const descDefects = [];
  if (measured.mcp_after !== published.mcp_after) descDefects.push(`mcp after ${measured.mcp_after} != published ${published.mcp_after}`);
  if (measured.pi_after !== published.pi_after) descDefects.push(`pi after ${measured.pi_after} != published ${published.pi_after}`);
  if (measured.mcp_before !== published.mcp_before) descDefects.push(`mcp before ${measured.mcp_before} != published ${published.mcp_before}`);
  if (measured.pi_before !== published.pi_before) descDefects.push(`pi before ${measured.pi_before} != published ${published.pi_before}`);
  if (shippedHeadJson && shippedHeadJson.combined?.tokens !== measured.mcp_after + measured.pi_after)
    descDefects.push(`shipped estimator combined ${shippedHeadJson.combined?.tokens} != my mcp+pi ${measured.mcp_after + measured.pi_after}`);
  const pctMcp = (100 * (measured.mcp_after - measured.mcp_before)) / measured.mcp_before;
  const pctPi = (100 * (measured.pi_after - measured.pi_before)) / measured.pi_before;
  if (Math.abs(pctMcp - -11.2) > 0.15) descDefects.push(`mcp delta ${pctMcp.toFixed(1)}% != published -11.2%`);
  if (Math.abs(pctPi - -34.1) > 0.15) descDefects.push(`pi delta ${pctPi.toFixed(1)}% != published -34.1%`);

  const descArtifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    estimator: "ceil(chars/4) over JSON.stringify({name,description,inputSchema|parameters}), verifier-owned serializer",
    head: { mcp: head.mcp, pi: head.pi },
    pre_trim: { mcp: before.mcp, pi: before.pi },
    measured_tokens_c4: measured,
    published,
    shipped_estimator_combined: shippedHeadJson?.combined ?? null,
    deltas_pct: { mcp: Number(pctMcp.toFixed(2)), pi: Number(pctPi.toFixed(2)) },
    defects: descDefects,
  };
  const descWritten = writeArtifact("bench/verification/backlog/results/f38-prompt-tax.json", descArtifact);

  rows.push({
    issue: 38,
    claim: "tool-description prompt tax: measured before/after prompt tokens for the tool block",
    verdict: descDefects.length ? "needs-work" : "verified",
    evidence:
      `my own serializer, estimator ceil(chars/4): MCP ${measured.mcp_before} -> ${measured.mcp_after} tokens (${pctMcp.toFixed(1)}%), ` +
      `Pi ${measured.pi_before} -> ${measured.pi_after} tokens (${pctPi.toFixed(1)}%); published table 1056->938 (-11.2%) and 1012->667 (-34.1%); ` +
      `shipped bench/tool-descriptions.mjs combined (my run) = ${shippedHeadJson?.combined?.chars} chars ~ ${shippedHeadJson?.combined?.tokens} tokens`,
    method: "verifier-owned measurement over HEAD and over the pre-trim commit (git archive 3d1268d~1, the trim commit's parent) with the same serializer; shipped script re-run by the verifier for cross-check",
    n: 4,
    gate: g.status,
    artifact: "bench/verification/backlog/results/f38-prompt-tax.json",
    evidence_hashes: { artifact: descWritten.sha256, probe: stableHash(descArtifact) },
    notes: descDefects.length ? descDefects.join(" | ") : "every published number reproduced exactly with the verifier's own serializer",
  });

  rmrf(home);
  rmrf(beforeDir);
  delete process.env.PI_ULTRASEARCH_TEST_LOG;
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
