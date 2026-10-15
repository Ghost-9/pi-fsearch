// Grep page ranking (#48): a grep result page is ordered by what its files
// contain, not by where the candidate order happened to put them.
//
// The engine reads candidates in `(doc_rank, mtime, segment, doc)` order, which
// on a corpus whose mtimes tie degenerates to path-alphabetical: the changelog
// that mentions a symbol sorts above the file that declares it. `page_key` in
// `engine/src/content.rs` stable-sorts the page the search already read:
//   1. a file whose matched line is a definition of the match;
//   2. then more matches;
//   3. then source over prose.
// This test drives the real daemon through the harness, not the client.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { EngineHarness, writeFile, tmpdir, until } from "./harness.mjs";

// Built so the candidate order (path-alphabetical) puts the *wrong* file first
// in every case, so removing the ranking fails the assertions.
function fixture() {
  const h = new EngineHarness({ root: path.join(tmpdir("us-rank-"), "root") });
  // Case 1 - definition vs mentions. `doc_a.md` sorts before `def_a.ts` and has
  // eight matches; the declaring file has one.
  writeFile(path.join(h.root, "docs", "notes-a.md"), ["alpha_marker alpha_marker alpha_marker alpha_marker", "alpha_marker alpha_marker alpha_marker alpha_marker", "", "alpha_marker", "alpha_marker", ""].join("\n"));
  writeFile(path.join(h.root, "src", "def-a.ts"), "export function alpha_marker() {\n  return 1;\n}\n");
  // Case 2 - no definition either side, equal match counts: only the class
  // tie-break separates them, and `docs/` sorts first.
  writeFile(path.join(h.root, "docs", "notes-b.md"), "beta_marker one\nbeta_marker two\nbeta_marker three\n");
  writeFile(path.join(h.root, "src", "uses-b.ts"), "// beta_marker one\n// beta_marker two\n// beta_marker three\n");
  // Case 3 - control: the prose file really does have more matches, so it must
  // still win. A ranking that ignored counts would put `src/uses-c.ts` first.
  writeFile(path.join(h.root, "src", "uses-c.ts"), "// gamma_marker\n");
  writeFile(path.join(h.root, "docs", "notes-c.md"), "gamma_marker\ngamma_marker\ngamma_marker\n");
  return h;
}

// Case 4 - the candidate tier. The page is filled from the candidates read
// first, so a fresh checkout (every mtime identical, order = path-alphabetical)
// would spend the whole page on prose that sorts early and never reach the file
// that declares the term. `doc_rank` demotes prose so the declaration is read.
function proseCrowdFixture() {
  const h = new EngineHarness({ root: path.join(tmpdir("us-rank-crowd-"), "root") });
  for (let i = 1; i <= 6; i++) {
    writeFile(path.join(h.root, "aaa", `notes-${i}.md`), "delta_marker appears here\n");
  }
  writeFile(path.join(h.root, "src", "def-d.ts"), "export function delta_marker() {\n  return 1;\n}\n");
  return h;
}

const names = (res) => (res.files ?? []).map((f) => path.basename(f.path));
const pick = (res, name) => (res.files ?? []).find((f) => path.basename(f.path) === name);

test("grep ranks a page by definition, then match count, then source over prose", async () => {
  const h = fixture();
  await h.start();
  try {
    const ready = await until(
      async () => {
        const s = await h.status().catch(() => null);
        return s?.ok && (s.content_docs ?? 0) >= 6 && (s.content_pending ?? 0) === 0 ? s : null;
      },
      { timeoutMs: 30_000 }
    );
    assert.ok(ready, "fixture indexed");

    // 1. The declaration beats the file that mentions it eight times.
    const a = await h.grep("alpha_marker");
    assert.deepEqual(names(a), ["def-a.ts", "notes-a.md"], "a definition outranks more mentions");

    // The ranking's definition signal is not leaked into a plain grep's
    // answer: `def` stays an opt-in field (`defs: true`), so callers that did
    // not ask for it see the same shape as before.
    assert.equal("def" in (pick(a, "def-a.ts").matches[0] ?? {}), false, "plain grep carries no def field");
    const aDefs = await h.grep("alpha_marker", { defs: true });
    assert.equal(pick(aDefs, "def-a.ts").matches[0].def, true, "the declaration line is marked when asked");
    assert.equal("def" in (pick(aDefs, "notes-a.md").matches[0] ?? {}), false, "a mention is not a declaration");

    // 2. Equal matches, no definition: the source file wins over the prose one.
    const b = await h.grep("beta_marker");
    assert.deepEqual(names(b), ["uses-b.ts", "notes-b.md"], "source outranks prose on a tie");

    // 3. A genuine match-count advantage is not overturned by the class rank.
    const c = await h.grep("gamma_marker");
    assert.deepEqual(names(c), ["notes-c.md", "uses-c.ts"], "more matches still outrank fewer");
  } finally {
    await h.stop();
  }
});

test("grep ranking does not touch symbol mode, whose plan already means 'defines it'", async () => {
  const h = fixture();
  await h.start();
  try {
    const ready = await until(
      async () => {
        const s = await h.status().catch(() => null);
        return s?.ok && (s.content_docs ?? 0) >= 6 && (s.content_pending ?? 0) === 0 ? s : null;
      },
      { timeoutMs: 30_000 }
    );
    assert.ok(ready, "fixture indexed");

    // Only the declaring file is a candidate, and only its declaration line is
    // returned: the two mention-only files never enter the set.
    const sym = await h.grep("alpha_marker", { mode: "symbol" });
    assert.deepEqual(names(sym), ["def-a.ts"]);
    assert.equal(sym.files[0].matches.length, 1, "one declaration line");
    assert.match(sym.files[0].matches[0].text, /export function alpha_marker/);
  } finally {
    await h.stop();
  }
});

test("a fresh checkout's path order does not spend the page on prose", async () => {
  const h = proseCrowdFixture();
  await h.start();
  try {
    const ready = await until(
      async () => {
        const s = await h.status().catch(() => null);
        return s?.ok && (s.content_docs ?? 0) >= 7 && (s.content_pending ?? 0) === 0 ? s : null;
      },
      { timeoutMs: 30_000 }
    );
    assert.ok(ready, "fixture indexed");

    // Six prose files sort before `src/` and all match; a page of three would be
    // filled by them if the candidate order were plain path order.
    const res = await h.grep("delta_marker", { limit: 3 });
    assert.deepEqual(names(res)[0], "def-d.ts", "the declaring file survives a small page");
    const defs = await h.grep("delta_marker", { limit: 3, defs: true });
    assert.equal(pick(defs, "def-d.ts").matches[0].def, true, "and it is the declaration line that put it there");
  } finally {
    await h.stop();
  }
});

test("grep paging is unchanged: `cursor` still resumes in candidate order", async () => {
  const h = fixture();
  await h.start();
  try {
    const ready = await until(
      async () => {
        const s = await h.status().catch(() => null);
        return s?.ok && (s.content_docs ?? 0) >= 6 && (s.content_pending ?? 0) === 0 ? s : null;
      },
      { timeoutMs: 30_000 }
    );
    assert.ok(ready, "fixture indexed");

    const first = await h.grep("alpha_marker", { limit: 1 });
    assert.ok(first.next > 0, "a first page over a 2-file set offers a cursor");
    const second = await h.grep("alpha_marker", { limit: 1, cursor: first.next });
    const seen = new Set([...names(first), ...names(second)]);
    assert.deepEqual([...seen].sort(), ["def-a.ts", "notes-a.md"], "every file is reachable across pages");
  } finally {
    await h.stop();
  }
});
