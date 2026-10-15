#!/usr/bin/env node
/**
 * Run the release checks, record each one's exit status, and write JSON for the
 * release artifact (#33). `bench/release-artifact.mjs` reads the file.
 *
 * Usage: node bench/run-checks.mjs --out "$RUNNER_TEMP/checks.json"
 *
 * The list is deliberately what a hosted runner can verify: unit tests, engine
 * tests, the gate (hermetic part; the live part skips without a daemon). The
 * release artifact does not claim absolute latency — see docs/sla.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node bench/run-checks.mjs [--out <file>]\n\nRuns: " + ["npm test", "cargo test --release", "npm run test:engine", "npm run test:gate"].join(", ") + ".\nWrites each command's exit status as JSON for bench/release-artifact.mjs.");
  process.exit(0);
}
const out = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "checks.json";
})();

const CHECKS = [
  ["npm test", ["npm", "test"]],
  ["cargo test --release", ["cargo", "test", "--release", "--manifest-path", "engine/Cargo.toml"]],
  ["npm run test:engine", ["npm", "run", "test:engine"]],
  ["npm run test:gate", ["npm", "run", "test:gate"]],
];

const rows = [];
let failed = 0;
for (const [name, cmd] of CHECKS) {
  const started = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: REPO, stdio: "inherit" });
  const code = r.status ?? 1;
  if (code !== 0) failed++;
  rows.push({ name, command: cmd.join(" "), exit: code, ms: Date.now() - started });
}

fs.writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`wrote ${out}: ${rows.length} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
