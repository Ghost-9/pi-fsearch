// bench/baseline/judgments.mjs
// Judgment-set scorer, wave1/baseline (verifier).
//
// Scores the wave1/advisor judgment set (bench/judgments/wave1-judgments.json,
// 30 queries: recall@k, MRR@10, nDCG@10 with 3/2/1 gains, zero-result rate,
// false-positive rate, reformulation signal) against the UltraSearch client.
//
//   PI_ULTRASEARCH_TEST=1 node bench/baseline/judgments.mjs
//   JUDGMENTS_PATH=/path/to/wave1-judgments.json node bench/baseline/judgments.mjs
//
// Output: results/judgments-baseline.json (+ frozen copy of the input set)
//
// Metric definitions (documented so later waves cannot move the goalposts):
//   relevance:  judged grades 3/2/1; unjudged results = 0
//   success:    grade >= 2 ("an agent stops searching")
//   recall@k:   |expected with grade>=1 in top-k| / |expected with grade>=1|
//               (diagnostic: success_recall@10 uses grade>=2)
//   MRR@10:     reciprocal rank of the first grade>=2 result (rel1 variant recorded too)
//   nDCG@10:    DCG = sum (2^grade_i - 1)/log2(i+1); IDCG = ideal ordering of all
//               expected grades, same gain/discount; linear-gain variant recorded.
//   reformulation: top-1 grade < 2.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  ensureTestEnv,
  initClientModule,
  makeClient,
  timeExec,
  machineInfo,
  utcDate,
  utcDateShort,
  saveJSON,
  RESULTS_DIR,
  requireFixture,
  log,
  sleep,
  environmentGate,
  finalizeEnvironmentStatus,
  auditSnapshot,
  readAuditSince,
} from "./lib.mjs";

ensureTestEnv();

const JUDGMENTS_CANDIDATES = [
  process.env.JUDGMENTS_PATH,
  path.join(REPO_ROOT, "bench", "judgments", "wave1-judgments.json"),
  "/Users/batra/.pi/agent/extensions/pi-ultrasearch/bench/judgments/wave1-judgments.json",
].filter(Boolean);

function loadJudgments() {
  for (const p of JUDGMENTS_CANDIDATES) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return { path: p, raw, data: JSON.parse(raw), sha256: crypto.createHash("sha256").update(raw).digest("hex") };
    }
  }
  throw new Error(`Judgment file not found in: ${JUDGMENTS_CANDIDATES.join(", ")}`);
}

function norm(p, root) {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? abs : rel;
}

// Set from src/semantic.ts in main(); semantic lanes must mirror index.ts.
let semanticIntent = null;

// ------------------------------------------------------------------ scoring

function scoreQuery(retrieved, expected, kMax = 10) {
  const grades = new Map(expected.map((e) => [norm(e.path, expected.__root), e.grade]));
  const top = retrieved.slice(0, kMax).map((p, i) => ({
    rank: i + 1,
    path: p,
    grade: grades.get(p) ?? 0,
  }));

  const expectedGrades = expected.map((e) => e.grade);
  const rel1 = expected.filter((e) => e.grade >= 1).map((e) => norm(e.path, expected.__root));
  const rel2 = expected.filter((e) => e.grade >= 2).map((e) => norm(e.path, expected.__root));

  const recallAt = (k, relSet) => {
    if (relSet.length === 0) return null;
    const set = new Set(relSet);
    const hit = top.slice(0, k).filter((r) => set.has(r.path)).length;
    return hit / relSet.length;
  };

  const firstRank = (minGrade) => {
    const r = top.find((x) => x.grade >= minGrade);
    return r ? r.rank : null;
  };

  const gain = (g, linear) => (linear ? g : Math.pow(2, g) - 1);
  const dcg = (list, linear) =>
    list.reduce((a, r, i) => a + gain(r.grade, linear) / Math.log2(i + 2), 0);
  const idealList = [...expectedGrades].sort((a, b) => b - a).map((g) => ({ grade: g }));
  const idcgExp = dcg(idealList, false);
  const idcgLin = dcg(idealList, true);
  const ndcg10 = idcgExp > 0 ? dcg(top, false) / idcgExp : null;
  const ndcg10Linear = idcgLin > 0 ? dcg(top, true) / idcgLin : null;

  const r1 = firstRank(1);
  const r2 = firstRank(2);
  return {
    top10: top,
    recall_at_1: recallAt(1, rel1),
    recall_at_3: recallAt(3, rel1),
    recall_at_5: recallAt(5, rel1),
    recall_at_10: recallAt(10, rel1),
    success_recall_at_10: recallAt(10, rel2),
    mrr_at_10_rel1: r1 ? 1 / r1 : 0,
    mrr_at_10_rel2: r2 ? 1 / r2 : 0,
    ndcg_at_10: ndcg10,
    ndcg_at_10_linear: ndcg10Linear,
    top1_grade: top[0]?.grade ?? 0,
    reformulation_signal: (top[0]?.grade ?? 0) < 2,
  };
}

