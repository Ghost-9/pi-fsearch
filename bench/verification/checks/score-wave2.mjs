#!/usr/bin/env node
// bench/verification/checks/score-wave2.mjs — wave-2 judgment-set scorer (verifier).
//
// Scores bench/judgments/wave2-judgments.json (schema ultrasearch.judgments/v2)
// against the frozen corpus and writes a gated baseline artifact. It implements
// the lane metrics the bars file names, the schema's extra assertions
// (symbol_assertions, not_expected, intra_file_order, paired ranking signals,
// controls) and the exclusion rules (requires_feature, known_fail, and the
// degenerate-signal rule for a non-git/mtime-uniform corpus).
//
//   PI_ULTRASEARCH_TEST=1 node bench/verification/checks/score-wave2.mjs \
//     [--judgments <file>] [--bars <file>] [--corpus <dir>] [--out <file>] [--gate <file>]
//
// Reads src/ from the worktree it runs in; never writes src/, tests/ or the
// author harnesses. Same metric definitions as the frozen wave-1 scorer
// (bench/baseline/judgments.mjs: rel = grade>=1 for recall, grade>=2 for
// success@10, 2^g-1 nDCG gains, 1/log2(rank+1) discount).

process.env.PI_ULTRASEARCH_TEST = "1";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const JUDGMENTS_PATH = opt("judgments", path.join(REPO, "bench", "judgments", "wave2-judgments.json"));
const BARS_PATH = opt("bars", path.join(REPO, "bench", "judgments", "wave2-bars.json"));
const OUT = opt("out", path.join(HERE, "..", "after", "wave2-baseline.json"));
const GATE_FILE = opt("gate");

const judgments = JSON.parse(fs.readFileSync(JUDGMENTS_PATH, "utf8"));
const bars = fs.existsSync(BARS_PATH) ? JSON.parse(fs.readFileSync(BARS_PATH, "utf8")) : { lanes: {} };
const ROOT = opt("corpus", judgments.corpus?.root);
if (!ROOT || !fs.existsSync(ROOT)) throw new Error(`corpus root missing: ${ROOT}`);

const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src", "client.ts")).href);
const { searchSemanticIntent } = await import(pathToFileURL(path.join(REPO, "src", "semantic.ts")).href);

// ---------------------------------------------------------------- helpers

const norm = (p) => {
  const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? abs : rel;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = ((s.length - 1) * p) / 100;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const walk = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      out.push(...walk(p));
    } else out.push(p);
  }
  return out;
};
function treeHash(files) {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(path.relative(ROOT, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}
function rawStatus() {
  const SOCKET = path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock");
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: SOCKET });
    let b = "";
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("status timeout"));
    }, 10000);
    s.on("connect", () => s.write(JSON.stringify({ id: 1, op: "status" }) + "\n"));
    s.on("data", (d) => {
      b += d.toString();
      if (b.includes("\n")) {
        clearTimeout(t);
        s.destroy();
        try {
          resolve(JSON.parse(b.slice(0, b.indexOf("\n"))));
        } catch (e) {
          reject(e);
        }
      }
    });
    s.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
const tryExec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------- grading (wave-1 definitions)

function scoreQuery(retrieved, expected, kMax = 10) {
  const grades = new Map(expected.map((e) => [norm(e.path), e.grade]));
  const top = retrieved.slice(0, kMax).map((p, i) => ({ rank: i + 1, path: p, grade: grades.get(p) ?? 0 }));
  const rel1 = expected.filter((e) => e.grade >= 1).map((e) => norm(e.path));
  const rel2 = expected.filter((e) => e.grade >= 2).map((e) => norm(e.path));
  const recallAt = (k, relSet) => {
    if (!relSet.length) return null;
    const set = new Set(relSet);
    return top.slice(0, k).filter((r) => set.has(r.path)).length / relSet.length;
  };
  const firstRank = (min) => top.find((x) => x.grade >= min)?.rank ?? null;
  const gain = (g) => Math.pow(2, g) - 1;
  const dcg = (list) => list.reduce((a, r, i) => a + gain(r.grade) / Math.log2(i + 2), 0);
  const ideal = [...expected.map((e) => e.grade)].sort((a, b) => b - a).map((g) => ({ grade: g }));
  const idcg = dcg(ideal);
  return {
    top10: top,
    recall_at_1: recallAt(1, rel1),
    recall_at_3: recallAt(3, rel1),
    recall_at_5: recallAt(5, rel1),
    recall_at_10: recallAt(10, rel1),
    success_recall_at_10: recallAt(10, rel2),
    mrr_at_10: firstRank(1) ? 1 / firstRank(1) : 0,
    ndcg_at_10: idcg > 0 ? dcg(top) / idcg : null,
    top1_grade: top[0]?.grade ?? 0,
    recall_at_limit: recallAt(retrieved.length, rel1),
  };
}

