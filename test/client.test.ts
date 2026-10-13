process.env.PI_ULTRASEARCH_TEST = "1";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { FSearchClient } from "../src/client.ts";
import { scrubSecrets, isPathSafe, matchesIgnorePattern, isSensitiveFile } from "../src/sanitize.ts";
import { renderUltraSearchDeclarations, renderFSearchDeclarations, getFSearchCodemodeTools } from "../src/codemode.ts";
import { recordAudit, loadAudit, summarizeAudit, formatAuditSummary, resetAudit } from "../src/telemetry.ts";
import { analyzeCommandForBypass, diagnoseEmptyQuery } from "../src/observer.ts";
import { formatGrepFiles } from "../src/formatter.ts";
import { LsmCompactor } from "../src/compactor.ts";
import { recordMistake, learnCorrection, getLearnedCorrection, formatRecursiveLearningReport } from "../src/recursive-learning.ts";
import { UltraSearchTui } from "../src/tui.ts";
import { expandIntentKeywords, searchSemanticIntent } from "../src/semantic.ts";
import { FSearchMcpServer } from "../src/mcp.ts";

const sharedClient = new FSearchClient();

after(() => {
  sharedClient.close();
});

test("FSearchClient ping", async () => {
  const ok = await sharedClient.ping();
  assert.equal(ok, true);
});

test("FSearchClient search: exact match succeeds", async () => {
  const res = await sharedClient.search("package.json", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.hits));
  assert.ok(res.hits.length > 0);
  assert.ok(res.hits.some((h) => h.path.endsWith("package.json")));
});

test("FSearchClient strict zero typo tolerance (no forgiveness)", async () => {
  // A misspelled query must NEVER match or forgive typos
  const res = await sharedClient.search("pckage.json", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  // Zero typo tolerance guarantees 0 hits for misspelled token
  assert.equal(res.hits?.length ?? 0, 0);
});

test("FSearchClient grep with trigram index", async () => {
  const res = await sharedClient.grep("FSearchClient", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.files));
  assert.ok(res.files.length > 0);
  assert.ok(res.files.some((f) => f.path.includes("client.ts") || f.path.includes("client.test.ts")));
});

test("FSearchClient multiGrep", async () => {
  const res = await sharedClient.multiGrep(["FSearchClient", "scrubSecrets"], {
    in: process.cwd(),
    limit: 10,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.files));
});

test("FSearchClient proximity re-ranking", () => {
  const hits = [
    { kind: "file" as const, mtime: 0, path: "/Users/batra/repo/other/deep/file.ts", score: 100, size: 0 },
    { kind: "file" as const, mtime: 0, path: "/Users/batra/repo/src/components/button.ts", score: 100, size: 0 },
  ];
  const ranked = sharedClient.applyProximityRanking(hits, "/Users/batra/repo/src/components/card.ts");
  assert.ok(ranked[0].path.includes("button.ts"));
  assert.ok(ranked[0].score > ranked[1].score);
});

test("sanitize: scrubs secrets properly", () => {
  const samplePrefix = "sk" + "_live_";
  const inputs = [
    "api_key: 'abcdef1234567890'",
    `const stripeKey = '${samplePrefix}1234567890abcdef12345678';`,
    "const bearer = 'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID'",
    "DATABASE_URL=postgres://app_user:SuperSecretPassword123@db.prod.internal:5432/main",
  ];
  for (const input of inputs) {
    const scrubbed = scrubSecrets(input);
    assert.ok(scrubbed.includes("[REDACTED"));
    assert.ok(!scrubbed.includes("SuperSecretPassword123"));
  }
});

test("sanitize: identifies sensitive environment and credential files", () => {
  assert.equal(isSensitiveFile(".env"), true);
  assert.equal(isSensitiveFile(".env.local"), true);
  assert.equal(isSensitiveFile(".env.production"), true);
  assert.equal(isSensitiveFile("/repo/.env"), true);
  assert.equal(isSensitiveFile("id_rsa"), true);
  assert.equal(isSensitiveFile("id_ed25519"), true);
  assert.equal(isSensitiveFile("server.pem"), true);
  assert.equal(isSensitiveFile("private.key"), true);
  assert.equal(isSensitiveFile("service-account-key.json"), true);
  assert.equal(isSensitiveFile("credentials.json"), true);
  assert.equal(isSensitiveFile(".npmrc"), true);

  // Non-sensitive files
  assert.equal(isSensitiveFile("package.json"), false);
  assert.equal(isSensitiveFile("index.ts"), false);
  assert.equal(isSensitiveFile("README.md"), false);
});

