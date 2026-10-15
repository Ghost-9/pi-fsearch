#!/usr/bin/env node
// bench/verification/backlog/lib.mjs — shared helpers for the wave-5 backlog
// adjudication (issues #20-#54). Verifier-owned: nothing here imports the
// author's verification scripts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..", "..");
export const ENGINE_BIN =
  process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch");
export const CORPUS = process.env.VERIFY_CORPUS ?? "/Users/batra/.cache/ultrasearch/corpus/wave1-0a16e50";

export function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Sorted-key JSON hash, so key order in the emitting object cannot change it. */
export function stableHash(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return sha256Text(JSON.stringify(norm(value)));
}

export function tmpdir(prefix = "ults-verify-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function nowIso() {
  return new Date().toISOString();
}

/** Gate check, run by the verifier itself (mirrors bench/baseline/gate-check.mjs). */
export function gate() {
  const load1 = os.loadavg()[0];
  let ac = null;
  try {
    ac = execFileSync("pmset", ["-g", "batt"], { encoding: "utf-8" });
  } catch {
    ac = "";
  }
  const onAc = /'AC Power'/.test(ac);
  let competing = [];
  try {
    const ps = execFileSync("ps", ["-Ao", "comm="], { encoding: "utf-8" });
    competing = ps
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /(^|\/)(cargo|rustc)$/.test(l));
  } catch {
    /* ignore */
  }
  return {
    status: onAc && load1 < 1.5 && competing.length === 0 ? "final" : "provisional",
    pass: onAc && load1 < 1.5 && competing.length === 0,
    ac_power: onAc,
    load1,
    competing_processes: competing,
    rule: "AC power AND 1-min load < 1.5 AND no cargo/rustc process",
  };
}

/** Spawn with timeout, capture stdout/stderr and exit code. */
export function run(command, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? REPO,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out, stderr: err, timedOut, command: `${command} ${args.join(" ")}` });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, stdout: out, stderr: String(e), timedOut, command: `${command} ${args.join(" ")}`, spawnError: String(e) });
    });
  });
}

/** One line-delimited JSON request over a socket; returns the parsed reply. */
export function rawJson(socket, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: socket });
    let b = "";
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms: ${JSON.stringify(payload)}`));
    }, timeoutMs);
    s.on("connect", () => s.write(JSON.stringify(payload) + "\n"));
    s.on("data", (d) => {
      b += d.toString();
      if (b.includes("\n")) {
        clearTimeout(t);
        s.destroy();
        try {
          resolve(JSON.parse(b.slice(0, b.indexOf("\n"))));
        } catch (e) {
          reject(e);
        }
      }
    });
    s.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Start an isolated daemon over `corpus`; returns a handle with stop(). */
export async function startIsolatedDaemon({ dir = tmpdir("ults-iso-"), corpus = CORPUS, warm = false, timeoutMs = 180000 } = {}) {
  const socket = path.join(dir, "ultrasearch.sock");
  const env = {
    ...process.env,
    ULTRASEARCH_DIR: dir,
    ULTRASEARCH_HOME: corpus,
    ULTRASEARCH_SCAN_ROOT: corpus,
    ...(warm ? { ULTRASEARCH_WARM: corpus } : {}),
  };
  const logPath = path.join(dir, "daemon.log");
  const log = fs.openSync(logPath, "a");
  const child = spawn(ENGINE_BIN, ["serve"], { env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const st = await rawJson(socket, { id: 1, op: "status" }, 4000);
      last = st;
      if (st.ok === true && (st.content_pending ?? 0) === 0) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  const status = last;
  return {
    dir,
    socket,
    pid: child.pid,
    status,
    logPath,
    async stop() {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(child.pid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      // the daemon leaves the socket behind on some paths
      try {
        fs.rmSync(socket, { force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** Copy the repo (working tree, tracked files only) to a scratch dir for mutation tests. */
export function scratchCopy(tag) {
  const dir = tmpdir(`ults-mutate-${tag}-`);
  const tar = path.join(dir, "tree.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("tar", ["-xf", tar, "-C", dir], { stdio: ["ignore", "ignore", "inherit"] });
  fs.rmSync(tar, { force: true });
  // node_modules is needed by some tests but is gitignored; symlink it.
  const nm = path.join(REPO, "node_modules");
  if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, "node_modules"))) {
    fs.symlinkSync(nm, path.join(dir, "node_modules"));
  }
  const engine = path.join(REPO, "engine", "target");
  if (fs.existsSync(engine) && !fs.existsSync(path.join(dir, "engine", "target"))) {
    fs.symlinkSync(engine, path.join(dir, "engine", "target"));
  }
  return dir;
}

/** Textual replacement in a file, fatal when the needle is absent (mutation must land). */
export function mutate(file, oldText, newText) {
  const src = fs.readFileSync(file, "utf-8");
  if (!src.includes(oldText)) throw new Error(`mutation needle not found in ${file}: ${JSON.stringify(oldText.slice(0, 80))}`);
  fs.writeFileSync(file, src.replace(oldText, newText));
}

export class Recorder {
  constructor(issue, claim) {
    this.row = {
      issue,
      claim,
      verdict: "needs-work",
      evidence: "",
      method: "",
      n: 0,
      gate: null,
      artifact: "",
      evidence_hashes: {},
      notes: "",
    };
  }
  set(patch) {
    Object.assign(this.row, patch);
    return this;
  }
  addHash(key, value) {
    this.row.evidence_hashes[key] = typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : stableHash(value);
    return this;
  }
  done() {
    return this.row;
  }
}

/** Write a JSON artifact and return its sha256. */
export function writeArtifact(relPath, value) {
  const abs = path.join(REPO, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(value, null, 2) + "\n");
  return { path: relPath, sha256: sha256(abs) };
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** Percentile of a numeric sample (linear interpolation, matches common p50/p95 use). */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Seeded splitmix64 — an independent PRNG so bootstrap CIs are reproducible. */
export function splitmix64(seed) {
  let s = BigInt(seed) & 0xffffffffffffffffn;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    z = z ^ (z >> 31n);
    return Number(z >> 11n) / Number(1n << 53n);
  };
}

/** Bootstrap 95% CI of the median (verifier-owned implementation). */
export function bootstrapMedianCI(values, { resamples = 10000, seed = 20261015 } = {}) {
  if (values.length === 0) return { median: null, lo: null, hi: null, n: 0 };
  const rand = splitmix64(seed);
  const meds = [];
  for (let i = 0; i < resamples; i++) {
    const sample = new Array(values.length);
    for (let j = 0; j < values.length; j++) sample[j] = values[Math.floor(rand() * values.length)];
    meds.push(percentile(sample, 0.5));
  }
  return {
    median: percentile(values, 0.5),
    lo: percentile(meds, 0.025),
    hi: percentile(meds, 0.975),
    n: values.length,
    resamples,
    seed,
  };
}