// ---------------------------------------------------------------- dispatch

async function runOne(client, q) {
  const limit = q.params?.limit ?? 10;
  const rec = {
    id: q.id,
    lane: q.lane,
    sub_lane: q.sub_lane ?? null,
    difficulty: q.difficulty ?? null,
    query: q.query,
    params: q.params ?? {},
    must_hit: q.must_hit === true,
    negative: q.negative === true,
    requires_feature: q.requires_feature ?? null,
    known_fail: q.known_fail === true,
    signal: q.signal ?? null,
    ms: null,
    source: null,
    error: null,
    retrieved: [],
    matches: {},
    call: null,
    control: null,
    pair_group: q.paired_with ?? null,
  };
  const t0 = performance.now();
  try {
    if (q.params?.mode === "semantic") {
      rec.call = `searchSemanticIntent(${JSON.stringify(q.query)}, in=<root>, limit=${limit})`;
      const sem = await searchSemanticIntent(client, q.query, { in: ROOT, limit });
      rec.source = "semantic_intent";
      rec.retrieved = (sem.files ?? []).map((f) => norm(f.path));
      rec.matches = Object.fromEntries((sem.files ?? []).map((f) => [norm(f.path), f.matches ?? []]));
      rec.extra = { expanded_terms: sem.matchedTokens ?? null, confidence: sem.confidence ?? null };
    } else if (q.params?.mode) {
      const mode = q.params.mode;
      rec.call = `grep(${JSON.stringify(q.query)}, in=<root>, mode=${mode}, limit=${limit})`;
      const res = await client.grep(q.query, { in: ROOT, limit, mode, budget_ms: 2500, context: 0, tag_symbols: mode === "symbol" });
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.files ?? []).map((f) => norm(f.path));
      rec.matches = Object.fromEntries((res.files ?? []).map((f) => [norm(f.path), f.matches ?? []]));
    } else {
      const opts = { in: ROOT, limit, git: true };
      if (q.params?.near) opts.near = path.resolve(ROOT, q.params.near);
      if (q.params?.boost === true) opts.boost = true;
      if (q.params?.git) opts.git = q.params.git;
      rec.call = `search(${JSON.stringify(q.query)}, in=<root>, limit=${limit}${opts.near ? ", near=" + q.params.near : ""}${opts.boost ? ", boost=true" : ""}${q.params?.git ? ", git=" + q.params.git : ""})`;
      const res = await client.search(q.query, opts);
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.hits ?? []).map((h) => norm(h.path));
      if (q.control_params) {
        const cres = await client.search(q.query, { ...opts, boost: q.control_params.boost === true });
        rec.control = {
          params: q.control_params,
          call: `boost=${q.control_params.boost === true}`,
          retrieved: (cres.hits ?? []).map((h) => norm(h.path)),
        };
      }
    }
  } catch (e) {
    rec.error = String(e?.message ?? e);
  }
  rec.ms = performance.now() - t0;
  return rec;
}

// ---------------------------------------------------------------- assertions

