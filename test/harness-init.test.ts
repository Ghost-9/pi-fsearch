import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyHarnessInit,
  applyPlan,
  formatDiff,
  planHarnessInit,
  renderHarnessList,
  renderInitReport,
} from "../src/harness-init.ts";
import { HARNESSES, harnessById, resolveLaunch } from "../src/harness-registry.ts";
import { checkToml, normalizeJsonc, readTomlSection } from "../src/config-edit.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs: string[] = [];
test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function tempHome(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ults-init-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function backups(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.includes(".bak-")) found.push(p);
    }
  };
  walk(dir);
  return found;
}

const CMD = "/opt/test/bin/ultrasearch-mcp";

function planOne(home: string, id: string, extra: Record<string, unknown> = {}) {
  const plans = planHarnessInit({ home, harnessIds: [id], command: CMD, platform: "darwin", ...extra });
  assert.equal(plans.length, 1);
  return plans[0] as NonNullable<(typeof plans)[0]>;
}

// ---------------------------------------------------------------------------
// planning is pure
// ---------------------------------------------------------------------------

test("init: planning reads configs but writes nothing", () => {
  const home = tempHome("pure");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const configPath = path.join(home, ".cursor", "mcp.json");
  const original = `{\n  "mcpServers": {\n    "rea": { "command": "/bin/rea" }\n  }\n}\n`;
  fs.writeFileSync(configPath, original);
  const plan = planOne(home, "cursor");
  assert.equal(plan.action, "create");
  assert.equal(plan.diff?.includes('+    "ultrasearch"'), true, plan.diff);
  assert.equal(plan.diff?.includes('"rea"'), true);
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "planning must not write");
  assert.equal(backups(home).length, 0);
});

test("init: a fresh HOME with an explicit harness creates the file and parents on apply", () => {
  const home = tempHome("fresh");
  const plan = planOne(home, "windsurf");
  assert.equal(plan.action, "create");
  const applied = applyHarnessInit(plan);
  assert.equal(applied.written, true, applied.plan.writeError);
  assert.equal(applied.plan.action, "create");
  assert.match(applied.plan.revertCommand ?? "", /^rm /);
  const written = JSON.parse(fs.readFileSync(plan.configPath, "utf8"));
  assert.deepEqual(written.mcpServers.ultrasearch, { command: CMD, args: [] });
});

test("init: apply is idempotent and never duplicates the entry", () => {
  const home = tempHome("idempotent");
  const first = planOne(home, "cursor");
  applyHarnessInit(first);
  const afterFirst = fs.readFileSync(first.configPath, "utf8");
  const second = planOne(home, "cursor");
  assert.equal(second.action, "unchanged");
  const appliedSecond = applyHarnessInit(second);
  assert.equal(appliedSecond.written, false);
  assert.equal(fs.readFileSync(first.configPath, "utf8"), afterFirst);
  const parsed = JSON.parse(afterFirst);
  assert.equal(Object.keys(parsed.mcpServers).filter((k) => k === "ultrasearch").length, 1);
  assert.equal(backups(home).length, 0, "no backup for an unchanged config");
});

test("init: an update writes a timestamped backup and the printed revert command restores it", () => {
  const home = tempHome("update");
  const first = planOne(home, "cursor");
  applyHarnessInit(first);
  const merged = fs.readFileSync(first.configPath, "utf8");
  const updated = planOne(home, "cursor", { command: "/opt/other/ultrasearch-mcp" });
  assert.equal(updated.action, "update");
  assert.match(updated.reason ?? "", /command/);
  const applied = applyHarnessInit(updated);
  assert.equal(applied.written, true, applied.plan.writeError);
  assert.ok(applied.plan.backupPath, "update must back up the config");
  assert.match(applied.plan.backupPath as string, /\.bak-\d{8}-\d{6}-ultrasearch-init$/);
  assert.equal(fs.readFileSync(applied.plan.backupPath as string, "utf8"), merged, "backup is the pre-update file");
  assert.match(applied.plan.revertCommand ?? "", /^cp /);
  assert.equal(JSON.parse(fs.readFileSync(first.configPath, "utf8")).mcpServers.ultrasearch.command, "/opt/other/ultrasearch-mcp");
  // The printed revert command is exactly `cp <backup> <config>`.
  const [, backup, config] = /^cp ("[^"]+") ("[^"]+")$/.exec(applied.plan.revertCommand as string) ?? [];
  assert.equal(JSON.parse(backup as string), applied.plan.backupPath);
  assert.equal(JSON.parse(config as string), first.configPath);
  fs.copyFileSync(applied.plan.backupPath as string, first.configPath);
  assert.equal(fs.readFileSync(first.configPath, "utf8"), merged);
});

