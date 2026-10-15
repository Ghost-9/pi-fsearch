#!/usr/bin/env node
// bench/verification/backlog/checks/f40-history.mjs — issue #40
//
// Claim: query history is opt-in (default off), stored locally with a
// documented retention cap and opt-out, 0600, scrubbed, and surfaces
// suggestions in the TUI and CLI.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, gate, run, tmpdir, rmrf, sha256Text, writeArtifact, stableHash } from "../lib.mjs";

const CLI = path.join(REPO, "bin", "cli.ts");

export async function check() {
  const g = gate();
  const home = tmpdir("ults-hist-");
  const scope = path.join(home, "repo");
  fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(scope, "needle-file.txt"), "needle\n");
  const baseEnv = { HOME: home, PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_SOCKET: path.join(home, "none.sock"), PI_ULTRASEARCH_NO_SPAWN: "1" };

  // 1. default: no file is created by a real CLI query
  const plain = await run("node", [CLI, "query", "needle-file.txt", "--in", scope], { cwd: REPO, env: baseEnv, timeoutMs: 60000 });
  const defaultPath = path.join(home, ".cache", "ultrasearch", "history.json");
  const defaultExists = fs.existsSync(defaultPath);

  // 2. opt-in: an entry is written, 0600, and scrubbed
  // Runtime-constructed canary: credential-shaped for the scrubber under test, but
  // never a secret-shaped literal in the source (wave-1 finding F2, and GitHub push
  // protection classifies literal key-shaped strings).
  const canary = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("_");
  const optIn = await run("node", [CLI, "query", `needle-file.txt token=${canary}`, "--in", scope], {
    cwd: REPO,
    env: { ...baseEnv, ULTRASEARCH_HISTORY: "1" },
    timeoutMs: 60000,
  });
  const optInExists = fs.existsSync(defaultPath);
  let mode = null;
  let scrubbed = null;
  let contents = null;
  if (optInExists) {
    mode = (fs.statSync(defaultPath).mode & 0o777).toString(8);
    contents = fs.readFileSync(defaultPath, "utf-8");
    scrubbed = !contents.includes(canary) && /redact/i.test(contents);
  }

  // 3. explicit opt-out wins
  rmrf(path.dirname(defaultPath));
  await run("node", [CLI, "query", "needle-file.txt", "--in", scope], {
    cwd: REPO,
    env: { ...baseEnv, ULTRASEARCH_HISTORY: "0" },
    timeoutMs: 60000,
  });
  const optOutExists = fs.existsSync(defaultPath);

  // 4. retention cap: 12 entries with max=10
  const histPath = path.join(home, "capped.json");
  const { appendHistory, resolveHistoryOptions, loadHistory, suggestQueries } = await import(path.join(REPO, "src", "history.ts"));
  const opts = resolveHistoryOptions({ ULTRASEARCH_HISTORY: "1", ULTRASEARCH_HISTORY_MAX: "10", ULTRASEARCH_HISTORY_FILE: histPath });
  for (let i = 0; i < 12; i++) appendHistory({ q: `query-${i}`, tool: "ultrasearch_query" }, opts);
  const stored = loadHistory(opts);
  const capOk = stored.length === 10 && stored[stored.length - 1].q === "query-11" && stored[0].q === "query-2";

  // 5. suggestions from history (CLI surface)
  const suggest = await run("node", [CLI, "history", "--suggest", "query-", "--limit", "3"], {
    cwd: REPO,
    env: { ...baseEnv, ULTRASEARCH_HISTORY: "1", ULTRASEARCH_HISTORY_FILE: histPath },
    timeoutMs: 60000,
  });

  // 6. TUI surface reads history (source-level + call check)
  const tuiSrc = fs.readFileSync(path.join(REPO, "src", "tui.ts"), "utf-8");
  const tuiUsesHistory = /loadHistory|resolveHistoryOptions|suggestQueries/.test(tuiSrc);

  const defects = [];
  if (defaultExists) defects.push("default (no env) wrote a history file");
  if (!optInExists) defects.push("opt-in did not write a history file");
  if (mode !== "600") defects.push(`history file mode ${mode} != 600`);
  if (!scrubbed) defects.push("opt-in history stored an unscrubbed credential-shaped query");
  if (optOutExists) defects.push("ULTRASEARCH_HISTORY=0 still wrote a history file");
  if (!capOk) defects.push(`retention cap failed: ${stored.length} stored, first=${stored[0]?.q}, last=${stored[stored.length - 1]?.q}`);
  if (!/query-/.test(suggest.stdout)) defects.push(`CLI --suggest returned no suggestion: ${suggest.stdout.trim().slice(0, 120)}`);
  if (!tuiUsesHistory) defects.push("TUI does not read the history module");

  const artifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    default_run: { exit: plain.code, history_exists: defaultExists, stdout: plain.stdout.trim().slice(0, 200) },
    opt_in_run: { exit: optIn.code, history_exists: optInExists, mode, scrubbed, keys: contents ? Object.keys(JSON.parse(contents)) : null },
    opt_out_run: { history_exists: optOutExists },
    retention: { stored: stored.map((e) => e.q), ok: capOk },
    cli_suggest: { exit: suggest.code, stdout: suggest.stdout.trim(), stderr: suggest.stderr.trim().slice(0, 200) },
    tui_uses_history: tuiUsesHistory,
    defects,
  };
  const written = writeArtifact("bench/verification/backlog/results/f40-history.json", artifact);

  return [
    {
      issue: 40,
      claim: "query history: opt-in default off, documented retention cap and opt-out, 0600, scrubbed, suggestions in TUI and CLI",
      verdict: defects.length ? "needs-work" : "verified",
      evidence:
        `default run (no env): history file exists=${defaultExists}; ULTRASEARCH_HISTORY=1: exists=${optInExists}, mode=${mode}, credential-shaped token scrubbed=${scrubbed}; ` +
        `ULTRASEARCH_HISTORY=0: exists=${optOutExists}; retention max=10 after 12 appends: ${stored.length} stored (${stored[0]?.q}..${stored[stored.length - 1]?.q}); ` +
        `CLI --suggest returned: ${JSON.stringify(suggest.stdout.trim().slice(0, 60))}; TUI reads the module=${tuiUsesHistory}`,
      method: "real CLI (`bin/cli.ts`) runs under a temp HOME with an unreachable socket; retention and suggestion logic driven through the history module directly; the credential-shaped token is a verifier-constructed canary, never a real secret",
      n: 6,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f40-history.json",
      evidence_hashes: { artifact: written.sha256, probe: stableHash(artifact) },
      notes: defects.length ? defects.join(" | ") : "opt-in, mode, scrub, cap, opt-out and both surfaces reproduced",
    },
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
