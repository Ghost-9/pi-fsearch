#!/usr/bin/env node
// bench/verification/backlog/checks/removal-matrix.mjs
//
// One scratch copy of HEAD per guard. For each feature a mutation restores the
// behaviour the issue was filed against; the shipped guard test must then FAIL.
// A guard that still passes after its feature is removed proves nothing.
//
// Each row records: mutation, guard test, pass/fail before, pass/fail after.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, gate, run, scratchCopy, mutate, writeArtifact, stableHash, sha256Text } from "../lib.mjs";

async function runTest(root, testFile, pattern, timeoutMs = 150000) {
  const args = ["--test"];
  if (pattern) args.push("--test-name-pattern", pattern);
  args.push(path.join(root, "test", testFile));
  const r = await run("node", args, { cwd: root, env: { PI_ULTRASEARCH_TEST: "1" }, timeoutMs });
  const tests = Number((r.stdout.match(/^[ℹ#] tests (\d+)/m) ?? [])[1] ?? -1);
  const pass = Number((r.stdout.match(/^[ℹ#] pass (\d+)/m) ?? [])[1] ?? -1);
  const fail = Number((r.stdout.match(/^[ℹ#] fail (\d+)/m) ?? [])[1] ?? -1);
  return { exit: r.code, tests, pass, fail, timed_out: r.timedOut === true, failed: fail > 0 || r.timedOut === true, tail: r.stdout.slice(-300) };
}

const CASES = [
  {
    issue: 25,
    feature: "filter-then-limit ordering in search()",
    file: "src/client.ts",
    needle: `      if (res.ok && hits.length > 0 && respectIgnore && scoped) {
        const before = hits.length;
        hits = this.filterIgnoredHits(hits, options.in!);
        filteredCount += before - hits.length;
      }

      const truncatedCount = Math.max(0, hits.length - limit);
      const kept = hits.slice(0, limit);
      const engineCapped = rawHits.length >= overscan && kept.length >= limit;`,
    replacement: `      // MUTATION: the pre-#25 order — limit first, then filter.
      const keptPre = hits.slice(0, limit);
      if (res.ok && keptPre.length > 0 && respectIgnore && scoped) {
        const before = keptPre.length;
        hits = this.filterIgnoredHits(keptPre, options.in!);
        filteredCount += before - hits.length;
      }

      const truncatedCount = Math.max(0, hits.length - limit);
      const kept = hits.slice(0, limit);
      const engineCapped = rawHits.length >= overscan && kept.length >= limit;`,
    test: "client-features.test.ts",
    pattern: "ignore filtering runs before limit",
  },
  {
    issue: 27,
    feature: "WatchSession.stop() closes the directory watcher",
    file: "src/watch.ts",
    needle: `    try {
      this.watcher?.close();
    } catch {
      // An already-closed watcher is not an error.
    }
    this.watcher = null;`,
    replacement: `    // MUTATION: stop() forgets to close the watcher.
    this.watcher = null;`,
    test: "watch.test.ts",
    pattern: "stop\\(\\) closes the watcher",
  },
  {
    issue: 28,
    feature: "realpath dedupe in dedupeHits",
    file: "src/roots.ts",
    needle: `    const existing = byReal.get(realPath);
    if (!existing) {
      byReal.set(realPath, candidate);
      continue;
    }
    duplicates++;
    if (prefer && candidate.active && !existing.active) byReal.set(realPath, candidate);
  }
  return { hits: [...byReal.values()], duplicates };`,
    replacement: `    // MUTATION: no dedupe at all.
    byReal.set(realPath + ":" + hits.indexOf(hit), candidate);
  }
  return { hits: [...byReal.values()], duplicates: 0 };`,
    test: "roots.test.ts",
    pattern: "dedupe",
  },
  {
    issue: 30,
    feature: "the default MCP surface is exactly one prefix and six tools",
    file: "src/mcp.ts",
    needle: `  const surface = rename(prefix);
  for (const alias of config.aliases ?? []) {`,
    replacement: `  const surface = rename(prefix);
  // MUTATION: the historical fsearch_* prefix leaks into the default surface.
  surface.push(...rename("fsearch"));
  for (const alias of config.aliases ?? []) {`,
    test: "interop-surface.test.ts",
    pattern: "exactly one prefix and six tools",
  },
  {
    issue: 31,
    feature: "the real-session view is the default",
    file: "src/telemetry.ts",
    needle: `  const view: AuditView = opts.view ?? "real";`,
    replacement: `  const view: AuditView = opts.view ?? "all"; // MUTATION: default widened to all rows`,
    test: "telemetry-views.test.ts",
    pattern: "real is the default",
  },
  {
    issue: 37,
    feature: "machine-readable tokenCount on every result",
    file: "src/client.ts",
    needle: `      tokenCount: Math.ceil(params.charCount / 4),`,
    replacement: `      tokenCount: undefined as unknown as number, // MUTATION: drop the machine-readable count`,
    test: "client-features.test.ts",
    pattern: "every result carries tokenCount",
  },
  {
    issue: 40,
    feature: "history is opt-in",
    file: "src/history.ts",
    needle: `  const enabled = truthy(raw);`,
    replacement: `  const enabled = !falsy(raw); // MUTATION: history on unless explicitly disabled`,
    test: "history.test.ts",
    pattern: "ULTRASEARCH_HISTORY enables",
  },
  {
    issue: 51,
    feature: "init refuses to patch an unparseable config",
    file: "src/harness-init.ts",
    needle: `      return { ...base, action: "refuse", reason: \`unparseable \${spec.format.toUpperCase()}: \${parse.reason}\`, before };`,
    replacement: `      return { ...base, action: "create", reason: \`MUTATION: patched anyway (\${parse.reason})\`, before }; // MUTATION`,
    test: "harness-init.test.ts",
    pattern: "unparseable",
  },
  {
    issue: 53,
    feature: "a half-written marker pair is refused",
    file: "src/policy.ts",
    needle: `  const endMarker = text.indexOf(POLICY_END, start + POLICY_BEGIN.length);
  if (endMarker === -1) throw new PolicyError(\`found \${POLICY_BEGIN} without \${POLICY_END}\`);`,
    replacement: `  const endMarker = text.indexOf(POLICY_END, start + POLICY_BEGIN.length);
  // MUTATION: guess the end of an unterminated block.
  if (endMarker === -1) return { start, end: text.length };`,
    test: "policy.test.ts",
    pattern: "unterminated marker",
  },
];

export async function check() {
  const g = gate();
  const rows = [];

  // ---- baseline: every guard test passes on an unmutated copy ----
  const baselineRoot = scratchCopy("baseline");
  const baseline = {};
  for (const c of CASES) {
    baseline[c.issue] = await runTest(baselineRoot, c.test, c.pattern);
  }

  const results = [];
  for (const c of CASES) {
    const root = scratchCopy(`m${c.issue}`);
    let mutationError = null;
    let after = null;
    try {
      mutate(path.join(root, c.file), c.needle, c.replacement);
      after = await runTest(root, c.test, c.pattern);
    } catch (e) {
      mutationError = String(e).slice(0, 300);
    }
    results.push({
      issue: c.issue,
      feature: c.feature,
      file: c.file,
      test: `${c.test} :: ${c.pattern}`,
      baseline: baseline[c.issue],
      mutated: after,
      mutation_error: mutationError,
      guard_is_live: Boolean(after && after.failed && baseline[c.issue].failed === false),
    });
  }

  const dead = results.filter((r) => !r.guard_is_live);
  const artifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    baseline_root: baselineRoot,
    cases: results,
    dead_guards: dead.map((d) => d.issue),
  };
  const written = writeArtifact("bench/verification/backlog/results/removal-matrix.json", artifact);

  rows.push({
    issue: "removal-matrix",
    claim: "every functional guard fails when the feature it guards is removed (non-vacuity)",
    verdict: dead.length === 0 ? "verified" : "needs-work",
    evidence: results
      .map((r) => `#${r.issue}: baseline pass=${r.baseline?.pass}/fail=${r.baseline?.fail}${r.baseline?.timed_out ? " (timed out)" : ""}, mutated pass=${r.mutated?.pass}/fail=${r.mutated?.fail}${r.mutated?.timed_out ? " (timed out)" : ""} → live=${r.guard_is_live}`)
      .join("; "),
    method: "each case is a fresh `git archive HEAD` copy; one targeted mutation restores the pre-fix behaviour; the shipped guard test is re-run and must fail",
    n: results.length,
    gate: g.status,
    artifact: "bench/verification/backlog/results/removal-matrix.json",
    evidence_hashes: { artifact: written.sha256, probe: stableHash(artifact) },
    notes: dead.length ? `guards that stayed green after mutation: ${dead.map((d) => `#${d.issue} (${d.mutation_error ?? "test still passed"})`).join(", ")}` : "all guards are live",
  });
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
