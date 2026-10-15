#!/usr/bin/env node
// bench/verification/checks/latency-rename-neutral.mjs — FINAL VERIFIER variant.
//
// The committed latency.mjs measures the repo scope with the literal
// "FSearchClient", which exists only before the UltraSearch rename. This variant
// re-measures the SAME row shape (client grep vs `rg -l`, alternating A/B, n=30,
// seeded bootstrap CI) with patterns that exist in BOTH checkouts, so the repo
// grep row is comparable across the rename.
//
//   PI_ULTRASEARCH_TEST=1 OUT_JSON=<path> node bench/verification/checks/latency-rename-neutral.mjs
//
// It imports the worktree's own bench/baseline/lib.mjs, so it measures the client
// of whichever checkout it runs in (before: FSearchClient at 0a16e50; after: main).

import * as os from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  REPO_ROOT,
  ensureTestEnv,
  initClientModule,
  makeClient,
  stats,
  timeExec,
  machineInfo,
  utcDate,
  environmentGate,
  finalizeEnvironmentStatus,
  sleep,
} = await import(path.join(HERE, "..", "..", "baseline", "lib.mjs"));

ensureTestEnv();

const N = Number(process.env.BENCH_N || 30);
const WARMUP = 2;
const OUT = process.env.OUT_JSON || path.join(REPO_ROOT, "bench", "verification", "after", "latency-rename-neutral.json");

const ROWS = [
  { id: "repo__grep_neutral_symbol", pattern: "resolveDefaultSocketPath" },
  { id: "repo__grep_neutral_class", pattern: "export class" },
];
const MULTI = ["resolveDefaultSocketPath", "recordAudit"];

async function runAB({ label, usFn, nativeFn }) {
  for (let i = 0; i < WARMUP; i++) {
    try {
      await usFn();
    } catch {}
    try {
      nativeFn();
    } catch {}
  }
  const us = [];
  const native = [];
  const usErrors = [];
  let usHits = null;
  let nativeHits = null;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      const res = await usFn();
      us.push(performance.now() - t0);
      usHits = Array.isArray(res?.files) ? res.files.length : Array.isArray(res?.hits) ? res.hits.length : null;
    } catch (e) {
      us.push(performance.now() - t0);
      usErrors.push(String(e?.message ?? e));
    }
    const t1 = performance.now();
    try {
      const out = nativeFn();
      native.push(performance.now() - t1);
      nativeHits = out.stdout.split("\n").filter(Boolean).length;
    } catch (e) {
      native.push(performance.now() - t1);
    }
  }
  return {
    label,
    paired_alternation: true,
    n: N,
    warmup: WARMUP,
    us: stats(us, `${label}::us`),
    native: stats(native, `${label}::native`),
    us_errors: usErrors.slice(0, 5),
    us_hits_last: usHits,
    native_hits_last: nativeHits,
  };
}

await initClientModule();
const runs = {};

for (const row of ROWS) {
  const client = makeClient();
  try {
    runs[row.id] = await runAB({
      label: row.id,
      usFn: () => client.grep(row.pattern, { in: REPO_ROOT, limit: 10 }),
      nativeFn: () => timeExec("rg", ["-l", "--no-messages", "--color", "never", row.pattern, REPO_ROOT]),
    });
    runs[row.id].native_cmd = `rg -l --no-messages --color never '${row.pattern}' ${REPO_ROOT}`;
  } finally {
    client.close();
  }
  await sleep(200);
}

{
  const client = makeClient();
  try {
    runs.repo__multi_grep_neutral = await runAB({
      label: "repo__multi_grep_neutral",
      usFn: () => client.multiGrep(MULTI, { in: REPO_ROOT }),
      nativeFn: () => timeExec("rg", ["-l", "--no-messages", "--color", "never", "-e", MULTI[0], "-e", MULTI[1], REPO_ROOT]),
    });
    runs.repo__multi_grep_neutral.native_cmd = `rg -l --no-messages -e ${MULTI[0]} -e ${MULTI[1]} ${REPO_ROOT}`;
  } finally {
    client.close();
  }
}

const client = makeClient();
let daemonStatus = null;
try {
  daemonStatus = await client.status();
} catch {}
client.close();

const preGate = environmentGate(daemonStatus);
const endGate = environmentGate(null);
const env = finalizeEnvironmentStatus(preGate, endGate);

const report = {
  meta: {
    suite: "latency-rename-neutral",
    wave: "wave1/verify-final",
    generated_at: utcDate(),
    status: env.status,
    repo_root: REPO_ROOT,
    commit: timeExec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim(),
    patterns: { rows: ROWS.map((r) => r.pattern), multi: MULTI },
    note: "Variant of bench/baseline/latency.mjs with rename-neutral repo patterns; same method (alternating A/B, n=30, seeded bootstrap CI).",
    machine: machineInfo(),
    daemon: daemonStatus,
    environment: env,
    loadavg_end: os.loadavg(),
    pi_ultrasearch_test: process.env.PI_ULTRASEARCH_TEST,
  },
  results: runs,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`status=${env.status}`);
for (const [k, r] of Object.entries(runs)) {
  console.log(
    `${k.padEnd(30)} n=${r.n} us=${r.us.median.toFixed(3)} [${r.us.median_ci95[0].toFixed(3)},${r.us.median_ci95[1].toFixed(3)}] native=${r.native.median.toFixed(3)} usHits=${r.us_hits_last} nativeHits=${r.native_hits_last}`,
  );
}
console.log(`raw JSON: ${OUT}`);
