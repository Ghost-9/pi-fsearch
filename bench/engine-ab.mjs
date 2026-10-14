#!/usr/bin/env node
// Alternating A/B benchmark for the engine, per the repository's measurement
// contract: two real daemons over one fixture, alternating rounds, medians
// with a bootstrap confidence interval, an output-equivalence check, and the
// raw samples written to bench/results/engine/.
//
//   node bench/engine-ab.mjs [--n 20] [--files 4000] [--label budget]
//
// A (baseline) is a second checkout built from a git ref, so the comparison
// is between two binaries and not between two code paths in one process:
//
//   A = --baseline <ref>   (default: the commit before the budget work)
//   B = the working tree's engine/target/release/fsearch
//
// A result is only quotable on a quiet machine: the script refuses to call a
// difference real when the 1-minute load average is above --max-load
// (default 1.5) and says so in its output.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { EngineHarness, tmpdir, makeTree, REPO_ROOT, ENGINE_DIR, until, median, medianCI, sleep } from "../test/engine/harness.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const N = Number(opt("n", 20));
const FILES = Number(opt("files", 4000));
const LABEL = opt("label", "engine");
const MAX_LOAD = Number(opt("max-load", 1.5));
const BASELINE_REF = opt("baseline", "f84ce92");
const OUT_DIR = path.join(REPO_ROOT, "bench", "results", "engine");

/** Build a baseline daemon from `ref` into a throwaway checkout. */
function baselineBinary(ref) {
  const dir = path.join(os.tmpdir(), `us-baseline-${ref}`);
  // A pre-rebrand ref builds `fsearch`; a rebranded one builds `ultrasearch`.
  // The socket name follows the binary (see `startDaemon`).
  const bin = [path.join(dir, "engine", "target", "release", "ultrasearch"), path.join(dir, "engine", "target", "release", "fsearch")].find((p) =>
    fs.existsSync(p),
  );
  if (bin) return bin;
  fs.mkdirSync(dir, { recursive: true });
  const tar = execFileSync("git", ["-C", REPO_ROOT, "archive", ref], { maxBuffer: 1 << 30 });
  fs.writeFileSync(path.join(dir, "src.tar"), tar);
  execFileSync("tar", ["-xf", path.join(dir, "src.tar"), "-C", dir], { stdio: "inherit" });
  execFileSync("cargo", ["build", "--release"], { cwd: path.join(dir, "engine"), stdio: "inherit" });
  return bin;
}

/** The digest of a result set: paths and scores, order included. */
function digest(hits) {
  return (hits ?? []).map((h) => `${h.path}|${h.score}`).join("\n");
}

