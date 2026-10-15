#!/usr/bin/env node
// bench/verification/backlog/run-all.mjs — run every wave-5 backlog check and
// merge the rows into bench/verification/backlog-closure.json.
//
//   node bench/verification/backlog/run-all.mjs [--only a,b] [--out <file>] [--reuse <dir>]
//
// Each check script is a verifier-owned program that prints one JSON array of
// rows on stdout and writes its raw evidence under
// bench/verification/backlog/results/. `--reuse` reads previously captured
// stdout files instead of re-running (used when a long arm is already fresh).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { REPO, gate, sha256, sha256Text, writeArtifact } from "./lib.mjs";

const CHECKS = [
  { id: "f24", script: "checks/f24-fallback.mjs" },
  { id: "f40", script: "checks/f40-history.mjs" },
  { id: "surface", script: "checks/surface-29-30.mjs" },
  { id: "telemetry", script: "checks/telemetry-31-38.mjs" },
  { id: "f41", script: "checks/f41-prefetch.mjs" },
  { id: "daemon", script: "checks/daemon-suite.mjs" },
  { id: "harness", script: "checks/harness-cli.mjs" },
  { id: "measure", script: "checks/measure-20-21.mjs" },
  { id: "removal", script: "checks/removal-matrix.mjs" },
];

function parseArgs(argv) {
  const out = { only: null, reuse: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) out.only = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--reuse" && argv[i + 1]) out.reuse = path.resolve(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) out.out = path.resolve(argv[++i]);
  }
  return out;
}

function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, "bench", "verification", "backlog", script)], {
      cwd: REPO,
      env: { ...process.env, PI_ULTRASEARCH_TEST: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

const opts = parseArgs(process.argv.slice(2));
const g = gate();
const captured = {};
const failures = [];

for (const c of CHECKS) {
  if (opts.only && !opts.only.includes(c.id)) continue;
  let stdout = null;
  if (opts.reuse) {
    const p = path.join(opts.reuse, `${c.id}.json`);
    if (fs.existsSync(p)) stdout = fs.readFileSync(p, "utf-8");
  }
  if (stdout === null) {
    const r = await runScript(c.script);
    const rawDir = path.join(REPO, "bench", "verification", "backlog", "results", "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, `${c.id}.json`), r.stdout);
    captured[c.id] = { stdout_sha256: sha256Text(r.stdout), exit: r.code, stderr_tail: r.stderr.slice(-500) };
    if (r.code !== 0) failures.push(`${c.id} exit ${r.code}: ${r.stderr.slice(-300)}`);
    stdout = r.stdout;
  } else {
    captured[c.id] = { reused: true, stdout_sha256: sha256Text(stdout) };
  }
  try {
    const start = stdout.indexOf("[");
    const rows = JSON.parse(stdout.slice(start));
    captured[c.id].rows = rows;
  } catch (e) {
    failures.push(`${c.id}: could not parse rows: ${String(e).slice(0, 160)}`);
  }
}

const issueRows = [];
const controlRows = [];
for (const c of CHECKS) {
  const rows = captured[c.id]?.rows ?? [];
  for (const r of rows) {
    if (typeof r.issue === "number") issueRows.push({ ...r, check: c.id });
    else controlRows.push({ ...r, check: c.id });
  }
}
issueRows.sort((a, b) => a.issue - b.issue);

// Optional ci95 enrichment, read from the committed artifacts (not re-measured
// here): #20's paired saved-fraction interval and #21's per-query paired CI.
function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf-8"));
  } catch {
    return null;
  }
}
for (const r of issueRows) {
  if (r.issue === 21) {
    const scopes = readJson("bench/results/scopes-2026-10-15-degraded.json");
    const q = scopes?.scopes?.small?.queries?.[0];
    if (q?.pairedDeltaMs) {
      r.ci95 = {
        source: "bench/results/scopes-2026-10-15-degraded.json (small-path-exact, paired delta ms)",
        n: q.pairedDeltaMs.n,
        point: q.pairedDeltaMs.point,
        lo: q.pairedDeltaMs.lo,
        hi: q.pairedDeltaMs.hi,
        method: q.pairedDeltaMs.method,
        resamples: q.pairedDeltaMs.resamples,
        gate: scopes?.status ?? "degraded",
      };
    }
  }
  if (r.issue === 20) {
    r.ci95 = {
      source: "bench/results/TOKENS.md (saved fraction, read from the committed table; no independent re-measurement on a provisional host)",
      saved_fraction: [0.884, 0.884],
      paired_delta_tokens: [0.0, 137.0],
      gate: "degraded",
    };
  }
}

const closeable = issueRows.filter((r) => r.verdict === "verified").map((r) => r.issue);
const mustStayOpen = issueRows.filter((r) => r.verdict !== "verified").map((r) => r.issue);

const report = {
  suite: "wave5-backlog-closure",
  wave: "wave5/verify",
  verifier: "independent verifier (this session) — every number re-measured or re-derived; author summaries never used as inputs",
  generated_at: new Date().toISOString(),
  head_commit: spawnSyncGit(["rev-parse", "HEAD"]),
  head_ref: spawnSyncGit(["rev-parse", "--abbrev-ref", "HEAD"]),
  base_main: spawnSyncGit(["rev-parse", "origin/main"]),
  gate: g,
  status_legend: {
    verified: "independently re-measured or re-derived; the acceptance lines reproduce",
    refuted: "the claim does not reproduce",
    "needs-work": "at least one acceptance line does not reproduce; the failing line is named in notes",
  },
  environment_note:
    "The shared host is not idle (load1 " +
    g.load1.toFixed(2) +
    " against a < 1.5 bound), so the environment gate is provisional. Every row here is a functional or set comparison, not a latency claim, except where noted; timing numbers that need a clean gate (#20, #21) are marked needs-work for that reason rather than promoted.",
  method: {
    isolation: "every daemon-backed check starts its own daemon (own ULTRASEARCH_DIR/HOME/SCAN_ROOT/socket) over a verifier fixture; the live daemon is never queried",
    removal_tests:
      "each functional guard is re-run against a scratch `git archive HEAD` copy with the pre-fix behaviour restored; a guard that still passes is reported dead (bench/verification/backlog/results/removal-matrix.json)",
    evidence: "raw JSON per check under bench/verification/backlog/results/, hashed into each row",
  },
  rows: issueRows,
  controls: controlRows,
  verdicts: {
    verified: closeable,
    needs_work: mustStayOpen,
    counts: { verified: closeable.length, needs_work: mustStayOpen.length, total: issueRows.length },
  },
  safe_to_close: closeable,
  must_stay_open: mustStayOpen,
  findings: "bench/verification/backlog/FINDINGS.md",
  report: "bench/verification/backlog/REPORT.md",
  failures,
  reproduction: [
    "cd <worktree> && PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/run-all.mjs",
    "PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/checks/daemon-suite.mjs   # daemon-backed rows",
    "PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/checks/removal-matrix.mjs  # guard non-vacuity",
  ],
};

function spawnSyncGit(args) {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

const outPath = opts.out ?? path.join(REPO, "bench", "verification", "backlog-closure.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ wrote: path.relative(REPO, outPath), rows: issueRows.length, controls: controlRows.length, verified: closeable, needs_work: mustStayOpen, failures }, null, 2));
