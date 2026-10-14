// Engine search behaviour: the `budget_ms` contract (#16), early termination
// and its equivalence to a full scan (#35), frecency, and worktree scoping
// against two linked worktrees (#22).
//
// Every test that measures asserts its numbers too: the scope it searched,
// how many files that scope holds, and the load average at the time, so a
// latency claim can be judged rather than believed. See the benchmark
// harness in bench/ for the n>=20 medians with confidence intervals.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { EngineHarness, writeFile, tmpdir, until } from "./harness.mjs";

/** Files in a fixture, so a claim about it is checkable. */
function countFiles(root) {
  let n = 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true, recursive: true })) if (e.isFile()) n++;
  return n;
}

/** Two files with the same name in different folders: a score tie. */
function tieFixture() {
  const h = new EngineHarness({ root: path.join(tmpdir("us-tie-"), "root") });
  writeFile(path.join(h.root, "one", "needle-report.txt"), "needle\n");
  writeFile(path.join(h.root, "two", "needle-report.txt"), "needle\n");
  return h;
}

test("budget: an ample budget is byte-for-byte the same answer as no budget", async () => {
  const h = new EngineHarness({ files: 2000, kind: "deep" });
  await h.start();
  try {
    const plain = await h.search("file-*", { limit: 40 });
    const budgeted = await h.search("file-*", { limit: 40, budget_ms: 60_000 });
    assert.ok(plain.ok && budgeted.ok, JSON.stringify(budgeted).slice(0, 200));
    const strip = (r) => (r.hits ?? []).map((x) => `${x.path}|${x.score}|${x.kind}|${x.size}`);
    assert.deepEqual(strip(budgeted), strip(plain), "the budget changed the answer");
    assert.equal(budgeted.complete, true);
    // The numbers the claim rests on.
    assert.ok(budgeted.scanned > 0, `scanned=${budgeted.scanned}`);
    assert.ok(budgeted.considered > 0, `considered=${budgeted.considered}`);
    assert.equal(budgeted.budget_ms, 60_000);
    assert.ok((budgeted.scanned ?? 0) >= countFiles(h.root), `scanned ${budgeted.scanned} of ${countFiles(h.root)} files`);
  } finally {
    h.cleanup();
  }
});

test("budget: an expired budget says so, and its hits are a subset of the full set", async () => {
  const h = new EngineHarness({ files: 4000, kind: "deep" });
  await h.start();
  try {
    const full = await h.search("file-*", { limit: 50 });
    const fullSet = new Set((full.hits ?? []).map((x) => x.path));
    assert.equal(fullSet.size, 50);

    // A 1 ms deadline over 4000 files: whether it expires is machine
    // dependent, so assert the contract in both directions rather than a
    // timing that would flake on a fast box.
    const tight = await h.search("file-*", { limit: 50, budget_ms: 1 });
    assert.ok(tight.ok, JSON.stringify(tight).slice(0, 200));
    assert.equal(typeof tight.complete, "boolean");
    assert.equal(tight.budget_ms, 1);
    assert.ok(typeof tight.scanned === "number" && typeof tight.considered === "number");
    assert.ok((tight.hits ?? []).length <= 50);
    for (const hit of tight.hits ?? []) {
      assert.ok(fullSet.has(hit.path), `a partial result is not in the full set: ${hit.path}`);
    }
    if (tight.complete === false) {
      assert.ok(tight.considered < countFiles(h.root), "an incomplete answer that scored everything");
    }
  } finally {
    h.cleanup();
  }
});

test("budget: a candidate cap stops scoring and marks the answer partial (#35)", async () => {
  const h = new EngineHarness({ files: 4000, kind: "deep" });
  await h.start();
  try {
    const full = await h.search("file-*", { limit: 50, candidates: 10_000_000 });
    assert.equal(full.complete, true, JSON.stringify(full).slice(0, 200));
    const capped = await h.search("file-*", { limit: 50, candidates: 1000 });
    assert.equal(capped.complete, false, JSON.stringify(capped).slice(0, 200));
    assert.ok((capped.considered ?? 0) < (full.considered ?? 0), `${capped.considered} vs ${full.considered}`);
    assert.ok((capped.hits ?? []).length <= 50);
  } finally {
    h.cleanup();
  }
});

test("grep reports the same scanned/considered vocabulary and a complete flag", async () => {
  const h = new EngineHarness({ files: 300, kind: "deep" });
  await h.start();
  await until(async () => (await h.status()).content_docs >= 300, { timeoutMs: 30_000 });
  try {
    const r = await h.grep("NEEDLE_3", { budget_ms: 60_000 });
    assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
    assert.equal(r.complete, true);
    assert.ok(typeof r.scanned === "number" && typeof r.considered === "number", JSON.stringify(r).slice(0, 200));
    assert.equal(r.scanned, r.read);
    assert.equal(r.considered, r.candidates);
  } finally {
    h.cleanup();
  }
});