function assertionsFor(q, rec) {
  const out = { symbol_assertions: [], not_expected: [], intra_file_order: null };
  if (Array.isArray(q.symbol_assertions)) {
    for (const a of q.symbol_assertions) {
      const target = norm(a.path);
      const rank = rec.retrieved.indexOf(target) + 1 || null;
      const first = (rec.matches[target] ?? [])[0]?.text ?? null;
      let regexOk = null;
      if (a.first_match_matches) {
        try {
          regexOk = new RegExp(a.first_match_matches).test((first ?? "").trim());
        } catch {
          regexOk = null;
        }
      }
      out.symbol_assertions.push({
        path: target,
        expect_file_rank: a.expect_file_rank ?? null,
        actual_rank: rank,
        rank_ok: a.expect_file_rank ? rank === a.expect_file_rank : null,
        first_match: (first ?? "").trim().slice(0, 120) || null,
        first_match_matches: a.first_match_matches ?? null,
        first_match_ok: regexOk,
        ok: (a.expect_file_rank ? rank === a.expect_file_rank : true) && (regexOk === null ? true : regexOk === true),
      });
    }
  }
  if (Array.isArray(q.not_expected)) {
    for (const n of q.not_expected) {
      const target = norm(n.path);
      const rank = rec.retrieved.indexOf(target) + 1 || null;
      out.not_expected.push({ path: target, returned: rank !== null, rank, why: n.why ?? null });
    }
  }
  if (Array.isArray(q.intra_file_order)) {
    // The file that carries the declaration: the first returned file with >= 3 matches.
    const candidate = rec.retrieved.find((p) => (rec.matches[p] ?? []).length >= 3) ?? rec.retrieved[0] ?? null;
    const texts = (rec.matches[candidate] ?? []).slice(0, q.intra_file_order.length).map((m) => (m.text ?? "").trim());
    out.intra_file_order = {
      file: candidate,
      expected_order: q.intra_file_order,
      actual_order: texts,
      order_ok: texts.length === q.intra_file_order.length && q.intra_file_order.every((needle, i) => texts[i].includes(needle)),
    };
  }
  return out;
}

// ---------------------------------------------------------------- run

const client = new UltraSearchClient({ timeoutMs: 20000 });
const rows = [];
let seq = 0;
for (const q of judgments.queries) {
  const rec = await runOne(client, q);
  rec.score = scoreQuery(rec.retrieved, (q.expected ?? []).map((e) => ({ path: norm(e.path), grade: e.grade })));
  rec.assertions = assertionsFor(q, rec);
  rec.negative_result = q.negative
    ? {
        returned_count: rec.retrieved.length,
        fp: rec.retrieved.length > 0,
        fp_rule: q.fp_rule ?? "any returned path is a false positive",
        absent_concept: q.absent_concept ?? null,
      }
    : null;
  rec.zero_result = rec.retrieved.length === 0;
  rec.excluded_from_tier_l = rec.requires_feature !== null || rec.known_fail === true;
  rows.push(rec);
  process.stderr.write(`[wave2] ${rec.id} ${rec.lane} n=${rec.retrieved.length} ms=${rec.ms.toFixed(1)}${rec.error ? " ERR " + rec.error.slice(0, 60) : ""}\n`);
  if (++seq % 10 === 0) await new Promise((r) => setTimeout(r, 50));
}
const status = await client.status().catch(() => null);
client.close();

// ---------------------------------------------------------------- aggregates

