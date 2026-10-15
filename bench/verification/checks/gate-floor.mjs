#!/usr/bin/env node
// bench/verification/checks/gate-floor.mjs — where does the 5 ms gate floor live?
//
// Wave 1's blocker note claims `npm run test:gate`'s "daemon-backed p95 trigram
// grep < 5 ms" fails because the *raw daemon* already costs ~7 ms on this
// machine, with no client involved. This re-measures both legs independently:
//
//   raw leg    line-delimited JSON straight onto the live socket (no client)
//   client leg `UltraSearchClient.grep` (the same call the gate makes)
//
// Same query, scope and limit as test/benchmark-gate.test.ts ("Live CI Gate:
// daemon-backed p95 trigram grep < 5ms"): pattern "UltraSearchClient",
// in = repo root, limit 10.
//
//   PI_ULTRASEARCH_TEST=1 [N=60] node bench/verification/checks/gate-floor.mjs

process.env.PI_ULTRASEARCH_TEST = "1";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const OUT = path.join(HERE, "..", "after", "checks-gate-floor.json");
const SOCKET = path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock");
const PATTERN = "UltraSearchClient";
const N = Number(process.env.N || 60);

const { UltraSearchClient } = await import(path.join(REPO, "src", "client.ts"));

function rawGrep() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: SOCKET });
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("raw grep timeout"));
    }, 10000);
    sock.on("connect", () => sock.write(JSON.stringify({ id: 1, op: "grep", pattern: PATTERN, in: REPO, limit: 10 }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        clearTimeout(t);
        sock.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  const i = ((s.length - 1) * p) / 100;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

const client = new UltraSearchClient({ timeoutMs: 15000 });
const raw = [];
const cl = [];
const errors = [];

for (let i = 0; i < 3; i++) {
  await rawGrep();
  await client.grep(PATTERN, { in: REPO, limit: 10 });
}

let filesMatched = null;
for (let i = 0; i < N; i++) {
  let t0 = performance.now();
  const r = await rawGrep();
  raw.push(performance.now() - t0);
  if (r.ok !== true) errors.push("raw not ok");

  t0 = performance.now();
  const g = await client.grep(PATTERN, { in: REPO, limit: 10 });
  cl.push(performance.now() - t0);
  if (g.ok !== true) errors.push("client not ok");
  filesMatched = (g.files ?? []).length;
}

const status = await client.status();
client.close();

const summary = {
  suite: "gate-floor",
  wave: "wave1/verify-final",
  generated_at: new Date().toISOString(),
  status: "final",
  query: PATTERN,
  scope: REPO,
  limit: 10,
  n: N,
  socket: SOCKET,
  note: "Same call as test/benchmark-gate.test.ts:152. Warmups excluded (3 rounds); the raw leg opens a fresh connection each sample, so its number is if anything conservative.",
  raw_daemon_only: { p50: pct(raw, 50), p95: pct(raw, 95), min: Math.min(...raw), max: Math.max(...raw) },
  client: { p50: pct(cl, 50), p95: pct(cl, 95), min: Math.min(...cl), max: Math.max(...cl) },
  gate_threshold_ms: 5.0,
  raw_p95_below_threshold: pct(raw, 95) < 5.0,
  verdict: pct(raw, 95) < 5.0 ? "raw daemon alone would pass the 5 ms gate" : "the raw daemon alone exceeds the 5 ms gate on this machine: the gate measures the machine floor, not a client regression",
  files_matched: filesMatched,
  daemon: { entries: status.entries, content_docs: status.content_docs, full_disk_access: status.full_disk_access, staleness_ms: status.staleness_ms },
  errors,
  loadavg: os.loadavg(),
};

fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
console.log(`raw    p50=${summary.raw_daemon_only.p50.toFixed(2)} p95=${summary.raw_daemon_only.p95.toFixed(2)} ms (n=${N})`);
console.log(`client p50=${summary.client.p50.toFixed(2)} p95=${summary.client.p95.toFixed(2)} ms (n=${N})`);
console.log(summary.verdict);
console.log(`raw JSON: ${OUT}`);
process.exit(0);
