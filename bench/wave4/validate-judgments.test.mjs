#!/usr/bin/env node
// bench/wave4/validate-judgments.test.mjs — the validator must be able to fail.
//
//   node --test bench/wave4/validate-judgments.test.mjs
//
// Four classes of assertion:
//   1. the shipped v2 set validates;
//   2. the shipped v1 set does NOT — and it fails on exactly the 16 audited
//      expectations, which proves the validator detects the real defects rather
//      than failing on nothing;
//   3. a deliberately unsatisfiable expectation of each lane kind fails;
//   4. an unjustified removal (a file that does contain the term, or a rank
//      inside the top-10 window) fails.
//
// The corpus must exist. It is not optional: the point of the validator is a
// data check against the frozen corpus, and a skipped data check proves nothing.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJudgments } from "./validate-judgments.mjs";
import { corpusReader, findCorpus, pathMatches, literalOccurs, regexOccurs, declares, V1_SHA256, V1_PATH } from "./amendment.mjs";
import * as crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CORPUS = findCorpus(process.env.PI_ULTRASEARCH_CORPUS ?? null);
const corpus = corpusReader(CORPUS);
const v1Raw = fs.readFileSync(path.join(REPO, V1_PATH));
const v1 = JSON.parse(v1Raw.toString("utf8"));
const v1Sha = crypto.createHash("sha256").update(v1Raw).digest("hex");
const v2 = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "judgments", "wave1-judgments.v2.json"), "utf8"));
const AUDIT = JSON.parse(fs.readFileSync(path.join(REPO, "bench", "wave3", "results", "final-expectation-audit.json"), "utf8"));
const auditMisses = AUDIT.rows.flatMap((r) => r.misses);

/** A judgment set around one query, so a single defect is isolated. */
const set = (q, extra = {}) => ({ schema: "ultrasearch.judgments/v2", version: 2, queries: [q], ...extra });
const errorsOf = (result, code) => result.errors.filter((e) => e.code === code);

test("the frozen v1 file is byte-identical to its recorded hash", () => {
  assert.equal(v1Sha, V1_SHA256);
});

test("the shipped v2 set validates against the frozen corpus", () => {
  const r = validateJudgments(v2, { corpus, v1, v1Sha256: v1Sha });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.stats.mustHitRows, 33);
  assert.equal(r.stats.checked, 71);
});

test("the shipped v1 set is invalid, on exactly the audited expectations", () => {
  const r = validateJudgments(v1, { corpus, v1, v1Sha256: v1Sha });
  assert.equal(r.ok, false);
  const unsatisfiable = errorsOf(r, "unsatisfiable");
  assert.equal(unsatisfiable.length, 16, `expected the 16 audited misses, got ${unsatisfiable.length}`);
  for (const m of auditMisses) {
    assert.ok(
      unsatisfiable.some((e) => e.msg.startsWith(`${m.id} (`) && e.msg.includes(`${m.expected} is not satisfiable`)),
      `v1 validation does not flag ${m.id}/${m.expected} (${m.class})`,
    );
  }
});

test("a path-lane expectation that does not match the path fails", () => {
  const r = validateJudgments(set({ id: "X1", lane: "path", query: "package.json", must_hit: true, expected: [{ path: "src/client.ts", grade: 3 }] }), { corpus });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "unsatisfiable").length, 1);
});

test("a content-lane expectation absent from the file's content fails", () => {
  const r = validateJudgments(set({ id: "X2", lane: "grep-literal", query: "enforceExactQuery", must_hit: true, params: { mode: "literal" }, expected: [{ path: "README.md", grade: 3 }] }), { corpus });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "unsatisfiable").length, 1);
});

test("a symbol-lane expectation that references without declaring fails", () => {
  const r = validateJudgments(set({ id: "X3", lane: "symbol", query: "FSearchClient", must_hit: true, params: { mode: "symbol" }, expected: [{ path: "src/mcp.ts", grade: 3 }] }), { corpus });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "unsatisfiable").length, 1);
});

test("a regex-lane expectation with no matching line fails", () => {
  const r = validateJudgments(set({ id: "X4", lane: "grep-regex", query: "^NEVER_MATCHES_ZZZ$", must_hit: true, params: { mode: "regex" }, expected: [{ path: "src/client.ts", grade: 3 }] }), { corpus });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "unsatisfiable").length, 1);
});

test("an absent-string removal that hides a real match fails", () => {
  const r = validateJudgments(set(
    { id: "X5", lane: "grep-literal", query: "enforceExactQuery", must_hit: true, params: { mode: "literal" }, expected: [{ path: "src/client.ts", grade: 3 }] },
    { removed: [{ id: "X5", lane: "grep-literal", query: "readme", path: "README.md", grade: 1, class: "absent-string", why: "wrongly claimed absent", evidence: { rg_command: "rg -c -i readme README.md", occurrences_case_sensitive: 0, occurrences_case_insensitive: 0 } }] },
  ), { corpus });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "removal-hides-match").length, 1);
});