test("init: a user's extra keys in our entry survive an update", () => {
  const home = tempHome("merge");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".cursor", "mcp.json"),
    `{\n  "mcpServers": {\n    "ultrasearch": { "command": "${CMD}", "args": [], "startup_timeout_sec": 30 }\n  }\n}\n`
  );
  const plan = planOne(home, "cursor", { command: "/opt/other/ultrasearch-mcp" });
  assert.equal(plan.action, "update");
  const applied = applyHarnessInit(plan);
  const entry = JSON.parse(fs.readFileSync(plan.configPath, "utf8")).mcpServers.ultrasearch;
  assert.equal(entry.command, "/opt/other/ultrasearch-mcp");
  assert.equal(entry.startup_timeout_sec, 30, "unmanaged keys are preserved");
});

test("init: --remove deletes only our entry, and revert restores the file", () => {
  const home = tempHome("remove");
  const home2 = path.join(home, ".cursor");
  fs.mkdirSync(home2, { recursive: true });
  const original = `{\n  "mcpServers": {\n    "rea": { "command": "/bin/rea", "args": ["mcp"] },\n    "ultrasearch": { "command": "${CMD}", "args": [] },\n    "zzz": { "command": "/bin/z" }\n  }\n}\n`;
  fs.writeFileSync(path.join(home2, "mcp.json"), original);
  const plan = planOne(home, "cursor", { remove: true });
  assert.equal(plan.action, "remove");
  const applied = applyHarnessInit(plan);
  assert.equal(applied.written, true, applied.plan.writeError);
  assert.ok(applied.plan.backupPath);
  const after = JSON.parse(fs.readFileSync(plan.configPath, "utf8"));
  assert.equal(after.mcpServers.ultrasearch, undefined);
  assert.deepEqual(Object.keys(after.mcpServers), ["rea", "zzz"]);
  fs.copyFileSync(applied.plan.backupPath as string, plan.configPath);
  assert.equal(fs.readFileSync(plan.configPath, "utf8"), original);
});

test("init: removing an entry that is not there is a no-op", () => {
  const home = tempHome("remove-absent");
  const plan = planOne(home, "cursor", { remove: true });
  assert.equal(plan.action, "absent");
  const applied = applyHarnessInit(plan);
  assert.equal(applied.written, false);
});

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

test("init: an unparseable JSON config is refused, not patched", () => {
  for (const [id, rel] of [
    ["cursor", ".cursor/mcp.json"],
    ["vscode", "Library/Application Support/Code/User/mcp.json"],
    ["claude-code", ".claude.json"],
  ] as const) {
    const home = tempHome(`refuse-${id}`);
    const configPath = path.join(home, rel);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `{ "mcpServers": { oops`);
    const plan = planOne(home, id);
    assert.equal(plan.action, "refuse", id);
    assert.match(plan.reason ?? "", /unparseable JSON/);
    const applied = applyHarnessInit(plan);
    assert.equal(applied.written, false);
    assert.equal(fs.readFileSync(configPath, "utf8"), `{ "mcpServers": { oops`);
    assert.equal(backups(home).length, 0);
  }
});

test("init: an unparseable TOML config is refused, not patched", () => {
  const home = tempHome("refuse-toml");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const configPath = path.join(home, ".codex", "config.toml");
  fs.writeFileSync(configPath, "model = 'unterminated\n");
  const plan = planOne(home, "codex");
  assert.equal(plan.action, "refuse");
  assert.match(plan.reason ?? "", /unparseable TOML/);
  assert.equal(applyHarnessInit(plan).written, false);
});

