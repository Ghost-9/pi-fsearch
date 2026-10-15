#!/usr/bin/env node
// bench/verification/backlog/checks/f24-fallback.mjs — issue #24
//
// Claim: native fallback is async with timeout + cancellation; no `execFileSync`
// in the request path; a cancelled fallback stops the child; the event loop
// stays responsive (measured).
//
// Independent method:
//  1. run the real fallback trigger (HOME=temp => a consent-gated scope) with a
//     stubbed `rg` that sleeps, sampling the event loop from a 10 ms interval;
//  2. removal control: mutate `src/spawn.ts` in a scratch copy to the blocking
//     `execFileSync` implementation the issue replaced, and re-run the probe —
//     it must show the block, or the probe proves nothing;
//  3. cancel mid-flight and count tracked children;
//  4. probe `index.ts::resolveWorktreeRoot` from a non-git cwd with a stubbed
//     `git` — is its `execFileSync` reachable from a tool call?

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { REPO, gate, run, sha256, sha256Text, scratchCopy, mutate, writeArtifact, tmpdir, rmrf } from "../lib.mjs";

function runProbe(source, { cwd = REPO, env = {}, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        resolve({ probe_error: `exit=${code} out=${out.slice(-400)} err=${err.slice(-600)}` });
      }
    });
  });
}

/** Body shared by both probes: HOME -> consent-gated scope, stubbed rg. */
function fallbackProbeSource(importRoot) {
  return `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const ROOT = ${JSON.stringify(importRoot)};
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ults-home-"));
process.env.HOME = home;
process.env.PI_ULTRASEARCH_TEST = "1";
const scope = path.join(home, "Documents", "scope");
fs.mkdirSync(scope, { recursive: true });
fs.writeFileSync(path.join(scope, "a.txt"), "marker\\n");

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ults-bin-"));
const rg = path.join(bin, "rg");
fs.writeFileSync(rg, "#!/bin/sh\\nfor last; do :; done\\nsleep " + (process.env.STUB_SLEEP_MS || "0.4") + "\\nprintf '%s\\\\n' \\"$last/a.txt\\"\\n");
fs.chmodSync(rg, 0o755);
process.env.PATH = bin + ":" + process.env.PATH;

const { UltraSearchClient } = await import(path.join(ROOT, "src", "client.ts"));
const { activeChildCount } = await import(path.join(ROOT, "src", "spawn.ts"));
const client = new UltraSearchClient({
  socketPath: path.join(home, "no-such.sock"),
  autoSpawnDaemon: false,
  maxReconnectRetries: 0,
  lanes: 1,
  timeoutMs: 300,
  enableFallback: true,
});
const gaps = [];
let last = performance.now();
const iv = setInterval(() => { const n = performance.now(); gaps.push(n - last); last = n; }, 10);
const started = performance.now();
let res;
try { res = await client.search("a.txt", { in: scope, limit: 5, skipAudit: true, respectIgnore: false }); }
catch (e) { res = { error: String(e) }; }
const elapsed = performance.now() - started;
await new Promise((r) => setTimeout(r, 200)); // let the interval catch up after any block
gaps.push(performance.now() - last);
clearInterval(iv);
const out = {
  elapsed_ms: Math.round(elapsed),
  max_gap_ms: Math.round(Math.max(...gaps) * 100) / 100,
  ticks: gaps.length,
  expected_ticks: Math.round((elapsed + 200) / 10),
  source: res.source ?? null,
  hits: res.hits?.length ?? null,
  error: res.error ?? null,
  active_children_after: activeChildCount(),
};
console.log(JSON.stringify(out));
client.close();
fs.rmSync(home, { recursive: true, force: true });
`;
}

const INDEX_PROBE = `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerHooks } from "node:module";
const ROOT = process.env.PROBE_REPO;
registerHooks({ resolve(spec, ctx, next) {
  if (spec === "typebox") return { url: new URL("test/helpers/typebox-stub.mjs", "file://" + ROOT + "/").href, shortCircuit: true };
  return next(spec, ctx);
}});
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ults-home-"));
process.env.HOME = home;
process.env.PI_ULTRASEARCH_TEST = "1";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ults-nogit-"));
process.chdir(cwd); // no .git anywhere up the temp tree
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ults-gitbin-"));
const git = path.join(bin, "git");
const log = path.join(home, "git-invoked.log");
fs.writeFileSync(git, "#!/bin/sh\\nsleep " + (process.env.STUB_SLEEP_MS || "0.4") + "\\necho x >> " + JSON.stringify(log) + "\\nexit 128\\n");
fs.chmodSync(git, 0o755);
process.env.PATH = bin + ":" + process.env.PATH;
const { loadPiHarness } = await import(path.join(ROOT, "test/helpers/pi-harness.ts"));
const harness = await loadPiHarness({ socketPath: path.join(home, "no-such.sock") });
const gaps = [];
let last = performance.now();
const iv = setInterval(() => { const n = performance.now(); gaps.push(n - last); last = n; }, 10);
const started = performance.now();
let err = null;
try { await harness.callTool("query", { query: "x", limit: 1 }); } catch (e) { err = String(e).slice(0, 200); }
const elapsed = performance.now() - started;
await new Promise((r) => setTimeout(r, 200));
gaps.push(performance.now() - last);
clearInterval(iv);
const invocations = fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\\n").filter(Boolean).length : 0;
console.log(JSON.stringify({ elapsed_ms: Math.round(elapsed), max_gap_ms: Math.round(Math.max(...gaps) * 100) / 100, git_invocations: invocations, error: err }));
process.exit(0);
`;

