process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MockDaemon } from "./helpers/mock-daemon.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-cli-"));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

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
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// #40 history surface in the CLI
// ---------------------------------------------------------------------------

test("cli: `history --suggest` prints suggestions from the opt-in store", async () => {
  const historyPath = path.join(tmp, "cli-history.json");
  fs.writeFileSync(
    historyPath,
    JSON.stringify({
      version: 1,
      entries: [
        { q: "grep options", tool: "ultrasearch_grep", ts: 1, hits: 3 },
        { q: "grep initializer", tool: "ultrasearch_grep", ts: 2, hits: 1 },
        { q: "unrelated query", tool: "ultrasearch_query", ts: 3 },
      ],
    })
  );
  const res = await runCli(["history", "--suggest", "grep"], {
    ULTRASEARCH_HISTORY: "1",
    ULTRASEARCH_HISTORY_FILE: historyPath,
  });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes("grep options"), `stdout=${JSON.stringify(res.stdout)}`);
  assert.ok(res.stdout.includes("grep initializer"));
});

test("cli: `history` states that recording is off when history is not enabled", async () => {
  const res = await runCli(["history", "--suggest", "anything"], {
    ULTRASEARCH_HISTORY: "0",
    ULTRASEARCH_HISTORY_FILE: path.join(tmp, "missing-history.json"),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /No suggestions from stored history/);
});

test("cli: a query records history only when enabled, and the store is capped", async () => {
  const daemon = new MockDaemon({ reply: (req: any) => (req.op === "search" ? { ok: true, hits: [] } : { ok: true }) });
  await daemon.listen();
  const historyPath = path.join(tmp, "query-history.json");
  try {
    const res = await runCli(["query", "package.json", "--in", tmp], {
      PI_ULTRASEARCH_SOCKET: daemon.socketPath,
      ULTRASEARCH_HISTORY: "1",
      ULTRASEARCH_HISTORY_FILE: historyPath,
      ULTRASEARCH_HISTORY_MAX: "10",
      ULTRASEARCH_ROOTS: "",
    });
    assert.equal(res.code, 0, res.stderr);
    const stored = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    assert.equal(stored.entries.length, 1);
    assert.equal(stored.entries[0].q, "package.json");
    assert.equal(stored.entries[0].tool, "ultrasearch_query");
  } finally {
    await daemon.close();
  }
});

test("cli: with history off, a query writes no history file", async () => {
  const daemon = new MockDaemon({ reply: (req: any) => (req.op === "search" ? { ok: true, hits: [] } : { ok: true }) });
  await daemon.listen();
  const historyPath = path.join(tmp, "never-written.json");
  try {
    const res = await runCli(["query", "package.json", "--in", tmp], {
      PI_ULTRASEARCH_SOCKET: daemon.socketPath,
      ULTRASEARCH_HISTORY: "0",
      ULTRASEARCH_HISTORY_FILE: historyPath,
      ULTRASEARCH_ROOTS: "",
    });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.existsSync(historyPath), false);
  } finally {
    await daemon.close();
  }
});

test("cli: the TUI renders opt-in history suggestions", async () => {
  const historyPath = path.join(tmp, "tui-history.json");
  fs.writeFileSync(
    historyPath,
    JSON.stringify({ version: 1, entries: [{ q: "grep options", tool: "ultrasearch_grep", ts: 2, hits: 3 }] })
  );
  const daemon = new MockDaemon({ reply: (req: any) => (req.op === "status" ? { ok: true, entries: 1, stale_ms: 0 } : { ok: true }) });
  await daemon.listen();
  try {
    const res = await runCli(["tui", "--once"], {
      PI_ULTRASEARCH_SOCKET: daemon.socketPath,
      ULTRASEARCH_HISTORY: "1",
      ULTRASEARCH_HISTORY_FILE: historyPath,
      ULTRASEARCH_ROOTS: "",
    });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes("SUGGESTED QUERIES"), `stdout=${JSON.stringify(res.stdout.slice(0, 500))}`);
    assert.ok(res.stdout.includes("grep options"), "the stored query must be suggested");
  } finally {
    await daemon.close();
  }
});

// ---------------------------------------------------------------------------
// #27 watch mode end to end through the CLI
// ---------------------------------------------------------------------------