test("init: a failed post-write verification restores the previous file", () => {
  const home = tempHome("verify");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const configPath = path.join(home, ".cursor", "mcp.json");
  const original = `{\n  "mcpServers": {}\n}\n`;
  fs.writeFileSync(configPath, original);
  const plan = planOne(home, "cursor");
  const sabotaged = { ...plan, after: `{ this is not json` };
  const applied = applyHarnessInit(sabotaged);
  assert.equal(applied.written, false);
  assert.match(applied.plan.writeError ?? "", /post-write parse failed/);
  assert.equal(fs.readFileSync(configPath, "utf8"), original, "the previous file must be restored");
  assert.equal(fs.existsSync(`${configPath}.ultrasearch-init.tmp-${process.pid}`), false);
});

// ---------------------------------------------------------------------------
// per-harness shapes
// ---------------------------------------------------------------------------

test("init: codex writes a TOML table and preserves the rest of config.toml", () => {
  const home = tempHome("codex");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const before = `model = "gpt-5"\n\n[mcp_servers.rea]\ncommand = "/opt/homebrew/bin/rea"\nargs = ["mcp"]\n\n[desktop]\nfollowUpQueueMode = "steer"\n`;
  const configPath = path.join(home, ".codex", "config.toml");
  fs.writeFileSync(configPath, before);
  const plan = planOne(home, "codex");
  assert.equal(plan.action, "create");
  const applied = applyHarnessInit(plan);
  assert.equal(applied.written, true, applied.plan.writeError);
  const written = fs.readFileSync(configPath, "utf8");
  assert.equal(checkToml(written).ok, true);
  assert.deepEqual(readTomlSection(written, ["mcp_servers", "ultrasearch"]), { command: CMD, args: [] });
  assert.deepEqual(readTomlSection(written, ["mcp_servers", "rea"]), { command: "/opt/homebrew/bin/rea", args: ["mcp"] });
  assert.match(written, /\[desktop\]\nfollowUpQueueMode = "steer"/);
  // A second plan is unchanged and a remove leaves the other tables valid.
  assert.equal(planOne(home, "codex").action, "unchanged");
  const removed = applyHarnessInit(planOne(home, "codex", { remove: true }));
  assert.equal(removed.written, true, removed.plan.writeError);
  const afterRemove = fs.readFileSync(configPath, "utf8");
  assert.equal(readTomlSection(afterRemove, ["mcp_servers", "ultrasearch"]), undefined);
  assert.equal(readTomlSection(afterRemove, ["mcp_servers", "rea"])?.command, "/opt/homebrew/bin/rea");
});

test("init: zed edits JSONC without dropping comments or trailing commas", () => {
  const home = tempHome("zed");
  fs.mkdirSync(path.join(home, ".config", "zed"), { recursive: true });
  const configPath = path.join(home, ".config", "zed", "settings.json");
  const before = `// Zed settings\n{\n  "theme": "One Dark", /* keep me */\n  "context_servers": {\n    "opencode": { "command": "opencode", "args": ["mcp"], },\n  },\n}\n`;
  fs.writeFileSync(configPath, before);
  const plan = planOne(home, "zed");
  assert.equal(plan.action, "create");
  const applied = applyHarnessInit(plan);
  assert.equal(applied.written, true, applied.plan.writeError);
  const written = fs.readFileSync(configPath, "utf8");
  assert.match(written, /^\/\/ Zed settings/);
  assert.match(written, /\/\* keep me \*\//);
  assert.match(written, /\.\s*$|,\s*\n\s*\}/m);
  const parsed = JSON.parse(normalizeJsonc(written));
  assert.deepEqual(parsed.context_servers.ultrasearch, { command: CMD, args: [] });
  assert.deepEqual(parsed.context_servers.opencode, { command: "opencode", args: ["mcp"] });
  assert.equal(parsed.theme, "One Dark");
  assert.equal(planOne(home, "zed").action, "unchanged");
});