const CANCEL_PROBE = `
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const ROOT = ${JSON.stringify(REPO)};
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ults-home-"));
process.env.HOME = home; process.env.PI_ULTRASEARCH_TEST = "1";
const scope = path.join(home, "Documents", "scope"); fs.mkdirSync(scope, { recursive: true });
fs.writeFileSync(path.join(scope, "a.txt"), "marker\\n");
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ults-bin-")); const rg = path.join(bin, "rg");
fs.writeFileSync(rg, "#!/bin/sh\\ntrap 'exit 143' TERM\\nsleep 5\\n"); fs.chmodSync(rg, 0o755);
process.env.PATH = bin + ":" + process.env.PATH;
const { UltraSearchClient } = await import(path.join(ROOT, "src", "client.ts"));
const { activeChildCount } = await import(path.join(ROOT, "src", "spawn.ts"));
const client = new UltraSearchClient({ socketPath: path.join(home, "no.sock"), autoSpawnDaemon: false, maxReconnectRetries: 0, lanes: 1, timeoutMs: 300, enableFallback: true });
const ac = new AbortController();
const p = client.search("a.txt", { in: scope, limit: 5, skipAudit: true, respectIgnore: false, signal: ac.signal });
await new Promise(r => setTimeout(r, 400));
const during = activeChildCount();
ac.abort();
const res = await p;
await new Promise(r => setTimeout(r, 500));
console.log(JSON.stringify({ children_during: during, children_after: activeChildCount(), error: res.error ?? null, ok: res.ok }));
client.close(); fs.rmSync(home, { recursive: true, force: true });
`;

// The mutation: spawnCapture's async spawn replaced by the blocking call the
// issue was filed about. Keeps the same result shape.
const SPAWN_MUTATION = {
  needle: 'import { spawn, type ChildProcess } from "node:child_process";',
  replacement: 'import { spawn, execFileSync, type ChildProcess } from "node:child_process";',
};
const SPAWN_MUTATION2 = {
  needle: `  return await new Promise<SpawnCaptureResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;`,
  replacement: `  // MUTATION (removal test): the synchronous implementation issue #24 replaced.
  if (process.env.ULTS_BLOCKING_FALLBACK === "1") {
    const syncStart = performance.now();
    try {
      const stdout = String(execFileSync(command, args, { cwd: options.cwd, env: options.env, timeout: timeoutMs, maxBuffer, encoding: "utf-8" }));
      return { ok: true, stdout, stderr: "", code: 0, signal: null, timedOut: false, cancelled: false, truncated: false, notFound: false, ms: Math.round((performance.now() - syncStart) * 100) / 100 };
    } catch (err: any) {
      return { ok: false, stdout: "", stderr: String(err?.stderr ?? ""), code: err?.status ?? null, signal: null, timedOut: false, cancelled: false, truncated: false, notFound: err?.code === "ENOENT", ms: Math.round((performance.now() - syncStart) * 100) / 100, error: String(err?.message ?? err) };
    }
  }
  return await new Promise<SpawnCaptureResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;`,
};

