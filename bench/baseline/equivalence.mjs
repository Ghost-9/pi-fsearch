// bench/baseline/equivalence.mjs
// Golden equivalence baseline, wave1/baseline (verifier).
//
// Fixed 30-query set. For every query, UltraSearch results (through the same
// client path the agent tools use) and native rg/find results are captured
// side by side and stored as golden JSON for future exact-set diffing.
//
//   PI_ULTRASEARCH_TEST=1 node bench/baseline/equivalence.mjs
//
// Output: results/equivalence-golden.json

import * as path from "node:path";
import {
  REPO_ROOT,
  FIXTURE_ROOT,
  SEARCH_SCOPE,
  FIXTURE_SPECIAL,
  ensureTestEnv,
  initClientModule,
  makeClient,
  timeExec,
  machineInfo,
  utcDate,
  utcDateShort,
  saveJSON,
  relTo,
  setMetrics,
  isGitRepo,
  requireFixture,
  log,
  sleep,
  environmentGate,
  finalizeEnvironmentStatus,
} from "./lib.mjs";

ensureTestEnv();

const SCOPES = {
  repo: { dir: REPO_ROOT, git: isGitRepo(REPO_ROOT) },
  fixture: { dir: FIXTURE_ROOT, git: isGitRepo(FIXTURE_ROOT) },
  search: { dir: SEARCH_SCOPE, git: isGitRepo(SEARCH_SCOPE) },
};

// ---- fixed 30-query set -----------------------------------------------------

const QUERIES = [
  // path — repo (6)
  { id: "p01", kind: "path", scope: "repo", q: "package.json" },
  { id: "p02", kind: "path", scope: "repo", q: "client.ts" },
  { id: "p03", kind: "path", scope: "repo", q: "formatter.ts" },
  { id: "p04", kind: "path", scope: "repo", q: "tsconfig.json" },
  { id: "p05", kind: "path", scope: "repo", q: "README.md" },
  { id: "p06", kind: "path", scope: "repo", q: "index.ts" },
  // path — fixture (4)
  { id: "p07", kind: "path", scope: "fixture", q: FIXTURE_SPECIAL.markerFile },
  { id: "p08", kind: "path", scope: "fixture", q: FIXTURE_SPECIAL.specialFile },
  { id: "p09", kind: "path", scope: "fixture", q: FIXTURE_SPECIAL.deepFile },
  { id: "p10", kind: "path", scope: "fixture", q: "package.json" },
  // path — search scope (3)
  { id: "p11", kind: "path", scope: "search", q: "VaultAndUpdaterTests.swift" },
  { id: "p12", kind: "path", scope: "search", q: "PageFindHarness.swift" },
  { id: "p13", kind: "path", scope: "search", q: "dmg.py" },
  // grep — repo (7)
  { id: "g01", kind: "grep", scope: "repo", q: "FSearchClient" },
  { id: "g02", kind: "grep", scope: "repo", q: "PI_ULTRASEARCH_TEST" },
  { id: "g03", kind: "grep", scope: "repo", q: "resolveDefaultSocketPath" },
  { id: "g04", kind: "grep", scope: "repo", q: "recordAudit" },
  { id: "g05", kind: "grep", scope: "repo", q: "formatGrepFiles" },
  { id: "g06", kind: "grep", scope: "repo", q: "enforceExactQuery" },
  { id: "g07", kind: "grep", scope: "repo", q: "estimateTokensSaved" },
  // grep — fixture (3)
  { id: "g08", kind: "grep", scope: "fixture", q: FIXTURE_SPECIAL.marker },
  { id: "g09", kind: "grep", scope: "fixture", q: FIXTURE_SPECIAL.marker2 },
  { id: "g10", kind: "grep", scope: "fixture", q: "special_alpha_marker" },
  // grep — search scope (2)
  { id: "g11", kind: "grep", scope: "search", q: "VaultAndUpdater" },
  { id: "g12", kind: "grep", scope: "search", q: "PageFind" },
  // multi-grep (2)
  { id: "m01", kind: "multi", scope: "repo", patterns: ["recordAudit", "formatGrepFiles"] },
  { id: "m02", kind: "multi", scope: "fixture", patterns: [FIXTURE_SPECIAL.marker, FIXTURE_SPECIAL.marker2] },
  // negative controls (3)
  { id: "n01", kind: "path", scope: "repo", q: "zzz_absent_alpha_9c3f.ts" },
  { id: "n02", kind: "path", scope: "fixture", q: "zzz_absent_beta_9c3f.ts" },
  // n03 targets the fixture, NOT the repo: the literal appears in this script and
  // in results JSON committed inside the repo, which would self-contaminate (finding F2).
  { id: "n03", kind: "grep", scope: "fixture", q: "zzz_absent_token_" + "9c3f" },
];

const LIMIT = 1000;

function nativePath(scopeId, q) {
  const s = SCOPES[scopeId];
  if (s.git) {
    return { tool: "rg --files -g", cmd: "rg", args: ["--files", "-g", q, s.dir] };
  }
  return { tool: "find -name", cmd: "find", args: [s.dir, "-type", "f", "-name", q] };
}

