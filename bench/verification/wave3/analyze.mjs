#!/usr/bin/env node
// bench/verification/wave3/analyze.mjs — the wave-3 adjudication matrix.
//
// Re-scores every artifact from raw `retrieved` arrays with the verifier's own
// scorer (lib-verify.mjs), re-runs every statistic, and compares both the
// committed arms and the verifier's own isolated-daemon re-measurements.
//
//   node bench/verification/wave3/analyze.mjs
//
// Output: bench/verification/wave3/matrix.json (raw evidence for the summary).

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  sha256, load, mean, pct, scoreQuery, evaluateBars, laneAgg,
  pairedMetric, pairedRate, bca63, excludesZero,
} from "./lib-verify.mjs";

const REPO = "/Users/batra/ultrasearch-verify";
const R = (p) => path.join(REPO, p);
const OUT = R("bench/verification/wave3/matrix.json");
const CORPUS1 = path.join(process.env.HOME, ".cache", "ultrasearch", "corpus", "wave1-0a16e50");
const CORPUS2 = path.join(process.env.HOME, ".cache", "pi-ultrasearch-bench", "corpus-8d1419d-clean");
const J1 = load(R("bench/judgments/wave1-judgments.json"));
const J2 = load(R("bench/judgments/wave2-judgments.json"));

const normRel = (p) => {
  let s = String(p).replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  return s;
};
const exists = (root, rel) => fs.existsSync(path.join(root, normRel(rel)));
const readFile = (root, rel) => (exists(root, rel) ? fs.readFileSync(path.join(root, normRel(rel)), "utf8") : null);

/** Re-score every row of an artifact with the verifier's own scorer. */
function rescore(artifact, judgments, root) {
  const qById = Object.fromEntries(judgments.queries.map((q) => [q.id, q]));
  const rows = artifact.rows.map((r) => {
    const q = qById[r.id];
    const expected = (q?.expected ?? []).map((e) => ({ path: normRel(e.path), grade: e.grade }));
    const sc = scoreQuery(r.retrieved.map(normRel), expected);
    return {
      id: r.id, lane: r.lane, query: r.query, params: r.params ?? {},
      must_hit: r.must_hit === true, negative: r.negative === true,
      excluded_from_tier_l: r.excluded_from_tier_l === true || (q?.requires_feature ?? null) !== null || q?.known_fail === true,
      retrieved: r.retrieved.map(normRel), ms: r.ms ?? null,
      stored: r.score ?? null, score: sc,
      extra: r.extra ?? null, control: r.control ?? null, assertions: r.assertions ?? null,
    };
  });
  return { rows, qById, root };
}

const artifactMeta = (p) => {
  const a = load(p);
  return {
    path: path.relative(REPO, p), sha256: sha256(p),
    label: a.meta?.label ?? null, status: a.meta?.status ?? null,
    gate: a.meta?.gate ? { status: a.meta.gate.status, gate_pass: a.meta.gate.gate_pass ?? null, load1: a.meta.gate.load1 ?? null } : null,
    head_commit: a.meta?.head_commit ?? null,
    engine: a.meta?.engine?.sha256 ?? a.meta?.engine_sha256 ?? null,
    corpus_tree: a.meta?.corpus?.tree_sha256 ?? null,
    judgments_sha: a.meta?.judgments?.sha256 ?? null,
    daemon: a.meta?.daemon_provenance ?? a.meta?.daemon ?? null,
    rows: a.rows?.length ?? 0,
  };
};

const matrix = {
  meta: {
    suite: "wave3-independent-verification",
    verifier: "independent (adversarial) verification pass, wave 3",
    generated_at: new Date().toISOString(),
    head: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    scorer: "bench/verification/wave3/lib-verify.mjs (verifier re-implementation)",
    statistics: "BCa 10000 resamples, splitmix64 seed 20261015; percentile bootstrap and exact paired sign test reported alongside",
    corpora: { wave1: CORPUS1, wave2: CORPUS2 },
  },
  block47: {},
  block48: {},
  blockRegressions: {},
  blockCost: {},
  blockIdentity: {},
  blockAudit: {},
};

