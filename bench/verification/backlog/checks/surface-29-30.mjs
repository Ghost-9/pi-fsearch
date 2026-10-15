#!/usr/bin/env node
// bench/verification/backlog/checks/surface-29-30.mjs — issues #29, #30
//
// #29: Code Mode declarations are generated from the registry and a drift test
//      fails on mismatch; a recipe executes end to end in the sandbox.
// #30: the MCP alias surface defaults to exactly six tools; aliases are
//      callable; per-client profiles list and call a representative tool.
//
// Independent method: regenerate the declarations myself and diff; drive a real
// `bin/mcp-server.ts` child over stdio (initialize -> tools/list -> tools/call)
// for the default surface and for a configured alias; then run the drift guard
// against a mutated registry in a scratch copy to prove it is not vacuous.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { REPO, gate, run, sha256, sha256Text, scratchCopy, mutate, writeArtifact, stableHash } from "../lib.mjs";

/** Drive a real stdio MCP server child: returns the frames it answered. */
function mcpSession({ args = [], env = {}, requests }) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(REPO, "bin", "mcp-server.ts"), ...args], {
      cwd: REPO,
      env: { ...process.env, PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_NO_SPAWN: "1", PI_ULTRASEARCH_SOCKET: "/tmp/no-such-ults.sock", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    const finish = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    setTimeout(() => {
      const frames = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { parse_error: l.slice(0, 200) };
          }
        });
      finish();
      resolve({ frames, stderr: err.slice(0, 800) });
    }, 2500);
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verifier", version: "1" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

