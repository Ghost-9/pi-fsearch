import test, { after } from "node:test";
import assert from "node:assert/strict";
import { FSearchClient } from "../src/client.ts";
import { scrubSecrets, isPathSafe, matchesIgnorePattern } from "../src/sanitize.ts";
import { renderFSearchDeclarations, getFSearchCodemodeTools } from "../src/codemode.ts";

const sharedClient = new FSearchClient();

after(() => {
  sharedClient.close();
});

test("FSearchClient ping", async () => {
  const ok = await sharedClient.ping();
  assert.equal(ok, true);
});

test("FSearchClient search with cwd scope", async () => {
  const res = await sharedClient.search("package.json", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.hits));
});

test("FSearchClient grep with trigram index", async () => {
  const res = await sharedClient.grep("FSearchClient", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.files));
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
  const decls = renderFSearchDeclarations();
  assert.ok(decls.includes("declare namespace tools"));
  assert.ok(decls.includes("fsearch_query"));
  assert.ok(decls.includes("fsearch_grep"));
  assert.ok(decls.includes("fsearch_multi_grep"));
});

test("codemode: sandbox tool definitions", async () => {
  const tools = getFSearchCodemodeTools(sharedClient);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "fsearch_query");
  assert.equal(tools[1].name, "fsearch_grep");
});