// =====================================================================
// BLOCK 47 — the scorer clamp
// =====================================================================
{
  const arms = [
    ["bench/verification/after/wave2-baseline.json", "verifier frozen baseline (old scorer)"],
    ["bench/verification/after/wave2-baseline-prewave2engine.json", "pre-wave-2 engine"],
    ["bench/verification/after/wave2-livewave1daemon.json", "installed wave-1 daemon"],
    ["bench/wave3/results/wave2-score-fixed.json", "author fixed re-score"],
    ["bench/verification/wave3/rerun/wave2-main.json", "verifier re-run, main engine"],
    ["bench/verification/wave3/rerun/wave2-base.json", "verifier re-run, pre-#48 base engine"],
  ];
  const perArm = [];
  for (const [rel, note] of arms) {
    const p = R(rel);
    if (!fs.existsSync(p)) { perArm.push({ artifact: rel, note, missing: true }); continue; }
    const a = load(p);
    const rs02 = a.rows.find((r) => r.id === "RS02");
    const eff = rescore(a, J2, CORPUS2);
    const row = eff.rows.find((r) => r.id === "RS02");
    const expected = new Set((J2.queries.find((q) => q.id === "RS02").expected ?? []).map((e) => normRel(e.path)));
    const got = new Set(row.retrieved);
    perArm.push({
      artifact: rel, note, meta: artifactMeta(p),
      rs02: {
        retrieved_n: row.retrieved.length,
        expected_n: expected.size,
        intersection_n: [...expected].filter((p0) => got.has(p0)).length,
        fixed: row.score.recall_at_limit,
        clamped: row.score.recall_at_limit_clamped,
        stored_recall_at_limit: rs02?.score?.recall_at_limit ?? rs02?.score?.recall_at_limit_frozen_kmax10 ?? null,
        stored_clamped_spelling: rs02?.score?.recall_at_limit_kmax_clamped ?? null,
      },
    });
  }

  // Full 18-bar re-evaluation of the frozen wave-2 set, old vs fixed formula.
  const frozen = load(R("bench/verification/after/wave2-baseline.json"));
  const eff = rescore(frozen, J2, CORPUS2);
  // `evaluateBars` reads `score.recall_at_limit`; run it once with the fixed
  // rows and once with the clamped value substituted.
  const barsFixed = evaluateBars(eff.rows);
  const clampedRows = eff.rows.map((r) => ({ ...r, score: { ...r.score, recall_at_limit: r.score.recall_at_limit_clamped } }));
  const barsOld = evaluateBars(clampedRows);
  const failList = (bars) => bars.filter((b) => b.pass === false).map((b) => ({ lane: b.lane, bar: b.bar, expected: b.expected, observed: b.observed }));
  const sum = (bars) => ({ total: bars.length, pass: bars.filter((b) => b.pass === true).length, fail: bars.filter((b) => b.pass === false).length });

  // Cross-check the author's fixed re-score of the same frozen rows.
  const authorFixed = load(R("bench/wave3/results/wave2-score-fixed.json"));
  const authorFixedBars = authorFixed.bars ? (() => {
    const flat = [];
    for (const [lane, arr] of Object.entries(authorFixed.bars)) for (const b of arr) flat.push({ lane, ...b });
    return sum(flat);
  })() : null;
  const myVsAuthor = ["RS01", "RS02", "RS09", "SE01", "SE09", "SY01", "K3"].map((id) => {
    const mine = eff.rows.find((r) => r.id === id);
    const theirs = authorFixed.rows.find((r) => r.id === id);
    return {
      id,
      retrieved_identical: JSON.stringify(mine?.retrieved) === JSON.stringify(theirs?.retrieved),
      fixed_mine: mine?.score.recall_at_limit ?? null,
      fixed_author: theirs?.score?.recall_at_limit ?? null,
      clamped_mine: mine?.score.recall_at_limit_clamped ?? null,
      clamped_author: theirs?.score?.recall_at_limit_kmax_clamped ?? null,
    };
  });

  matrix.block47 = {
    claim: "Tier-L glob_set_completeness 0.714 was a scorer clamp: recall_at_limit was computed against a top sliced to kMax=10",
    per_arm: perArm,
    frozen_set: {
      source: "bench/verification/after/wave2-baseline.json (gate final, load1 1.34)",
      rows: eff.rows.length,
      old_formula: { ...sum(barsOld), failing: failList(barsOld) },
      fixed_formula: { ...sum(barsFixed), failing: failList(barsFixed) },
      rs02_old: eff.rows.find((r) => r.id === "RS02").score.recall_at_limit_clamped,
      rs02_fixed: eff.rows.find((r) => r.id === "RS02").score.recall_at_limit,
    },
    author_fixed_bars: authorFixedBars,
    cross_check_row_sample: myVsAuthor,
    all_arms_rs02_14: perArm.filter((a) => !a.missing).every((a) => a.rs02.retrieved_n === 14 && a.rs02.fixed === 1),
    verdict_note: "old formula cap = min(kMax,|retrieved|)/|expected|; fixed formula counts the whole returned list",
  };
}

