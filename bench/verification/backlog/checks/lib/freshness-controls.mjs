#!/usr/bin/env node
// bench/verification/backlog/checks/lib/freshness-controls.mjs
//
// Independent controls for the `--require-fresh` rule (issue #52).
//
// The rule under test is implemented in bench/harness-matrix.mjs::makeStaleCheck
// and is not exported, so it is exercised the way a user would: through the real
// CLI with a `--dir` of forged artifacts, against real git history. Four
// controls cover the four outcomes, plus the two "before/after its own commit"
// states the author claimed:
//
//   A  older ancestor commit, clean tree, MCP surface unchanged   -> fresh (exit 0)
//   B  artifact.worktreeDirty = true                              -> stale (exit 1)
//   C  artifact commit reachable only from a side branch          -> stale (exit 1)
//   D  MCP-surface file changed after the artifact's commit       -> stale (exit 1)
//   E  HEAD == artifact commit (the state before the artifact commit) -> fresh (exit 0)
//   and the real committed artifacts at the real HEAD             -> fresh (exit 0)
//
// Everything is verifier-owned: the forks, the commits and the forged artifacts
// are built here; nothing from the author's test suite is reused.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { REPO, tmpdir, rmrf } from "../../lib.mjs";

const SURFACE = ["src/tool-schema.ts", "src/mcp.ts", "bin/mcp-server.ts", "src/harness-registry.ts", "package.json"];

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  } catch (e) {
    return `__ERR__ ${String(e.message).split("\n")[0]}`;
  }
}