test("init: each harness uses its declared key path and entry shape", () => {
  const home = tempHome("shapes");
  const plans = planHarnessInit({
    home,
    harnessIds: ["codex", "claude-code", "claude-desktop", "cursor", "windsurf", "zed", "vscode", "antigravity"],
    command: CMD,
    platform: "darwin",
  });
  for (const plan of plans) {
    assert.equal(plan.action, "create", plan.id);
    const applied = applyHarnessInit(plan);
    assert.equal(applied.written, true, `${plan.id}: ${applied.plan.writeError}`);
    const text = fs.readFileSync(plan.configPath, "utf8");
    assert.ok(text.includes("ultrasearch"), plan.id);
    if (plan.id === "codex") {
      assert.deepEqual(readTomlSection(text, ["mcp_servers", "ultrasearch"]), { command: CMD, args: [] });
    } else {
      const parsed = JSON.parse(normalizeJsonc(text));
      const entry = plan.serverKey.reduce((cur: any, key) => cur?.[key], parsed)?.ultrasearch;
      for (const key of Object.keys(plan.entry ?? {})) {
        assert.deepEqual(entry?.[key], (plan.entry as Record<string, unknown>)[key], `${plan.id}.${key}`);
      }
      if (plan.id === "vscode" || plan.id === "claude-code") assert.equal(entry.type, "stdio");
      if (plan.id === "zed") assert.deepEqual(Object.keys(entry), ["command", "args"]);
    }
  }
  assert.equal(backups(home).length, 0, "fresh files need no backup");
});

// ---------------------------------------------------------------------------
// defaults, detection, launch resolution
// ---------------------------------------------------------------------------

test("init: Pi is skipped by default with a note, and --force registers it", () => {
  const home = tempHome("pi");
  const skipped = planOne(home, "pi");
  assert.equal(skipped.action, "skipped");
  assert.match(skipped.reason ?? "", /native extension/);
  assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "mcp.json")), false);
  const forced = planOne(home, "pi", { force: true });
  assert.equal(forced.action, "create");
  const applied = applyHarnessInit(forced);
  assert.equal(applied.written, true, applied.plan.writeError);
  const written = JSON.parse(fs.readFileSync(forced.configPath, "utf8"));
  assert.equal(written.mcpServers.ultrasearch.command, CMD);
});

test("init: undeclared harnesses are not-detected unless explicitly selected", () => {
  const home = tempHome("detect");
  const all = planHarnessInit({ home, command: CMD, platform: "darwin" });
  for (const plan of all) {
    if (plan.id === "pi" || plan.id === "t3code") {
      assert.equal(plan.action, "skipped", plan.id);
    } else if (!plan.installed) {
      assert.equal(plan.action, "not-detected", plan.id);
      assert.match(plan.reason ?? "", /not detected/);
    }
  }
  const explicit = planHarnessInit({ home, harnessIds: ["windsurf"], command: CMD, platform: "darwin" })[0];
  assert.equal(explicit.action, "create", "an explicit --harness is planned even when undetected");
});

test("init: launch resolution prefers explicit, then env, then the installed shim", () => {
  const home = tempHome("launch");
  const shimDir = path.join(home, ".local", "bin");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "ultrasearch-mcp"), "#!/bin/sh\n", { mode: 0o755 });
  assert.deepEqual(resolveLaunch({ home, command: "/x/y", args: ["--a"], env: {} }), {
    command: "/x/y",
    args: ["--a"],
    source: "explicit",
  });
  assert.deepEqual(resolveLaunch({ home, env: { ULTRASEARCH_MCP_COMMAND: "/env/us", ULTRASEARCH_MCP_ARGS: "--p x" } }), {
    command: "/env/us",
    args: ["--p", "x"],
    source: "env",
  });
  assert.deepEqual(resolveLaunch({ home, env: {} }), {
    command: path.join(shimDir, "ultrasearch-mcp"),
    args: [],
    source: "installed",
  });
  const bare = tempHome("launch-bare");
  const fallback = resolveLaunch({ home: bare, env: { PATH: "" }, repoRoot: repoRoot });
  assert.equal(fallback.command, process.execPath);
  assert.match(fallback.args[0] as string, /mcp-server\.(ts|js)$/);
});