// =====================================================================
// BLOCK 48 — grep-page ranking, committed arms and my re-run
// =====================================================================
{
  const baseC = rescore(load(R("bench/wave3/results/final-base.json")), J1, CORPUS1);
  const rankC = rescore(load(R("bench/wave3/results/final-rank.json")), J1, CORPUS1);
  const baseM = rescore(load(R("bench/verification/wave3/rerun/measure-base.json")), J1, CORPUS1);
  const mainM = rescore(load(R("bench/verification/wave3/rerun/measure-main.json")), J1, CORPUS1);
  const committedCompare = load(R("bench/wave3/results/final-compare.json"));

  const METRICS = [
    ["recall_at_10", "recall@10"],
    ["recall_at_3", "recall@3"],
    ["success_recall_at_10", "success_recall@10 (grade>=2)"],
    ["ndcg_at_10", "nDCG@10"],
    ["recall_at_limit", "recall@limit (whole set)"],
  ];
  const overall = (b, a) => ({
    ...Object.fromEntries(METRICS.map(([k, label]) => [k, pairedMetric(b.rows, a.rows, k, label)])),
    reformulation_signal: pairedRate(b.rows, a.rows, "reformulation_signal", "reformulation (top-1 grade < 2)"),
  });
  const byLane = (b, a, lane) => ({
    lane,
    ...Object.fromEntries(METRICS.map(([k, label]) => [k, pairedMetric(b.rows.filter((r) => r.lane === lane), a.rows.filter((r) => r.lane === lane), k, label)])),
    reformulation_signal: pairedRate(b.rows.filter((r) => r.lane === lane), a.rows.filter((r) => r.lane === lane), "reformulation_signal", "reformulation"),
  });

  const lanesToShow = [...new Set(baseC.rows.filter((r) => r.must_hit && !r.negative).map((r) => r.lane))];
  const committed = {
    overall: overall(baseC, rankC),
    by_lane: Object.fromEntries(lanesToShow.map((l) => [l, byLane(baseC, rankC, l)])),
  };
  const rerun = {
    overall: overall(baseM, mainM),
    by_lane: Object.fromEntries(lanesToShow.map((l) => [l, byLane(baseM, mainM, l)])),
  };

  // Claimed values, transcribed from docs/wave3/W3-02.
  const claimed = {
    recall_at_10: { before: 0.7833333333333332, after: 0.7961538461538461, delta: 0.012820512820512822, ci: [0, 0.038461538461538464], claimed_excludes_zero: false, doc_note: "includes 0, not claimed" },
    ndcg_at_10: { before: 0.8628903747917224, after: 0.9120703849896526, delta: 0.049180010197930245, ci: [0.011161163792428251, 0.13451867283595778], claimed_excludes_zero: true, doc_note: "sub-threshold vs +0.05" },
    reformulation_signal: { before: 0.15384615384615385, after: 0.038461538461538464, delta: -0.11538461538461539, ci: [-0.34615384615384615, -0.038461538461538464], claimed_excludes_zero: true },
    grep_literal_reformulation: { before: 0.4, after: 0, n: 5 },
    grep_regex_reformulation: { before: 0.5, after: 0, n: 2 },
  };

  // Row-level identity between the verifier's re-run arms (which rows moved).
  const movedRows = [];
  for (const b of baseM.rows) {
    const a = mainM.rows.find((r) => r.id === b.id);
    const setEq = JSON.stringify([...b.retrieved].sort()) === JSON.stringify([...a.retrieved].sort());
    const orderEq = JSON.stringify(b.retrieved) === JSON.stringify(a.retrieved);
    if (!orderEq || b.score.ndcg_at_10 !== a.score.ndcg_at_10) {
      movedRows.push({
        id: b.id, lane: b.lane, set_equal: setEq, order_equal: orderEq,
        before_ndcg: b.score.ndcg_at_10, after_ndcg: a.score.ndcg_at_10,
        before_top: b.retrieved.slice(0, 10), after_top: a.retrieved.slice(0, 10),
      });
    }
  }
  // Committed arm pair: exactly which rows moved, base -> rank.
  const committedMoved = [];
  for (const b of baseC.rows) {
    const a = rankC.rows.find((r) => r.id === b.id);
    const setEq = JSON.stringify([...b.retrieved].sort()) === JSON.stringify([...a.retrieved].sort());
    const orderEq = JSON.stringify(b.retrieved) === JSON.stringify(a.retrieved);
    if (!orderEq || b.score.ndcg_at_10 !== a.score.ndcg_at_10) {
      committedMoved.push({ id: b.id, lane: b.lane, set_equal: setEq, order_equal: orderEq, before_ndcg: b.score.ndcg_at_10, after_ndcg: a.score.ndcg_at_10 });
    }
  }
  // Cross-arm equality: does the main binary give the same rows as the author's rank binary?
  const rankVsMain = baseM.rows.map((b) => {
    const r = rankC.rows.find((x) => x.id === b.id);
    const m = mainM.rows.find((x) => x.id === b.id);
    return { id: b.id, rank_eq_main: JSON.stringify(r.retrieved) === JSON.stringify(m.retrieved), base_eq_committed_base: JSON.stringify(b.retrieved) === JSON.stringify(baseC.rows.find((x) => x.id === b.id).retrieved) };
  });

  matrix.block48 = {
    claim_doc: "docs/wave3/W3-02-grep-page-ranking.md",
    arms: {
      committed: {
        before: artifactMeta(R("bench/wave3/results/final-base.json")),
        after: artifactMeta(R("bench/wave3/results/final-rank.json")),
        engine_changed: artifactMeta(R("bench/wave3/results/final-base.json")).engine !== artifactMeta(R("bench/wave3/results/final-rank.json")).engine,
      },
      rerun: {
        before: artifactMeta(R("bench/verification/wave3/rerun/measure-base.json")),
        after: artifactMeta(R("bench/verification/wave3/rerun/measure-main.json")),
        engine_changed: artifactMeta(R("bench/verification/wave3/rerun/measure-base.json")).engine !== artifactMeta(R("bench/verification/wave3/rerun/measure-main.json")).engine,
      },
    },
    claimed,
    committed_compare_artifact: {
      path: "bench/wave3/results/final-compare.json",
      method_note: committedCompare.meta.method,
      overall: committedCompare.overall,
      engine: { before: committedCompare.meta.before.engine, after: committedCompare.meta.after.engine },
    },
    committed_recomputed: committed,
    rerun_recomputed: rerun,
    moved_rows: movedRows,
    committed_moved_rows: committedMoved,
    committed_identical_rows: baseC.rows.length - committedMoved.length,
    rerun_identical_rows: baseM.rows.length - movedRows.length,
    rank_vs_main_rows: {
      identical: rankVsMain.filter((x) => x.rank_eq_main).length,
      total: rankVsMain.length,
      base_reproduces_committed: rankVsMain.filter((x) => x.base_eq_committed_base).length,
    },
  };
}