test("sanitize: path boundary safety and traversal protection", () => {
  assert.equal(isPathSafe("/Users/batra/repo/src/index.ts", "/Users/batra/repo"), true);
  assert.equal(isPathSafe("/Users/batra/repo/../../etc/passwd", "/Users/batra/repo"), false);
  assert.equal(isPathSafe("/Users/batra/.aws/credentials", "/Users/batra/repo"), false);
});

test("sanitize: ignore pattern matching", () => {
  const patterns = ["node_modules", "*.log", "build/"];
  assert.equal(matchesIgnorePattern("/project/node_modules/pkg/index.js", patterns), true);
  assert.equal(matchesIgnorePattern("/project/debug.log", patterns), true);
  assert.equal(matchesIgnorePattern("/project/src/app.ts", patterns), false);
});

test("codemode: renders TypeScript declarations", () => {
  const decls = renderUltraSearchDeclarations();
  assert.ok(decls.includes("declare namespace tools"));
  assert.ok(decls.includes("fsearch_query"));
  assert.ok(decls.includes("fsearch_grep"));
  assert.ok(decls.includes("fsearch_multi_grep"));
  assert.equal(renderFSearchDeclarations(), decls);
});

test("codemode: sandbox tool definitions", async () => {
  const tools = getFSearchCodemodeTools(sharedClient);
  assert.ok(typeof tools.fsearch_query === "function");
  assert.ok(typeof tools.fsearch_grep === "function");
  assert.ok(typeof tools.fsearch_multi_grep === "function");
});

test("mcp: supports both ultrasearch_* and fsearch_* JSON-RPC tools", async () => {
  const server = new FSearchMcpServer(sharedClient);
  const listResp = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(listResp && listResp.result && listResp.result.tools);
  const toolNames = listResp.result.tools.map((t: any) => t.name);
  assert.ok(toolNames.includes("ultrasearch_query"));
  assert.ok(toolNames.includes("ultrasearch_grep"));
  assert.ok(toolNames.includes("fsearch_query"));
  assert.ok(toolNames.includes("fsearch_grep"));

  const callResp = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ultrasearch_query", arguments: { query: "package.json" } },
  });
  assert.ok(callResp && callResp.result && callResp.result.content);
});

test("observability: telemetry logging and audit summary", () => {
  resetAudit();
  recordAudit({
    ts: Date.now(),
    tool: "fsearch_query",
    query: "index.ts",
    ms: 0.42,
    ok: true,
    hitCount: 1,
    source: "index",
  });
  recordAudit({
    ts: Date.now(),
    tool: "fsearch_query",
    query: "nonexistent.xyz",
    ms: 0.15,
    ok: true,
    hitCount: 0,
    source: "index",
    diagnosticHint: "Zero typo tolerance enforced",
  });

  const summary = summarizeAudit();
  assert.equal(summary.totalCalls, 2);
  const formatted = formatAuditSummary(summary);
  assert.ok(formatted.includes("Pi-UltraSearch Observability"));
  assert.ok(formatted.includes("fsearch_query"));
});

test("observability: shadow detector detects CLI find and rg bypasses", () => {
  resetAudit();
  analyzeCommandForBypass("find . -name '*.ts'", 35);
  analyzeCommandForBypass("rg -rn 'function' src/", 85);

  const summary = summarizeAudit();
  assert.equal(summary.cliBypasses.length, 2);
  assert.ok(summary.optimizationAdvice.some((a) => a.includes("CLI subprocess searches")));
});

test("observability: diagnostic analyzer generates zero-typo guidance", async () => {
  const hint = await diagnoseEmptyQuery("Cargo.toml", process.cwd(), sharedClient);
  assert.ok(hint && (hint.includes("Exact match exists") || hint.includes("Zero typo tolerance")));
});

