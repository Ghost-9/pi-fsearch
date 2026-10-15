#!/usr/bin/env node
/**
 * Engine concurrency benchmark (issue #18).
 *
 * What it measures, per daemon, on raw sockets (no client lanes involved):
 *
 *   single      median wall time of one grep
 *   batch       median wall time of `--concurrent` greps issued together
 *   ratio       batch / single  (~1: the batch finishes as one call; ~N: the
 *               engine serializes; >N: worse than serial)
 *   cores       the daemon's CPU seconds / wall seconds during the batch
 *
 * Two daemons are measured alternately (A = baseline binary, B = treatment),
 * n rounds each, because a shared machine drifts. The environment gate is
 * recorded; a run on a loaded machine is written as `degraded` and is not
 * quotable.
 *
 * The reliable evidence for the helper-pool fix is the deterministic engine
 * unit test `content::tests::concurrent_runs_share_the_helper_pool` (it fails
 * on the old code with a lane that never runs). This benchmark is the
 * end-to-end number, and on an idle machine a treatment should show a batch
 * ratio closer to 1 than the baseline's.
 *
 * Usage:
 *   node bench/engine-concurrency.mjs --baseline-bin /path/to/baseline \\
 *     [--treatment-bin engine/target/release/ultrasearch] [--files 5000]
 *     [--pattern value] [--limit 100000] [--concurrent 3] [--pairs 20]
 *     [--force-degraded] [--json]
 */
process.env.PI_ULTRASEARCH_TEST = "1";
process.env.PI_ULTRASEARCH_BENCH = "1";

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTree, tmpdir, sleep, median, medianCI } from "../test/engine/harness.mjs";
import { pairedDeltaCI, pairedRatioCI, ciExcludesZero, fmt, fmtCI } from "./lib/stats.mjs";
import { checkEnvironment, formatEnvironmentGate } from "./lib/env-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "engine");

function parseArgs(argv) {
  const a = {
    baselineBin: null,
    treatmentBin: path.join(HERE, "..", "engine", "target", "release", "ultrasearch"),
    files: 5000,
    pattern: "value",
    limit: 100000,
    concurrent: 3,
    pairs: 20,
    maxLoad: 1.5,
    forceDegraded: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--baseline-bin") a.baselineBin = argv[++i];
    else if (k === "--treatment-bin") a.treatmentBin = argv[++i];
    else if (k === "--files") a.files = Number(argv[++i]);
    else if (k === "--pattern") a.pattern = argv[++i];
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--concurrent") a.concurrent = Number(argv[++i]);
    else if (k === "--pairs") a.pairs = Number(argv[++i]);
    else if (k === "--max-load") a.maxLoad = Number(argv[++i]);
    else if (k === "--force-degraded") a.forceDegraded = true;
    else if (k === "--json") a.json = true;
  }
  return a;
}

/** CPU seconds for `pid` (ps cputime). */
function cpuSeconds(pid) {
  const out = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  const p = out.split(":").map(Number);
  return p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : Number(out) || 0;
}

function connect(socket) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socket);
    let buf = "";
    const waiters = new Map();
    sock.on("connect", () => resolve(api));
    sock.on("error", reject);
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          const w = waiters.get(msg.id);
          if (w) {
            waiters.delete(msg.id);
            w(msg);
          }
        } catch {}
      }
    });
    let id = 1;
    const api = {
      request(obj) {
        const myId = id++;
        return new Promise((r) => {
          waiters.set(myId, r);
          sock.write(JSON.stringify({ ...obj, id: myId }) + "\n");
        });
      },
      close() {
        sock.destroy();
      },
    };
  });
}