function nativeGrep(scopeId, q) {
  const s = SCOPES[scopeId];
  return { tool: "rg -l", cmd: "rg", args: ["-l", "--no-messages", "--color", "never", q, s.dir] };
}

function nativeMulti(scopeId, patterns) {
  const s = SCOPES[scopeId];
  const args = ["-l", "--no-messages", "--color", "never"];
  for (const p of patterns) args.push("-e", p);
  args.push(s.dir);
  return { tool: "rg -l -e", cmd: "rg", args };
}

function usHitsToPaths(res, scopeDir) {
  const hits = res?.hits ?? [];
  return {
    all: hits.map((h) => h.path),
    files: hits.filter((h) => h.kind === "file").map((h) => h.path),
    ignored: hits.filter((h) => h.kind === "file" && h.git === "ignored").map((h) => h.path),
    nonIgnoredFiles: hits
      .filter((h) => h.kind === "file" && h.git !== "ignored")
      .map((h) => h.path),
  };
}

async function runQuery(client, q) {
  const s = SCOPES[q.scope];
  const rec = {
    id: q.id,
    kind: q.kind,
    scope: q.scope,
    scope_dir: s.dir,
    query: q.q ?? null,
    patterns: q.patterns ?? null,
    limit: LIMIT,
    native_tool: null,
    native_status: null,
    native_stderr_sample: null,
    us_error: null,
    us_source: null,
    us_took_us: null,
    us_raw_count: null,
    us_file_count: null,
    us_ignored_count: null,
    us_effective_file_count: null,
    native_count: null,
    metrics_raw_files_vs_native: null,
    metrics_effective_files_vs_native: null,
    us_set: [],
    us_ignored_set: [],
    us_effective_set: [],
    native_set: [],
  };

  try {
    if (q.kind === "path") {
      const res = await client.search(q.q, { in: s.dir, limit: LIMIT });
      const p = usHitsToPaths(res, s.dir);
      rec.us_error = res.ok ? null : String(res.error ?? "not ok");
      rec.us_source = res.source ?? null;
      rec.us_took_us = res.took_us ?? null;
      rec.us_raw_count = p.all.length;
      rec.us_file_count = p.files.length;
      rec.us_ignored_count = p.ignored.length;
      rec.us_effective_file_count = p.nonIgnoredFiles.length;
      rec.us_set = p.files.map((x) => relTo(s.dir, x)).sort();
      rec.us_ignored_set = p.ignored.map((x) => relTo(s.dir, x)).sort();
      rec.us_effective_set = p.nonIgnoredFiles.map((x) => relTo(s.dir, x)).sort();

      const n = nativePath(q.scope, q.q);
      rec.native_tool = n.tool;
      const out = timeExec(n.cmd, n.args);
      rec.native_status = out.status;
      rec.native_stderr_sample = out.stderr.slice(0, 300) || null;
      rec.native_set = out.stdout
        .split("\n")
        .filter(Boolean)
        .map((x) => relTo(s.dir, path.resolve(x)))
        .sort();
      rec.native_count = rec.native_set.length;
    } else if (q.kind === "grep") {
      const res = await client.grep(q.q, { in: s.dir, limit: LIMIT });
      const files = (res.files ?? []).map((f) => f.path);
      rec.us_error = res.ok ? null : String(res.error ?? "not ok");
      rec.us_source = res.source ?? null;
      rec.us_took_us = res.took_us ?? null;
      rec.us_raw_count = files.length;
      rec.us_file_count = files.length;
      rec.us_ignored_count = 0;
      rec.us_effective_file_count = files.length;
      rec.us_set = files.map((x) => relTo(s.dir, x)).sort();
      rec.us_effective_set = [...rec.us_set];
      rec.us_ignored_set = [];

      const n = nativeGrep(q.scope, q.q);
      rec.native_tool = n.tool;
      const out = timeExec(n.cmd, n.args);
      rec.native_status = out.status;
      rec.native_stderr_sample = out.stderr.slice(0, 300) || null;
      rec.native_set = out.stdout
        .split("\n")
        .filter(Boolean)
        .map((x) => relTo(s.dir, path.resolve(x)))
        .sort();
      rec.native_count = rec.native_set.length;
    } else {
      const res = await client.multiGrep(q.patterns, { in: s.dir });
      const files = (res.files ?? []).map((f) => f.path);
      rec.us_error = res.ok ? null : String(res.error ?? "not ok");
      rec.us_source = res.source ?? null;
      rec.us_took_us = res.took_us ?? null;
      rec.us_raw_count = files.length;
      rec.us_file_count = files.length;
      rec.us_ignored_count = 0;
      rec.us_effective_file_count = files.length;
      rec.us_set = files.map((x) => relTo(s.dir, x)).sort();
      rec.us_effective_set = [...rec.us_set];
      rec.us_ignored_set = [];

      const n = nativeMulti(q.scope, q.patterns);
      rec.native_tool = n.tool;
      const out = timeExec(n.cmd, n.args);
      rec.native_status = out.status;
      rec.native_stderr_sample = out.stderr.slice(0, 300) || null;
      rec.native_set = out.stdout
        .split("\n")
        .filter(Boolean)
        .map((x) => relTo(s.dir, path.resolve(x)))
        .sort();
      rec.native_count = rec.native_set.length;
    }
  } catch (e) {
    rec.us_error = String(e?.message ?? e);
  }

  if (rec.us_set.length || rec.native_count !== null) {
    rec.metrics_raw_files_vs_native = setMetrics(rec.us_set, rec.native_set);
    rec.metrics_effective_files_vs_native = setMetrics(rec.us_effective_set, rec.native_set);
  }
  return rec;
}