export async function check() {
  const g = gate();
  const rows = [];

  // ---------------- #29: declaration generation + drift ----------------
  const generated = await run("node", [path.join(REPO, "bin", "gen-codemode-declarations.ts"), "--stdout"], { cwd: REPO, timeoutMs: 60000 });
  const goldenPath = path.join(REPO, "test", "fixtures", "codemode-declarations.txt");
  const golden = fs.readFileSync(goldenPath, "utf-8");
  const declMatch = generated.stdout === golden;

  // the drift test in the repo, run by me
  const driftTest = await run("node", ["--test", "--test-name-pattern", "declarations", path.join(REPO, "test", "interop-surface.test.ts")], {
    cwd: REPO,
    env: { PI_ULTRASEARCH_TEST: "1" },
    timeoutMs: 180000,
  });
  const driftTestOk = /^[ℹ#] fail 0$/m.test(driftTest.stdout) && /[ℹ#] pass [1-9]/.test(driftTest.stdout);

  // recipes execute end to end
  const recipeTest = await run("node", ["--test", "--test-name-pattern", "recipes", path.join(REPO, "test", "interop-surface.test.ts")], {
    cwd: REPO,
    env: { PI_ULTRASEARCH_TEST: "1" },
    timeoutMs: 180000,
  });
  const recipeOk = /^[ℹ#] fail 0$/m.test(recipeTest.stdout) && /[ℹ#] pass [1-9]/.test(recipeTest.stdout);

  // removal control: a schema change must fail the drift guard
  let driftControl = { ran: false, failed: false, error: null };
  try {
    const scratch = scratchCopy("f29");
    mutate(
      path.join(scratch, "src", "tool-schema.ts"),
      'description:\n    "Exact indexed path search (<0.1ms, no typo tolerance).',
      'description:\n    "MUTATED indexed path search (<0.1ms, no typo tolerance).'
    );
    const ctl = await run("node", ["--test", "--test-name-pattern", "declarations", path.join(scratch, "test", "interop-surface.test.ts")], {
      cwd: scratch,
      env: { PI_ULTRASEARCH_TEST: "1" },
      timeoutMs: 180000,
    });
    driftControl = { ran: true, failed: /^[ℹ#] fail [1-9]/m.test(ctl.stdout), error: ctl.code };
  } catch (e) {
    driftControl.error = String(e);
  }

  const declDefects = [];
  if (!declMatch) declDefects.push("regenerated declarations differ from the committed golden");
  if (!driftTestOk) declDefects.push("the shipped declaration drift test did not pass");
  if (!recipeOk) declDefects.push("the recipe sandbox test did not pass");
  if (!driftControl.failed) declDefects.push("removal control: the drift guard did not fail on a registry mutation");

  const declArtifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    declaration_sha256: { regenerated: sha256Text(generated.stdout), golden: sha256Text(golden), match: declMatch },
    drift_test: { exit: driftTest.code, pass: (driftTest.stdout.match(/^[ℹ#] pass (\d+)/m) ?? [])[1], fail: (driftTest.stdout.match(/^[ℹ#] fail (\d+)/m) ?? [])[1] },
    recipe_test: { exit: recipeTest.code, pass: (recipeTest.stdout.match(/^[ℹ#] pass (\d+)/m) ?? [])[1], fail: (recipeTest.stdout.match(/^[ℹ#] fail (\d+)/m) ?? [])[1] },
    drift_removal_control: { ...driftControl, note: "registry mutated in a scratch copy of HEAD; the guard must fail" },
    defects: declDefects,
    stderr_tail: recipeTest.stderr.slice(-300),
  };
  const declWritten = writeArtifact("bench/verification/backlog/results/f29-codemode.json", declArtifact);

  rows.push({
    issue: 29,
    claim: "Code Mode declarations are generated from the registry with a drift test that fails the build on mismatch, plus end-to-end pipeline recipes",
    verdict: declDefects.length ? "needs-work" : "verified",
    evidence:
      `regenerated declarations sha256 ${sha256Text(generated.stdout).slice(0, 16)}… == committed golden ${sha256Text(golden).slice(0, 16)}… ${declMatch}; ` +
      `drift test: pass=${(driftTest.stdout.match(/^[ℹ#] pass (\d+)/m) ?? [])[1]} fail=${(driftTest.stdout.match(/^[ℹ#] fail (\d+)/m) ?? [])[1]}; ` +
      `recipe test: pass=${(recipeTest.stdout.match(/^[ℹ#] pass (\d+)/m) ?? [])[1]} fail=${(recipeTest.stdout.match(/^[ℹ#] fail (\d+)/m) ?? [])[1]}; ` +
      `removal control (registry mutated in scratch): drift guard failed=${driftControl.failed}`,
    method: "own regeneration via bin/gen-codemode-declarations.ts --stdout compared byte-for-byte with the golden; the repo's drift and recipe tests re-run by the verifier; removal control mutates src/tool-schema.ts in a scratch copy of HEAD",
    n: 4,
    gate: g.status,
    artifact: "bench/verification/backlog/results/f29-codemode.json",
    evidence_hashes: { artifact: declWritten.sha256, regenerated: sha256Text(generated.stdout), golden: sha256Text(golden), probe: stableHash(declArtifact) },
    notes: declDefects.length ? declDefects.join(" | ") : "generation is the single source, the guard is live and non-vacuous, recipes execute",
  });

  // ---------------- #30: MCP surface ----------------
  const defaultSession = await mcpSession({ requests: [INIT, INITIALIZED, LIST] });
  const listFrame = defaultSession.frames.find((f) => f.id === 2);
  const defaultTools = (listFrame?.result?.tools ?? []).map((t) => t.name);

  const aliasSession = await mcpSession({
    args: ["--alias", "fsearch"],
    requests: [INIT, INITIALIZED, LIST, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fsearch_locate", arguments: { filename: "package.json" } } }],
  });
  const aliasList = aliasSession.frames.find((f) => f.id === 2);
  const aliasTools = (aliasList?.result?.tools ?? []).map((t) => t.name);
  const aliasCall = aliasSession.frames.find((f) => f.id === 3);
  const aliasKnown = !aliasCall?.error;

  const unknownSession = await mcpSession({
    requests: [INIT, INITIALIZED, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fsearch_locate", arguments: { filename: "x" } } }],
  });
  const unknownCall = unknownSession.frames.find((f) => f.id === 3);

  const { MCP_CLIENT_PROFILES, buildToolSurface, resolveMcpSurfaceConfig } = await import(path.join(REPO, "src", "mcp.ts"));
  const profileResults = [];
  for (const profile of MCP_CLIENT_PROFILES) {
    const session = await mcpSession({
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: profile.protocolVersion, capabilities: {}, clientInfo: { name: profile.client, version: "1" } } },
        INITIALIZED,
        LIST,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: profile.representativeTool, arguments: profile.representativeTool === "ultrasearch_query" ? { query: "x" } : profile.representativeTool === "ultrasearch_multi_grep" ? { patterns: ["x"] } : profile.representativeTool === "ultrasearch_metrics" ? {} : { pattern: "x" } } },
      ],
    });
    const list = session.frames.find((f) => f.id === 2);
    const call = session.frames.find((f) => f.id === 3);
    profileResults.push({
      client: profile.client,
      tools: (list?.result?.tools ?? []).length,
      call_answered: Boolean(call && !call.error),
      call_error: call?.error ?? null,
      negotiated: session.frames.find((f) => f.id === 1)?.result?.protocolVersion ?? null,
    });
  }

  const surfaceConfig = {
    default: buildToolSurface({}).length,
    alias: buildToolSurface({ aliases: ["fsearch"] }).length,
    env: resolveMcpSurfaceConfig({ ULTRASEARCH_MCP_ALIASES: "fsearch,fs" }).aliases,
  };

  const surfaceDefects = [];
  if (defaultTools.length !== 6) surfaceDefects.push(`default tools/list returned ${defaultTools.length}, expected 6 (${defaultTools.join(",")})`);
  if (!defaultTools.every((n) => n.startsWith("ultrasearch_"))) surfaceDefects.push(`default surface is not one prefix: ${defaultTools.join(",")}`);
  if (aliasTools.length !== 12) surfaceDefects.push(`alias surface returned ${aliasTools.length}, expected 12`);
  if (!aliasKnown) surfaceDefects.push(`alias tool call failed: ${JSON.stringify(aliasCall?.error)}`);
  if (!unknownCall?.error) surfaceDefects.push("an unconfigured fsearch_* alias was accepted without being configured");
  if (profileResults.some((p) => p.tools !== 6 || !p.call_answered)) surfaceDefects.push(`a client profile failed: ${JSON.stringify(profileResults.filter((p) => p.tools !== 6 || !p.call_answered))}`);

  const surfaceArtifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    default_surface: { tools: defaultTools, frames: defaultSession.frames.length },
    alias_surface: { tools: aliasTools, call: aliasCall ?? null },
    unconfigured_alias_call: unknownCall ?? null,
    profiles: profileResults,
    build_tool_surface: surfaceConfig,
    defects: surfaceDefects,
  };
  const surfaceWritten = writeArtifact("bench/verification/backlog/results/f30-mcp-surface.json", surfaceArtifact);

  rows.push({
    issue: 30,
    claim: "MCP alias surface: default exactly 6 tools, aliases callable when configured, per-client parity smoke",
    verdict: surfaceDefects.length ? "needs-work" : "verified",
    evidence:
      `real stdio MCP server: default tools/list = ${defaultTools.length} [${defaultTools.join(", ")}]; ` +
      `--alias fsearch tools/list = ${aliasTools.length} (6 canonical + 6 alias); tools/call fsearch_locate answered=${aliasKnown}; ` +
      `unconfigured fsearch_locate rejected=${Boolean(unknownCall?.error)}; client profiles listing 6 and calling their representative tool: ${profileResults.filter((p) => p.tools === 6 && p.call_answered).length}/${profileResults.length} ` +
      `(${profileResults.map((p) => `${p.client}:${p.negotiated}`).join(", ")})`,
    method: "verifier drives the real bin/mcp-server.ts over stdio with initialize/initialized/tools/list/tools/call for the default surface, a configured alias, an unconfigured alias, and every profile in MCP_CLIENT_PROFILES",
    n: 7,
    gate: g.status,
    artifact: "bench/verification/backlog/results/f30-mcp-surface.json",
    evidence_hashes: { artifact: surfaceWritten.sha256, probe: stableHash(surfaceArtifact) },
    notes: surfaceDefects.length
      ? surfaceDefects.join(" | ")
      : "default prefix, alias copies, alias call and every profile reproduced over real stdio; the tool *calls* run with an intentionally unreachable socket (NO_SPAWN + /tmp socket), so what they prove is alias/call routing — the native fallback answered — not daemon behaviour",
  });

  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
