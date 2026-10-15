#!/usr/bin/env node
// bench/verification/wave4/isolated-scope-daemon.mjs — start an isolated engine
// daemon whose content-index HOME and whose allowed SCAN_ROOT are different
// places. Needed for the trigram-guard check: `search`/`grep` may scan anywhere
// under SCAN_ROOT, but the content index (source=index) only covers HOME.
//
//   node isolated-scope-daemon.mjs start --dir <d> --home <indexed> --scan <root> \
//        [--expect-docs <n>] [--engine <path>]
//   node isolated-scope-daemon.mjs stop  --dir <d>
//
// Never touches the live daemon: the socket is <d>/ultrasearch.sock.

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DIR = opt("dir");
const SOCKET = path.join(DIR ?? "", "ultrasearch.sock");
const PIDFILE = path.join(DIR ?? "", "scope-daemon.pid");
const ENGINE = opt("engine", process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch"));

const raw = (payload, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const s = net.createConnection({ path: SOCKET });
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

if (cmd === "start") {
  const HOME = opt("home");
  const SCAN = opt("scan");
  const WANT = Number(opt("expect-docs", 0));
  if (!DIR || !HOME || !SCAN) {
    console.error("--dir, --home and --scan are required");
    process.exit(2);
  }
  fs.mkdirSync(DIR, { recursive: true });
  const env = { ...process.env, ULTRASEARCH_DIR: DIR, ULTRASEARCH_HOME: HOME, ULTRASEARCH_SCAN_ROOT: SCAN, ULTRASEARCH_WARM: HOME };
  const log = fs.openSync(path.join(DIR, "scope-daemon.log"), "a");
  const child = spawn(ENGINE, ["serve"], { env, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  const deadline = Date.now() + 90000;
  let last = -1;
  let stable = 0;
  let st = null;
  while (Date.now() < deadline) {
    st = await raw({ op: "status" }).catch(() => null);
    const docs = st?.content_docs ?? 0;
    const pending = st?.content_pending ?? 0;
    if (docs === last && docs >= WANT && pending === 0) {
      if (++stable >= 3) break;
    } else stable = 0;
    last = docs;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!st || last < WANT) {
    console.error(`content index did not reach ${WANT} docs (saw ${last})`);
    process.exit(1);
  }
  console.log(JSON.stringify({ pid: child.pid, socket: SOCKET, dir: DIR, home: HOME, scan: SCAN, entries: st.entries ?? null, content_docs: st.content_docs ?? null, content_pending: st.content_pending ?? null }));
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
      /* gone */
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
} else {
  console.error("usage: start|stop");
  process.exit(2);
}
