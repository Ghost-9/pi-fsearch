process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ROOTS_ENV,
  ROOTS_FILE_ENV,
  dedupeGrepFiles,
  dedupeHits,
  findGitRoot,
  loadRootConfig,
  multiRootGrep,
  multiRootSearch,
  normalizeRoots,
  parseRootsConfig,
  realpathOr,
  rootScope,
  type AttributedHit,
} from "../src/roots.ts";
import type { UltraSearchGrepFile, UltraSearchHit } from "../src/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-roots-"));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function mkdir(rel: string): string {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hit(file: string, score = 1): UltraSearchHit {
  return { kind: "file", mtime: 0, path: file, score, size: 10 };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("roots: no config is inert (single active root, no extra scope)", () => {
  const active = mkdir("inert");
  const config = loadRootConfig({ env: {}, configPath: path.join(tmp, "does-not-exist.json") });
  assert.equal(config.source, "none");
  assert.deepEqual(config.roots, []);
  assert.deepEqual(rootScope(active, config), [realpathOr(active)]);
});

test("roots: ULTRASEARCH_ROOTS is parsed with the OS path delimiter", () => {
  const a = mkdir("env-a");
  const b = mkdir("env-b");
  const env = { [ROOTS_ENV]: [a, b].join(path.delimiter) } as NodeJS.ProcessEnv;
  const config = loadRootConfig({ env, configPath: path.join(tmp, "unused.json") });
  assert.equal(config.source, "env");
  assert.deepEqual(config.roots, [realpathOr(a), realpathOr(b)]);
});

test("roots: config file is read and an unusable one falls back to none", () => {
  const a = mkdir("file-a");
  const b = mkdir("file-b");
  const configPath = path.join(tmp, "roots.json");
  fs.writeFileSync(configPath, JSON.stringify({ roots: [a, b], preferActiveWorktree: false }));
  const config = loadRootConfig({ env: {}, configPath });
  assert.equal(config.source, "file");
  assert.deepEqual(config.roots, [realpathOr(a), realpathOr(b)]);
  assert.equal(config.preferActiveWorktree, false);

  fs.writeFileSync(configPath, "{not json");
  assert.equal(loadRootConfig({ env: {}, configPath }).source, "none");
  assert.equal(parseRootsConfig("[]"), null);
  assert.equal(parseRootsConfig('{"roots": "nope"}'), null);
});

test("roots: ULTRASEARCH_ROOTS_FILE selects the config path", () => {
  const a = mkdir("envfile-a");
  const configPath = path.join(tmp, "envfile-roots.json");
  fs.writeFileSync(configPath, JSON.stringify({ roots: [a] }));
  const config = loadRootConfig({ env: { [ROOTS_FILE_ENV]: configPath } as NodeJS.ProcessEnv });
  assert.deepEqual(config.roots, [realpathOr(a)]);
});

test("roots: normalizeRoots collapses a symlinked duplicate by realpath", () => {
  const real = mkdir("norm-real");
  const link = path.join(tmp, "norm-link");
  try {
    fs.symlinkSync(real, link, "dir");
  } catch {
    return; // symlinks unavailable on this filesystem
  }
  assert.deepEqual(normalizeRoots([real, link]), [realpathOr(real)]);
});

test("roots: findGitRoot walks to the nearest .git entry", () => {
  const repo = mkdir("gitrepo");
  fs.mkdirSync(path.join(repo, ".git"));
  const nested = mkdir("gitrepo/src/deep");
  assert.equal(findGitRoot(nested), repo);
  assert.equal(findGitRoot(mkdir("no-git-here")), null);
});

// ---------------------------------------------------------------------------
// dedupe + attribution
// ---------------------------------------------------------------------------

test("roots: nested roots return each file once, keeping the active worktree copy", async () => {
  const active = mkdir("nested-repo");
  const nestedRoot = mkdir("nested-repo/packages/app");
  const file = path.join(nestedRoot, "index.ts");
  fs.writeFileSync(file, "export const x = 1;\n");

  const result = await multiRootSearch("index.ts", {
    activeRoot: active,
    roots: [nestedRoot],
    search: async () => ({ hits: [hit(file)] }), // both roots return the same file
  });

  assert.equal(result.multi, true);
  assert.equal(result.roots.length, 2);
  assert.equal(result.hits.length, 1, "the same realpath must appear once");
  assert.equal(result.duplicates, 1);
  const kept = result.hits[0] as AttributedHit;
  assert.equal(kept.realPath, realpathOr(file));
  assert.equal(kept.active, true, "the active worktree's copy wins");
  assert.equal(kept.root, realpathOr(active));
});

test("roots: a symlinked extra root is realpath-collapsed before searching", async () => {
  const active = mkdir("sym-active");
  const linked = path.join(tmp, "sym-linked");
  try {
    fs.symlinkSync(active, linked, "dir");
  } catch {
    return;
  }
  const scopes: string[] = [];
  const result = await multiRootSearch("x", {
    activeRoot: active,
    roots: [linked],
    search: async (_q, scope) => {
      scopes.push(scope);
      return { hits: [hit(path.join(active, "only.ts"))] };
    },
  });
  assert.equal(result.multi, false, "a root that is a symlink of the active one is not a second search");
  assert.deepEqual(scopes, [realpathOr(active)]);
});

test("roots: hits from an extra root are attributed to it, not the active root", () => {
  const active = mkdir("attr-active");
  const extra = mkdir("attr-extra");
  const file = path.join(extra, "deep", "b.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x\n");

  const { hits } = dedupeHits([hit(file)], { activeRoot: active, roots: [realpathOr(extra)] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].active, false);
  assert.equal(hits[0].root, realpathOr(extra));
});

test("roots: dedupeHits without a preferred active copy keeps the first occurrence", () => {
  const active = mkdir("first-active");
  const file = path.join(active, "f.ts");
  fs.writeFileSync(file, "x\n");
  const { hits, duplicates } = dedupeHits([hit(file, 9), hit(file, 1)], { activeRoot: active, preferActiveWorktree: false });
  assert.equal(hits.length, 1);
  assert.equal(duplicates, 1);
  assert.equal(hits[0].score, 9);
});

test("roots: grep files dedupe by realpath too", () => {
  const active = mkdir("grep-active");
  const file = path.join(active, "g.ts");
  fs.writeFileSync(file, "x\n");
  const files: UltraSearchGrepFile[] = [
    { path: file, matches: [{ line: 1, text: "x" }] },
    { path: file, matches: [{ line: 1, text: "x" }] },
  ];
  const { files: deduped, duplicates } = dedupeGrepFiles(files, { activeRoot: active });
  assert.equal(deduped.length, 1);
  assert.equal(duplicates, 1);
  assert.equal(deduped[0].active, true);
});

test("roots: multiRootSearch reports per-root failures instead of silently dropping them", async () => {
  const active = mkdir("fail-active");
  const extra = mkdir("fail-extra");
  const result = await multiRootSearch("q", {
    activeRoot: active,
    roots: [extra],
    search: async (_q, scope) => {
      if (scope.endsWith("fail-extra")) throw new Error("socket down");
      return { hits: [hit(path.join(active, "ok.ts"))] };
    },
  });
  assert.equal(result.hits.length, 1, "the healthy root still answers");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /socket down/);
});

test("roots: multiRootGrep merges and dedupes across roots", async () => {
  const active = mkdir("mg-active");
  const extra = mkdir("mg-extra");
  const file = path.join(active, "shared.ts");
  fs.writeFileSync(file, "needle\n");
  const result = await multiRootGrep("needle", {
    activeRoot: active,
    roots: [extra],
    grep: async () => ({ files: [{ path: file, matches: [{ line: 1, text: "needle" }] }] }),
  });
  assert.equal(result.multi, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.files[0].active, true);
});
