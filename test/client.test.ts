import test from "node:test";
import assert from "node:assert/strict";
import { FSearchClient } from "../src/client.ts";
import { scrubSecrets, isPathSafe } from "../src/sanitize.ts";

test("FSearchClient ping", async () => {
  const client = new FSearchClient();
  const ok = await client.ping();
  assert.equal(ok, true);
  client.close();
});

test("FSearchClient search with cwd scope", async () => {
  const client = new FSearchClient();
  const res = await client.search("package.json", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.hits));
  client.close();
});

test("FSearchClient grep with trigram index", async () => {
  const client = new FSearchClient();
  const res = await client.grep("FSearchClient", {
    in: process.cwd(),
    limit: 5,
  });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.files));
  client.close();
});

test("sanitize: scrubs secrets properly", () => {
  const input = "const token = 'ghp_123456789012345678901234567890123456'; api_key: 'abcdef1234567890'";
  const scrubbed = scrubSecrets(input);
  assert.ok(!scrubbed.includes("ghp_123456789012345678901234567890123456"));
  assert.ok(scrubbed.includes("[REDACTED_"));
});

test("sanitize: path boundary safety", () => {
  assert.equal(isPathSafe("/Users/batra/Search/Sources", "/Users/batra/Search"), true);
  assert.equal(isPathSafe("/Users/batra/.aws/credentials", "/Users/batra/Search"), false);
});
