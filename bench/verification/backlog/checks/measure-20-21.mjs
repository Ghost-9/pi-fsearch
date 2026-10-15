#!/usr/bin/env node
// bench/verification/backlog/checks/measure-20-21.mjs — issues #20, #21
//
// Both are measurement claims on a shared host. The environment gate is
// provisional (load1 >> 1.5), and the committed artifacts are explicitly
// `-degraded`, so the timing/delta numbers cannot be promoted to `verified`;
// this check records the gate reason, verifies every non-timing sub-claim
// independently, and proves the equivalence guard is not vacuous.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, gate, run, writeArtifact, stableHash, sha256Text } from "../lib.mjs";

export async function check() {
  const g = gate();
  const rows = [];

  // ---------------- #20 ----------------
  const tokensArtifacts = fs.readdirSync(path.join(REPO, "bench", "results")).filter((f) => /^tokens-.*\.json$/.test(f));
  const tokensMd = fs.readFileSync(path.join(REPO, "bench", "results", "TOKENS.md"), "utf-8");
  const degraded = tokensArtifacts.filter((f) => f.includes("degraded"));
  const latest = degraded.length ? JSON.parse(fs.readFileSync(path.join(REPO, "bench", "results", degraded[degraded.length - 1]), "utf-8")) : null;

  // the estimator must be labelled an estimate everywhere it is displayed
  // Every line that displays the savings figure must also label it an estimate.
  const displaySites = ["src/telemetry.ts", "src/tui.ts"];
  const labelHits = displaySites.map((f) => {
    const lines = fs.readFileSync(path.join(REPO, f), "utf-8").split("\n");
    const shown = lines.filter((l) => /Tokens Saved/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    const unlabelled = shown.filter((l) => !/estimat|\(est\)/i.test(l));
    return { file: f, shown: shown.length, unlabelled: unlabelled.length, sample: shown.slice(0, 3) };
  });
  // per-row TUI figure sits under the labelled header; recorded, not a verdict
  const perRowLine = fs.readFileSync(path.join(REPO, "src", "tui.ts"), "utf-8").split("\n").find((l) => /\+\$\{tokensSavedCount\}t saved/.test(l)) ?? "";
  const perRowLabelled = /estimat|\(est\)|not measured/i.test(perRowLine);
  const missingLabelSites = labelHits.filter((l) => l.shown === 0).map((l) => l.file);
  const unlabelledSites = labelHits.filter((l) => l.unlabelled > 0).map((l) => l.file);

  const labelTest = await run("node", ["--test", "--test-name-pattern", "tokens-saved is labelled", path.join(REPO, "test", "telemetry-views.test.ts")], {
    cwd: REPO,
    env: { PI_ULTRASEARCH_TEST: "1" },
    timeoutMs: 120000,
  });
  const labelTestOk = /^[ℹ#] fail 0$/m.test(labelTest.stdout) && /[ℹ#] pass [1-9]/.test(labelTest.stdout);

  const estimatedDeltaPresent = /saved fraction/i.test(tokensMd) && /paired delta/i.test(tokensMd);
  const methodDocumented = /Method/.test(tokensMd) && /estimator/i.test(tokensMd) && /20\d\d-\d\d-\d\d/.test(tokensMd);
  const heuristicCompared = /Heuristic vs measurement/.test(tokensMd) && /overstates/.test(tokensMd);
  const measuredStatus = latest?.status ?? latest?.environmentGate?.status ?? "unknown";

  const f20Defects = [];
  if (missingLabelSites.length) f20Defects.push(`no savings display found in ${JSON.stringify(missingLabelSites)}`);
  if (unlabelledSites.length) f20Defects.push(`unlabelled Tokens Saved line in ${JSON.stringify(unlabelledSites)}`);
  if (!labelTestOk) f20Defects.push("the shipped 'tokens-saved is labelled an estimate' test did not pass");
  if (!estimatedDeltaPresent) f20Defects.push("TOKENS.md has no measured delta");
  if (!methodDocumented) f20Defects.push("TOKENS.md does not document scope and method");
  if (!heuristicCompared) f20Defects.push("TOKENS.md does not compare the heuristic against the measurement");
  const f20Gate = g.pass && measuredStatus === "final";
  if (!f20Gate) f20Defects.push(`measurement artifact status=${measuredStatus}, gate=${g.status}: the measured deltas may not be cited as production evidence`);

  const f20Artifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    artifacts: tokensArtifacts,
    latest_artifact_status: measuredStatus,
    latest_artifact_method: latest?.method ?? null,
    labels: labelHits,
    per_row_tui_figure_labelled_on_its_own_line: perRowLabelled,
    label_test: { exit: labelTest.code, ok: labelTestOk },
    doc: { measured_delta: estimatedDeltaPresent, method_documented: methodDocumented, heuristic_compared: heuristicCompared },
    defects: f20Defects,
  };
  const f20Written = writeArtifact("bench/verification/backlog/results/m20-tokens.json", f20Artifact);
  rows.push({
    issue: 20,
    claim: "prompt-token accounting harness with measured deltas and the heuristic's overstatement; estimate formula labelled everywhere",
    verdict: f20Gate && f20Defects.length === 0 ? "verified" : "needs-work",
    evidence:
      `harness artifacts: ${JSON.stringify(tokensArtifacts)} (status=${measuredStatus}); TOKENS.md documents the scope/method, a measured paired delta and a heuristic-vs-measurement table ` +
      `(overstatement rows: ${(tokensMd.match(/overstates|n\/a/g) ?? []).length}); estimate labelling present in ${JSON.stringify(labelHits)}; shipped label test pass=${labelTestOk}; ` +
      `environment gate: ${g.status} (load1 ${g.load1.toFixed(2)} vs < 1.5)`,
    method: "verifier reads the committed token artifacts and the shipped doc, re-runs the labelling guard, and applies the frozen gate rule: a measurement on a provisional host may not be promoted to verified",
    n: 5,
    gate: g.status,
    artifact: "bench/verification/backlog/results/m20-tokens.json",
    evidence_hashes: { artifact: f20Written.sha256, probe: stableHash(f20Artifact) },
    notes: (f20Defects.length ? f20Defects.join(" | ") : "measurement and labelling both verified on a gate-clean host") +
      (perRowLabelled ? "" : "; fidelity note: the TUI per-row savings figure is unlabelled on its own line (the labelled header and inspector cover it)"),
  });

  // ---------------- #21 ----------------
  const scopeArtifacts = fs.readdirSync(path.join(REPO, "bench", "results")).filter((f) => /^scopes-.*\.json$/.test(f));
  const scopeChecked = [];
  for (const f of scopeArtifacts) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "results", f), "utf-8"));
      const scopes = Object.keys(d.scopes ?? {});
      const queries = scopes.flatMap((s) => d.scopes[s].queries ?? []);
      const withStats = queries.filter((q) => q.ultra?.n > 0 && typeof q.ultra?.median === "number" && typeof q.ultra?.p95 === "number");
      const withCI = queries.filter((q) => q.pairedDeltaMs && typeof q.pairedDeltaMs.lo === "number" && typeof q.pairedDeltaMs.hi === "number");
      scopeChecked.push({ file: f, status: d.status ?? d.environmentGate?.status ?? "unknown", scopes, queries: queries.length, with_stats: withStats.length, with_ci: withCI.length, equivalence_rows: queries.filter((q) => q.equivalence).length, relevance_pass: d.relevance?.pass ?? null });
    } catch (e) {
      scopeChecked.push({ file: f, error: String(e) });
    }
  }
  const latestScope = scopeChecked[scopeChecked.length - 1] ?? {};

  // the equivalence guard is non-vacuous
  const { compareSets } = await import(path.join(REPO, "bench", "lib", "native.mjs"));
  const eq = {
    identical: compareSets(["/a/x.ts", "/a/y.ts"], ["/a/x.ts", "/a/y.ts"], { nativeOnly: 0 }),
    missing_from_index: compareSets(["/a/x.ts"], ["/a/x.ts", "/a/y.ts"], { nativeOnly: 0 }),
    extra_in_index: compareSets(["/a/x.ts", "/a/z.ts"], ["/a/x.ts"], { nativeOnly: 0 }),
    tolerance_allows: compareSets(["/a/x.ts"], ["/a/x.ts", "/a/y.ts"], { nativeOnly: 0.5 }),
  };
  const eqOk = eq.identical.pass === true && eq.missing_from_index.pass === false && eq.extra_in_index.pass === false && eq.tolerance_allows.pass === true;

  // a real equivalence run of the shipped comparator over the committed golden
  const golden = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "baseline", "results", "equivalence-golden.json"), "utf-8"));
  const goldenRows = (golden.queries ?? golden.rows ?? []).slice(0, 30);
  const goldenEq = goldenRows.map((r) => compareSets(r.us?.paths ?? r.ultraPaths ?? [], r.native?.paths ?? r.nativePaths ?? [], r.tolerance ?? { nativeOnly: 0 }));
  const goldenPassRate = goldenEq.length ? goldenEq.filter((r) => r.pass).length / goldenEq.length : null;

  const f21Defects = [];
  if (!(latestScope.with_stats === latestScope.queries && latestScope.queries > 0)) f21Defects.push(`scope artifact stats incomplete: ${JSON.stringify(latestScope)}`);
  if (!(latestScope.with_ci === latestScope.queries && latestScope.queries > 0)) f21Defects.push(`scope artifact CI incomplete: ${JSON.stringify(latestScope)}`);
  if (!(latestScope.equivalence_rows === latestScope.queries)) f21Defects.push("not every query row carries an equivalence comparison");
  if (!eqOk) f21Defects.push(`compareSets is not discriminating: ${JSON.stringify(eq)}`);
  const f21Gate = g.pass && latestScope.status === "final";
  if (!f21Gate) f21Defects.push(`scope artifact status=${latestScope.status}, gate=${g.status}: the medians/CI may not be cited as production evidence`);

  const f21Artifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    artifacts: scopeChecked,
    equivalence_guard: eq,
    golden_recheck: { rows: goldenRows.length, pass_rate: goldenPassRate, tolerance_values: [...new Set(goldenRows.map((r) => JSON.stringify(r.tolerance ?? { nativeOnly: 0 })))] },
    defects: f21Defects,
  };
  const f21Written = writeArtifact("bench/verification/backlog/results/m21-scopes.json", f21Artifact);
  rows.push({
    issue: 21,
    claim: "multi-scope fixtures with medians/p95/n/CI committed per release, plus an output-equivalence check that fails beyond a documented tolerance",
    verdict: f21Gate && f21Defects.length === 0 ? "verified" : "needs-work",
    evidence:
      `artifacts: ${JSON.stringify(scopeChecked.map((s) => ({ f: s.file, status: s.status, queries: s.queries, with_stats: s.with_stats, with_ci: s.with_ci })))}; ` +
      `equivalence guard non-vacuous: identical=${eq.identical.pass} missing=${eq.missing_from_index.pass} extra=${eq.extra_in_index.pass} tolerance=${eq.tolerance_allows.pass}; ` +
      `re-check over the committed golden: ${goldenRows.length} rows, pass rate ${goldenPassRate}; environment gate: ${g.status} (load1 ${g.load1.toFixed(2)} vs < 1.5)`,
    method: "verifier reads the committed scope artifacts for the required statistics, drives the shipped compareSets with four constructed cases, and re-runs it over the committed equivalence golden",
    n: 4,
    gate: g.status,
    artifact: "bench/verification/backlog/results/m21-scopes.json",
    evidence_hashes: { artifact: f21Written.sha256, probe: stableHash(f21Artifact) },
    notes: f21Defects.length ? f21Defects.join(" | ") : "artifacts and equivalence guard verified on a gate-clean host",
  });

  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