// =====================================================================
// BLOCK Regressions — wave-2 38 rows on current main
// =====================================================================
{
  const before = rescore(load(R("bench/verification/after/wave2-baseline.json")), J2, CORPUS2);
  const authorAfter = rescore(load(R("bench/wave3/results/wave2-score-fixed.json")), J2, CORPUS2);
  const mainAfterPath = R("bench/verification/wave3/rerun/wave2-main.json");
  const baseAfterPath = R("bench/verification/wave3/rerun/wave2-base.json");
  const mainAfter = fs.existsSync(mainAfterPath) ? rescore(load(mainAfterPath), J2, CORPUS2) : null;
  const baseAfter = fs.existsSync(baseAfterPath) ? rescore(load(baseAfterPath), J2, CORPUS2) : null;

  const diffRows = (b, a) => {
    const rows = [];
    for (const rb of b.rows) {
      const ra = a.rows.find((r) => r.id === rb.id);
      const setEq = JSON.stringify([...rb.retrieved].sort()) === JSON.stringify([...ra.retrieved].sort());
      const orderEq = JSON.stringify(rb.retrieved) === JSON.stringify(ra.retrieved);
      const scoreSame = JSON.stringify(rb.score) === JSON.stringify(ra.score);
      if (!orderEq || !scoreSame) {
        rows.push({
          id: rb.id, lane: rb.lane, set_equal: setEq, order_equal: orderEq,
          before_ndcg: rb.score.ndcg_at_10, after_ndcg: ra.score.ndcg_at_10,
          before_retrieved: rb.retrieved, after_retrieved: ra.retrieved,
          before_score: rb.score, after_score: ra.score,
        });
      }
    }
    return rows;
  };

  const laneDeltas = (b, a) => {
    const lanes = [...new Set(b.rows.map((r) => r.lane))];
    return Object.fromEntries(lanes.map((l) => {
      const ab = laneAgg(b.rows, l), aa = laneAgg(a.rows, l);
      return [l, {
        n: ab.n,
        ndcg10: { before: ab.ndcg10, after: aa.ndcg10, delta: aa.ndcg10 - ab.ndcg10 },
        recall10: { before: ab.recall10, after: aa.recall10, delta: aa.recall10 - ab.recall10 },
        success3: { before: ab.success3, after: aa.success3, delta: aa.success3 - ab.success3 },
        mrr10: { before: ab.mrr10, after: aa.mrr10, delta: aa.mrr10 - ab.mrr10 },
      }];
    }));
  };

  const pairs = {
    author_before_vs_author_after: { before: artifactMeta(R("bench/verification/after/wave2-baseline.json")), after: artifactMeta(R("bench/wave3/results/wave2-score-fixed.json")), moved: diffRows(before, authorAfter), lane_deltas: laneDeltas(before, authorAfter) },
  };
  if (baseAfter) pairs.base_rerun_vs_main_rerun = { before: artifactMeta(baseAfterPath), after: null, moved: diffRows(baseAfter, mainAfter), lane_deltas: laneDeltas(baseAfter, mainAfter) };
  if (mainAfter) pairs.author_before_vs_main_rerun = { before: artifactMeta(R("bench/verification/after/wave2-baseline.json")), after: artifactMeta(mainAfterPath), moved: diffRows(before, mainAfter), lane_deltas: laneDeltas(before, mainAfter) };

  const claim = { identical_rows: 37, total: 38, only_moved: "SE09", se09_before_ndcg: 0.388782088943954, se09_after_ndcg: 0.3689622507814621, semantic_lane_delta: -0.001982, tolerance: 0.02 };
  const mainMoved = pairs.author_before_vs_main_rerun?.moved ?? [];
  const maxAbsLaneNdcg = Math.max(...Object.values(pairs.author_before_vs_main_rerun?.lane_deltas ?? {}).map((l) => Math.abs(l.ndcg10.delta)));
  matrix.blockRegressions = {
    claim,
    pairs,
    main_run: {
      moved_rows: mainMoved.map((m) => ({ id: m.id, lane: m.lane, set_equal: m.set_equal, order_equal: m.order_equal, before_ndcg: m.before_ndcg, after_ndcg: m.after_ndcg })),
      moved_count: mainMoved.length,
      identical_count: mainMoved.length ? 38 - mainMoved.length : 38,
      max_abs_lane_ndcg_delta: maxAbsLaneNdcg,
      within_tolerance: maxAbsLaneNdcg <= claim.tolerance,
      semantic_lane: pairs.author_before_vs_main_rerun?.lane_deltas["semantic-paraphrase"] ?? null,
    },
  };
}