async function startDaemon(binary, dir, root, extraEnv = {}) {
  fs.mkdirSync(dir, { recursive: true });
  // The fork renamed the socket too, and a baseline may be either side of that.
  const socketName = path.basename(binary) === "fsearch" ? "fsearch.sock" : "ultrasearch.sock";
  const child = spawn(binary, ["serve"], {
    env: {
      ...process.env,
      // Both spellings: a baseline checkout may predate the ULTRASEARCH_*
      // names, and the current one prefers them.
      ULTRASEARCH_DIR: dir,
      ULTRASEARCH_SCAN_ROOT: root,
      ULTRASEARCH_HOME: root,
      FSEARCH_DIR: dir,
      FSEARCH_SCAN_ROOT: root,
      FSEARCH_HOME: root,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b.toString()));
  const probe = new EngineHarness({ root, dir, socketName });
  probe.child = child;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s = await probe.status().catch(() => null);
    if (s?.ok) return { probe, child, stderr };
    if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${stderr}`);
    await sleep(50);
  }
  throw new Error(`daemon did not become ready: ${stderr}`);
}

async function main() {
  const binaryB = path.join(ENGINE_DIR, "target", "release", "ultrasearch");
  if (!fs.existsSync(binaryB)) throw new Error("build the engine first: cargo build --release --manifest-path engine/Cargo.toml");
  const binaryA = baselineBinary(BASELINE_REF);
  const load = os.loadavg()[0];

  const base = tmpdir("us-bench-");
  const root = path.join(base, "root");
  makeTree(root, FILES, "deep");

  console.log(`A = baseline ${BASELINE_REF}  ${binaryA}`);
  console.log(`B = working tree       ${binaryB}`);
  console.log(`fixture: ${FILES} files; n=${N} alternating rounds; load1m=${load.toFixed(2)}`);

  const a = await startDaemon(binaryA, path.join(base, "idxA"), root);
  const b = await startDaemon(binaryB, path.join(base, "idxB"), root);

  const out = { label: LABEL, baseline_ref: BASELINE_REF, n: N, files: FILES, load1m: load, queries: {}, quotable: load <= MAX_LOAD };
  try {
    // Grep needs the content index; wait for both so a cold build is not
    // measured as a query.
    await until(async () => (await a.probe.status()).content_docs > 0, { timeoutMs: 120_000 }).catch(() => null);
    await until(async () => (await b.probe.status()).content_docs > 0, { timeoutMs: 120_000 }).catch(() => null);

    const QUERIES = [
      { name: "path-search", query: "file-*", extra: {} },
      { name: "path-search-budget", query: "file-*", extra: { budget_ms: 60_000 } },
      { name: "path-narrow", query: "file-0000*", extra: {} },
      { name: "grep", extra: {}, grep: "NEEDLE_3" },
    ];
    for (const q of QUERIES) {
      const ra = [];
      const rb = [];
      const digA = new Set();
      const digB = new Set();
      for (let i = 0; i < N; i++) {
        // Alternating within a round, so drift hurts both equally.
        const tA0 = performance.now();
        const rA = q.grep ? await a.probe.grep(q.grep, q.extra) : await a.probe.search(q.query, { limit: 30, ...q.extra });
        const wA = performance.now() - tA0;
        const tB0 = performance.now();
        const rB = q.grep ? await b.probe.grep(q.grep, q.extra) : await b.probe.search(q.query, { limit: 30, ...q.extra });
        const wB = performance.now() - tB0;
        if (!rA.ok || !rB.ok) throw new Error(`query failed: ${JSON.stringify(rA).slice(0, 120)} / ${JSON.stringify(rB).slice(0, 120)}`);
        ra.push({ wall_ms: wA, took_us: rA.took_us, scanned: rA.scanned, considered: rA.considered, complete: rA.complete });
        rb.push({ wall_ms: wB, took_us: rB.took_us, scanned: rB.scanned, considered: rB.considered, complete: rB.complete });
        digA.add(q.grep ? (rA.files ?? []).map((f) => f.path).join("\n") : digest(rA.hits));
        digB.add(q.grep ? (rB.files ?? []).map((f) => f.path).join("\n") : digest(rB.hits));
      }
      const wa = ra.map((s) => s.wall_ms);
      const wb = rb.map((s) => s.wall_ms);
      const diffs = ra.map((s, i) => s.wall_ms - rb[i].wall_ms);
      const equivalent = digA.size === 1 && digB.size === 1 && [...digA][0] === [...digB][0];
      const p95 = (xs) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
      out.queries[q.name] = {
        n: N,
        a: { median_ms: median(wa), ci: medianCI(wa), p95_ms: p95(wa) },
        b: { median_ms: median(wb), ci: medianCI(wb), p95_ms: p95(wb) },
        diff_median_ms: median(diffs),
        diff_ci: medianCI(diffs),
        equivalent,
        raw: { a: ra, b: rb },
      };
      console.log(
        `${q.name.padEnd(20)} A ${median(wa).toFixed(2)}ms  B ${median(wb).toFixed(2)}ms  Δ ${median(diffs).toFixed(2)}ms  ` +
          `CI[${medianCI(diffs)[0].toFixed(2)}, ${medianCI(diffs)[1].toFixed(2)}]  n=${N}  output ${equivalent ? "identical" : "DIFFERENT"}`,
      );
    }
  } finally {
    a.child.kill();
    b.child.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`raw results: ${file}`);
  if (!out.quotable) {
    console.log(
      `NOT QUOTABLE: 1-minute load average ${load.toFixed(2)} > ${MAX_LOAD}. Recorded for trend only; re-run on a quiet ` +
        `machine (AC power, nothing else building) before quoting any of it.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