const laneNames = [...new Set(rows.map((r) => r.lane))];
const agg = {};
for (const lane of laneNames) {
  const all = rows.filter((r) => r.lane === lane);
  const mustHit = all.filter((r) => r.must_hit && !r.negative);
  const gated = mustHit.filter((r) => !r.excluded_from_tier_l);
  const negatives = all.filter((r) => r.negative);
  const m = (fn) => mean(gated.map(fn).filter((v) => v !== null && v !== undefined));
  /** One metric block over an arbitrary row set (used for both the gated and the full must-hit basis). */
  const metricBlock = (rows) => ({
    n: rows.length,
    recall10: mean(rows.map((r) => r.score.recall_at_10).filter((v) => v !== null)),
    recall3: mean(rows.map((r) => r.score.recall_at_3).filter((v) => v !== null)),
    success3: mean(rows.map((r) => r.score.recall_at_3).filter((v) => v !== null)),
    mrr10: mean(rows.map((r) => r.score.mrr_at_10)),
    ndcg10: mean(rows.map((r) => r.score.ndcg_at_10).filter((v) => v !== null)),
    zero_result_rate: rows.length ? rows.filter((r) => r.zero_result).length / rows.length : null,
    ms_p50: pct(rows.map((r) => r.ms), 50),
    ms_max: Math.max(...rows.map((r) => r.ms), 0),
  });
  const top3DocShare = mean(
    gated
      .filter((r) => r.retrieved.length > 0)
      .map((r) => {
        const top3 = r.retrieved.slice(0, 3);
        const docs = top3.filter((p) => /^(README|CHANGELOG|CONTRIBUTING|NOTICE|docs\/)/.test(p)).length;
        return docs / Math.max(1, Math.min(3, top3.length));
      }),
  );
  agg[lane] = {
    queries: all.length,
    must_hit: mustHit.length,
    must_hit_gated: gated.length,
    must_hit_excluded: mustHit.length - gated.length,
    negatives: negatives.length,
    /** Author-claim basis: every must-hit row, known_fail and feature-gated included. */
    all: metricBlock(mustHit),
    /** Tier-L basis: declared-answerable, non-known_fail rows only. */
    gated: metricBlock(gated),
    recall10: m((r) => r.score.recall_at_10),
    recall3: m((r) => r.score.recall_at_3),
    success3: m((r) => r.score.recall_at_3),
    mrr10: m((r) => r.score.mrr_at_10),
    ndcg10: m((r) => r.score.ndcg_at_10),
    zero_result_rate: gated.length ? gated.filter((r) => r.zero_result).length / gated.length : null,
    fp_rate: negatives.length ? negatives.filter((r) => r.negative_result.fp).length / negatives.length : null,
    neg_fp_rows: negatives.filter((r) => r.negative_result.fp).map((r) => ({ id: r.id, returned: r.retrieved.slice(0, 5) })),
    top3_doc_share: top3DocShare,
    ms_p50: pct(gated.map((r) => r.ms), 50),
    ms_p95: pct(gated.map((r) => r.ms), 95),
    ms_max: Math.max(...gated.map((r) => r.ms), 0),
    not_expected_returned: gated.flatMap((r) => r.assertions.not_expected.filter((n) => n.returned).map((n) => ({ id: r.id, path: n.path }))),
    symbol_assertions: gated.flatMap((r) => r.assertions.symbol_assertions.map((a) => ({ id: r.id, ...a }))),
    known_fail_rows: mustHit.filter((r) => r.known_fail).map((r) => ({ id: r.id, recall10: r.score.recall_at_10, retrieved: r.retrieved.length })),
    feature_gated_rows: mustHit.filter((r) => r.requires_feature).map((r) => ({ id: r.id, requires_feature: r.requires_feature })),
  };
}

// signal-specific observations
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
const signals = {
  exact_path: byId.RS01 ? { recall10: byId.RS01.score.recall_at_10, not_expected: byId.RS01.assertions.not_expected } : null,
  glob: byId.RS02 ? { recall_at_limit: byId.RS02.score.recall_at_limit, retrieved: byId.RS02.retrieved.length } : null,
  near_pair: byId.RS03 && byId.RS04
    ? {
        RS03_near_client_ts: { top5: byId.RS03.retrieved.slice(0, 5), first_src_rank: (byId.RS03.retrieved.findIndex((p) => p.startsWith("src/")) + 1) || null },
        RS04_near_test: { top5: byId.RS04.retrieved.slice(0, 5), first_src_rank: (byId.RS04.retrieved.findIndex((p) => p.startsWith("src/")) + 1) || null },
        order_differs: JSON.stringify(byId.RS03.retrieved) !== JSON.stringify(byId.RS04.retrieved),
        primary_demoted: byId.RS03.retrieved.indexOf("src/client.ts") === byId.RS03.retrieved.length - 1,
      }
    : null,
  frecency: byId.RS05 ? { rank_of_readme: (byId.RS05.retrieved.findIndex((p) => /^README/.test(p)) + 1) || null, degenerate: true, why: "archive corpus: no .git, uniform mtimes" } : null,
  boost_ab: byId.RS06 ? { arm_true: byId.RS06.retrieved, arm_false: byId.RS06.control?.retrieved ?? null, identical: JSON.stringify(byId.RS06.retrieved) === JSON.stringify(byId.RS06.control?.retrieved ?? []), degenerate: true, why: "archive corpus: no .git, uniform mtimes (forbidden claim)" } : null,
  git_filter: byId.RS07 ? { retrieved: byId.RS07.retrieved.length, degenerate: true, why: "archive corpus has no .git" } : null,
  multi_term_exact: byId.RS09 ? { known_fail: true, retrieved: byId.RS09.retrieved.length, recall10: byId.RS09.score.recall_at_10 } : null,
  intra_file_order: rows.filter((r) => r.assertions.intra_file_order).map((r) => ({ id: r.id, ...r.assertions.intra_file_order })),
};