// =====================================================================
// BLOCK Cost — daemon work counters must not increase
// =====================================================================
{
  const loadWork = (p) => (fs.existsSync(p) ? load(p) : null);
  const mine = {
    base: loadWork(R("bench/verification/wave3/rerun/work-base.json")),
    main: loadWork(R("bench/verification/wave3/rerun/work-main.json")),
  };
  const committed = {
    base: loadWork(R("bench/wave3/results/final-work-base.json")),
    rank: loadWork(R("bench/wave3/results/final-work-rank.json")),
  };
  const compareWork = (b, a) => {
    const rows = [];
    for (const rb of b.rows) {
      const ra = a.rows.find((r) => r.id === rb.id);
      const key = (r) => JSON.stringify((r.samples ?? []).map((s) => ({ read: s.read ?? null, candidates: s.candidates ?? null, n: s.n ?? null, error: s.error ?? null })));
      const before = key(rb), after = key(ra);
      const reads = (r) => (r.samples ?? []).map((s) => s.read ?? null);
      const increased = reads(rb).some((v, i) => v !== null && reads(ra)[i] !== null && reads(ra)[i] > v);
      rows.push({ id: rb.id, lane: rb.lane, identical: before === after, read_increased: increased, before, after });
    }
    return { n: rows.length, identical: rows.filter((r) => r.identical).length, any_read_increased: rows.some((r) => r.read_increased), differing: rows.filter((r) => !r.identical).map((r) => ({ id: r.id, lane: r.lane, before: r.before.slice(0, 160), after: r.after.slice(0, 160), read_increased: r.read_increased })) };
  };
  matrix.blockCost = {
    claim: "read/candidates/result counts unchanged 30/30; no ordinary query pays extra work",
    mine: mine.base && mine.main ? compareWork(mine.base, mine.main) : { missing: true },
    committed: committed.base && committed.rank ? compareWork(committed.base, committed.rank) : { missing: true },
    meta: {
      mine_base: mine.base?.meta ?? null, mine_main: mine.main?.meta ?? null,
      committed_base: committed.base?.meta ?? null, committed_rank: committed.rank?.meta ?? null,
    },
  };
}