test("formatter: compact mode produces clean file:line output", () => {
  const dummy = [
    {
      path: "/test/repo/src/index.ts",
      matches: [
        { line: 10, text: "export function search() {}" },
        { line: 20, text: "const a = 1;" },
      ],
    },
  ];
  const res = formatGrepFiles(dummy, { worktreeRoot: "/test/repo", compact: true });
  assert.ok(res.text.includes("src/index.ts:10: export function search() {}"));
  assert.ok(res.text.includes("src/index.ts:20: const a = 1;"));
  assert.ok(!res.text.includes("==="));
});

test("formatter: masks sensitive .env and key files with DLP protection", () => {
  const dummy = [
    {
      path: "/test/repo/.env",
      matches: [
        { line: 1, text: "STRIPE_SECRET=sk_live_998877665544332211" },
        { line: 2, text: "DB_PASS=supersecretpassword" },
      ],
    },
  ];
  const res = formatGrepFiles(dummy, { worktreeRoot: "/test/repo", compact: true });
  assert.ok(res.text.includes("[DLP_PROTECTED: Environment credential / key masked to prevent secret leakage]"));
  assert.ok(!res.text.includes("supersecretpassword"));
});

test("formatter: token budget truncation triggers gracefully", () => {
  const dummy = [
    {
      path: "/test/repo/src/large.ts",
      matches: Array.from({ length: 50 }, (_, i) => ({
        line: i + 1,
        text: "line " + i + " content with long text padding for token limit",
      })),
    },
  ];
  const res = formatGrepFiles(dummy, { worktreeRoot: "/test/repo", compact: true, maxTokens: 40 });
  assert.ok(res.truncatedCount > 0);
  assert.ok(res.text.includes("[... Truncated:"));
});

test("formatter: symbol prioritization ranks declarations first", () => {
  const dummy = [
    {
      path: "/test/repo/src/symbols.ts",
      matches: [
        { line: 5, text: "callSearchFunction();" },
        { line: 12, text: "export function search() {}" },
      ],
    },
  ];
  const res = formatGrepFiles(dummy, { worktreeRoot: "/test/repo", compact: true, prioritizeSymbols: true });
  const lines = res.text.split("\n");
  assert.ok(lines[0].includes("export function search()"));
});

test("formatter: renders rich surrounding context and symbol tags", () => {
  const dummy = [
    {
      path: "/test/repo/src/client.ts",
      matches: [
        {
          line: 45,
          text: "export function extractExactWords(query: string): string[] {",
          before: ["/** docstring */"],
          after: ["  return [];"],
        },
      ],
    },
  ];
  const res = formatGrepFiles(dummy, {
    worktreeRoot: "/test/repo",
    compact: true,
    showContext: true,
    tagSymbols: true,
  });
  assert.ok(res.text.includes("src/client.ts-44- /** docstring */"));
  assert.ok(res.text.includes("src/client.ts:45: [def:fn] export function extractExactWords"));
  assert.ok(res.text.includes("src/client.ts-46- return [];"));
});

test("compactor: manual and automated compaction supervisor", async () => {
  const compactor = new LsmCompactor(sharedClient);
  const res = await compactor.compact();
  assert.equal(res.ok, true);
  assert.ok(res.stats && res.stats.durationMs > 0);
  assert.ok(compactor.getHistory().length > 0);
});

test("recursive-learning: mistake recording, typo remapping, and memory reports", () => {
  recordMistake("typo", "pckage.json", "User intended package.json");
  learnCorrection("pckage.json", "package.json");
  const correction = getLearnedCorrection("pckage.json");
  assert.equal(correction, "package.json");

  recordMistake("dlp_violation", "sk_live_test", "Intercepted stripe secret");
  recordMistake("cli_bypass", "find . -name '*.ts'", "CLI bypass detected");

  const report = formatRecursiveLearningReport();
  assert.ok(report.includes("Recursive Learning"));
  assert.ok(report.includes("package.json"));
});

test("tui: snapshot execution produces mission control dashboard", async () => {
  const tui = new UltraSearchTui();
  // Ensure run(true) completes without throwing in headless mode
  await tui.run(true);
});

test("semantic: intent keyword expansion and hybrid retrieval", async () => {
  const keywords = expandIntentKeywords("where is the user authentication and login logic?");
  assert.ok(keywords.includes("auth"));
  assert.ok(keywords.includes("login"));

  const res = await searchSemanticIntent(sharedClient, "auth token secret", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(typeof res.confidence, "number");
  assert.ok(Array.isArray(res.files));
});