// ------------------------------------------------------------------ runners

async function runOne(client, root, q) {
  const limit = q.params?.limit ?? 10;
  const lane = q.lane;
  const rec = {
    id: q.id,
    lane,
    difficulty: q.difficulty,
    must_hit: q.must_hit === true,
    negative: q.negative === true,
    query: q.query,
    params: q.params ?? {},
    call: null,
    ms: null,
    us_source: null,
    us_error: null,
    retrieved: [],
    retrieved_count: 0,
    control: null,
    extra: null,
  };

  const t0 = performance.now();
  if (lane === "path" || lane === "ranking-frecency" || lane === "ranking-proximity" || lane === "ranking-boost-ab") {
    const opts = { in: root, limit, git: true };
    if (q.params?.near) opts.near = path.resolve(root, q.params.near);
    if (q.params?.boost === true) opts.boost = true;
    rec.call = `search(${JSON.stringify(q.query)}, in=<root>, limit=${limit}${opts.near ? ", near=" + opts.near : ""}${opts.boost ? ", boost=true" : ""})`;
    const res = await client.search(q.query, opts);
    rec.ms = performance.now() - t0;
    rec.us_source = res.source ?? null;
    rec.us_error = res.ok === false ? String(res.error ?? "not ok") : null;
    rec.retrieved = (res.hits ?? []).map((h) => norm(h.path, root));
    if (lane === "ranking-boost-ab" && q.control_params) {
      const c0 = performance.now();
      const cres = await client.search(q.query, { ...opts, boost: q.control_params.boost === true });
      rec.control = {
        params: q.control_params,
        call: `boost=${q.control_params.boost === true}`,
        ms: performance.now() - c0,
        retrieved: (cres.hits ?? []).map((h) => norm(h.path, root)),
      };
    }
    if (q.params?.mode === "symbol" && q.params?.path_filter) {
      // handled below only for grep lanes; path lanes never carry mode
    }
  } else if (lane === "symbol" && q.params?.path_filter) {
    // K4: intra-file line order. Try file scope first, fall back to root scope.
    const fileScope = path.resolve(root, q.params.path_filter);
    rec.call = `grep(${JSON.stringify(q.query)}, in=${q.params.path_filter}, mode=symbol, limit=${limit})`;
    let used = "file_scope";
    let res;
    try {
      res = await client.grep(q.query, { in: fileScope, limit, mode: "symbol", budget_ms: 2500, context: 0, tag_symbols: true });
      if (!res.ok || !(res.files ?? []).length) throw new Error("file scope empty");
    } catch {
      used = "root_scope";
      res = await client.grep(q.query, { in: root, limit, mode: "symbol", budget_ms: 2500, context: 0, tag_symbols: true });
    }
    rec.ms = performance.now() - t0;
    rec.us_source = res.source ?? null;
    rec.us_error = res.ok === false ? String(res.error ?? "not ok") : null;
    rec.retrieved = (res.files ?? []).map((f) => norm(f.path, root));
    if (used === "root_scope") {
      rec.retrieved = rec.retrieved.filter((p) => p.endsWith("src/client.ts"));
    }
    rec.extra = { scope_used: used, line_order: null };
    const targetFile = (res.files ?? []).find((f) => norm(f.path, root).endsWith("src/client.ts"));
    if (targetFile) {
      const ms = [...(targetFile.matches ?? [])].sort((a, b) => a.line - b.line);
      rec.extra.line_order = ms.slice(0, 3).map((m) => ({ line: m.line, text: (m.text ?? "").trim().slice(0, 120) }));
      rec.extra.first_match_is_class_decl = /class\s+FSearchClient/.test(ms[0]?.text ?? "");
    }
  } else {
    const mode = q.params?.mode ?? "literal";
    let res;
    if (mode === "semantic") {
      rec.call = `searchSemanticIntent(${JSON.stringify(q.query)}, in=<root>, limit=${limit})`;
      const sem = await semanticIntent(client, q.query, { in: root, limit });
      res = { ok: true, files: sem.files ?? [], source: "semantic_intent" };
      rec.extra = { expanded_terms: sem.matchedTokens ?? null, confidence: sem.confidence ?? null };
    } else {
      rec.call = `grep(${JSON.stringify(q.query)}, in=<root>, mode=${mode}, limit=${limit})`;
      res = await client.grep(q.query, { in: root, limit, mode, budget_ms: 2500, context: 0, tag_symbols: mode === "symbol" });
    }
    rec.ms = performance.now() - t0;
    rec.us_source = res.source ?? null;
    rec.us_error = res.ok === false ? String(res.error ?? "not ok") : null;
    rec.retrieved = (res.files ?? []).map((f) => norm(f.path, root));
  }
  rec.retrieved_count = rec.retrieved.length;
  return rec;
}