test("init: the registry is internally consistent", () => {
  assert.equal(new Set(HARNESSES.map((h) => h.id)).size, HARNESSES.length);
  for (const spec of HARNESSES) {
    assert.ok(spec.label && spec.note, spec.id);
    assert.ok(["json", "jsonc", "toml"].includes(spec.format), spec.id);
    assert.ok(spec.serverKey.length >= 1, spec.id);
    assert.ok(["machine-measured", "machine-observed", "docs", "assumed"].includes(spec.entryShapeSource), spec.id);
    assert.ok(["measured", "assumed"].includes(spec.protocolVersionSource), spec.id);
    assert.equal(harnessById(spec.id), spec);
  }
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test("init: the report and list render without leaking a false claim", () => {
  const home = tempHome("render");
  const plans = planHarnessInit({ home, harnessIds: ["cursor", "pi"], command: CMD, platform: "darwin" });
  const text = renderInitReport(plans, { wrote: false });
  assert.match(text, /no files were written/);
  assert.match(text, /skipped by default/);
  const json = JSON.parse(renderInitReport(plans, { json: true, wrote: false }));
  assert.equal(json.schema, "ultrasearch/init@1");
  assert.equal(json.wrote, false);
  assert.ok(json.plans.some((p: any) => p.id === "cursor" && p.diff.includes("+++")));
  const list = renderHarnessList(planHarnessInit({ home, command: CMD, platform: "darwin", force: true }));
  assert.match(list, /^id\s+harness/m);
  assert.match(list, /claude-desktop/);
  assert.match(list, /2025-06-18 \(assumed\)/);
  const listJson = JSON.parse(renderHarnessList(planHarnessInit({ home, command: CMD, platform: "darwin", force: true }), true));
  assert.equal(listJson.harnesses.length, HARNESSES.length);
});

test("init: formatDiff shows context, changes and no false lines for an append", () => {
  const diff = formatDiff('a = "1"\n', 'a = "1"\n[mcp_servers.x]\ncommand = "y"\n', "cfg.toml");
  assert.match(diff, /^--- cfg\.toml\n\+\+\+ cfg\.toml/m);
  assert.match(diff, /^ a = "1"$/m);
  assert.match(diff, /^\+\[mcp_servers\.x\]$/m);
  assert.ok(!/^-/m.test(diff.replace(/^--- /m, "")), "an append must not look like a removal");
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [path.join(repoRoot, "bin", "cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, PI_ULTRASEARCH_TEST: "1", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (c: string) => (stdout += c));
  child.stderr.on("data", (c: string) => (stderr += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test("cli: `init --list` exits 0 and never writes", async () => {
  const home = tempHome("cli-list");
  const res = await runCli(["init", "--list", "--home", home]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /id\s+harness\s+surface/);
  assert.equal(fs.existsSync(path.join(home, ".cursor")), false);
});

test("cli: `init --harness cursor` plans, `--write` applies, and `--json` is machine-readable", async () => {
  const home = tempHome("cli-write");
  const dry = await runCli(["init", "--harness", "cursor", "--home", home, "--json", "--command", CMD]);
  assert.equal(dry.code, 0, dry.stderr);
  const dryJson = JSON.parse(dry.stdout);
  assert.equal(dryJson.wrote, false);
  assert.equal(dryJson.plans[0].action, "create");
  assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false, "--json without --write writes nothing");

  const write = await runCli(["init", "--harness", "cursor", "--home", home, "--write", "--command", CMD]);
  assert.equal(write.code, 0, write.stderr);
  assert.match(write.stdout, /1 config\(s\) patched/);
  assert.match(write.stdout, /revert : rm /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.ultrasearch.command, CMD);

  const again = await runCli(["init", "--harness", "cursor", "--home", home, "--write", "--json", "--command", CMD]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).plans[0].action, "unchanged");
});

test("cli: `--dry-run` and `--write` together are rejected; a refusal exits nonzero", async () => {
  const home = tempHome("cli-errors");
  const conflict = await runCli(["init", "--home", home, "--write", "--dry-run"]);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /mutually exclusive/);

  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ nope");
  const refused = await runCli(["init", "--harness", "cursor", "--home", home, "--write", "--command", CMD]);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /refuse/);
  assert.equal(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"), "{ nope");
});

test("cli: `init --harness nope` is a usage error", async () => {
  const home = tempHome("cli-unknown");
  const res = await runCli(["init", "--harness", "nope", "--home", home]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown harness id\(s\): nope/);
});

test("cli: `init --remove --write` removes the entry and prints a cp revert", async () => {
  const home = tempHome("cli-remove");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".cursor", "mcp.json"),
    `{\n  "mcpServers": {\n    "ultrasearch": { "command": "${CMD}", "args": [] }\n  }\n}\n`
  );
  const res = await runCli(["init", "--harness", "cursor", "--home", home, "--remove", "--write"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /revert : cp /);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers, {});
});
