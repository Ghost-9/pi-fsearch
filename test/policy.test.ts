process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  POLICY_BEGIN,
  POLICY_END,
  POLICY_HARNESSES,
  PolicyError,
  applyPolicy,
  planPolicy,
  policyBlock,
  policyHarnessIds,
} from "../src/policy.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ults-policy-home-"));
test.after(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

/** A fresh project root per test, so no two tests share a target file. */
function freshRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ults-policy-${name}-`));
  return root;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the real CLI with HOME pinned at a temp dir: a bug that resolved a
 * harness config against the operator's home cannot touch the real one.
 */
async function runCli(args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [path.join(repoRoot, "bin", "cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: tmpHome, PI_ULTRASEARCH_TEST: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (c: string) => (stdout += c));
  child.stderr.on("data", (c: string) => (stderr += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function backupsFor(file: string): string[] {
  return fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${path.basename(file)}.bak-`))
    .sort();
}

// ---------------------------------------------------------------------------
// Generation: one block, every harness, carrying the measured why
// ---------------------------------------------------------------------------

test("policy: every harness resolves to the file it is documented to read", () => {
  const files = Object.fromEntries(policyHarnessIds().map((id) => [id, POLICY_HARNESSES[id].file]));
  assert.deepEqual(files, {
    pi: "AGENTS.md",
    codex: "AGENTS.md",
    "claude-code": "CLAUDE.md",
    cursor: ".cursor/rules/ultrasearch.mdc",
    vscode: ".github/instructions/ultrasearch.instructions.md",
    antigravity: ".agents/rules/ultrasearch.md",
    generic: "CONTRIBUTING.md",
  });
  for (const id of policyHarnessIds()) assert.ok(POLICY_HARNESSES[id].label);
});

test("policy: the block is marker-framed and carries the measured reason and usage examples", () => {
  for (const id of policyHarnessIds()) {
    const block = policyBlock(id);
    assert.ok(block.startsWith(`${POLICY_BEGIN}\n`), `${id}: block must start with the begin marker`);
    assert.ok(block.trimEnd().endsWith(POLICY_END), `${id}: block must end with the end marker`);
    // The measured why: the verified wave-1 range, its source artifact, and
    // the honest caveat about grep being context-dependent.
    assert.match(block, /9–29×/, `${id}: the measured path-search range must be in the block`);
    assert.match(block, /wave1-summary\.json/, `${id}: the measurement source must be cited`);
    assert.match(block, /context-dependent/, `${id}: grep's context dependence must be stated`);
    // Short CLI + MCP examples.
    assert.match(block, /ultrasearch query <glob\|name>/);
    assert.match(block, /ultrasearch grep <pattern> --in <dir>/);
    assert.match(block, /ultrasearch_query/);
    assert.match(block, /ultrasearch_grep/);
    assert.match(block, /rg.*find|find.*rg/, `${id}: the fallback must name rg/find`);
  }
});

// ---------------------------------------------------------------------------
// Planning and applying: create, update, backup, remove, idempotence
// ---------------------------------------------------------------------------