test("a window removal whose measured rank is inside the top 10 fails", () => {
  const r = validateJudgments(set(
    { id: "X6", lane: "grep-literal", query: "client", must_hit: true, params: { mode: "literal" }, expected: [{ path: "src/mcp.ts", grade: 1 }] },
    { removed: [{ id: "X6", lane: "grep-literal", query: "client", path: "src/mcp.ts", grade: 1, class: "content-mention-not-top10", why: "claimed out of window", evidence: { rg_command: "rg -c -F client src/mcp.ts", lane_probe: { rank: 2, match_count: 23 } } }] },
  ), { corpus });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "removal-window").length, 1);
});

test("a v1 expectation that vanishes without a record fails", () => {
  const broken = set({ id: "S1", lane: "symbol", query: "FSearchClient", must_hit: true, params: { mode: "symbol" }, expected: [{ path: "src/client.ts", grade: 3 }] });
  const r = validateJudgments(broken, { corpus, v1: { queries: [{ id: "S1", lane: "symbol", query: "FSearchClient", must_hit: true, expected: [{ path: "src/client.ts", grade: 3 }, { path: "src/mcp.ts", grade: 1 }] }] } });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "unaccounted").length, 1);
});

test("a re-homing that changes the relevance grade fails", () => {
  const r = validateJudgments(set(
    { id: "S1", lane: "symbol", query: "FSearchClient", must_hit: true, params: { mode: "symbol" }, expected: [{ path: "src/client.ts", grade: 3 }] },
    { rehomings: [{ id: "S1", expected_path: "src/mcp.ts", grade: 3, to: { id: "S1c", lane: "grep-literal" } }] },
  ), { corpus, v1: { queries: [{ id: "S1", lane: "symbol", query: "FSearchClient", must_hit: true, expected: [{ path: "src/client.ts", grade: 3 }, { path: "src/mcp.ts", grade: 1 }] }] } });
  assert.equal(r.ok, false);
  assert.equal(errorsOf(r, "grade-changed").length, 1);
});

test("a minimal satisfiable set passes (positive control for the failing cases)", () => {
  const r = validateJudgments(set({ id: "X7", lane: "grep-literal", query: "FSearchClient", must_hit: true, params: { mode: "literal" }, expected: [{ path: "src/client.ts", grade: 3 }] }), { corpus });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test("pathMatches handles tokens and globs", () => {
  assert.equal(pathMatches("src/client.ts", "client.ts"), true);
  assert.equal(pathMatches("test/client.test.ts", "client.ts"), false);
  assert.equal(pathMatches("test/client.test.ts", "client"), true);
  assert.equal(pathMatches("src/client.ts", "src/**/*.ts"), true);
  assert.equal(pathMatches("src/deep/nested/file.ts", "src/**/*.ts"), true);
  assert.equal(pathMatches("test/bench.ts", "src/**/*.ts"), false);
  assert.equal(pathMatches(".github/workflows/ci.yml", "ci.yml"), true);
});

test("literalOccurs is the engine's smart case", () => {
  assert.equal(literalOccurs("class UltraSearchClient", "client"), true);
  assert.equal(literalOccurs("class UltraSearchClient", "Client"), true);
  assert.equal(literalOccurs("class UltraSearchClient", "ultrasearchclient"), true, "an all-lowercase pattern is case-insensitive (smart case)");
  assert.equal(literalOccurs("class UltraSearchClient", "UltraSearchclient"), false, "a pattern with uppercase is exact");
  assert.equal(literalOccurs("import { X } from './client.ts'", "client.ts"), true);
});

test("declares separates a declaration from a reference", () => {
  assert.equal(declares("export class FSearchClient {", "FSearchClient"), true);
  assert.equal(declares("import { FSearchClient } from './client.ts';", "FSearchClient"), false, "an import is a reference, not a declaration — the property that makes the symbol lane declaration-only");
  assert.equal(declares("new FSearchClient()", "FSearchClient"), false);
});

test("regexOccurs follows line semantics", () => {
  assert.equal(regexOccurs("export class FooClient {", "class\\s+\\w+Client"), true);
  assert.equal(regexOccurs("const x = 1;", "class\\s+\\w+Client"), false);
});

test("the corpus is present (a skipped data check would prove nothing)", () => {
  assert.ok(fs.existsSync(CORPUS), CORPUS);
  assert.ok(fs.existsSync(path.join(CORPUS, "src", "client.ts")));
});
