#!/usr/bin/env node
// bench/verification/wave4/verify-wave4.mjs — the wave-4 independent verifier.
//
// Re-measures the v1 and v2 judgment sets on its OWN isolated daemon over the
// frozen wave-1 corpus and re-derives the seven gates with the verifier's own
// scorer (bench/verification/wave4/metrics.mjs). The author's artifacts are
// never inputs: they are compared against only AFTER the independent numbers
// exist, as an agreement check.
//
//   PI_ULTRASEARCH_TEST=1 node bench/verification/wave4/verify-wave4.mjs \
//     [--corpus <dir>] [--dir <scratch>] [--out <raw.json>] [--label <name>]
//
// The daemon runs with ULTRASEARCH_DIR/HOME/SCAN_ROOT inside the scratch dir and
// the client is pointed at PI_ULTRASEARCH_SOCKET=<scratch>/ultrasearch.sock, so
// the live daemon and its index are never reached.

process.env.PI_ULTRASEARCH_TEST = "1";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreQuery, corpusReader, laneSatisfiable, norm } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
/** Absolute-or-relative -> path relative to the corpus root (the frozen
 *  runner's normaliser: the engine answers with absolute paths). */
const normRel = (p) => {
  const abs = path.isAbsolute(p) ? p : path.resolve(CORPUS, p);
  const rel = path.relative(CORPUS, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? abs : rel;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (x, n = 6) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(n)) : x);

const CORPUS = opt("corpus", path.join(os.homedir(), ".cache", "ultrasearch", "corpus", "wave1-0a16e50"));
const ENGINE = opt("engine", path.join(REPO, "engine", "target", "release", "ultrasearch"));
const LABEL = opt("label", `w4v-${process.pid}`);
const DIR = opt("dir", path.join(os.homedir(), ".cache", `us-w4verify-${LABEL}`));
const OUT = opt("out", path.join(HERE, "results", "verify-raw.json"));
const SOCKET = path.join(DIR, "ultrasearch.sock");
process.env.PI_ULTRASEARCH_SOCKET = SOCKET;

const V1_PATH = path.join(REPO, "bench", "judgments", "wave1-judgments.json");
const V2_PATH = path.join(REPO, "bench", "judgments", "wave1-judgments.v2.json");
const V1_SHA_RECORDED = "4af5fed8cc7ed23d561c5bfcd59a37bf3ec78edf27793df3702b934350185ea1";

if (!fs.existsSync(CORPUS)) throw new Error(`frozen corpus missing: ${CORPUS}`);
if (!fs.existsSync(ENGINE)) throw new Error(`engine binary missing: ${ENGINE} (cargo build --release --manifest-path engine/Cargo.toml)`);

