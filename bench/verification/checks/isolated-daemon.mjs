#!/usr/bin/env node
// bench/verification/checks/isolated-daemon.mjs — run the built engine over a fixture
// corpus on its own socket, without touching the live daemon or the live index.
//
//   node bench/verification/checks/isolated-daemon.mjs start --dir <d> --corpus <c> [--warm]
//   node bench/verification/checks/isolated-daemon.mjs wait  --dir <d> [--timeout 120]
//   node bench/verification/checks/isolated-daemon.mjs stop  --dir <d>
//
// `start` spawns `engine/target/release/ultrasearch serve` with
//   ULTRASEARCH_DIR=<d>  ULTRASEARCH_HOME=<corpus>  ULTRASEARCH_SCAN_ROOT=<corpus>
// and prints {pid, socket, entries, content_docs}. The socket is <d>/ultrasearch.sock;
// clients reach it with PI_ULTRASEARCH_SOCKET=<socket>.

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const ENGINE_BIN = process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch");

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DIR = opt("dir");
const CORPUS = opt("corpus");
if (!DIR) {
  console.error("--dir is required");
  process.exit(2);
}
const SOCKET = path.join(DIR, "ultrasearch.sock");
const PIDFILE = path.join(DIR, "verify-daemon.pid");

function rawJson(socket, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: socket });
    let b = "";
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    s.on("connect", () => s.write(JSON.stringify({ id: 1, ...payload }) + "\n"));
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

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const st = await rawJson(SOCKET, { op: "status" }, 4000);
      last = st;
      if (st.ok === true && (st.content_pending ?? 0) === 0) return st;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`daemon not ready within ${timeoutMs}ms; last status: ${JSON.stringify(last)?.slice(0, 200)}`);
}

if (cmd === "start") {
  if (!CORPUS || !fs.existsSync(CORPUS)) {
    console.error(`corpus missing: ${CORPUS}`);
    process.exit(2);
  }
  if (!fs.existsSync(ENGINE_BIN)) {
    console.error(`engine binary missing: ${ENGINE_BIN} (run: cargo build --release --manifest-path engine/Cargo.toml)`);
    process.exit(2);
  }
  fs.mkdirSync(DIR, { recursive: true });
  const env = {
    ...process.env,
    ULTRASEARCH_DIR: DIR,
    ULTRASEARCH_HOME: CORPUS,
    ULTRASEARCH_SCAN_ROOT: CORPUS,
    ...(argv.includes("--warm") ? { ULTRASEARCH_WARM: CORPUS } : {}),
  };
  const log = fs.openSync(path.join(DIR, "verify-daemon.log"), "a");
  const child = spawn(ENGINE_BIN, ["serve"], { env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  const st = await waitReady(Number(opt("timeout", 120000)));
  console.log(JSON.stringify({ pid: child.pid, socket: SOCKET, dir: DIR, corpus: CORPUS, engine: ENGINE_BIN, entries: st.entries ?? null, content_docs: st.content_docs ?? null, content_pending: st.content_pending ?? null }));
  process.exit(0);
} else if (cmd === "wait") {
  const st = await waitReady(Number(opt("timeout", 120000)));
  console.log(JSON.stringify({ socket: SOCKET, entries: st.entries ?? null, content_docs: st.content_docs ?? null, content_pending: st.content_pending ?? null }));
  process.exit(0);
} else if (cmd === "stop") {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(PIDFILE, "utf8").trim());
  } catch {
    /* no pidfile */
  }
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    fs.rmSync(SOCKET, { force: true });
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ stopped: pid }));
  process.exit(0);
} else if (cmd === "status") {
  const st = await rawJson(SOCKET, { op: "status" }).catch((e) => ({ error: String(e) }));
  console.log(JSON.stringify(st));
  process.exit(0);
} else {
  console.error("usage: start|wait|stop|status --dir <d> [--corpus <c>] [--warm]");
  process.exit(2);
}