async function main() {
  requireFixture();
  await initClientModule();
  const client = makeClient({ timeoutMs: 20000 });
  const daemonStatus = await client.status().catch(() => null);
  const preGate = environmentGate(daemonStatus);
  log(`environment gate: ${preGate.status}`);

  const meta = {
    suite: "equivalence",
    wave: "wave1/baseline",
    generated_at: utcDate(),
    date_short: utcDateShort(),
    commit: timeExec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim(),
    branch: timeExec("git", ["branch", "--show-current"], { cwd: REPO_ROOT }).stdout.trim(),
    machine: machineInfo(),
    daemon: daemonStatus,
    query_count: QUERIES.length,
    limit: LIMIT,
    tolerance: {
      policy:
        "Future waves are diffed by exact set comparison against these frozen sets. A pre-existing entry that " +
        "disappears from US results is a regression unless it is listed in the exceptions below.",
      path_recall_floor_delta_pp: -2,
      grep_recall_floor_delta_pp: -5,
      exceptions: [
        "US path search returns .gitignore-ignored entries tagged git:ignored (finding F1); metrics_effective_files_vs_native excludes them.",
        "US grep covers the daemon trigram corpus, which may not include every file on disk; native rg always walks the filesystem.",
        "US multi-grep returns files, native rg -l returns files; per-file match counts are not compared here.",
        "Path queries on git scopes use `rg --files` (respects .gitignore); non-git scopes use `find`.",
        "Sets are relative to scope dir. Entries are capped at 500 in metrics diff lists; full sets are stored.",
      ],
    },
  };

  const results = [];
  for (const q of QUERIES) {
    const rec = await runQuery(client, q);
    results.push(rec);
    log(
      `${rec.id} ${rec.kind}/${rec.scope} us=${rec.us_set.length}` +
        (rec.us_ignored_count ? ` (ignored:${rec.us_ignored_count})` : "") +
        ` native=${rec.native_count} ` +
        `recall=${rec.metrics_effective_files_vs_native?.recall_vs_native ?? "n/a"}`,
    );
    await sleep(60);
  }
  client.close();

  const summary = {
    total_queries: results.length,
    path_queries: results.filter((r) => r.kind === "path").length,
    grep_queries: results.filter((r) => r.kind === "grep").length,
    multi_queries: results.filter((r) => r.kind === "multi").length,
    negative_queries: results.filter((r) => r.id.startsWith("n")).length,
    us_total_files: results.reduce((a, r) => a + (r.us_set.length || 0), 0),
    native_total_files: results.reduce((a, r) => a + (r.native_count || 0), 0),
    queries_with_us_ignored: results.filter((r) => (r.us_ignored_count || 0) > 0).map((r) => r.id),
    queries_with_us_error: results.filter((r) => r.us_error).map((r) => r.id),
    queries_recall_below_1_raw: results
      .filter((r) => r.metrics_raw_files_vs_native && r.metrics_raw_files_vs_native.recall_vs_native < 1)
      .map((r) => r.id),
    queries_recall_below_1_effective: results
      .filter((r) => r.metrics_effective_files_vs_native && r.metrics_effective_files_vs_native.recall_vs_native < 1)
      .map((r) => r.id),
    negative_queries_with_us_hits: results.filter((r) => r.id.startsWith("n") && r.us_set.length > 0).map((r) => r.id),
    negative_queries_with_native_hits: results
      .filter((r) => r.id.startsWith("n") && (r.native_count || 0) > 0)
      .map((r) => r.id),
  };

  const environment = finalizeEnvironmentStatus(preGate, environmentGate(daemonStatus));
  meta.status = environment.status;
  meta.environment = environment;
  const golden = { meta, summary, queries: results };
  const file = saveJSON(`equivalence-golden.json`, golden);

  console.log("\n=== EQUIVALENCE GOLDEN (files, effective vs native) ===");
  for (const r of results) {
    const m = r.metrics_effective_files_vs_native;
    const mm = r.metrics_raw_files_vs_native;
    console.log(
      `${r.id} ${r.kind.padEnd(6)} ${r.scope.padEnd(8)} us=${String(r.us_set.length).padStart(4)}` +
        ` ignored=${String(r.us_ignored_count ?? 0).padStart(3)}` +
        ` native=${String(r.native_count ?? "?").padStart(4)}` +
        ` recall_eff=${(m?.recall_vs_native ?? NaN).toFixed(3)}` +
        ` recall_raw=${(mm?.recall_vs_native ?? NaN).toFixed(3)}`,
    );
  }
  console.log(`\nraw JSON: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
