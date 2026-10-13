import test, { after } from "node:test";
import assert from "node:assert/strict";
import { FSearchClient } from "../src/client.ts";
import { scrubSecrets, isPathSafe, matchesIgnorePattern } from "../src/sanitize.ts";
import { renderUltraSearchDeclarations, renderFSearchDeclarations, getFSearchCodemodeTools } from "../src/codemode.ts";
import { recordAudit, loadAudit, summarizeAudit, formatAuditSummary, resetAudit } from "../src/telemetry.ts";
import { analyzeCommandForBypass, diagnoseEmptyQuery } from "../src/observer.ts";

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
  ];
  for (const input of inputs) {
    const scrubbed = scrubSecrets(input);
    assert.ok(scrubbed.includes("[REDACTED"));
  }
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