/** Run the real CLI checker; returns { exit, staleReasons, output }. */
function runChecker(scriptRepo, dir) {
  const r = spawnSync(process.execPath, [path.join(scriptRepo, "bench", "harness-matrix.mjs"), "--dir", dir, "--check", "--require-fresh"], {
    cwd: scriptRepo,
    env: { ...process.env, PI_ULTRASEARCH_TEST: "1" },
    encoding: "utf-8",
    timeout: 240000,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const staleReasons = [...out.matchAll(/^\s*- stale:([^:]+): (.+)$/gm)].map((m) => ({ id: m[1], reason: m[2] }));
  return { exit: r.status, staleReasons, output: out.slice(-800) };
}

function forgeArtifact(dir, id, patch) {
  const p = path.join(dir, `${id}.json`);
  const d = JSON.parse(fs.readFileSync(p, "utf-8"));
  Object.assign(d, patch);
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
}

export async function runFreshnessControls({ headCommit } = {}) {
  const head = headCommit ?? git(REPO, ["rev-parse", "HEAD"]);
  const results = [];

  const baseDir = tmpdir("ults-fresh-base-");
  for (const f of fs.readdirSync(path.join(REPO, "bench", "harness-smoke"))) {
    if (f.endsWith(".json")) fs.copyFileSync(path.join(REPO, "bench", "harness-smoke", f), path.join(baseDir, f));
  }

  // ---- committed artifacts at the real HEAD ----
  const committed = runChecker(REPO, path.join(REPO, "bench", "harness-smoke"));
  results.push({ control: "committed-at-HEAD", expect: "fresh", exit: committed.exit, stale_reasons: committed.staleReasons });

  // ---- A: older ancestor, clean, surface unchanged ----
  const olderAncestor = git(REPO, ["rev-list", "-n", "1", `${head}~2`]);
  const surfaceUnchanged = spawnSync("git", ["diff", "--quiet", olderAncestor, head, "--", ...SURFACE], { cwd: REPO }).status === 0;
  const dirA = tmpdir("ults-fresh-A-");
  fs.cpSync(baseDir, dirA, { recursive: true });
  for (const f of fs.readdirSync(dirA)) if (f.endsWith(".json")) forgeArtifact(dirA, f.replace(".json", ""), { commit: olderAncestor });
  const ctrlA = runChecker(REPO, dirA);
  results.push({
    control: "A-older-ancestor-clean-surface-unchanged",
    expect: "fresh",
    artifact_commit: olderAncestor,
    ancestor: true,
    surface_unchanged: surfaceUnchanged,
    exit: ctrlA.exit,
    stale_reasons: ctrlA.staleReasons,
    ok: ctrlA.exit === 0,
  });

  // ---- B: dirty tree at generation ----
  const dirB = tmpdir("ults-fresh-B-");
  fs.cpSync(baseDir, dirB, { recursive: true });
  forgeArtifact(dirB, "pi", { worktreeDirty: true });
  const ctrlB = runChecker(REPO, dirB);
  results.push({
    control: "B-dirty-tree",
    expect: "stale",
    exit: ctrlB.exit,
    stale_reasons: ctrlB.staleReasons,
    ok: ctrlB.exit !== 0 && ctrlB.staleReasons.some((r) => /dirty tree/i.test(r.reason)),
  });

  // ---- C/D/E in a scratch clone so history can be controlled ----
  // Realpath the clone: macOS /tmp is a symlink to /private/tmp, and the checker
  // only runs its main() when argv[1] equals import.meta.url (which Node
  // canonicalises). Passing the symlinked path would silently no-op the CLI.
  const cloneTmp = tmpdir("ults-fresh-clone-");
  rmrf(cloneTmp);
  execFileSync("git", ["clone", "--quiet", REPO, cloneTmp], { stdio: ["ignore", "ignore", "inherit"] });
  const clone = fs.realpathSync(cloneTmp);
  const nm = path.join(REPO, "node_modules");
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(clone, "node_modules"));

  // D: one commit that changes an MCP-surface file; artifacts name the parent
  git(clone, ["checkout", "-q", "-b", "control"]);
  fs.appendFileSync(path.join(clone, "src", "tool-schema.ts"), "\n// freshness control (verifier)\n");
  git(clone, ["-c", "user.name=v", "-c", "user.email=v@l", "commit", "-qam", "control: surface change"]);
  const headD = git(clone, ["rev-parse", "HEAD"]);
  const parentD = git(clone, ["rev-parse", "HEAD~1"]);
  const dirD = tmpdir("ults-fresh-D-");
  fs.cpSync(baseDir, dirD, { recursive: true });
  for (const f of fs.readdirSync(dirD)) if (f.endsWith(".json")) forgeArtifact(dirD, f.replace(".json", ""), { commit: parentD });
  const ctrlD = runChecker(clone, dirD);
  results.push({
    control: "D-mcp-surface-changed",
    expect: "stale",
    artifact_commit: parentD,
    head: headD,
    surface_diff_present: spawnSync("git", ["diff", "--quiet", parentD, headD, "--", ...SURFACE], { cwd: clone }).status === 1,
    exit: ctrlD.exit,
    stale_reasons: ctrlD.staleReasons,
    ok: ctrlD.exit !== 0 && ctrlD.staleReasons.some((r) => /MCP surface changed/i.test(r.reason)),
  });

  // C: a side commit that is not an ancestor of the checked-out HEAD
  git(clone, ["checkout", "-q", "-b", "side", parentD]);
  fs.appendFileSync(path.join(clone, "README.md"), "\nside control\n");
  git(clone, ["-c", "user.name=v", "-c", "user.email=v@l", "commit", "-qam", "control: side commit"]);
  const side = git(clone, ["rev-parse", "HEAD"]);
  git(clone, ["checkout", "-q", "control"]);
  const dirC = tmpdir("ults-fresh-C-");
  fs.cpSync(baseDir, dirC, { recursive: true });
  for (const f of fs.readdirSync(dirC)) if (f.endsWith(".json")) forgeArtifact(dirC, f.replace(".json", ""), { commit: side });
  const ctrlC = runChecker(clone, dirC);
  results.push({
    control: "C-non-ancestor-commit",
    expect: "stale",
    artifact_commit: side,
    head: headD,
    ancestor: spawnSync("git", ["merge-base", "--is-ancestor", side, headD], { cwd: clone }).status === 0,
    exit: ctrlC.exit,
    stale_reasons: ctrlC.staleReasons,
    ok: ctrlC.exit !== 0 && ctrlC.staleReasons.some((r) => /not an ancestor/i.test(r.reason)),
  });

  // E: HEAD == artifact commit (the pre-artifact-commit state)
  git(clone, ["checkout", "-q", parentD]);
  const dirE = tmpdir("ults-fresh-E-");
  fs.cpSync(baseDir, dirE, { recursive: true });
  for (const f of fs.readdirSync(dirE)) if (f.endsWith(".json")) forgeArtifact(dirE, f.replace(".json", ""), { commit: parentD });
  const ctrlE = runChecker(clone, dirE);
  results.push({
    control: "E-head-equals-artifact-commit",
    expect: "fresh",
    artifact_commit: parentD,
    head: parentD,
    exit: ctrlE.exit,
    stale_reasons: ctrlE.staleReasons,
    ok: ctrlE.exit === 0,
  });

  for (const d of [baseDir, dirA, dirB, dirC, dirD, dirE]) rmrf(d);
  rmrf(cloneTmp);

  const byName = Object.fromEntries(results.map((r) => [r.control, r]));
  return {
    head,
    mcp_surface_paths: SURFACE,
    results,
    all_branches_exercised: {
      fresh_committed: byName["committed-at-HEAD"]?.exit === 0,
      fresh_older_ancestor: byName["A-older-ancestor-clean-surface-unchanged"]?.ok === true,
      stale_dirty: byName["B-dirty-tree"]?.ok === true,
      stale_non_ancestor: byName["C-non-ancestor-commit"]?.ok === true,
      stale_surface_changed: byName["D-mcp-surface-changed"]?.ok === true,
      fresh_before_artifact_commit: byName["E-head-equals-artifact-commit"]?.ok === true,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runFreshnessControls(), null, 2));
}
