#!/usr/bin/env node
// bench/verification/checks/daemon-block.mjs — capture the daemon provenance block
// that every gated artifact must carry (mission requirement for the F10 re-run):
// pid, entries, event_id, and proof that exactly one process owns the socket.
//
//   node bench/verification/checks/daemon-block.mjs [--out <file>] [--gate <file>]
//
// Writes/prints:
//   { socket, socket_owner_pid, socket_owner_count, serve_process_count,
//     single_socket_owner, entries, event_id, last_event_id, content_docs,
//     index_bytes, full_disk_access, staleness_ms, replay_in_progress,
//     event_lag, compactions, gate, captured_at, client_commit }

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.PI_ULTRASEARCH_TEST = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

const SOCKET = path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock");

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
}

function rawStatus() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: SOCKET });
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("status timeout"));
    }, 10000);
    sock.on("connect", () => sock.write(JSON.stringify({ id: 1, op: "status" }) + "\n"));
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

const owners = tryExec("lsof", ["-t", SOCKET]).split("\n").map((s) => s.trim()).filter(Boolean);
const servers = tryExec("pgrep", ["-f", "UltraSearch.*serve"]).split("\n").map((s) => s.trim()).filter(Boolean);
const status = await rawStatus().catch((e) => ({ error: String(e?.message ?? e) }));

const block = {
  socket: SOCKET,
  socket_owner_pid: owners.length ? Number(owners[0]) : null,
  socket_owner_count: owners.length,
  serve_process_count: servers.length,
  single_socket_owner: owners.length === 1 && servers.length === 1,
  entries: status.entries ?? null,
  event_id: status.event_id ?? null,
  last_event_id: status.last_event_id ?? null,
  event_lag: status.event_lag ?? null,
  content_docs: status.content_docs ?? null,
  content_pending: status.content_pending ?? null,
  index_bytes: status.index_bytes ?? null,
  full_disk_access: status.full_disk_access ?? null,
  staleness_ms: status.staleness_ms ?? null,
  replay_in_progress: status.replay_in_progress ?? null,
  compactions: status.compactions ?? null,
  status_error: status.error ?? null,
  client_commit: tryExec("git", ["-C", REPO, "rev-parse", "HEAD"]) || null,
  captured_at: new Date().toISOString(),
};

const gateFile = opt("gate");
if (gateFile) {
  try {
    block.gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
  } catch {
    block.gate = null;
  }
}

/** Attach a provenance block to a measurement artifact (mutates + writes the file). */
export function stampArtifact(artifactPath, provenance) {
  const obj = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  obj.meta = obj.meta ?? {};
  // `daemon_pre_run` is always the pre-run precondition; `daemon_provenance` is the
  // scorer's own (post-run) capture when it has one, else the same block.
  obj.meta.daemon_pre_run = provenance;
  obj.meta.daemon_provenance = obj.meta.daemon_provenance ?? provenance;
  obj.meta.head_commit = obj.meta.head_commit ?? provenance.client_commit ?? null;
  fs.writeFileSync(artifactPath, JSON.stringify(obj, null, 2) + "\n");
  return obj;
}

const out = opt("out");
const target = opt("stamp");
if (target) {
  stampArtifact(target, block);
  console.log(`stamped ${target}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(block, null, 2) + "\n");
console.log(JSON.stringify({ pid: block.socket_owner_pid, single_owner: block.single_socket_owner, entries: block.entries, event_id: block.event_id, last_event_id: block.last_event_id, full_disk_access: block.full_disk_access }));
process.exit(block.single_socket_owner && !block.status_error ? 0 : 1);