// =====================================================================
// BLOCK Audit — recall-cap ground truth
// =====================================================================
{
  const resultsRel = "bench/verification/wave3/rerun/measure-main.json";
  const artifact = load(R(resultsRel));
  const rows = new Map(rescore(artifact, J1, CORPUS1).rows.map((r) => [r.id, r]));
  const summary = { total_missing: 0, by_class: {}, rows_affected: 0, audited_recall_at_10: 0, reported_recall_at_10: 0, reachable_misses: [] };
  const audits = [];

  const pathMatches = (relPath, query) => {
    const tokens = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['^!]/, "").replace(/\$$/, "").replace(/[\\()|]/g, ""));
    const p = relPath.toLowerCase();
    return tokens.length > 0 && tokens.every((t) => t.length > 0 && p.includes(t.toLowerCase()));
  };
  const contentMatches = (lane, query, text, mode) => {
    if (text === null) return false;
    if (lane === "grep-regex" || mode === "regex") {
      try { return new RegExp(query, "m").test(text); } catch { return false; }
    }
    const needle = query.trim();
    const insensitive = !/[A-Z]/.test(needle);
    return insensitive ? text.toLowerCase().includes(needle.toLowerCase()) : text.includes(needle);
  };
  const declares = (text, name) => {
    if (text === null) return false;
    const DEFINERS = "(fn|func|function|def|class|struct|enum|trait|interface|type|typealias|impl|let|const|var|val|static|module|mod|protocol|extension|define|typedef|union|object|record|namespace|actor)";
    const MODS = "(public|private|protected|internal|fileprivate|open|static|async|readonly|abstract|override|final|sealed|declare|export|default|pub|unsafe|extern)";
    return new RegExp(`(?:${DEFINERS})(?:<[^>\\n]*>)?[ \\t*&]+(?:mut[ \\t]+)?${name}(?!\\w)`).test(text) || new RegExp(`(?:${MODS})[ \\t]+${name}(?!\\w)`).test(text);
  };

  for (const q of J1.queries) {
    if (q.must_hit !== true || q.negative === true) continue;
    const rec = rows.get(q.id);
    if (!rec) continue;
    const rel = (q.expected ?? []).filter((e) => e.grade >= 1).map((e) => ({ ...e, path: normRel(e.path) }));
    const top10 = new Set(rec.retrieved.slice(0, 10));
    const got = new Set(rec.retrieved);
    const laneIsPath = ["path", "ranking-frecency", "ranking-proximity", "ranking-boost-ab"].includes(q.lane);
    const laneIsSymbol = q.lane === "symbol";
    const misses = [];
    for (const e of rel) {
      if (top10.has(e.path)) continue;
      const text = readFile(CORPUS1, e.path);
      let klass;
      if (!exists(CORPUS1, e.path)) klass = "absent-file";
      else if (laneIsSymbol && !declares(text, q.query) && text.includes(q.query)) klass = "symbol-lane-reference";
      else if (laneIsSymbol && !text.includes(q.query)) klass = "absent-string";
      else if (laneIsPath && !pathMatches(e.path, q.query) && contentMatches(q.lane, q.query, text, q.params?.mode)) klass = "path-lane-content";
      else if (laneIsPath && !pathMatches(e.path, q.query) && !contentMatches(q.lane, q.query, text, q.params?.mode)) klass = "absent-string";
      else if (!contentMatches(q.lane, q.query, text, q.params?.mode)) klass = "absent-string";
      else klass = "reachable";
      summary.total_missing += 1;
      summary.by_class[klass] = (summary.by_class[klass] ?? 0) + 1;
      if (klass === "reachable") summary.reachable_misses.push({ id: q.id, lane: q.lane, expected: e.path });
      misses.push({
        id: q.id, lane: q.lane, query: q.query, expected: e.path, grade: e.grade,
        in_returned: got.has(e.path), class: klass,
        path_matches_query: pathMatches(e.path, q.query),
        content_matches_query: contentMatches(q.lane, q.query, text, q.params?.mode),
        declares_query: laneIsSymbol ? declares(text, q.query) : null,
        file_bytes: text === null ? null : Buffer.byteLength(text),
      });
    }
    const unreachable = new Set(misses.filter((m) => m.class !== "reachable").map((m) => m.expected));
    const reachable = rel.filter((e) => !unreachable.has(e.path));
    const hits = reachable.filter((e) => top10.has(e.path)).length;
    audits.push({
      id: q.id, lane: q.lane, expected_rel: rel.length, returned: rec.retrieved.length,
      reported_recall_at_10: rec.score.recall_at_10,
      unreachable_expected: unreachable.size,
      reachable_expected: reachable.length,
      audited_recall_at_10: reachable.length ? hits / reachable.length : null,
      misses,
    });
    if (misses.length) summary.rows_affected += 1;
  }
  const mh = audits.filter((a) => a.expected_rel > 0);
  summary.audited_recall_at_10 = mh.reduce((a, r) => a + (r.audited_recall_at_10 ?? 0), 0) / mh.length;
  summary.reported_recall_at_10 = mh.reduce((a, r) => a + r.reported_recall_at_10, 0) / mh.length;

  // Hard, independent verification of the three absent-string files: raw byte
  // scan of the file + the whole corpus for the literal, not a regex engine.
  const byteScan = (rel, needle) => {
    const p = path.join(CORPUS1, rel);
    if (!fs.existsSync(p)) return { file: rel, missing: true };
    const text = fs.readFileSync(p, "utf8");
    return { file: rel, bytes: Buffer.byteLength(text), exact_hits: text.split(needle).length - 1, casefold_hits: text.toLowerCase().split(needle.toLowerCase()).length - 1 };
  };
  const corpusScan = (needle, ci = false) => {
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== ".git") walk(p); continue; }
        const t = fs.readFileSync(p, "utf8");
        const hay = ci ? t.toLowerCase() : t;
        const needle2 = ci ? needle.toLowerCase() : needle;
        if (hay.includes(needle2)) hits.push(path.relative(CORPUS1, p));
      }
    };
    walk(CORPUS1);
    return hits;
  };
  const absentChecks = [
    { id: "G4", query: "fsearch.sock", expected: "README.md", needle: "fsearch.sock", ci: false },
    { id: "P6", query: "codemode", expected: "OPTIMIZATIONS.md", needle: "codemode", ci: false },
    { id: "K1", query: "readme", expected: "CONTRIBUTING.md", needle: "readme", ci: true },
  ].map((c) => ({ ...c, file_scan: byteScan(c.expected, c.needle), corpus_hits: corpusScan(c.needle, c.ci) }));

  // Compare with the author's committed audit for the same artifact.
  const authorAuditPath = R("bench/wave3/results/final-expectation-audit.json");
  const authorAudit = fs.existsSync(authorAuditPath) ? load(authorAuditPath) : null;
  const mainAuditPath = R("bench/verification/wave3/rerun/expectation-audit-main.json");

  matrix.blockAudit = {
    claim: "recall@10 = 1.00 unsatisfiable on the frozen set; 16 misses: 3 absent-string, 6 path-lane-content, 7 symbol-lane-reference; audited recall 1.0000",
    source_results: resultsRel,
    source_meta: artifactMeta(R(resultsRel)),
    summary,
    absent_string_ground_truth: absentChecks,
    author_audit: authorAudit ? { results: authorAudit.meta.results, summary: authorAudit.summary } : null,
    audit_rows: audits.filter((a) => a.misses.length > 0),
    next: { main_audit_path: path.relative(REPO, mainAuditPath) },
  };
}

