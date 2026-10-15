#!/usr/bin/env node
/**
 * Transparent MCP stdio recorder (issue #52).
 *
 * Native-arm smoke support: a harness is pointed at this script instead of at
 * the server directly. Every frame is appended to a log file, then forwarded
 * byte-for-byte to the wrapped server, and the server's stdout is forwarded
 * back untouched. That makes the harness's *own* client behavior measurable —
 * notably the `protocolVersion` and `clientInfo` it actually sends — while the
 * harness still talks to the real UltraSearch MCP server.
 *
 * Usage:
 *   node bench/harness-smoke/probe-server.mjs --log <file.jsonl> -- <command> [args...]
 *
 * Stdout carries only protocol frames; diagnostics go to stderr.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";

function parseArgs(argv) {
  let log = null;
  let separator = argv.indexOf("--");
  if (separator === -1) separator = argv.length;
  for (let i = 0; i < separator; i++) {
    if (argv[i] === "--log" && argv[i + 1]) log = argv[++i];
    else if (argv[i].startsWith("--log=")) log = argv[i].slice("--log=".length);
  }
  return { log, command: argv.slice(separator + 1) };
}

const { log, command } = parseArgs(process.argv.slice(2));
if (!log || command.length === 0) {
  process.stderr.write("usage: probe-server.mjs --log <file.jsonl> -- <command> [args...]\n");
  process.exit(2);
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
let logged = 0;

function record(dir, frame) {
  if (logged > MAX_LOG_BYTES) return;
  const line = JSON.stringify({ dir, at: Date.now(), frame }) + "\n";
  logged += line.length;
  try {
    fs.appendFileSync(log, line);
  } catch {}
}

const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    record("in", JSON.parse(trimmed));
  } catch {
    record("in", { unparsed: trimmed.slice(0, 500) });
  }
  if (!child.stdin.destroyed) child.stdin.write(trimmed + "\n");
});
rl.on("close", () => {
  if (!child.stdin.destroyed) child.stdin.end();
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});
child.stdout.setEncoding("utf8");
let outBuffer = "";
child.stdout.on("data", (chunk) => {
  outBuffer += chunk;
  let idx;
  while ((idx = outBuffer.indexOf("\n")) >= 0) {
    const line = outBuffer.slice(0, idx).trim();
    outBuffer = outBuffer.slice(idx + 1);
    if (!line) continue;
    try {
      record("out", JSON.parse(line));
    } catch {
      record("out", { unparsed: line.slice(0, 500) });
    }
  }
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
child.on("error", (err) => {
  process.stderr.write(`probe-server: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
