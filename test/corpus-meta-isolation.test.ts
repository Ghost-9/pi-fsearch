// The corpus metadata must not be part of the searchable corpus.
//
// THE DEFECT (measured through the real daemon, test/engine/harness.mjs over a
// fixture corpus root):
//
//   root = { .corpus-meta.json, README.md, notes.txt }
//   query "corpus"       -> 1 hit, ".corpus-meta.json"
//   query "corpus-meta"  -> 1 hit, ".corpus-meta.json"
//
// `bench/baseline/make-corpus.mjs` wrote `.corpus-meta.json` INSIDE the corpus
// root. It is then just another file in the tree the engine indexes and ranks —
// so a query meant for the corpus's own contents is answered by the bench
// metadata instead, and it quotes the commit, the tree hash and the file count,
// poisoning the exact retrieval and ranking the corpus exists to measure.
//
// The fix is the generator's, not the engine's: the metadata is written BESIDE
// the corpus root (`<corpus>.meta.json`). Suppressing dotfiles in the engine
// would be the wrong repair — `.gitignore` and `.github/workflows` are exactly
// the kind of thing search must be able to find.
//
// Both tests use the SAME query and differ only in whether the metadata file is
// inside the root, so the pair is a real control: the regression test can only
// pass by the metadata being absent, never by the query finding nothing.
//
//   node --test test/corpus-meta-isolation.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineHarness, HAS_ENGINE, writeFile, tmpdir } from "./engine/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "us-corpus-meta-"));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/**
 * Hit paths relative to the fixture root. The daemon reports realpaths while
 * the fixture is addressed through the `/var` -> `/private/var` symlink, so
 * both sides are resolved before comparing.
 */
function relativeHits(root, hits) {
  const real = fs.realpathSync(root);
  return (hits ?? []).map((x) => path.relative(real, fs.realpathSync(x.path)));
}

// ---------------------------------------------------------------------------
// The generators must place the metadata outside the corpus root
// ---------------------------------------------------------------------------

test("make-corpus.mjs writes the metadata BESIDE the corpus root", () => {
  const src = read("bench/baseline/make-corpus.mjs");
  // The old line wrote it inside: path.join(ROOT, ".corpus-meta.json").
  assert.doesNotMatch(
    src,
    /path\.join\(\s*ROOT\s*,\s*["']\.corpus-meta\.json["']\s*\)/,
    "make-corpus.mjs must not write .corpus-meta.json inside the corpus root"
  );
  assert.doesNotMatch(
    src,
    /path\.join\(\s*dir\s*,\s*["']\.corpus-meta\.json["']\s*\)/,
    "same for a per-corpus dir"
  );
  // It is now the sibling path.
  assert.match(src, /const META = `\$\{ROOT\}\.meta\.json`;/, "META must be the sibling <ROOT>.meta.json");
});

test("make-corpora.mjs writes the metadata BESIDE each corpus root", () => {
  const src = read("bench/wave3/make-corpora.mjs");
  assert.doesNotMatch(
    src,
    /path\.join\(\s*dir\s*,\s*["']\.corpus-meta\.json["']\s*\)/,
    "make-corpora.mjs must not write .corpus-meta.json inside a corpus root"
  );
  assert.match(src, /const meta = `\$\{dir\}\.meta\.json`;/, "meta must be the sibling <dir>.meta.json");
});

// ---------------------------------------------------------------------------
// The corpus itself: metadata in means a hit, metadata out means no hit
// ---------------------------------------------------------------------------

test("REGRESSION: a corpus root carrying no metadata file returns no metadata hit", async (t) => {
  if (!HAS_ENGINE) return t.skip("release engine binary not built");
  const root = path.join(tmpdir("us-meta-clean-"), "corpus-0a16e50");
  // `corpus-notes.md` is named so the query "corpus" has a real target in the
  // clean corpus. `search` matches path names, so a query only the metadata
  // could satisfy would confuse "no leak" with "nothing found".
  writeFile(path.join(root, "corpus-notes.md"), "# corpus\n");
  writeFile(path.join(root, "README.md"), "# readme\n");
  writeFile(path.join(root, "notes.txt"), "hello\n");

  const h = new EngineHarness({ root });
  await h.start();
  try {
    const res = await h.search("corpus", { limit: 20 });
    const paths = relativeHits(root, res.hits);
    assert.deepEqual(
      paths.filter((p) => p.endsWith(".corpus-meta.json")),
      [],
      "no .corpus-meta.json may be returned from a corpus root"
    );
    // Non-vacuity: the search really worked and found the reachable file.
    assert.ok(
      paths.includes("corpus-notes.md"),
      `expected corpus-notes.md to be found, got ${JSON.stringify(paths)}`
    );
  } finally {
    h.cleanup();
  }
});

test("CONTROL: an in-root metadata file IS returned for the same query", async (t) => {
  // The non-vacuity control. It reconstructs the OLD corpus shape (metadata
  // inside the root) and requires the engine to surface it for the SAME query
  // the regression test above uses. If this ever stops holding, the regression
  // test can no longer detect the defect.
  if (!HAS_ENGINE) return t.skip("release engine binary not built");
  const root = path.join(tmpdir("us-meta-leaky-"), "corpus-0a16e50");
  writeFile(
    path.join(root, ".corpus-meta.json"),
    JSON.stringify({ commit: "0a16e50", files: 2, tree_sha256: "deadbeef" }, null, 2) + "\n"
  );
  writeFile(path.join(root, "corpus-notes.md"), "# corpus\n");

  const h = new EngineHarness({ root });
  await h.start();
  try {
    const res = await h.search("corpus", { limit: 20 });
    const paths = relativeHits(root, res.hits);
    assert.ok(
      paths.includes(".corpus-meta.json"),
      `expected the engine to return the in-root .corpus-meta.json, got ${JSON.stringify(paths)}`
    );
  } finally {
    h.cleanup();
  }
});

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));