// ---------------------------------------------------------------- corpus hash
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      out.push(...walk(p));
    } else out.push(p);
  }
  return out;
}
function treeHash(files) {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(path.relative(CORPUS, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}
const corpusFiles = walk(CORPUS).filter((f) => path.basename(f) !== ".corpus-meta.json");
const corpusTree = treeHash(corpusFiles);
const corpusMeta = load(path.join(CORPUS, ".corpus-meta.json"));

// ---------------------------------------------------------------- daemon
fs.mkdirSync(DIR, { recursive: true });
const logFd = fs.openSync(path.join(DIR, "verify-wave4.log"), "a");
const daemon = spawn(ENGINE, ["serve"], {
  env: { ...process.env, ULTRASEARCH_DIR: DIR, ULTRASEARCH_HOME: CORPUS, ULTRASEARCH_SCAN_ROOT: CORPUS, ULTRASEARCH_WARM: CORPUS },
  detached: true,
  stdio: ["ignore", logFd, logFd],
});
daemon.unref();
const stop = () => {
  try {
    process.kill(daemon.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  try {
    fs.rmSync(SOCKET, { force: true });
  } catch {
    /* ignore */
  }
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

// dynamic import AFTER PI_ULTRASEARCH_SOCKET is set
const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src", "client.ts")).href);
const { searchSemanticIntent } = await import(pathToFileURL(path.join(REPO, "src", "semantic.ts")).href);

const client = new UltraSearchClient({ timeoutMs: 20000 });

async function waitIndex(wantDocs, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const s = await client.status().catch(() => null);
    const docs = s?.content_docs ?? 0;
    const pending = s?.content_pending ?? 0;
    if (docs === last && docs >= wantDocs && pending === 0) {
      if (++stable >= 3) return s;
    } else stable = 0;
    last = docs;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`index did not stabilise at >= ${wantDocs} docs`);
}

const wantDocs = corpusFiles.filter((f) => path.basename(f) !== ".corpus-meta.json").length;
const status = await waitIndex(wantDocs);
const daemonProvenance = {
  pid: daemon.pid,
  socket: SOCKET,
  dir: DIR,
  corpus: CORPUS,
  engine: ENGINE,
  engine_sha256: sha256(ENGINE),
  entries: status.entries ?? null,
  content_docs: status.content_docs ?? null,
  content_pending: status.content_pending ?? null,
  isolated: SOCKET.startsWith(DIR + path.sep),
};

// ---------------------------------------------------------------- dispatch
// Mirrors the frozen wave-1/wave-3 runner's call shapes exactly (a different
// call shape would be a different measurement), but is written here so the
// verifier can read it.
async function runOne(q) {
  const limit = q.params?.limit ?? 10;
  const lane = q.lane;
  const rec = { id: q.id, lane, query: q.query, must_hit: q.must_hit === true, negative: q.negative === true, call: null, source: null, error: null, retrieved: [], control: null, ms: null };
  const t0 = performance.now();
  try {
    if (lane === "path" || lane === "ranking-frecency" || lane === "ranking-proximity" || lane === "ranking-boost-ab") {
      const opts = { in: CORPUS, limit, git: true };
      if (q.params?.near) opts.near = path.resolve(CORPUS, q.params.near);
      if (q.params?.boost === true) opts.boost = true;
      rec.call = `search(${JSON.stringify(q.query)}, in=<root>, limit=${limit}${opts.near ? ", near=" + q.params.near : ""}${opts.boost ? ", boost=true" : ""})`;
      const res = await client.search(q.query, opts);
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.hits ?? []).map((h) => normRel(h.path));
      if (lane === "ranking-boost-ab" && q.control_params) {
        const cres = await client.search(q.query, { ...opts, boost: q.control_params.boost === true });
        rec.control = { boost: q.control_params.boost === true, retrieved: (cres.hits ?? []).map((h) => normRel(h.path)) };
      }
    } else if (lane === "symbol" && q.params?.path_filter) {
      const fileScope = path.resolve(CORPUS, q.params.path_filter);
      rec.call = `grep(${JSON.stringify(q.query)}, in=${q.params.path_filter}, mode=symbol, limit=${limit})`;
      let used = "file_scope";
      let res;
      try {
        res = await client.grep(q.query, { in: fileScope, limit, mode: "symbol", budget_ms: 2500, context: 0, tag_symbols: true });
        if (!res.ok || !(res.files ?? []).length) throw new Error("file scope empty");
      } catch {
        used = "root_scope";
        res = await client.grep(q.query, { in: CORPUS, limit, mode: "symbol", budget_ms: 2500, context: 0, tag_symbols: true });
      }
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.files ?? []).map((f) => normRel(f.path));
      if (used === "root_scope") rec.retrieved = rec.retrieved.filter((p) => p.endsWith("src/client.ts"));
      rec.scope_used = used;
    } else if (q.params?.mode === "semantic") {
      const res = await searchSemanticIntent(client, q.query, { in: CORPUS, limit });
      rec.call = `searchSemanticIntent(${JSON.stringify(q.query)}, in=<root>, limit=${limit})`;
      rec.source = "semantic_intent";
      rec.retrieved = (res.files ?? []).map((f) => normRel(f.path));
    } else {
      const mode = q.params?.mode ?? "literal";
      rec.call = `grep(${JSON.stringify(q.query)}, in=<root>, mode=${mode}, limit=${limit})`;
      const res = await client.grep(q.query, { in: CORPUS, limit, mode, budget_ms: 2500, context: 0, tag_symbols: mode === "symbol" });
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.files ?? []).map((f) => normRel(f.path));
    }
  } catch (e) {
    rec.error = String(e?.message ?? e);
  }
  rec.ms = performance.now() - t0;
  return rec;
}

async function runSet(set, tag) {
  const rows = [];
  for (const q of set.queries) {
    const rec = await runOne(q);
    rec.score = scoreQuery(rec.retrieved, (q.expected ?? []).map((e) => ({ path: e.path, grade: e.grade })));
    rows.push(rec);
    process.stderr.write(`[w4-verify] ${tag} ${rec.id} ${rec.lane} n=${rec.retrieved.length}${rec.error ? " ERR " + rec.error.slice(0, 50) : ""}\n`);
  }
  return rows;
}

// ---------------------------------------------------------------- scorer cross-check
const { makeScoreQuery } = await import(pathToFileURL(path.join(REPO, "bench", "verification", "checks", "scoring.mjs")).href);
const shippedScore = makeScoreQuery(norm);
const METRIC_KEYS = ["recall_at_10", "ndcg_at_10", "mrr_at_10", "success_recall_at_10", "recall_at_limit"];

function crossCheckScorer(rows, set) {
  const byId = Object.fromEntries(set.queries.map((q) => [q.id, q]));
  let maxDelta = 0;
  const diffs = [];
  for (const r of rows) {
    const expected = (byId[r.id]?.expected ?? []).map((e) => ({ path: norm(e.path), grade: e.grade }));
    const theirs = shippedScore(r.retrieved, expected);
    for (const k of METRIC_KEYS) {
      const a = r.score[k];
      const b = theirs[k];
      if (a === null && b === null) continue;
      const d = Math.abs((a ?? NaN) - (b ?? NaN));
      if (Number.isFinite(d)) maxDelta = Math.max(maxDelta, d);
      if (!(d <= 1e-12)) diffs.push({ id: r.id, key: k, mine: a, shipped: b });
    }
  }
  return { max_abs_delta: maxDelta, disagreements: diffs };
}

// ---------------------------------------------------------------- gates
const THRESHOLDS = { recall10: 1.0, ndcg: 0.75, ndcgSemantic: 0.6, zeroResult: 0.0, falsePositive: 0.0, reformulation: 0.2, reformulationLane: 0.35 };
const mustHitRows = (rows) => rows.filter((r) => r.must_hit && !r.negative);
const negativeRows = (rows) => rows.filter((r) => r.negative === true);

function evaluateGates(rows) {
  const mh = mustHitRows(rows);
  const neg = negativeRows(rows);
  const recalls = mh.map((r) => r.score.recall_at_10);
  const ndcgs = mh.map((r) => r.score.ndcg_at_10);
  const sem = mh.filter((r) => r.lane === "semantic");
  const reform = mh.map((r) => (r.score.reformulation_signal ? 1 : 0));
  const lanes = [...new Set(mh.map((r) => r.lane))];
  const laneStats = Object.fromEntries(
    lanes.map((l) => {
      const rs = mh.filter((r) => r.lane === l);
      const v = rs.map((r) => (r.score.reformulation_signal ? 1 : 0));
      return [l, { n: rs.length, observed: round(mean(v)), pass: mean(v) <= THRESHOLDS.reformulationLane, failing: rs.filter((r) => r.score.reformulation_signal).map((r) => r.id) }];
    }),
  );
  const meanRecall = mean(recalls);
  const meanNdcg = mean(ndcgs);
  const meanSem = mean(sem.map((r) => r.score.ndcg_at_10));
  const zeroRate = mean(mh.map((r) => (r.score.zero_result ? 1 : 0)));
  const fpRate = mean(neg.map((r) => (r.retrieved.length > 0 ? 1 : 0)));
  const meanReform = mean(reform);
  const g = {
    1: { id: "g1_recall10", claim: "recall@10 == 1.00 on all must-hit rows", value: round(meanRecall), threshold: "== 1.00", pass: recalls.length > 0 && recalls.every((v) => v === 1), n: recalls.length, failing_rows: mh.filter((r) => r.score.recall_at_10 !== 1).map((r) => r.id) },
    2: { id: "g2_ndcg10_overall", claim: "nDCG@10 >= 0.75 overall", value: round(meanNdcg), threshold: ">= 0.75", pass: meanNdcg !== null && meanNdcg >= THRESHOLDS.ndcg, n: ndcgs.length },
    3: { id: "g3_ndcg10_semantic", claim: "nDCG@10 >= 0.60 semantic lane", value: round(meanSem), threshold: ">= 0.60", pass: meanSem !== null && meanSem >= THRESHOLDS.ndcgSemantic, n: sem.length, rows: sem.map((r) => `${r.id}:${round(r.score.ndcg_at_10)}`) },
    4: { id: "g4_zero_result_rate", claim: "zero-result rate == 0.00 on must-hit rows", value: round(zeroRate), threshold: "== 0.00", pass: zeroRate === 0, n: mh.length, failing_rows: mh.filter((r) => r.score.zero_result).map((r) => r.id) },
    5: { id: "g5_false_positive_rate", claim: "false-positive rate == 0.00 on negative rows", value: round(fpRate), threshold: "== 0.00", pass: fpRate === 0, n: neg.length, failing_rows: neg.filter((r) => r.retrieved.length > 0).map((r) => r.id) },
    6: { id: "g6_reformulation_overall", claim: "reformulation_signal <= 0.20 overall", value: round(meanReform), threshold: "<= 0.20", pass: meanReform !== null && meanReform <= THRESHOLDS.reformulation, n: reform.length, failing_rows: mh.filter((r) => r.score.reformulation_signal).map((r) => r.id) },
    7: { id: "g7_reformulation_per_lane", claim: "reformulation_signal <= 0.35 per lane", value: Object.fromEntries(Object.entries(laneStats).map(([l, s]) => [l, s.observed])), threshold: "<= 0.35 per lane", pass: Object.values(laneStats).every((s) => s.pass), n: mh.length, lanes: laneStats },
  };
  return { gates: g, all_green: Object.values(g).every((x) => x.pass === true), green_count: Object.values(g).filter((x) => x.pass === true).length };
}

// ---------------------------------------------------------------- run all arms
const v1Set = load(V1_PATH);
const v2Set = load(V2_PATH);

const v1Rows = await runSet(v1Set, "v1a");
const v2Rows = await runSet(v2Set, "v2");
const v1RowsB = await runSet(v1Set, "v1b"); // replay for retrieval determinism

const gV1 = evaluateGates(v1Rows);
const gV1b = evaluateGates(v1RowsB);
const gV2 = evaluateGates(v2Rows);

// ---------------------------------------------------------------- agreement with the author artifacts
function compareArtifact(mine, authorPath) {
  if (!fs.existsSync(authorPath)) return { path: authorPath, exists: false };
  const author = load(authorPath);
  const byId = Object.fromEntries(author.rows.map((r) => [r.id, r]));
  const diffs = [];
  let compared = 0;
  for (const r of mine) {
    const a = byId[r.id];
    if (!a) continue;
    compared += 1;
    if (JSON.stringify(r.retrieved) !== JSON.stringify(a.retrieved)) diffs.push({ id: r.id, kind: "retrieved", mine: r.retrieved, author: a.retrieved });
    if (r.call !== a.call) diffs.push({ id: r.id, kind: "call", mine: r.call, author: a.call });
    if ((r.source ?? null) !== (a.source ?? null)) diffs.push({ id: r.id, kind: "source", mine: r.source, author: a.source });
  }
  return { path: path.relative(REPO, authorPath), exists: true, sha256: sha256(authorPath), compared, diffs: diffs.slice(0, 10), diff_count: diffs.length, identical: diffs.length === 0 };
}

const agreement = {
  v1: compareArtifact(v1Rows, path.join(REPO, "bench", "wave4", "results", "v1.json")),
  v2: compareArtifact(v2Rows, path.join(REPO, "bench", "wave4", "results", "v2.json")),
  v1_replay: compareArtifact(v1RowsB, path.join(REPO, "bench", "wave4", "results", "v1.json")),
};

// ---------------------------------------------------------------- amendment neutrality
const v2ById = Object.fromEntries(v2Rows.map((r) => [r.id, r]));
const shared = v1Rows.filter((r) => v2ById[r.id]);
const neutrality = {
  shared_rows: shared.length,
  retrieved_identical: shared.every((r) => JSON.stringify(r.retrieved) === JSON.stringify(v2ById[r.id].retrieved)),
  calls_identical: shared.every((r) => r.call === v2ById[r.id].call),
  sources_identical: shared.every((r) => (r.source ?? null) === (v2ById[r.id].source ?? null)),
  changed_rows: shared.filter((r) => JSON.stringify(r.retrieved) !== JSON.stringify(v2ById[r.id].retrieved)).map((r) => r.id),
  v1_replay_identical: v1Rows.every((r) => JSON.stringify(r.retrieved) === JSON.stringify(v1RowsB.find((b) => b.id === r.id).retrieved)),
  controls_identical: v1Rows.every((r) => JSON.stringify(r.control) === JSON.stringify(v1RowsB.find((b) => b.id === r.id).control)),
};
{
  const v1ById = Object.fromEntries(v1Set.queries.map((q) => [q.id, q]));
  const v2Q = Object.fromEntries(v2Set.queries.map((q) => [q.id, q]));
  const expectedIdentical = shared.filter((r) => JSON.stringify(v1ById[r.id]?.expected ?? []) === JSON.stringify(v2Q[r.id]?.expected ?? []));
  const unchanged = expectedIdentical.filter((r) => r.must_hit && !r.negative && v2ById[r.id].must_hit && !v2ById[r.id].negative);
  const m = (rows, id, key) => rows.find((r) => r.id === id)?.score?.[key] ?? null;
  const deltas = [];
  for (const r of unchanged) {
    for (const key of ["recall_at_10", "ndcg_at_10"]) {
      const a = m(v1Rows, r.id, key);
      const b = m(v2Rows, r.id, key);
      if (a !== null && b !== null) deltas.push(Math.abs(b - a));
    }
    deltas.push(Math.abs((v2ById[r.id].score.reformulation_signal ? 1 : 0) - (r.score.reformulation_signal ? 1 : 0)));
  }
  // The expected-identical set also contains the negative rows (empty expected in
  // both arms), where every metric is trivially unchanged; both counts are kept so
  // the claim's `17 unchanged rows` is directly checkable.
  const negDeltas = expectedIdentical
    .filter((r) => r.negative === true)
    .map((r) => Math.abs(Number(v2ById[r.id].score.zero_result) - Number(r.score.zero_result)));
  neutrality.unchanged_rows = {
    n: unchanged.length,
    n_expected_identical_all_rows: expectedIdentical.length,
    delta_max_abs: deltas.length ? Math.max(...deltas) : null,
    all_exactly_zero: deltas.every((d) => d === 0) && negDeltas.every((d) => d === 0),
    ids: unchanged.map((r) => r.id),
    negative_rows: expectedIdentical.filter((r) => r.negative === true).map((r) => r.id),
  };
}

// ---------------------------------------------------------------- strict alternative
let strictAlternative;
{
  const removed = (v2Set.removed ?? []).filter((r) => r.class === "content-mention-not-top10");
  // The companion that re-homes the source row (`rehomed_from.id`), which is
  // where score-gates.mjs restores a window-removed expectation.
  const companionsOf = new Map();
  for (const q of v2Set.queries) {
    if (!q.rehomed_from?.id) continue;
    companionsOf.set(q.rehomed_from.id, [...(companionsOf.get(q.rehomed_from.id) ?? []), q.id]);
  }
  const restored = [];
  const strictRows = v2Rows.map((r) => {
    const q = v2Set.queries.find((x) => x.id === r.id);
    const add = [];
    for (const rm of removed) {
      if ((companionsOf.get(rm.id) ?? []).includes(r.id)) add.push({ path: rm.path, grade: rm.grade, from_removal: `${rm.id}/${rm.path}` });
    }
    if (!add.length) return r;
    const qExpected = (q.expected ?? []).map((e) => ({ path: e.path, grade: e.grade }));
    const strict = scoreQuery(r.retrieved, [...qExpected, ...add]);
    restored.push({ row: r.id, restored: add.map((a) => `${a.path}:${a.grade}`), recall_at_10: round(strict.recall_at_10), missing: [...qExpected, ...add].filter((e) => e.grade >= 1 && !strict.top10.some((t) => t.path === norm(e.path))).map((e) => `${e.path}:${e.grade}`) });
    return { ...r, score: strict };
  });
  const mh = mustHitRows(strictRows);
  const recall = mean(mh.map((r) => r.score.recall_at_10));
  strictAlternative = { restored, recall10: round(recall), gate1_passes: mh.every((r) => r.score.recall_at_10 === 1), n: mh.length };
}

// ---------------------------------------------------------------- v1 audited recall (my own classification)
const corpus = corpusReader(CORPUS);
const v1Missing = [];
for (const r of mustHitRows(v1Rows)) {
  const q = v1Set.queries.find((x) => x.id === r.id);
  for (const e of (q.expected ?? []).filter((x) => x.grade >= 1)) {
    const inTop = r.score.top10.some((t) => t.path === norm(e.path));
    if (inTop) continue;
    const sat = laneSatisfiable(q, e.path, corpus.text(e.path), corpus.exists(e.path));
    v1Missing.push({ id: r.id, lane: r.lane, path: e.path, grade: e.grade, satisfiable: sat.ok, kind: sat.kind, why: sat.why });
  }
}
const v1Audited = {
  missing_total: v1Missing.length,
  missing_satisfiable: v1Missing.filter((m) => m.satisfiable).length,
  missing_unsatisfiable: v1Missing.filter((m) => !m.satisfiable).length,
  rows_affected: new Set(v1Missing.map((m) => m.id)).size,
  reported_recall_at_10: round(mean(mustHitRows(v1Rows).map((r) => r.score.recall_at_10))),
  audited_recall_at_10: round(
    mean(
      mustHitRows(v1Rows).map((r) => {
        const q = v1Set.queries.find((x) => x.id === r.id);
        const reachable = (q.expected ?? []).filter((e) => e.grade >= 1 && laneSatisfiable(q, e.path, corpus.text(e.path), corpus.exists(e.path)).ok);
        if (!reachable.length) return null;
        const hit = reachable.filter((e) => r.score.top10.some((t) => t.path === norm(e.path))).length;
        return hit / reachable.length;
      }).filter((v) => v !== null),
    ),
  ),
  expectations: v1Missing,
};
{
  const authorAuditPath = path.join(REPO, "bench", "wave4", "results", "v1-expectation-audit.json");
  if (fs.existsSync(authorAuditPath)) {
    const authorAudit = load(authorAuditPath);
    const authorMisses = [];
    for (const r of authorAudit.rows) for (const m of r.misses ?? []) authorMisses.push({ key: `${r.id}|${m.expected}`, class: m.class });
    const mine = v1Missing.filter((m) => !m.satisfiable).map((m) => ({ key: `${m.id}|${m.path}`, kind: m.kind }));
    v1Audited.author_audit = {
      path: path.relative(REPO, authorAuditPath),
      sha256: sha256(authorAuditPath),
      author_misses: authorMisses.length,
      mine_unsatisfiable: mine.length,
      same_expectation_set: JSON.stringify(authorMisses.map((m) => m.key).sort()) === JSON.stringify(mine.map((m) => m.key).sort()),
      author_classes: authorAudit.summary.by_class,
      mine_kinds: mine.reduce((a, m) => ((a[m.kind] = (a[m.kind] ?? 0) + 1), a), {}),
    };
  }
}

// ---------------------------------------------------------------- K3 delegated judgement
const k3 = {};
{
  const q = "client";
  const g50 = await client.grep(q, { in: CORPUS, limit: 50, mode: "literal", budget_ms: 2500, context: 0 });
  const g10 = await client.grep(q, { in: CORPUS, limit: 10, mode: "literal", budget_ms: 2500, context: 0 });
  const sem = await searchSemanticIntent(client, q, { in: CORPUS, limit: 50 });
  const list50 = (g50.files ?? []).map((f) => normRel(f.path));
  const list10 = (g10.files ?? []).map((f) => normRel(f.path));
  const semList = (sem.files ?? []).map((f) => normRel(f.path));
  const readme = corpus.text("README.md") ?? "";
  k3.grep_literal = {
    match_count_limit50: list50.length,
    readme_rank_limit50: list50.indexOf("README.md") + 1 || null,
    readme_in_top10: list10.includes("README.md"),
    readme_rank_limit10: list10.indexOf("README.md") + 1 || null,
    source_limit50: g50.source ?? null,
    order_limit50: list50,
  };
  k3.semantic = { match_count_limit50: semList.length, readme_rank_limit50: semList.indexOf("README.md") + 1 || null, order_limit50: semList };
  k3.readme_occurrences = {
    case_sensitive: readme.includes(q) ? readme.split(q).length - 1 : 0,
    case_insensitive: readme.toLowerCase().split(q.toLowerCase()).length - 1,
  };
  const q3c = v2Set.queries.find((x) => x.id === "K3c");
  const r3c = v2Rows.find((x) => x.id === "K3c");
  const q3 = v2Set.queries.find((x) => x.id === "K3");
  const r3 = v2Rows.find((x) => x.id === "K3");
  k3.k3_row = { lane: q3.lane, query: q3.query, expected: q3.expected, retrieved: r3.retrieved, top1_grade: r3.score.top1_grade };
  k3.k3c_row = { lane: q3c.lane, query: q3c.query, expected: q3c.expected, retrieved: r3c.retrieved, readme_rank: r3c.retrieved.indexOf("README.md") + 1 || null };
  k3.companion_probe_claim = { rank_limit10_claimed: 18, rank_limit50_claimed: 18, match_count_claimed: 23, semantic_claimed: "12 of 15" };
  k3.readme_is_grade1_adjacent = { v1_k3_expected_readme_grade: 1, k3c_expected: q3c.expected };
}

// ---------------------------------------------------------------- engine provenance
const gitTree = (ref, dir) => execFileSync("git", ["-C", REPO, "ls-tree", "-r", ref, "--", dir], { encoding: "utf8" });
const engineProvenance = {
  working_tree_engine_sha256: sha256(ENGINE),
  engine_source_tree_sha256_at_head: crypto.createHash("sha256").update(gitTree("HEAD", "engine/")).digest("hex"),
  engine_source_tree_sha256_pre_wave4: crypto.createHash("sha256").update(gitTree("4b625b9", "engine/")).digest("hex"),
  engine_source_unchanged: gitTree("HEAD", "engine/") === gitTree("4b625b9", "engine/"),
  src_unchanged: execFileSync("git", ["-C", REPO, "diff", "--stat", "4b625b9", "HEAD", "--", "src/", "index.ts"], { encoding: "utf8" }).trim() === "",
  wave4_engine_src_diff: execFileSync("git", ["-C", REPO, "diff", "--stat", "4b625b9", "HEAD", "--", "engine/", "src/", "index.ts"], { encoding: "utf8" }).trim(),
  author_artifact_engine_sha256: load(path.join(REPO, "bench", "wave4", "results", "v2.json")).meta?.engine?.sha256 ?? null,
  note: "the author artifact records the engine built in the wave-4 checkout; this verifier rebuilt the same engine source in its own worktree, so the binary hash differs (build paths) while the source tree is identical — behavioural equivalence is checked by the retrieved-list agreement below",
};

const raw = {
  suite: "wave4-independent-verification-raw",
  generated_at: new Date().toISOString(),
  label: LABEL,
  head_commit: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  head_ref: execFileSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
  corpus: { root: CORPUS, tree_sha256: corpusTree, meta_tree_sha256: corpusMeta.tree_sha256, files: wantDocs, match: corpusTree === corpusMeta.tree_sha256 },
  daemon: daemonProvenance,
  gates: { v1: gV1, v1_replay: gV1b, v2: gV2 },
  scorer_crosscheck: { v1: crossCheckScorer(v1Rows, v1Set), v2: crossCheckScorer(v2Rows, v2Set) },
  author_agreement: agreement,
  amendment_neutrality: neutrality,
  strict_alternative: strictAlternative,
  v1_audited: v1Audited,
  k3: k3,
  engine_provenance: engineProvenance,
  evidence_hashes: {
    v1_judgments: sha256(V1_PATH),
    v1_judgments_matches_recorded: sha256(V1_PATH) === V1_SHA_RECORDED,
    v2_judgments: sha256(V2_PATH),
    gates_v2: fs.existsSync(path.join(REPO, "bench", "wave4", "gates-v2.json")) ? sha256(path.join(REPO, "bench", "wave4", "gates-v2.json")) : null,
    mapping: sha256(path.join(REPO, "docs", "wave4", "wave1-v2-mapping.md")),
    validator: sha256(path.join(REPO, "bench", "wave4", "validate-judgments.mjs")),
  },
  rows: { v1: v1Rows, v2: v2Rows, v1_replay: v1RowsB },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(raw, null, 2) + "\n");
stop();
process.off("exit", stop);

console.log(
  JSON.stringify(
    {
      out: path.relative(REPO, OUT),
      corpus_match: raw.corpus.match,
      v1: { gates: Object.fromEntries(Object.entries(gV1.gates).map(([k, v]) => [k, { value: v.value, pass: v.pass }])), green: gV1.green_count },
      v2: { gates: Object.fromEntries(Object.entries(gV2.gates).map(([k, v]) => [k, { value: v.value, pass: v.pass }])), green: gV2.green_count },
      neutrality,
      strict_alternative: { recall10: strictAlternative.recall10, gate1_passes: strictAlternative.gate1_passes, restored: strictAlternative.restored },
      v1_audited: { missing_total: v1Audited.missing_total, unreachable: v1Audited.missing_unsatisfiable, reported: v1Audited.reported_recall_at_10, audited: v1Audited.audited_recall_at_10 },
      author_agreement: { v1: agreement.v1.identical, v2: agreement.v2.identical, v1_replay: agreement.v1_replay.identical },
      scorer_crosscheck: { v1: raw.scorer_crosscheck.v1.max_abs_delta, v2: raw.scorer_crosscheck.v2.max_abs_delta },
      k3: { grep_rank50: k3.grep_literal.readme_rank_limit50, grep_count: k3.grep_literal.match_count_limit50, sem_rank: k3.semantic.readme_rank_limit50, sem_count: k3.semantic.match_count_limit50, occ: k3.readme_occurrences },
    },
    null,
    2,
  ),
);