fs.writeFileSync(OUT, JSON.stringify(matrix, null, 2) + "\n");
console.log("wrote", path.relative(REPO, OUT));
console.log("block47 frozen bars old:", matrix.block47.frozen_set.old_formula.pass + "/" + matrix.block47.frozen_set.old_formula.total,
  "fixed:", matrix.block47.frozen_set.fixed_formula.pass + "/" + matrix.block47.frozen_set.fixed_formula.total);
console.log("block47 all arms RS02=14:", matrix.block47.all_arms_rs02_14);
console.log("block48 rerun reform:", JSON.stringify(matrix.block48.rerun_recomputed.overall.reformulation_signal.delta),
  "CI", JSON.stringify(matrix.block48.rerun_recomputed.overall.reformulation_signal.ci95_bca),
  "excl0", matrix.block48.rerun_recomputed.overall.reformulation_signal.excludes_zero_bca);
console.log("block48 rerun ndcg:", JSON.stringify(matrix.block48.rerun_recomputed.overall.ndcg_at_10.delta),
  "CI", JSON.stringify(matrix.block48.rerun_recomputed.overall.ndcg_at_10.ci95_bca),
  "excl0", matrix.block48.rerun_recomputed.overall.ndcg_at_10.excludes_zero_bca);
console.log("blockRegressions moved:", matrix.blockRegressions.main_run.moved_count, "max|lane ndcg|", matrix.blockRegressions.main_run.max_abs_lane_ndcg_delta);
console.log("blockCost mine:", matrix.blockCost.mine.identical + "/" + matrix.blockCost.mine.n, "anyReadUp", matrix.blockCost.mine.any_read_increased);
console.log("blockAudit:", JSON.stringify(matrix.blockAudit.summary.by_class), "audited", matrix.blockAudit.summary.audited_recall_at_10);