async function startDaemon(bin, root, env = {}) {
  const dir = path.join(tmpdir("us-conc-"), "data");
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(bin, ["serve"], {
    env: { ...process.env, ULTRASEARCH_DIR: dir, ULTRASEARCH_HOME: root, ULTRASEARCH_SCAN_ROOT: root, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  const socket = path.join(dir, "ultrasearch.sock");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const c = await connect(socket);
      const s = await c.request({ op: "status" });
      c.close();
      if (s.ok && s.entries > 0 && s.content_pending === 0) {
        return { child, dir, socket, status: s };
      }
    } catch {}
    if (child.exitCode !== null) throw new Error(`${bin} exited`);
    await sleep(100);
  }
  throw new Error("daemon not ready");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.baselineBin || !fs.existsSync(args.baselineBin)) {
    console.error("REFUSED: --baseline-bin is required and must exist (build the parent commit, e.g. via bench/engine-ab.mjs).");
    process.exit(2);
  }
  const root = makeTree(path.join(tmpdir("us-conc-tree-"), "tree"), args.files, "flat");
  const base = await startDaemon(args.baselineBin, root);
  const treat = await startDaemon(args.treatmentBin, root);
  const daemons = [
    { name: "baseline", bin: args.baselineBin, ...base },
    { name: "treatment", bin: args.treatmentBin, ...treat },
  ];
  const env = checkEnvironment({ maxLoad1m: args.maxLoad });
  const gate = { ok: env.reasons.length === 0, reasons: env.reasons, info: env.info };
  console.log(`fixture ${args.files} files | pattern='${args.pattern}' limit=${args.limit} concurrent=${args.concurrent} pairs=${args.pairs}`);
  console.log(formatEnvironmentGate(gate));
  for (const d of daemons) console.log(`[${d.name}] pid ${d.child.pid} entries ${d.status.entries} content_docs ${d.status.content_docs}`);

  const opts = { op: "grep", pattern: args.pattern, in: root, limit: args.limit, budget_ms: 15000, skipAudit: true };
  const one = async (d) => {
    const c = await connect(d.socket);
    try {
      const t = performance.now();
      await c.request(opts);
      return performance.now() - t;
    } finally {
      c.close();
    }
  };
  const batch = async (d, n) => {
    const cs = await Promise.all(Array.from({ length: n }, () => connect(d.socket)));
    try {
      const t = performance.now();
      await Promise.all(cs.map((c) => c.request(opts)));
      return performance.now() - t;
    } finally {
      cs.forEach((c) => c.close());
    }
  };

  // Warm.
  for (const d of daemons) for (let i = 0; i < 5; i++) await one(d);

  const samples = { baseline: { single: [], batch: [] }, treatment: { single: [], batch: [] } };
  // Counterbalanced: alternate which daemon leads each round.
  for (let i = 0; i < args.pairs; i++) {
    const order = i % 2 === 0 ? daemons : [...daemons].reverse();
    for (const d of order) {
      samples[d.name].single.push(await one(d));
      samples[d.name].batch.push(await batch(d, args.concurrent));
    }
  }

  // CPU/wall for the batch, per daemon.
  const cores = {};
  for (const d of daemons) {
    const c0 = cpuSeconds(d.child.pid);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) await batch(d, args.concurrent);
    const wall = (performance.now() - t0) / 1000;
    cores[d.name] = (cpuSeconds(d.child.pid) - c0) / wall;
  }

  const summary = {};
  for (const name of ["baseline", "treatment"]) {
    const s = samples[name];
    const single = median(s.single);
    const b = median(s.batch);
    summary[name] = {
      singleMedianMs: single,
      batchMedianMs: b,
      ratio: b / single,
      singleCI: medianCI(s.single, { seed: 0x1a01 }),
      batchCI: medianCI(s.batch, { seed: 0x1a02 }),
      coresUsed: cores[name],
      n: s.single.length,
    };
  }
  const delta = pairedDeltaCI(samples.treatment.batch, samples.baseline.batch, { resamples: 10000, seed: 0x1a21 });
  const ratio = pairedRatioCI(samples.treatment.batch, samples.baseline.batch, { resamples: 10000, seed: 0x1a22 });

  const report = {
    schema: "ultrasearch.bench.engine-concurrency/v1",
    status: gate.ok ? "final" : "degraded",
    date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    gate,
    method: {
      design: "counterbalanced alternating rounds; raw sockets; two daemons over one fixture",
      statistic: "median of paired rounds; batch = concurrent greps issued together",
      ci: "seeded bootstrap, 10000 resamples",
      note: "ratio ~1 = batch finishes like one call; ~N = serialized; cores = daemon cputime / wall during the batch",
    },
    platform: { os: process.platform, arch: process.arch, cpus: os.cpus().length, loadavg: os.loadavg() },
    fixture: { root, files: args.files },
    workload: { pattern: args.pattern, limit: args.limit, concurrent: args.concurrent, pairs: args.pairs },
    daemons: daemons.map((d) => ({
      name: d.name,
      bin: d.bin,
      pid: d.child.pid,
      entries: d.status.entries,
      content_docs: d.status.content_docs,
      socket: d.socket,
    })),
    summary,
    pairedBatchDeltaMs: delta,
    pairedBatchRatio: ratio,
    significant: ciExcludesZero(delta),
    samples,
  };

  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `concurrency-${report.date}${report.status === "final" ? "" : "-degraded"}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const name of ["baseline", "treatment"]) {
      const s = summary[name];
      console.log(`[${name.padEnd(9)}] single ${fmt(s.singleMedianMs)} ms | batch(${args.concurrent}) ${fmt(s.batchMedianMs)} ms | ratio ${s.ratio.toFixed(2)} | cores ${s.coresUsed.toFixed(2)} | n=${s.n}`);
    }
    console.log(`paired batch delta (treat - base): ${fmtCI(delta)} ms | ratio ${fmtCI(ratio, 3)} | significant ${report.significant}`);
    console.log(`wrote ${file}`);
  }
  for (const d of daemons) d.child.kill("SIGTERM");
  if (!gate.ok && !args.forceDegraded) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
