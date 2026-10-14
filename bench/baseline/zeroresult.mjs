// bench/baseline/zeroresult.mjs
// Zero-result / fallback baseline, wave1/baseline (verifier).
//
// Deliberately absent and deliberately present targets are queried repeatedly.
// Zero-hit rates are recorded per class, and fallback occurrences are read only
// from rows this process appended to the TEST-ISOLATED audit log
// (~/.pi/agent/cache/pi-ultrasearch/test_audit.jsonl), isolated by line offset.
//
//   PI_ULTRASEARCH_TEST=1 node bench/baseline/zeroresult.mjs
//
// Output: results/zeroresult-baseline.json

import * as os from "node:os";
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
  auditSnapshot,
  readAuditSince,
  auditFilePath,
  stats,
  requireFixture,
  log,
  sleep,
  environmentGate,
  finalizeEnvironmentStatus,
} from "./lib.mjs";

ensureTestEnv();

const REPS = Number(process.env.ZERO_REPS || 5);

// Negative grep tokens are assembled at runtime so the full literal never appears
// in committed sources, and they target scopes that do not contain this repo's
// scripts or results JSON (self-contamination, finding F2).
const ZA = "zzz_absent_grep_";

const ABSENT = [
  { id: "a1", kind: "path", q: "zzz_absent_path_alpha_9c3f", scope: REPO_ROOT, scopeId: "repo" },
  { id: "a2", kind: "path", q: "zzz_absent_path_beta_9c3f", scope: FIXTURE_ROOT, scopeId: "fixture" },
  { id: "a3", kind: "path", q: "zzz_absent_path_gamma_9c3f", scope: SEARCH_SCOPE, scopeId: "search" },
  { id: "a4", kind: "grep", q: ZA + "alpha_9c3f", scope: FIXTURE_ROOT, scopeId: "fixture" },
  { id: "a5", kind: "grep", q: ZA + "beta_9c3f", scope: SEARCH_SCOPE, scopeId: "search" },
  { id: "a6", kind: "grep", q: ZA + "gamma_9c3f", scope: FIXTURE_ROOT, scopeId: "fixture" },
];

const PRESENT = [
  { id: "b1", kind: "path", q: "package.json", scope: REPO_ROOT, scopeId: "repo" },
  { id: "b2", kind: "path", q: FIXTURE_SPECIAL.markerFile, scope: FIXTURE_ROOT, scopeId: "fixture" },
  { id: "b3", kind: "path", q: "dmg.py", scope: SEARCH_SCOPE, scopeId: "search" },
  { id: "b4", kind: "grep", q: "FSearchClient", scope: REPO_ROOT, scopeId: "repo" },
  { id: "b5", kind: "grep", q: FIXTURE_SPECIAL.marker, scope: FIXTURE_ROOT, scopeId: "fixture" },
  { id: "b6", kind: "grep", q: "PageFind", scope: SEARCH_SCOPE, scopeId: "search" },
];

// All queries this experiment issues, used to isolate our audit rows.
const MY_QUERIES = new Set([...ABSENT, ...PRESENT].map((x) => x.q));
const MY_SCOPES = new Set([REPO_ROOT, FIXTURE_ROOT, SEARCH_SCOPE]);

function rowIsMine(r) {
  const key = r.query ?? r.pattern ?? "";
  if (!MY_QUERIES.has(key)) return false;
  if (r.scope && !MY_SCOPES.has(r.scope)) return false;
  return true;
}

async function call(client, item) {
  const t0 = performance.now();
  try {
    if (item.kind === "path") {
      const res = await client.search(item.q, { in: item.scope, limit: 30 });
      return {
        count: (res.hits ?? []).length,
        ok: res.ok !== false,
        source: res.source ?? null,
        ms: performance.now() - t0,
        err: null,
        took_us: res.took_us ?? null,
      };
    }
    const res = await client.grep(item.q, { in: item.scope, limit: 30, budget_ms: 2500, context: 0 });
    return {
      count: (res.files ?? []).length,
      ok: res.ok !== false,
      source: res.source ?? null,
      ms: performance.now() - t0,
      err: null,
      took_us: res.took_us ?? null,
    };
  } catch (e) {
    return { count: null, ok: false, source: null, ms: performance.now() - t0, err: String(e?.message ?? e), took_us: null };
  }
}

