// Content-index coverage policy (#17).
//
// The daemon's coverage is configurable and, crucially, *reported*: a 0-hit
// grep must never be ambiguous.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineHarness, writeFile, tmpdir, until, sleep } from "./harness.mjs";

/** A fixture with one covered folder and one that the policy excludes. */
function fixture() {
  const h = new EngineHarness({ root: path.join(tmpdir("us-cov-"), "root") });
  writeFile(path.join(h.root, "notes", "abc.md"), "MARKER_MD\n");
  writeFile(path.join(h.root, "notes", "abc.rs"), "MARKER_RS\n");
  writeFile(path.join(h.root, "notes", "abc.txt"), "MARKER_TXT\n");
  writeFile(path.join(h.root, "other", "abc.md"), "MARKER_MD\n");
  return h;
}

test("coverage: the policy is reported in status and enforced", async () => {
  const h = fixture();
  fs.writeFileSync(
    path.join(h.dir, "coverage.json"),
    JSON.stringify({ extensions: ["md", "rs"], roots: [path.join(h.root, "notes")], warm: [path.join(h.root, "notes")] }),
  );
  await h.start();
  try {
    const s = await h.status();
    assert.ok(s.content_policy, JSON.stringify(s).slice(0, 300));
    assert.equal(s.content_policy.configured, true);
    assert.equal(s.content_policy.extensions, 2);
    assert.equal(s.content_policy.roots, 1);
    assert.equal(s.content_policy.warm, 1);
    assert.match(s.content_policy.source, /coverage\.json$/);

    // Warm-up: the configured folder is content-searchable without any prior
    // search of it — "a freshly opened repo becomes content-searchable within
    // one documented warm-up window".
    const ready = await until(async () => {
      const st = await h.status();
      return st.content_docs >= 2 && st.content_pending === 0 ? st : null;
    }, { timeoutMs: 30_000 });
    assert.ok(ready, `warm-up did not finish: ${JSON.stringify(await h.status())}`);

    // Only .md and .rs, and only under notes.
    assert.ok((await h.grep("MARKER_MD")).files.some((f) => f.path.endsWith("notes/abc.md")));
    assert.ok((await h.grep("MARKER_RS")).files.some((f) => f.path.endsWith("notes/abc.rs")));
    assert.deepEqual((await h.grep("MARKER_TXT")).files, [], "a .txt outside the policy must not be covered");
    assert.ok(
      !(await h.grep("MARKER_MD")).files.some((f) => f.path.includes("/other/")),
      "a root outside the policy must not be covered",
    );
    // Name search is unaffected: the same files are still findable.
    assert.ok((await h.search("abc")).hits.some((x) => x.path.endsWith("other/abc.md")));
  } finally {
    h.cleanup();
  }
});

test("coverage: a malformed policy fails the daemon's start, not silently", async () => {
  const h = fixture();
  fs.writeFileSync(path.join(h.dir, "coverage.json"), `{"extensions": "md"}`);
  await assert.rejects(
    () => h.start({ waitMs: 3000 }),
    (e) => /coverage/.test(String(e.message)) || /coverage/.test(h.stderr),
    `a bad policy must be reported: ${h.stderr}`,
  );
  h.cleanup();
});

test("coverage: the environment overrides the file", async () => {
  const h = fixture();
  fs.writeFileSync(path.join(h.dir, "coverage.json"), JSON.stringify({ extensions: ["md"] }));
  h.env.ULTRASEARCH_CONTENT_EXTS = "txt";
  await h.start();
  try {
    const s = await h.status();
    assert.equal(s.content_policy.extensions, 1);
    assert.equal(s.content_policy.source, "environment");
    await until(async () => (await h.status()).content_docs > 0, { timeoutMs: 30_000 });
    assert.deepEqual((await h.grep("MARKER_MD")).files, [], "the file's list must be overridden");
    assert.equal((await h.grep("MARKER_TXT")).files.length, 1, "the environment's list must apply");
  } finally {
    h.cleanup();
  }
});

test("coverage: without a policy nothing changes (the built-in rules apply)", async () => {
  const h = fixture();
  await h.start();
  try {
    await until(async () => (await h.status()).content_docs >= 4, { timeoutMs: 30_000 });
    const s = await h.status();
    assert.equal(s.content_policy.configured, false);
    await sleep(50);
    assert.ok((await h.grep("MARKER_TXT")).files.length > 0, "the built-in list covers .txt");
  } finally {
    h.cleanup();
  }
});