// bars
function evalBars() {
  const res = {};
  const floor = bars.lanes?.["symbol-ast"] ? bars.lanes : {};
  const get = (lane) => floor[lane]?.floor ?? {};
  const checks = {
    "symbol-ast": [
      ["zero_result_rate_max", "le", agg["symbol-ast"]?.zero_result_rate],
      ["false_positive_rate_max", "le", agg["symbol-ast"]?.fp_rate],
      ["recall10_min", "ge", agg["symbol-ast"]?.recall10],
      ["success3_min", "ge", agg["symbol-ast"]?.success3],
      ["mrr10_min", "ge", agg["symbol-ast"]?.mrr10],
    ],
    "semantic-paraphrase": [
      ["zero_result_rate_max", "le", agg["semantic-paraphrase"]?.zero_result_rate],
      ["false_positive_rate_max", "le", agg["semantic-paraphrase"]?.fp_rate],
      ["recall10_min", "ge", agg["semantic-paraphrase"]?.recall10],
      ["top3_doc_share_max", "le", agg["semantic-paraphrase"]?.top3_doc_share],
    ],
    "ranking-signal": [
      ["exact_recall10", "is", byId.RS01?.score.recall_at_10],
      ["glob_set_completeness", "is", byId.RS02?.score.recall_at_limit],
      ["false_positive_rate_max", "le", agg["ranking-signal"]?.fp_rate],
      ["near_pair_order_differs", "is", signals.near_pair?.order_differs],
      ["near_same_folder_peer_rank1", "is", signals.near_pair?.RS03_near_client_ts?.first_src_rank === 1],
    ],
    control: [
      ["recall10", "is", agg.control?.recall10],
      ["zero_result_rate", "is", agg.control?.zero_result_rate],
      ["ndcg10_min", "ge", agg.control?.ndcg10],
      ["mrr10_min", "ge", agg.control?.mrr10],
    ],
  };
  for (const [lane, list] of Object.entries(checks)) {
    const bar = get(lane);
    res[lane] = list.map(([key, op, observed]) => {
      const expected = bar[key];
      let pass = null;
      if (expected !== undefined && observed !== null && observed !== undefined) {
        pass = op === "le" ? observed <= expected : op === "ge" ? observed >= expected : observed === expected;
      }
      return { bar: key, expected, observed, op, pass };
    });
  }
  return res;
}

// ---------------------------------------------------------------- environment + provenance

const gate = GATE_FILE && fs.existsSync(GATE_FILE)
  ? JSON.parse(fs.readFileSync(GATE_FILE, "utf8"))
  : (() => {
      const pmset = tryExec("pmset", ["-g", "batt"]);
      const onAc = /AC Power/.test(pmset);
      const [l1] = os.loadavg();
      const competing = tryExec("ps", ["-Ao", "comm="]).split("\n").map((s) => s.trim().split("/").pop()).filter((b) => b === "cargo" || b === "rustc");
      return { status: onAc && l1 < 1.5 && competing.length === 0 ? "final" : "provisional", gate_pass: onAc && l1 < 1.5 && competing.length === 0, custom: true, on_ac: onAc, load1: Number(l1.toFixed(2)), competing_processes: competing };
    })();

