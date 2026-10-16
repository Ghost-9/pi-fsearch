// Strictness scoping for `search()`'s query transform.
//
// THE DEFECT (measured on the released engine, engine/target/release/ultrasearch):
//
//   enforceExactQuery("format grep files")  ->  "'format 'grep 'files"
//
// Every word became an exact conjunct, on top of a client-side path filter
// demanding that *every* word appear in the file name. The engine answers the
// plain query `format grep files` with 251 hits and the exact-conjunct form
// with **0**. A three-word description of what you are looking for is not a
// selector, and treating it as one makes search return nothing.
//
// Strictness is still correct for a name: `UltraSearchClient` and
// `src/client.ts` must be matched exactly. These tests pin both halves, and
// they are written so the natural-language cases FAIL against the old
// all-conjunct transform and the selector cases FAIL against a naive
// "never be strict" fix.
//
//   node --test test/exact-query-scope.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceExactQuery, extractExactWords, isSelectorQuery } from "../src/client.ts";

// ---------------------------------------------------------------------------
// Natural language: must NOT become a list of exact conjuncts
// ---------------------------------------------------------------------------

test("natural language is not a selector: exactness is not applied to any word", () => {
  for (const q of ["format grep files", "wireless noise cancelling headphones", "how do i reindex the daemon"]) {
    assert.equal(isSelectorQuery(q), false, `${q} must not be a selector`);
    const out = enforceExactQuery(q);
    assert.equal(
      out.includes("'"),
      false,
      `${q} must not be exact-prefixed, got ${JSON.stringify(out)} (old bug: every word became an exact conjunct)`
    );
    assert.equal(out, q, `${q} should pass through unchanged`);
  }
});

test("natural language contributes no exact words, so the path filter cannot require them all", () => {
  // The old extractExactWords returned ["format","grep","files"], and the caller
  // ANDs them over hit paths: no file name contains all three words.
  assert.deepEqual(extractExactWords("format grep files"), []);
  assert.deepEqual(extractExactWords("wireless headphones"), []);
});

// ---------------------------------------------------------------------------
// Selectors: must still be strict
// ---------------------------------------------------------------------------

test("a single identifier is a selector and is matched exactly", () => {
  for (const q of ["UltraSearchClient", "enforceExactQuery", "src/client.ts", "fsearch.sock", "git"]) {
    assert.equal(isSelectorQuery(q), true, `${q} must be a selector`);
    assert.equal(enforceExactQuery(q), `'${q}`, `${q} must be exact-prefixed`);
  }
});

test("a multi-token query of identifier-shaped names is a selector", () => {
  assert.equal(isSelectorQuery("fsearch.sock README.md"), true);
  assert.equal(enforceExactQuery("fsearch.sock README.md"), "'fsearch.sock 'README.md");
});

test("a selector still constrains the path to its exact words", () => {
  assert.deepEqual(extractExactWords("UltraSearchClient"), ["ultrasearchclient"]);
  assert.deepEqual(extractExactWords("src/client.ts"), ["src/client.ts"]);
});

// ---------------------------------------------------------------------------
// Operator tokens pass through untouched in both modes
// ---------------------------------------------------------------------------

test("filters, globs and prefix/suffix tokens are never rewritten", () => {
  for (const q of ["*.ts", "src/**/*.rs", "ext:ts", "^make", "build$"]) {
    assert.equal(enforceExactQuery(q), q, `${q} must pass through unchanged`);
  }
  // A filter beside a natural-language phrase does not make it a selector,
  // and does not get exact-prefixed either.
  assert.equal(isSelectorQuery("format grep files ext:ts"), false);
  assert.equal(enforceExactQuery("format grep files ext:ts"), "format grep files ext:ts");
  // A single identifier beside a filter is still a selector.
  assert.equal(isSelectorQuery("UltraSearchClient ext:ts"), true);
  assert.equal(enforceExactQuery("UltraSearchClient ext:ts"), "'UltraSearchClient ext:ts");
});

// ---------------------------------------------------------------------------
// The regression that pins the measured defect
// ---------------------------------------------------------------------------

test("REGRESSION: 'format grep files' is not sent as three exact conjuncts", () => {
  // The exact string the old code produced, and the reason search returned 0.
  assert.notEqual(enforceExactQuery("format grep files"), "'format 'grep 'files");
  // The measured engine behaviour this guards: plain query finds, conjunct form does not.
  const conjunct = "'format 'grep 'files";
  assert.equal(conjunct.split(" ").filter((t) => t.startsWith("'")).length, 3);
  assert.equal(enforceExactQuery("format grep files").split(" ").filter((t) => t.startsWith("'")).length, 0);
});

test("quoting is preserved as one selector", () => {
  assert.equal(isSelectorQuery('"src/client.ts"'), true);
  assert.equal(enforceExactQuery('"src/client.ts"'), "'src/client.ts");
  // Quoting a phrase does not turn it into a selector.
  assert.equal(isSelectorQuery('"format grep files"'), false);
});

test("empty and whitespace-only queries are handled", () => {
  assert.equal(isSelectorQuery(""), false);
  assert.equal(isSelectorQuery("   "), false);
  assert.equal(enforceExactQuery(""), "");
  assert.deepEqual(extractExactWords(""), []);
});