async function main() {
  requireFixture();
  const judgments = loadJudgments();
  const declaredRoot = process.env.JUDGMENTS_ROOT || judgments.data.corpus.root;
  const cleanRoot = path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", "corpus-0a16e50");
  let root = declaredRoot;
  let corpusSource = "declared-root";
  let cleanMeta = null;
  if (!process.env.JUDGMENTS_ROOT && fs.existsSync(path.join(cleanRoot, ".corpus-meta.json"))) {
    root = cleanRoot;
    corpusSource = "clean-archive";
    cleanMeta = JSON.parse(fs.readFileSync(path.join(cleanRoot, ".corpus-meta.json"), "utf8"));
  }
  if (!fs.existsSync(root)) throw new Error(`judgment corpus root missing: ${root}`);
  const corpusFiles = timeExec("find", [root, "-type", "f"], { timeoutMs: 30000 })
    .stdout.split("\n")
    .filter(Boolean)
    .filter((f) => path.basename(f) !== ".corpus-meta.json").length;
  const isGit = fs.existsSync(path.join(root, ".git"));
  const corpusCommit = isGit
    ? timeExec("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim()
    : (cleanMeta?.commit ?? null);
  const corpusDirty = isGit
    ? timeExec("git", ["status", "--porcelain"], { cwd: root }).stdout.trim().length > 0
    : false;

  await initClientModule();
  const semMod = await import(pathToFileURL(path.join(REPO_ROOT, "src", "semantic.ts")).href);
  semanticIntent = semMod.searchSemanticIntent;
  const client = makeClient({ timeoutMs: 20000 });
  const daemonStatus = await client.status().catch(() => null);
  const preGate = environmentGate(daemonStatus);
  log(`environment gate: ${preGate.status}`);

  const meta = {
    suite: "judgments",
    wave: "wave1/baseline",
    generated_at: utcDate(),
    date_short: utcDateShort(),
    commit: timeExec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim(),
    branch: timeExec("git", ["branch", "--show-current"], { cwd: REPO_ROOT }).stdout.trim(),
    machine: machineInfo(),
    daemon: daemonStatus,
    judgments: {
      path: judgments.path,
      sha256: judgments.sha256,
      schema: judgments.data.schema,
      version: judgments.data.version,
      author: judgments.data.author,
      query_count: judgments.data.queries.length,
      negatives: judgments.data.queries.filter((q) => q.negative === true).length,
      must_hit: judgments.data.queries.filter((q) => q.must_hit === true).length,
    },
    corpus: {
      id: judgments.data.corpus.id,
      root,
      source: corpusSource,
      clean_archive: cleanMeta
        ? { files: cleanMeta.files, tree_sha256: cleanMeta.tree_sha256, generated_at: cleanMeta.generated_at }
        : null,
      files_found: corpusFiles,
      files_declared: judgments.data.corpus.files,
      files_match_declared: corpusFiles === judgments.data.corpus.files,
      commit: corpusCommit,
      dirty: corpusDirty,
      spoiler_note:
        corpusSource === "declared-root"
          ? "WARNING: scoring against the worktree root; it contains bench/judgments/wave1-judgments.json which quotes every query (finding F8)"
          : null,
    },
    metric_definitions: {
      recall_at_k: "rel = expected grade>=1; |rel in top-k| / |rel|",
      success_recall_at_10: "rel = expected grade>=2",
      mrr_at_10_rel2: "1/rank of first grade>=2 result, else 0 (rel1 variant also recorded)",
      ndcg_at_10: "gain=2^grade-1, discount=1/log2(rank+1), IDCG over all expected grades (linear variant recorded)",
      reformulation_signal: "top-1 grade < 2",
      zero_result_rate: "must_hit queries with 0 retrieved / must_hit queries",
      false_positive_rate: "negative queries with retrieved>0 (or, for R3, no actionable error) / negative queries",
    },
    audit_note: "PI_ULTRASEARCH_TEST=1; R3 audit-row detection uses the isolated test audit log window.",
  };

  const snapBefore = auditSnapshot();
  const results = [];

  // K1 precondition: register an open of README.md >=30s before measuring frecency.
  const k1 = judgments.data.queries.find((q) => q.id === "K1");
  if (k1) {
    let opened = null;
    try {
      opened = await client.open(path.join(root, "README.md"));
    } catch (e) {
      opened = `error: ${String(e?.message ?? e)}`;
    }
    meta.frecency_precondition = { open_result: opened, wait_ms: 30000 };
    log(`K1 precondition: open(README.md) -> ${opened}; waiting 30s`);
    await sleep(30000);
  }

  const mustHit = judgments.data.queries.filter((q) => q.must_hit === true);
  const negatives = judgments.data.queries.filter((q) => q.negative === true);

  for (const q of judgments.data.queries) {
    q.expected.__root = root; // non-enumerable in JSON? it will serialize; strip before save
    let rec;
    try {
      rec = await runOne(client, root, q);
    } catch (e) {
      rec = {
        id: q.id,
        lane: q.lane,
        difficulty: q.difficulty,
        must_hit: q.must_hit === true,
        negative: q.negative === true,
        query: q.query,
        params: q.params ?? {},
        call: null,
        ms: null,
        us_source: null,
        us_error: `thrown: ${String(e?.message ?? e)}`,
        retrieved: [],
        retrieved_count: 0,
        control: null,
        extra: null,
        zero_result: true,
      };
    }
    if (q.must_hit === true) {
      rec.score = scoreQuery(rec.retrieved, q.expected, 10);
      rec.zero_result = rec.retrieved_count === 0;
      rec.false_positive = null;
    } else if (q.negative === true) {
      rec.zero_result = rec.retrieved_count === 0;
      // R3 also requires an actionable client-side error.
      if (q.id === "R3") {
        rec.error_class = rec.us_error ? "error_returned" : "no_error";
        rec.false_positive = rec.retrieved_count > 0 || !rec.us_error;
      } else {
        rec.false_positive = rec.retrieved_count > 0;
      }
    }
    if (rec.control) {
      rec.control.score = scoreQuery(rec.control.retrieved, q.expected, 10);
      rec.boost_delta_ndcg10 =
        rec.score && rec.control.score ? rec.score.ndcg_at_10 - rec.control.score.ndcg_at_10 : null;
    }
    results.push(rec);
    log(
      `${rec.id} ${rec.lane} ret=${rec.retrieved_count}` +
        (rec.score
          ? ` r@10=${rec.score.recall_at_10?.toFixed(2)} ndcg=${rec.score.ndcg_at_10?.toFixed(3)} top1=${rec.score.top1_grade}`
          : rec.negative
            ? ` fp=${rec.false_positive}`
            : ""),
    );
    await sleep(60);
  }

  await sleep(150);
  const auditRows = readAuditSince(snapBefore);
  const r3Rows = auditRows.filter((r) => (r.query ?? r.pattern ?? "").includes("(a+)+$"));
  const r3rec = results.find((r) => r.id === "R3");
  if (r3rec) {
    r3rec.audit_row_present = r3Rows.length > 0;
    r3rec.reached_socket_or_recorder = r3Rows.length > 0;
  }
  client.close();

  // ---- aggregates ----------------------------------------------------------
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const scored = results.filter((r) => r.score);
  const agg = {
    must_hit_queries: mustHit.length,
    negatives: negatives.length,
    recall_at_1: mean(scored.map((r) => r.score.recall_at_1)),
    recall_at_3: mean(scored.map((r) => r.score.recall_at_3)),
    recall_at_5: mean(scored.map((r) => r.score.recall_at_5)),
    recall_at_10: mean(scored.map((r) => r.score.recall_at_10)),
    success_recall_at_10: mean(scored.map((r) => r.score.success_recall_at_10)),
    mrr_at_10_rel1: mean(scored.map((r) => r.score.mrr_at_10_rel1)),
    mrr_at_10_rel2: mean(scored.map((r) => r.score.mrr_at_10_rel2)),
    ndcg_at_10: mean(scored.map((r) => r.score.ndcg_at_10)),
    ndcg_at_10_linear: mean(scored.map((r) => r.score.ndcg_at_10_linear)),
    zero_result_rate:
      mustHit.length > 0 ? mustHit.filter((q) => results.find((r) => r.id === q.id)?.zero_result).length / mustHit.length : null,
    false_positive_rate:
      negatives.length > 0
        ? negatives.filter((q) => results.find((r) => r.id === q.id)?.false_positive).length / negatives.length
        : null,
    reformulation_signal: mean(scored.map((r) => (r.score.reformulation_signal ? 1 : 0))),
    reformulation_by_lane: {},
    ndcg_by_lane: {},
  };
  for (const lane of [...new Set(scored.map((r) => r.lane))]) {
    const ls = scored.filter((r) => r.lane === lane);
    agg.reformulation_by_lane[lane] = mean(ls.map((r) => (r.score.reformulation_signal ? 1 : 0)));
    agg.ndcg_by_lane[lane] = mean(ls.map((r) => r.score.ndcg_at_10));
  }
  agg.semantic_ndcg_at_10 = agg.ndcg_by_lane["semantic"] ?? null;

  const acceptanceSource = judgments.data.acceptance?.must_pass_before_any_ranking_claim_ships ?? [];
  const gates = {
    "recall@10 == 1.00 on all must_hit queries": {
      observed: agg.recall_at_10,
      pass: agg.recall_at_10 === 1,
    },
    "zero_result_rate == 0.00 on must_hit queries": {
      observed: agg.zero_result_rate,
      pass: agg.zero_result_rate === 0,
    },
    [`false_positive_rate == 0.00 on the ${negatives.length} negative queries (spec text says 5)`]: {
      observed: agg.false_positive_rate,
      pass: agg.false_positive_rate === 0,
    },
    "nDCG@10 >= 0.75 overall": { observed: agg.ndcg_at_10, pass: agg.ndcg_at_10 !== null && agg.ndcg_at_10 >= 0.75 },
    "nDCG@10 >= 0.60 semantic lane": {
      observed: agg.semantic_ndcg_at_10,
      pass: agg.semantic_ndcg_at_10 !== null && agg.semantic_ndcg_at_10 >= 0.6,
    },
    "reformulation_signal <= 0.20 overall": {
      observed: agg.reformulation_signal,
      pass: agg.reformulation_signal !== null && agg.reformulation_signal <= 0.2,
    },
    "reformulation_signal <= 0.35 per lane": {
      observed: agg.reformulation_by_lane,
      pass: Object.values(agg.reformulation_by_lane).every((v) => v !== null && v <= 0.35),
    },
  };
  agg.acceptance_gates = gates;
  agg.acceptance_all_pass = Object.values(gates).every((g) => g.pass);
  agg.acceptance_source = acceptanceSource;

  // Clean non-serializable helper.
  for (const r of results) {
    // expected.__root was attached to the input object; drop it from output copies
    if (r.expected) delete r.expected.__root;
  }

  const environment = finalizeEnvironmentStatus(preGate, environmentGate(daemonStatus));
  meta.status = environment.status;
  meta.environment = environment;

  const report = { meta, aggregates: agg, queries: results };
  const file = saveJSON("judgments-baseline.json", report);
  // Freeze the exact input set alongside the results.
  fs.writeFileSync(path.join(RESULTS_DIR, "judgments-input.json"), judgments.raw);

  console.log("\n=== JUDGMENT SCORING ===");
  for (const [name, g] of Object.entries(gates)) {
    console.log(`${g.pass ? "PASS" : "FAIL"}  ${name} -> ${JSON.stringify(g.observed)}`);
  }
  console.log(`\noverall: ${agg.acceptance_all_pass ? "ALL GATES PASS" : "GATES FAIL"}  status=${meta.status}`);
  console.log(`recall@1/3/5/10 = ${[agg.recall_at_1, agg.recall_at_3, agg.recall_at_5, agg.recall_at_10].map((x) => x?.toFixed(3)).join(" / ")}`);
  console.log(`MRR@10(rel2)=${agg.mrr_at_10_rel2?.toFixed(3)}  nDCG@10=${agg.ndcg_at_10?.toFixed(3)}  zero=${agg.zero_result_rate}  fp=${agg.false_positive_rate}`);
  console.log(`\nraw JSON: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