test("policy: create writes the markers and creates no backup when the file is absent", () => {
  const root = freshRoot("create");
  const plan = planPolicy({ harness: "cursor", root });
  assert.equal(plan.action, "create");
  assert.equal(plan.exists, false);
  assert.match(plan.diff, /^--- \/dev\/null$/m, "a new file's diff must show it as new");
  assert.match(plan.diff, new RegExp(`^\\+${POLICY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

  const result = applyPolicy(plan);
  assert.equal(result.wrote, true);
  const content = fs.readFileSync(plan.path, "utf8");
  assert.ok(content.startsWith("---\n"), "Cursor's rule file needs its frontmatter");
  assert.match(content, /alwaysApply: true/);
  assert.ok(content.includes(POLICY_BEGIN) && content.includes(POLICY_END));
  assert.deepEqual(backupsFor(plan.path), [], "a file that did not exist has nothing to back up");
});

test("policy: a second apply is a true no-op (idempotent, no second backup)", () => {
  const root = freshRoot("idempotent");
  const first = applyPolicy(planPolicy({ harness: "pi", root }));
  assert.equal(first.wrote, true);
  const before = fs.readFileSync(first.path, "utf8");

  const secondPlan = planPolicy({ harness: "pi", root });
  assert.equal(secondPlan.action, "unchanged");
  assert.equal(secondPlan.diff, "");
  const second = applyPolicy(secondPlan);
  assert.equal(second.wrote, false);
  assert.equal(fs.readFileSync(first.path, "utf8"), before);
  assert.deepEqual(backupsFor(first.path), [], "an unchanged file must not be backed up again");
});

test("policy: patching an existing file preserves it, backs it up once, and restores byte-identically on remove", () => {
  const root = freshRoot("patch");
  const target = path.join(root, "CLAUDE.md");
  const original = "# Project handbook\n\nRules that were here first.\n";
  fs.writeFileSync(target, original);

  const applied = applyPolicy(planPolicy({ harness: "claude-code", root }));
  assert.equal(applied.action, "update");
  const patched = fs.readFileSync(target, "utf8");
  assert.ok(patched.startsWith(original.trimEnd()), "existing content must be preserved before the block");
  assert.ok(patched.includes(POLICY_BEGIN) && patched.includes(POLICY_END));
  const backups = backupsFor(target);
  assert.equal(backups.length, 1, "exactly one timestamped backup");
  assert.match(backups[0], /\.bak-\d{8}-\d{6}$/);
  assert.equal(fs.readFileSync(path.join(root, backups[0]), "utf8"), original, "the backup must hold the pre-write bytes");

  const removed = applyPolicy(planPolicy({ harness: "claude-code", root, remove: true }));
  assert.equal(removed.action, "remove");
  assert.equal(removed.deleteFile, false);
  assert.equal(fs.readFileSync(target, "utf8"), original, "--remove must restore the original bytes");
});

test("policy: remove deletes a file that held only the policy block", () => {
  const root = freshRoot("delete");
  const applied = applyPolicy(planPolicy({ harness: "antigravity", root }));
  assert.equal(fs.existsSync(applied.path), true);
  const removed = applyPolicy(planPolicy({ harness: "antigravity", root, remove: true }));
  assert.equal(removed.action, "remove");
  assert.equal(removed.deleteFile, true);
  assert.equal(fs.existsSync(applied.path), false, "a policy-only file must not be left as an empty shell");
});

test("policy: remove on a file without the block changes nothing", () => {
  const root = freshRoot("remove-missing");
  const target = path.join(root, "CONTRIBUTING.md");
  const original = "Contributions welcome.\n";
  fs.writeFileSync(target, original);
  const plan = planPolicy({ harness: "generic", root, remove: true });
  assert.equal(plan.action, "unchanged");
  assert.equal(plan.diff, "");
  const result = applyPolicy(plan);
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("policy: an unterminated marker pair is refused, never guessed or duplicated", () => {
  const root = freshRoot("half-marker");
  fs.writeFileSync(path.join(root, "AGENTS.md"), `Intro\n\n${POLICY_BEGIN}\nno end marker\n`);
  assert.throws(() => planPolicy({ harness: "pi", root }), PolicyError);
  assert.throws(() => planPolicy({ harness: "pi", root, remove: true }), PolicyError);
});

// ---------------------------------------------------------------------------
// CLI: dry-run vs write, and the safety rails
// ---------------------------------------------------------------------------

test("cli: --dry-run prints the diff and writes nothing", async () => {
  const root = freshRoot("dry");
  const res = await runCli(["policy", "--harness", "codex", "--root", root, "--dry-run"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^\+\+\+ b\/AGENTS\.md$/m);
  assert.ok(res.stdout.includes(`+${POLICY_BEGIN}`), `diff must show the added marker:\n${res.stdout}`);
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false, "--dry-run must not create the file");
});

test("cli: the default invocation shows the block and writes nothing", async () => {
  const root = freshRoot("show");
  const res = await runCli(["policy", "--harness", "generic", "--root", root]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes(POLICY_BEGIN) && res.stdout.includes(POLICY_END));
  assert.ok(res.stdout.includes("--write"), "the default output must tell the operator how to apply it");
  assert.equal(fs.existsSync(path.join(root, "CONTRIBUTING.md")), false);
});

test("cli: --write applies, and --remove --write reverses it", async () => {
  const root = freshRoot("cli-write");
  const written = await runCli(["policy", "--harness", "vscode", "--root", root, "--write"]);
  assert.equal(written.code, 0, written.stderr);
  const target = path.join(root, ".github/instructions/ultrasearch.instructions.md");
  assert.equal(fs.existsSync(target), true);
  assert.match(fs.readFileSync(target, "utf8"), /applyTo: '\*\*'/);

  const again = await runCli(["policy", "--harness", "vscode", "--root", root, "--write"]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /unchanged/);
  assert.deepEqual(backupsFor(target), [], "the idempotent second write must not back the file up");

  const removed = await runCli(["policy", "--harness", "vscode", "--root", root, "--remove", "--write"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(fs.existsSync(target), false, "removing a policy-only instructions file deletes it");
});

test("cli: a missing or unknown --harness fails with usage and writes nothing", async () => {
  const root = freshRoot("invalid");
  const missing = await runCli(["policy", "--root", root, "--write"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Usage: ultrasearch policy --harness/);
  assert.deepEqual(fs.readdirSync(root), []);

  const unknown = await runCli(["policy", "--harness", "emacs", "--root", root, "--write"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown harness 'emacs'/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("cli: --write with --dry-run is refused before anything changes", async () => {
  const root = freshRoot("conflict");
  const res = await runCli(["policy", "--harness", "pi", "--root", root, "--write", "--dry-run"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /mutually exclusive/);
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
});