test("frecency: an opened file outranks an identical one that was never opened (#22)", async () => {
  const h = tieFixture();
  await h.start();
  try {
    const before = await h.search("needle-report", { limit: 5, boost: true });
    const paths = (before.hits ?? []).map((x) => x.path);
    assert.equal(paths.length, 2, JSON.stringify(before.hits));

    // Opening is what `tool_execution_end` sends for a read/edit/write.
    const opened = paths.find((p) => p.includes("/two/")) ?? paths[1];
    const other = paths.find((p) => p !== opened);
    const res = await h.request({ op: "open", path: opened });
    assert.equal(res.ok, true, JSON.stringify(res));

    const after = await h.search("needle-report", { limit: 5, boost: true });
    const ranked = (after.hits ?? []).map((x) => x.path);
    assert.equal(ranked[0], opened, `the opened file must rank first: ${JSON.stringify(after.hits)}`);
    const boosted = after.hits.find((x) => x.path === opened);
    const untouched = after.hits.find((x) => x.path === other);
    assert.ok((boosted.boost ?? 0) > 0, `the boost component must be reported: ${JSON.stringify(boosted)}`);
    // A fresh mtime counts as one more open (`frecency::boost`), so the
    // untouched file may carry a small boost too; the opened one must carry
    // strictly more, which is what the ordering rests on.
    assert.ok(
      (boosted.boost ?? 0) > (untouched.boost ?? 0),
      `opened ${boosted.boost} vs untouched ${untouched.boost}`,
    );
  } finally {
    h.cleanup();
  }
});

test("worktrees: two linked worktrees do not leak into each other (#22)", async () => {
  const base = path.join(tmpdir("us-wt-"), "repo");
  fs.mkdirSync(base, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: base, stdio: ["ignore", "pipe", "ignore"] }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFile(path.join(base, "shared-name.md"), "main checkout\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const wtA = path.join(path.dirname(base), "wtA");
  const wtB = path.join(path.dirname(base), "wtB");
  git("worktree", "add", "-q", "-b", "branch-a", wtA);
  git("worktree", "add", "-q", "-b", "branch-b", wtB);
  // The daemon indexes and reports real paths (`/tmp` is `/private/tmp`).
  const realA = fs.realpathSync(wtA);
  const realB = fs.realpathSync(wtB);
  writeFile(path.join(wtA, "shared-name.md"), "worktree A\n");
  writeFile(path.join(wtB, "shared-name.md"), "worktree B\n");
  writeFile(path.join(wtA, "only-a.txt"), "A\n");
  writeFile(path.join(wtB, "only-b.txt"), "B\n");

  const h = new EngineHarness({ root: fs.realpathSync(path.dirname(base)) });
  await h.start();
  try {
    const a = await h.search(`in:${wtA} shared-name`);
    const aPaths = (a.hits ?? []).map((x) => x.path);
    assert.ok(aPaths.length > 0, JSON.stringify(a).slice(0, 300));
    assert.ok(aPaths.some((p) => p.startsWith(realA)), JSON.stringify(aPaths));
    assert.ok(!aPaths.some((p) => p.startsWith(realB)), `worktree B leaked into A: ${JSON.stringify(aPaths)}`);
    assert.ok(!aPaths.some((p) => p === path.join(fs.realpathSync(base), "shared-name.md")), JSON.stringify(aPaths));

    // A worktree is a checkout of the same repository: its files are
    // distinct paths, and a scoped search must not see the sibling's.
    const b = await h.search(`in:${wtB} shared-name`);
    const bPaths = (b.hits ?? []).map((x) => x.path);
    assert.ok(bPaths.every((p) => p.startsWith(realB)), JSON.stringify(bPaths));
    assert.ok(bPaths.some((p) => p === path.join(realB, "shared-name.md")), JSON.stringify(bPaths));

    // And the same for a grep.
    await until(async () => (await h.status()).content_docs > 0, { timeoutMs: 30_000 });
    const g = await h.grep("worktree", { in: wtA });
    const gPaths = (g.files ?? []).map((f) => f.path);
    assert.ok(gPaths.every((p) => p.startsWith(realA)), JSON.stringify(gPaths));
    const gb = await h.grep("worktree", { in: wtB });
    assert.ok((gb.files ?? []).every((f) => f.path.startsWith(realB)), JSON.stringify(gb.files));
  } finally {
    h.cleanup();
    fs.rmSync(path.dirname(base), { recursive: true, force: true });
  }
});

test("the test's own numbers are recorded: scope size and machine load", async () => {
  // A guard against quoting a latency from a loaded machine (advisor note:
  // AC on, load < 1.5, nothing else building).
  const load = os.loadavg()[0];
  const h = new EngineHarness({ files: 100 });
  await h.start();
  try {
    const n = countFiles(h.root);
    assert.equal(n, 100);
    assert.ok(load > 0, "load average must be readable");
    process.stderr.write(`[engine-test] scope=${n} files load1m=${load.toFixed(2)}\n`);
  } finally {
    h.cleanup();
  }
});
