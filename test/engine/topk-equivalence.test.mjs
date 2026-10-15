// Top-k equivalence and the #35 early-exit contract, against a real daemon.
//
// The promise this file freezes:
//   * With no bound asked for, nothing is added to the payload and the
//     answer is the exact top-k of a full scan.
//   * `early_exit` / `low_run` never change the answer when their threshold
//     is out of reach (small corpora), and a fired run is *reported*
//     (`complete:false`, `stopped_by:"low_run"`) with only genuine matches.
//   * `budget_ms` with time to spare is byte-identical to no budget.
//
// The query shape uses `path:` on purpose: it routes around `ranked` and
// `spread` (the bound-driven strategies) into the entry scan, which is where
// the low-score-run counter lives.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineHarness, makeTree, tmpdir } from "./harness.mjs";

const FILE_COUNT = 240;
const SCOPE_DIR = "d03";

/** Every fixture file under `root/<SCOPE_DIR>`, sorted. */
function expectedPaths(root) {
  // The engine answers with realpaths (/var -> /private/var on macOS).
  const dir = path.join(fs.realpathSync(root), SCOPE_DIR);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const key = (h) => `${h.path}|${h.score}`;

test("engine top-k equivalence and #35 early-exit contract", async (t) => {
  const root = makeTree(path.join(tmpdir("us-topk-"), "tree"), FILE_COUNT, "deep");
  const h = new EngineHarness({ root });
  await h.start();
  t.after(() => h.cleanup());

  const inScope = path.join(root, SCOPE_DIR);
  const query = "path:file file"; // one token + a path filter: the entry scan
  const LIMIT = 20;
  const plain = await h.search(query, { in: inScope, limit: LIMIT });
  assert.equal(plain.ok, true);
  assert.equal(plain.hits.length, LIMIT);
  assert.equal(plain.complete, undefined, "no bound asked for: no partial-answer fields");
  assert.equal(plain.scanned, undefined);
  assert.equal(plain.stopped_by, undefined);

  const all = await h.search(query, { in: inScope, limit: 1000 });
  const expected = expectedPaths(root);
  assert.equal(all.hits.length, expected.length, "limit 1000 must return every match");
  assert.deepEqual(all.hits.map((x) => x.path).sort(), expected, "the match set is the fixture set");

  await t.test("an ample budget is byte-identical to no budget", async () => {
    const got = await h.search(query, { in: inScope, limit: LIMIT, budget_ms: 5000 });
    assert.equal(got.complete, true);
    assert.equal(got.stopped_by, undefined);
    assert.deepEqual(got.hits.map(key), plain.hits.map(key));
  });

  await t.test("early_exit with an out-of-reach run changes nothing", async () => {
    const got = await h.search(query, { in: inScope, limit: LIMIT, early_exit: true });
    // LOW_RUN_DEFAULT (1<<20) is far above the ~240 entries here.
    assert.equal(got.complete, true);
    assert.equal(got.stopped_by, undefined);
    assert.deepEqual(got.hits.map(key), plain.hits.map(key));
  });

  await t.test("a low-score run is reported and returns only genuine matches", async () => {
    const got = await h.search(query, { in: inScope, limit: LIMIT, low_run: 4 });
    assert.equal(got.ok, true);
    assert.equal(got.complete, false, "a fired run must be marked partial");
    assert.equal(got.stopped_by, "low_run");
    assert.ok(got.considered > 0 && got.scanned > 0, `counters must be reported: ${got.scanned}/${got.considered}`);
    assert.ok(got.hits.length <= LIMIT);
    const genuine = new Set(expected);
    for (const hit of got.hits) assert.ok(genuine.has(hit.path), `a partial answer must not invent hits: ${hit.path}`);
  });

  await t.test("a modest run that is out of reach is exact", async () => {
    // `low_run` above the whole scope's entry count: cannot fire.
    const got = await h.search(query, { in: inScope, limit: LIMIT, low_run: 10000 });
    assert.equal(got.complete, true);
    assert.deepEqual(got.hits.map(key), plain.hits.map(key));
  });

  await t.test("the candidate cap is reported as `candidates`", async () => {
    const got = await h.search(query, { in: inScope, limit: LIMIT, candidates: 2 });
    assert.equal(got.complete, false);
    assert.equal(got.stopped_by, "candidates");
    assert.ok(got.considered >= 2);
  });

  await t.test("top-k is a prefix of a wider top-k", async () => {
    const wide = await h.search(query, { in: inScope, limit: 120 });
    assert.deepEqual(wide.hits.slice(0, LIMIT).map(key), plain.hits.map(key), "limit-k must be the head of limit-2k");
  });

  await t.test("repeats are stable (no run-to-run ranking drift)", async () => {
    for (let i = 0; i < 5; i++) {
      const again = await h.search(query, { in: inScope, limit: LIMIT });
      assert.deepEqual(again.hits.map(key), plain.hits.map(key));
    }
  });
});

test("the #35 wire options are reachable through the client API", async (t) => {
  const { UltraSearchClient } = await import("../../src/client.ts");
  const root = makeTree(path.join(tmpdir("us-topk-client-"), "tree"), 120, "deep");
  const h = new EngineHarness({ root });
  await h.start();
  t.after(() => h.cleanup());
  const client = new UltraSearchClient({ socketPath: h.socket, autoSpawnDaemon: false, lanes: 1 });
  t.after(() => client.close());

  const plain = await client.search("path:file file", { in: path.join(root, "d02"), limit: 10 });
  assert.equal(plain.ok, true);
  assert.equal(plain.hits.length, 10);

  // Out of reach: identical to the plain answer.
  const early = await client.search("path:file file", { in: path.join(root, "d02"), limit: 10, early_exit: true });
  assert.deepEqual(early.hits.map(key), plain.hits.map(key));

  // A tiny explicit run fires and is reported by the engine.
  const partial = await client.search("path:file file", { in: path.join(root, "d02"), limit: 10, low_run: 4 });
  assert.equal(partial.complete, false);
  assert.equal(partial.stopped_by, "low_run");
});