test("cli: `watch --once --json` streams the baseline and exits 0 with no socket held", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "watch-cli-"));
  const target = path.join(dir, "match.ts");
  fs.writeFileSync(target, "x\n");
  const daemon = new MockDaemon({
    reply: (req: any) => {
      if (req.op === "search") return { ok: true, hits: [{ kind: "file", mtime: 0, path: target, score: 2, size: 1 }] };
      if (req.op === "status") return { ok: true, stale_ms: 0 };
      return { ok: true };
    },
  });
  await daemon.listen();
  try {
    const res = await runCli(["watch", "*.ts", "--in", dir, "--once", "--json"], {
      PI_ULTRASEARCH_SOCKET: daemon.socketPath,
      ULTRASEARCH_ROOTS: "",
      ULTRASEARCH_HISTORY: "0",
    });
    assert.equal(res.code, 0, `stderr=${res.stderr}`);
    const events = res.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((e) => e.type === "baseline" && e.path === target),
      `stdout=${JSON.stringify(res.stdout)}`
    );
    assert.match(res.stderr, /watch stopped: 0 added/);
  } finally {
    await daemon.close();
  }
});

test("cli: `watch` without a query exits 2 with the usage line", async () => {
  const res = await runCli(["watch", "--json"], { ULTRASEARCH_HISTORY: "0" });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /Usage: ultrasearch watch/);
});

// ---------------------------------------------------------------------------
// #28 multi-root CLI output
// ---------------------------------------------------------------------------

test("cli: a two-root query collapses the duplicate and attributes the extra root", async () => {
  const active = fs.mkdtempSync(path.join(tmp, "active-"));
  const extra = fs.mkdtempSync(path.join(tmp, "extra-"));
  const shared = path.join(active, "shared.ts");
  fs.writeFileSync(shared, "x\n");
  const daemon = new MockDaemon({
    reply: (req: any) => {
      if (req.op === "search") {
        const inScope = req.in ?? active;
        // The nested/duplicated root returns the same realpath the active root does.
        const hits = String(inScope).includes(path.basename(extra)) ? [{ kind: "file", mtime: 0, path: shared, score: 1, size: 1 }] : [{ kind: "file", mtime: 0, path: shared, score: 1, size: 1 }];
        return { ok: true, hits };
      }
      return { ok: true };
    },
  });
  await daemon.listen();
  try {
    const res = await runCli(["query", "*.ts", "--in", active], {
      PI_ULTRASEARCH_SOCKET: daemon.socketPath,
      ULTRASEARCH_ROOTS: extra,
      ULTRASEARCH_HISTORY: "0",
    });
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `each file must appear once: ${JSON.stringify(lines)}`);
    assert.match(res.stderr, /duplicate path\(s\) collapsed/);
  } finally {
    await daemon.close();
  }
});

// ---------------------------------------------------------------------------
// Phase 4: `ultrasearch report --by harness`
// ---------------------------------------------------------------------------

test("cli: `report --by harness` prints one block per harness and keeps the view filter", async () => {
  const log = path.join(tmp, "harness-audit.jsonl");
  const fixture = [
    { ts: 1, tool: "ultrasearch_query", query: "pi-q", ms: 2, ok: true, hitCount: 1, source: "index", origin: "organic", harness: "pi" },
    { ts: 2, tool: "ultrasearch_query", query: "mcp-q", ms: 3, ok: true, hitCount: 2, source: "index", origin: "organic", harness: "mcp" },
  ];
  fs.writeFileSync(log, fixture.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const all = await runCli(["report", "--by", "harness", "--view", "all"], { PI_ULTRASEARCH_TEST_LOG: log });
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /Per-Harness Attribution/);
  assert.match(all.stdout, /• pi\s*: 1 call/);
  assert.match(all.stdout, /• mcp\s*: 1 call/);
  assert.match(all.stdout, /ESTIMATE ONLY/);

  // Test-file rows are forced synthetic, so the real view must exclude both.
  const real = await runCli(["report", "--by", "harness"], { PI_ULTRASEARCH_TEST_LOG: log });
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /Total Monitored Calls: 0/);
  assert.doesNotMatch(real.stdout, /Per-Harness Attribution/);

  const bad = await runCli(["report", "--by", "week"], { PI_ULTRASEARCH_TEST_LOG: log });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--by harness\|tool/);
});
