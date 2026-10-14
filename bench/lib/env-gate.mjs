/**
 * Environment gate for benchmark runs (advisor finding #3).
 *
 * A measurement is only written as a final result when the machine is in a
 * comparable state: AC power, load1m below the threshold, no cargo/rustc
 * builds competing for CPU. The daemon identity (pid, index size) is recorded
 * with every result so a later run can be compared against the same index.
 */
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { resolveDefaultSocketPath } from "../../src/client.ts";

function socketOwnerPid(socketPath) {
  try {
    const out = execFileSync("lsof", ["-t", socketPath], { encoding: "utf-8" }).trim();
    return out ? Number(out.split("\n")[0]) : null;
  } catch {
    return null;
  }
}

export function pidsMatching(pattern, options = {}) {
  try {
    const args = options.exact ? ["-x", pattern] : ["-f", pattern];
    const out = execFileSync("pgrep", args, { encoding: "utf-8" }).trim();
    return out
      ? out
          .split("\n")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [];
  } catch {
    // pgrep exits 1 when nothing matches
    return [];
  }
}

export function checkEnvironment(options = {}) {
  const maxLoad1m = options.maxLoad1m ?? 1.5;
  const reasons = [];
  const info = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
  };

  // Power source
  try {
    const batt = execFileSync("pmset", ["-g", "batt"], { encoding: "utf-8" });
    info.onAC = /AC Power/i.test(batt);
    info.powerSource = (batt.match(/Now drawing from '([^']+)'/) || [])[1] ?? "unknown";
    if (!info.onAC) reasons.push(`power source is '${info.powerSource}', not AC`);
  } catch (err) {
    info.onAC = null;
    reasons.push(`could not verify AC power (pmset unavailable: ${err?.message ?? err})`);
  }

  // Load average
  const [l1, l5, l15] = os.loadavg();
  info.load1m = Number(l1.toFixed(3));
  info.load5m = Number(l5.toFixed(3));
  info.load15m = Number(l15.toFixed(3));
  if (info.load1m >= maxLoad1m) {
    reasons.push(`load1m ${info.load1m.toFixed(2)} >= ${maxLoad1m}`);
  }

  // Competing compiler processes
  const competing = [];
  for (const name of options.forbiddenProcesses ?? ["cargo", "rustc"]) {
    const pids = pidsMatching(name, { exact: true });
    if (pids.length > 0) competing.push({ name, pids });
  }
  info.competingProcesses = competing;
  if (competing.length > 0) {
    reasons.push(`competing compiler processes: ${competing.map((c) => `${c.name}(${c.pids.join(",")})`).join(" ")}`);
  }

  // Daemon identity. pgrep alone is not enough: during this session a second
  // daemon was auto-spawned from ~/Applications and took over the socket while
  // the original kept running, so the socket owner is the pid that matters.
  info.daemonPids = pidsMatching("UltraSearch.*serve");
  info.daemonPid = info.daemonPids[0] ?? null;
  info.socketOwnerPid = socketOwnerPid(resolveDefaultSocketPath());
  info.daemonWarnings = [];
  if (info.daemonPids.length > 1) {
    info.daemonWarnings.push(`multiple daemons running: ${info.daemonPids.join(", ")} (socket owner: ${info.socketOwnerPid ?? "unknown"})`);
  }
  if (info.socketOwnerPid && info.daemonPid && info.socketOwnerPid !== info.daemonPid) {
    info.daemonWarnings.push(`pgrep-first pid ${info.daemonPid} is not the socket owner ${info.socketOwnerPid}`);
  }

  return { ok: reasons.length === 0, reasons, info };
}

/** Adds live daemon state to the environment record. */
export async function environmentWithDaemon(client, options = {}) {
  const gate = checkEnvironment(options);
  try {
    const status = await client.status();
    gate.info.daemon = {
      pid: gate.info.socketOwnerPid ?? gate.info.daemonPid,
      entries: status.entries ?? null,
      index_bytes: status.index_bytes ?? null,
      content_docs: status.content_docs ?? null,
      content_pending: status.content_pending ?? null,
    };
  } catch (err) {
    gate.reasons.push(`daemon status unavailable: ${err?.message ?? err}`);
    gate.ok = false;
    gate.info.daemon = { pid: gate.info.daemonPid, error: String(err?.message ?? err) };
  }
  return gate;
}

export function formatEnvironmentGate(gate) {
  const lines = [];
  lines.push(`environment: ${gate.ok ? "OK" : "REFUSED"}`);
  lines.push(
    `  power=${gate.info.powerSource ?? "unknown"} load1m=${gate.info.load1m} host=${gate.info.hostname} cpu=${gate.info.cpuModel}`
  );
  if (gate.info.daemon) lines.push(`  daemon pid=${gate.info.daemon.pid ?? "?"} index_bytes=${gate.info.daemon.index_bytes ?? "?"} entries=${gate.info.daemon.entries ?? "?"}`);
  for (const w of gate.info.daemonWarnings ?? []) lines.push(`  warning: ${w}`);
  for (const r of gate.reasons) lines.push(`  reason: ${r}`);
  return lines.join("\n");
}
