#!/usr/bin/env node
/**
 * Release benchmark artifact (#33).
 *
 * The workflow that runs this file has just run the hermetic gate, the unit
 * tests, the engine tests and `cargo test`. This script does not measure
 * latency: a hosted runner is not the reference machine, and an absolute
 * millisecond number produced there would be exactly the kind of unquotable
 * claim wave 1 retracted. What it writes down is:
 *
 *   - what was verified at this commit (hermetic gate, tests) with the
 *     command and its exit status,
 *   - the hashes of the frozen reference artifacts that ship with the release
 *     (their own `status` fields — `final`, `provisional`, `degraded` — are
 *     copied verbatim, never upgraded),
 *   - the platform and versions the checks ran on.
 *
 * Usage: node bench/release-artifact.mjs --tag v0.4.0 [--out bench/results]
 *        [--checks-json <path>]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

function parseArgs(argv) {
  const args = { tag: null, out: path.join(HERE, "results"), checksJson: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tag") args.tag = argv[++i];
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else if (argv[i] === "--checks-json") args.checksJson = argv[++i];
  }
  return args;
}

/** The frozen reference artifacts, with their own status copied verbatim. */
const REFERENCE = [
  "bench/verification/after/checks-gate-floor.json",
  "bench/verification/after/equivalence-golden.json",
  "bench/verification/after/tokens-baseline.json",
  "bench/verification/after/zeroresult-baseline.json",
  "bench/baseline/results/latency-2026-10-14.json",
  "bench/verification/after/latency-2026-10-15.json",
  "bench/verification/wave1-summary.json",
];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function referenceLine(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return { path: rel, present: false };
  let status = null;
  try {
    const j = JSON.parse(fs.readFileSync(abs, "utf8"));
    status = j.status ?? j.meta?.status ?? null;
  } catch {
    /* not all artifacts are JSON objects */
  }
  return { path: rel, present: true, status, sha256: sha256(abs), bytes: fs.statSync(abs).size };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const git = (a) => {
    try {
      return execFileSync("git", a, { cwd: REPO, encoding: "utf-8" }).trim();
    } catch {
      return null;
    }
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

  const checks = [];
  if (args.checksJson && fs.existsSync(args.checksJson)) {
    try {
      for (const c of JSON.parse(fs.readFileSync(args.checksJson, "utf8"))) checks.push(c);
    } catch {
      /* the workflow writes it; a bad file means no check rows */
    }
  }

  const artifact = {
    schema: "ultrasearch.release/v1",
    tag: args.tag,
    commit: git(["rev-parse", "HEAD"]),
    commitShort: git(["rev-parse", "--short", "HEAD"]),
    dirty: git(["status", "--porcelain"]) !== "",
    generatedAt: new Date().toISOString(),
    package: { name: pkg.name, version: pkg.version },
    platform: { os: process.platform, arch: process.arch, node: process.version, hostname: os.hostname(), cpus: os.cpus().length },
    // What the release workflow actually verified at this commit. The live
    // latency gate is NOT included: a hosted runner is not the reference
    // machine. `npm run test:gate` still runs there (hermetic part).
    checks,
    referenceMeasurements: REFERENCE.map(referenceLine),
    method: {
      claim: "This artifact states what was verified at this commit, not what this machine's latency was.",
      latency: "Latency claims come from bench/verification and bench/baseline artifacts, which carry their own status; see docs/sla.md.",
      gate: "npm run test:gate — hermetic mock gate strict; the live gate derives its floor in-run (docs/decisions/0012).",
    },
  };

  fs.mkdirSync(args.out, { recursive: true });
  const name = `release-${args.tag ?? "untagged"}.json`;
  const file = path.join(args.out, name);
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
  console.log(`wrote ${file}`);
  console.log(`  checks: ${checks.length}, reference artifacts present: ${artifact.referenceMeasurements.filter((r) => r.present).length}/${REFERENCE.length}`);
}

main();