async function main() {
  requireFixture();
  await initClientModule();
  const client = makeClient({ timeoutMs: 20000 });

  const meta = {
    suite: "zeroresult-fallback",
    wave: "wave1/baseline",
    generated_at: utcDate(),
    date_short: utcDateShort(),
    commit: timeExec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim(),
    branch: timeExec("git", ["branch", "--show-current"], { cwd: REPO_ROOT }).stdout.trim(),
    machine: machineInfo(),
    reps: REPS,
    audit_file: auditFilePath(),
    note:
      "Audit isolation is by line-offset snapshot: only rows appended during this run AND matching this " +
      "run's query set/scope are attributed. Other waves may append to the same test file concurrently.",
  };

  const daemonBefore = await client.ping().catch(() => false);
  const daemonStatus = await client.status().catch(() => null);
  const preGate = environmentGate(daemonStatus);
  meta.daemon = daemonStatus;
  log(`environment gate: ${preGate.status}`);
  const snapBefore = auditSnapshot();
  await sleep(120);

  const perQuery = [];
  for (const item of [...ABSENT, ...PRESENT]) {
    const cls = ABSENT.includes(item) ? "absent" : "present";
    const calls = [];
    for (let i = 0; i < REPS; i++) {
      calls.push(await call(client, item));
    }
    const zeroHits = calls.filter((c) => c.count === 0).length;
    const errors = calls.filter((c) => c.err).length;
    perQuery.push({
      ...item,
      class: cls,
      reps: REPS,
      zero_hit_calls: zeroHits,
      zero_hit_rate: zeroHits / REPS,
      error_calls: errors,
      source_counts: calls.reduce((a, c) => {
        const k = c.source ?? "null";
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {}),
      ms_stats: stats(calls.filter((c) => c.count !== null).map((c) => c.ms), `zeroresult::${item.id}`),
      calls: calls.map((c) => ({ count: c.count, ok: c.ok, source: c.source, ms: Number(c.ms.toFixed(4)), err: c.err })),
    });
    log(`${item.id} ${item.kind} ${cls} zero_hit_rate=${zeroHits}/${REPS}`);
    await sleep(60);
  }

  await sleep(150);
  const depsAfter = readAuditSince(snapBefore);
  const mine = depsAfter.filter(rowIsMine);
  const daemonAfter = await client.ping().catch(() => false);
  client.close();

  const bySource = (rows) =>
    rows.reduce((a, r) => {
      const k = r.source ?? "null";
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {});

  const absentRows = perQuery.filter((q) => q.class === "absent");
  const presentRows = perQuery.filter((q) => q.class === "present");

  const fallbackRows = mine.filter((r) => r.source === "native_fallback");
  const scanRows = mine.filter((r) => r.source === "scan");
  const indexRows = mine.filter((r) => r.source === "index");

  const environment = finalizeEnvironmentStatus(preGate, environmentGate(daemonStatus));
  meta.status = environment.status;
  meta.environment = environment;
  const report = {
    meta,
    daemon_reachable_before: daemonBefore,
    daemon_reachable_after: daemonAfter,
    absent: {
      query_count: absentRows.length,
      total_calls: absentRows.reduce((a, q) => a + q.reps, 0),
      zero_hit_rate: absentRows.reduce((a, q) => a + q.zero_hit_calls, 0) / absentRows.reduce((a, q) => a + q.reps, 0),
      false_positives: absentRows.filter((q) => q.zero_hit_calls < q.reps).map((q) => q.id),
    },
    present: {
      query_count: presentRows.length,
      total_calls: presentRows.reduce((a, q) => a + q.reps, 0),
      miss_rate: presentRows.reduce((a, q) => a + q.zero_hit_calls, 0) / presentRows.reduce((a, q) => a + q.reps, 0),
      false_negatives: presentRows.filter((q) => q.zero_hit_calls > 0).map((q) => q.id),
    },
    fallback: {
      my_audit_rows: mine.length,
      source_counts: bySource(mine),
      native_fallback_rows: fallbackRows.length,
      native_fallback_rate: mine.length ? fallbackRows.length / mine.length : null,
      scan_rows: scanRows.length,
      index_rows: indexRows.length,
      fallback_examples: fallbackRows.slice(0, 5).map((r) => ({ tool: r.tool, query: r.query ?? r.pattern, scope: r.scope, ms: r.ms })),
    },
    audit_window: {
      fresh_rows_total: depsAfter.length,
      mine_rows: mine.length,
      other_writers_rows: depsAfter.length - mine.length,
      other_tools_sample: depsAfter
        .filter((r) => !rowIsMine(r))
        .slice(0, 5)
        .map((r) => ({ tool: r.tool, query: r.query ?? r.pattern, scope: r.scope })),
    },
    per_query: perQuery,
  };

  const file = saveJSON("zeroresult-baseline.json", report);

  console.log("\n=== ZERO-RESULT / FALLBACK BASELINE ===");
  console.log(`absent  zero-hit rate: ${report.absent.zero_hit_rate.toFixed(3)} (expect 1.0)`);
  console.log(`present miss rate:     ${report.present.miss_rate.toFixed(3)} (expect 0.0)`);
  console.log(`my audit rows:         ${report.fallback.my_audit_rows}`);
  console.log(`source counts:         ${JSON.stringify(report.fallback.source_counts)}`);
  console.log(`native fallback rate:  ${report.fallback.native_fallback_rate}`);
  console.log(`audit rows by others:  ${report.audit_window.other_writers_rows} (shared file)`);
  console.log(`\nraw JSON: ${file}`);
  console.log(`\nDAEMON before/after: ${daemonBefore}/${daemonAfter} · loadavg ${os.loadavg().map((x) => x.toFixed(2)).join(",")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
