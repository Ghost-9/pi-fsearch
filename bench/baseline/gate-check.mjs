// bench/baseline/gate-check.mjs
// Exit 0 only when the measurement environment gate passes.
// Prints a JSON summary; used by run-all.sh --gate-wait and by hand.
import { environmentGate, ensureTestEnv } from "./lib.mjs";

ensureTestEnv();
const g = environmentGate();
console.log(
  JSON.stringify(
    {
      status: g.status,
      gate_pass: g.gate_pass,
      checks: g.checks,
      ac_power: g.power.on_ac,
      battery_percent: g.power.percent,
      discharging: g.power.discharging,
      load1: Number(g.loadavg[0].toFixed(2)),
      competing_processes: g.competing_processes,
      daemon_pid: g.daemon_pid,
      rule: g.gate_rule,
      checked_at: g.checked_at,
    },
    null,
    1,
  ),
);
process.exit(g.gate_pass ? 0 : 1);