export async function check() {
  const g = gate();
  const lexical = await run("sh", [
    "-c",
    `cd ${REPO} && for f in src/*.ts index.ts bin/*.ts; do grep -Hn "execFileSync\\|execSync *(" "$f" 2>/dev/null; done; true`,
  ]);

  const asyncProbe = await runProbe(fallbackProbeSource(REPO));

  // removal control in a scratch copy
  let scratch = null;
  let syncProbe = null;
  let mutationError = null;
  try {
    scratch = scratchCopy("f24");
    mutate(path.join(scratch, "src", "spawn.ts"), SPAWN_MUTATION.needle, SPAWN_MUTATION.replacement);
    mutate(path.join(scratch, "src", "spawn.ts"), SPAWN_MUTATION2.needle, SPAWN_MUTATION2.replacement);
    // sanity: the mutation is syntactically valid
    const typecheck = await run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(path.join(scratch, "src", "spawn.ts"))})`], { cwd: scratch, timeoutMs: 60000 });
    if (typecheck.code !== 0) mutationError = `scratch spawn.ts failed to import: ${typecheck.stderr.slice(-300)}`;
    else syncProbe = await runProbe(fallbackProbeSource(scratch), { env: { ULTS_BLOCKING_FALLBACK: "1" } });
  } catch (e) {
    mutationError = String(e);
  }

  const idxProbe = await runProbe(INDEX_PROBE, { env: { PROBE_REPO: REPO } });
  const cancelProbe = await runProbe(CANCEL_PROBE);

  const indexSync = lexical.stdout
    .split("\n")
    .filter((l) => /execFileSync/.test(l) && l.includes("index.ts"));

  const responsive = typeof asyncProbe.max_gap_ms === "number" && asyncProbe.max_gap_ms < 150;
  const controlBlocks = typeof syncProbe?.max_gap_ms === "number" && syncProbe.max_gap_ms >= 250;
  const indexBlocks = typeof idxProbe.max_gap_ms === "number" && idxProbe.max_gap_ms >= 250 && idxProbe.git_invocations > 0;
  const cancelled = (cancelProbe.children_during ?? 0) >= 1 && (cancelProbe.children_after ?? -1) === 0;

  const defects = [];
  if (!responsive) defects.push(`async probe max event-loop gap ${asyncProbe.max_gap_ms}ms (ticks ${asyncProbe.ticks}/${asyncProbe.expected_ticks})`);
  if (!controlBlocks) defects.push(`removal control did not block: max_gap_ms=${syncProbe?.max_gap_ms} (${mutationError ?? "no mutation error"})`);
  if (!cancelled) defects.push(`cancellation/leak check: ${JSON.stringify(cancelProbe)}`);
  if (indexBlocks)
    defects.push(
      `execFileSync still in the request path: index.ts::resolveWorktreeRoot shells out to git for a non-git cwd (blocked ${idxProbe.max_gap_ms}ms, ${idxProbe.git_invocations} invocation(s))`
    );

  const artifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    lexical_scan: lexical.stdout.trim().split("\n"),
    async_probe: asyncProbe,
    removal_control: { mutation_error: mutationError, sync_probe: syncProbe },
    index_request_path_probe: idxProbe,
    cancellation_probe: cancelProbe,
    verdicts: { responsive, control_blocks: controlBlocks, index_blocks: indexBlocks, cancelled },
    defects,
  };
  const written = writeArtifact("bench/verification/backlog/results/f24-fallback.json", artifact);

  return [
    {
      issue: 24,
      claim:
        "async fallback with timeout + cancellation; no `execFileSync` in the request path; a cancelled fallback stops the child; event loop responsive (measured)",
      verdict: defects.length ? "needs-work" : "verified",
      evidence:
        `real fallback trigger with a sleeping stubbed rg: event loop max gap ${asyncProbe.max_gap_ms}ms over ${asyncProbe.ticks} ticks ` +
        `(${asyncProbe.expected_ticks} expected) for a ${asyncProbe.elapsed_ms}ms call, source=${asyncProbe.source}, hits=${asyncProbe.hits}; ` +
        `removal control (src/spawn.ts -> execFileSync in a scratch copy): max gap ${syncProbe?.max_gap_ms}ms; ` +
        `cancellation: ${cancelProbe.children_during} child tracked mid-flight, ${cancelProbe.children_after} after abort (${JSON.stringify(cancelProbe.error)}); ` +
        `index.ts::resolveWorktreeRoot from a non-git cwd: ${idxProbe.git_invocations} sync git invocation(s), max gap ${idxProbe.max_gap_ms}ms`,
      method:
        "verifier probe: HOME=temp so the consent-gated fallback trigger fires; stubbed `rg` sleeps 400ms; 10ms event-loop sampler around client.search(); removal control mutates src/spawn.ts in a scratch copy of HEAD; index.ts probed through the real Pi harness with a stubbed `git` from a non-git cwd",
      n: 3,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f24-fallback.json",
      evidence_hashes: {
        artifact: written.sha256,
        lexical: sha256Text(lexical.stdout),
        async_probe: sha256Text(JSON.stringify(asyncProbe)),
        sync_probe: sha256Text(JSON.stringify(syncProbe)),
        index_probe: sha256Text(JSON.stringify(idxProbe)),
        cancellation: sha256Text(JSON.stringify(cancelProbe)),
      },
      notes: defects.length
        ? defects.join(" | ")
        : "all three acceptance lines reproduced independently (async path, cancellation, no blocking)",
    },
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