const SOCKET = process.env.PI_ULTRASEARCH_SOCKET ?? path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock");
const owners = tryExec("lsof", ["-t", SOCKET]).split("\n").filter(Boolean);
const servers = tryExec("pgrep", ["-f", "UltraSearch.*serve"]).split("\n").filter(Boolean);
const st = status ?? {};
const daemon = {
  socket: SOCKET,
  socket_owner_pid: owners.length ? Number(owners[0]) : null,
  socket_owner_count: owners.length,
  serve_process_count: servers.length,
  single_socket_owner: owners.length === 1 && servers.length === 1,
  entries: st.entries ?? null,
  event_id: st.event_id ?? null,
  last_event_id: st.last_event_id ?? null,
  content_docs: st.content_docs ?? null,
  index_bytes: st.index_bytes ?? null,
  full_disk_access: st.full_disk_access ?? null,
  staleness_ms: st.staleness_ms ?? null,
};

const corpusFiles = walk(ROOT).filter((f) => path.basename(f) !== ".corpus-meta.json");
const corpus = {
  root: ROOT,
  declared: judgments.corpus ?? null,
  files: corpusFiles.length,
  bytes: corpusFiles.reduce((a, f) => a + fs.statSync(f).size, 0),
  tree_sha256: treeHash(corpusFiles),
  spoiler_meta_inside_root: fs.existsSync(path.join(ROOT, ".corpus-meta.json")),
  declared_tree_sha256_match: judgments.corpus?.tree_sha256 === treeHash(corpusFiles),
};

const artifact = {
  meta: {
    suite: "wave2-judgments-baseline",
    wave: "wave2/verify-baseline",
    generated_at: new Date().toISOString(),
    status: gate.status === "final" && daemon.single_socket_owner ? "final" : "provisional",
    gate,
    daemon_provenance: daemon,
    head_commit: tryExec("git", ["-C", REPO, "rev-parse", "HEAD"]) || null,
    judgments: { path: path.relative(REPO, JUDGMENTS_PATH), version: judgments.version, sha256: crypto.createHash("sha256").update(fs.readFileSync(JUDGMENTS_PATH)).digest("hex") },
    bars: { path: path.relative(REPO, BARS_PATH), sha256: fs.existsSync(BARS_PATH) ? crypto.createHash("sha256").update(fs.readFileSync(BARS_PATH)).digest("hex") : null },
    corpus,
    metric_definitions: {
      recall10: "mean over gated must-hit rows of |expected(grade>=1) ∩ top10| / |expected(grade>=1)|",
      success3: "mean over gated must-hit rows of recall@3 (same rel set)",
      mrr10: "mean of 1/rank of the first grade>=1 result in the top 10",
      ndcg10: "mean nDCG@10, gains 2^grade-1, discount 1/log2(rank+1), IDCG over all expected grades",
      zero_result_rate: "share of gated must-hit rows returning no path",
      fp_rate: "share of negative rows returning >=1 path",
      top3_doc_share: "mean over gated rows with results of (docs in top3)/min(3, results); docs = README/CHANGELOG/CONTRIBUTING/NOTICE/docs/",
      exclusions: "requires_feature and known_fail rows are reported but excluded from every gated metric (Tier-L)",
      degenerate_signals: "boost/frecency/git arms are unmeasurable on this archive corpus (no .git, uniform mtimes) — recorded, never claimed",
    },
  },
  aggregates: agg,
  signals,
  bars: evalBars(),
  rows,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      out: OUT,
      status: artifact.meta.status,
      gate: gate.status,
      daemon_single_owner: daemon.single_socket_owner,
      corpus_files: corpus.files,
      corpus_hash_match: corpus.declared_tree_sha256_match,
      lanes: Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, { recall10: v.recall10, success3: v.success3, mrr10: v.mrr10, ndcg10: v.ndcg10, zero: v.zero_result_rate, fp: v.fp_rate, ms_p50: v.ms_p50 }])),
    },
    null,
    1,
  ),
);
process.exit(0);
