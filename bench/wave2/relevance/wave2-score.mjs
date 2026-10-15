// bench/wave2/relevance/wave2-score.mjs
// LOCAL iteration scorer for bench/judgments/wave2-judgments.json.
// Not the official instrument: the verifier owns the certified scorer extension.
// It implements the metric definitions of the wave-1 scorer plus the wave-2
// lane extensions (symbol assertions / not_expected, semantic, paired controls)
// so engine and client changes can be compared before/after locally.
//
// Usage:
//   PI_ULTRASEARCH_TEST=1 node bench/wave2/relevance/wave2-score.mjs \
//     --label before --repo /tmp/us-w2-baseline [--mode harness|live] [--engine-bin PATH] [--lane symbol-ast]
//
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_ULTRASEARCH_TEST = "1";

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const LABEL = arg("label", "run");
const REPO = path.resolve(arg("repo", path.resolve(HERE, "../../..")));
const MODE = arg("mode", "harness");
const ENGINE_BIN = arg("engine-bin", null);
const ONLY_LANE = arg("lane", null);
const OUT_DIR = path.join(REPO, "bench", "results", "wave2", "relevance");
fs.mkdirSync(OUT_DIR, { recursive: true });

const JUDGMENTS_PATH = path.join(REPO, "bench", "judgments", "wave2-judgments.json");
const judgments = JSON.parse(fs.readFileSync(JUDGMENTS_PATH, "utf8"));
const ROOT = judgments.corpus.root;

// ---------------------------------------------------------------- environment
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
function envBlock(daemonStatus) {
  const batt = sh("pmset", ["-g", "batt"]);
  const onAc = /\bAC Power\b/.test(batt);
  const pct = (batt.match(/(\d+)%/) ?? [])[1] ?? null;
  const loadavg = os.loadavg();
  const procs = sh("ps", ["-Ao", "pid=,comm="]);
  const cargo = procs.split("\n").filter((l) => /\/(cargo|rustc)$/.test(l.trim().split(/\s+/)[1] ?? ""));
  return {
    gate_rule: "AC power AND 1-min load < 1.5 AND no cargo/rustc process",
    checks: { ac_power: onAc, load1_lt_gate: loadavg[0] < 1.5, no_cargo_rustc: cargo.length === 0 },
    power: { on_ac: onAc, percent: pct ? Number(pct) : null, raw: batt.slice(0, 120) },
    loadavg,
    competing_processes: cargo.slice(0, 5),
    daemon_status: daemonStatus ?? null,
  };
}
function gatePass(env) {
  return env.checks.ac_power && env.checks.load1_lt_gate && env.checks.no_cargo_rustc;
}

// ------------------------------------------------------------------- metrics
const norm = (p) => (p.startsWith(ROOT) ? p.slice(ROOT.length).replace(/^\//, "") : p.startsWith("/") ? p : p);

function scoreQuery(retrieved, expected, kMax = 10) {
  const grades = new Map(expected.map((e) => [e.path, e.grade]));
  const top = retrieved.slice(0, kMax).map((p, i) => ({ rank: i + 1, path: p, grade: grades.get(p) ?? 0 }));
  const rel1 = expected.filter((e) => e.grade >= 1).map((e) => e.path);
  const rel2 = expected.filter((e) => e.grade >= 2).map((e) => e.path);
  const recallAt = (k, rel) => {
    if (!rel.length) return null;
    const set = new Set(rel);
    return top.slice(0, k).filter((r) => set.has(r.path)).length / rel.length;
  };
  const firstRank = (min) => {
    const r = top.find((x) => x.grade >= min);
    return r ? r.rank : null;
  };
  const gain = (g) => Math.pow(2, g) - 1;
  const dcg = (list) => list.reduce((a, r, i) => a + gain(r.grade) / Math.log2(i + 2), 0);
  const ideal = [...expected.map((e) => e.grade)].sort((a, b) => b - a).map((g) => ({ grade: g }));
  const idcg = dcg(ideal);
  return {
    recall_at_1: recallAt(1, rel1),
    recall_at_3: recallAt(3, rel1),
    recall_at_5: recallAt(5, rel1),
    recall_at_10: recallAt(10, rel1),
    success_recall_at_3: recallAt(3, rel2),
    mrr_at_10: firstRank(2) ? 1 / firstRank(2) : 0,
    ndcg_at_10: idcg > 0 ? dcg(top) / idcg : null,
    top1_grade: top[0]?.grade ?? 0,
    reformulation: (top[0]?.grade ?? 0) < 2,
  };
}

// --------------------------------------------------------------- daemon setup
const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src/client.ts")).href);
const { searchSemanticIntent } = await import(pathToFileURL(path.join(REPO, "src/semantic.ts")).href);

let harness = null;
let clientOpts = { timeoutMs: 20000, autoSpawnDaemon: false };
if (MODE === "harness") {
  if (ENGINE_BIN) process.env.ULTRASEARCH_ENGINE_BIN = ENGINE_BIN;
  const { EngineHarness, until } = await import(pathToFileURL(path.join(REPO, "test/engine/harness.mjs")).href);
  harness = new EngineHarness({ root: ROOT });
  await harness.start();
  const ready = await until(
    async () => {
      const s = await harness.status().catch(() => null);
      return s?.ok && (s.content_pending ?? 0) === 0 ? s : null;
    },
    { timeoutMs: 120_000 }
  );
  if (!ready) throw new Error("harness daemon did not finish indexing the corpus");
  clientOpts = { ...clientOpts, socketPath: harness.socket };
}
const client = new UltraSearchClient(clientOpts);
const status = await client.status().catch(() => null);
const env = envBlock(status);

// ------------------------------------------------------------------ runners
async function runQuery(q) {
  const lane = q.lane;
  const limit = q.params?.limit ?? 10;
  const rec = { id: q.id, lane, sub_lane: q.sub_lane ?? null, negative: q.negative === true, query: q.query, params: q.params ?? {}, retrieved: [], ms: null, error: null, extra: null };
  const t0 = performance.now();
  try {
    if (lane === "symbol-ast") {
      const res = await client.grep(q.query, { in: ROOT, limit, mode: "symbol", tag_symbols: true, budget_ms: 2500, context: 0 });
      rec.retrieved = (res.files ?? []).map((f) => norm(f.path));
      rec.error = res.ok ? null : String(res.error ?? "not ok");
      rec.source = res.source ?? null;
      const assertions = [];
      for (const a of q.symbol_assertions ?? []) {
        const idx = rec.retrieved.indexOf(a.path);
        const file = (res.files ?? []).find((f) => norm(f.path) === a.path);
        const first = file?.matches?.[0]?.text ?? null;
        assertions.push({
          path: a.path,
          file_rank: idx >= 0 ? idx + 1 : null,
          first_match: first ? first.trim().slice(0, 160) : null,
          first_match_matches: first != null && a.first_match_matches ? new RegExp(a.first_match_matches).test(first.trim()) : null,
          expect_file_rank: a.expect_file_rank ?? null,
        });
      }
      rec.extra = {
        assertions,
        not_expected_returned: (q.not_expected ?? []).filter((n) => rec.retrieved.includes(n.path)).map((n) => n.path),
        declaration_rank1: assertions.every((a) => a.expect_file_rank == null || a.file_rank === a.expect_file_rank),
      };
    } else if (lane === "semantic-paraphrase") {
      const res = await searchSemanticIntent(client, q.query, { in: ROOT, limit });
      rec.retrieved = (res.files ?? []).map((f) => norm(f.path));
      rec.extra = { confidence: res.confidence ?? null, abstained: res.evidence?.abstained ?? null, coverage_ratio: res.evidence?.coverage_ratio ?? null, reason: res.evidence?.reason ?? null, expanded: (res.matchedTokens ?? []).slice(0, 14) };
    } else if (q.params?.mode === "literal" || q.params?.mode === "regex" || q.params?.mode === "symbol") {
      const res = await client.grep(q.query, { in: ROOT, limit, mode: q.params.mode, budget_ms: 2500, context: 0 });
      rec.retrieved = (res.files ?? []).map((f) => norm(f.path));
      rec.error = res.ok ? null : String(res.error ?? "not ok");
      rec.source = res.source ?? null;
    } else {
      const opts = { in: ROOT, limit, git: q.params?.git === true };
      if (q.params?.near) opts.near = path.join(ROOT, q.params.near);
      if (q.params?.boost === true) opts.boost = true;
      const res = await client.search(q.query, opts);
      rec.retrieved = (res.hits ?? []).map((h) => norm(h.path));
      rec.error = res.ok ? null : String(res.error ?? "not ok");
      rec.source = res.source ?? null;
      rec.extra = { hit_vectors: (res.hits ?? []).map((h) => ({ path: norm(h.path), score: h.score ?? null, near: h.near ?? null, boost: h.boost ?? null, def: h.def ?? null, match: h.match ?? null, git: h.git ?? null, explain: h.explain ?? null })) };
      rec.search_options = opts.near ? { near: q.params.near, boost: q.params.boost === true } : { boost: q.params.boost === true };
    }
  } catch (e) {
    rec.error = `thrown: ${String(e?.message ?? e)}`;
  }
  rec.ms = performance.now() - t0;
  if (q.negative === true) {
    rec.zero_result = rec.retrieved.length === 0;
    rec.false_positive =
      q.id === "SY12"
        ? rec.retrieved.length > 0
        : rec.retrieved.length > 0;
  } else if (q.expected && q.expected.length) {
    const k = q.id === "RS02" ? limit : 10;
    rec.score = scoreQuery(rec.retrieved, q.expected, k);
    rec.zero_result = rec.retrieved.length === 0;
  } else if (q.must_hit) {
    rec.zero_result = rec.retrieved.length === 0;
  }
  return rec;
}

// ------------------------------------------------------------------- run all
const queries = judgments.queries.filter((q) => !ONLY_LANE || q.lane === ONLY_LANE);
const results = [];
for (const q of queries) {
  const rec = await runQuery(q);
  results.push(rec);
  const s = rec.score;
  console.log(`${rec.id.padEnd(5)} ${rec.lane.padEnd(20)} ret=${String(rec.retrieved.length).padStart(2)} ms=${Math.round(rec.ms)}${s ? ` r@10=${s.recall_at_10?.toFixed(2)} s@3=${s.success_recall_at_3?.toFixed(2)} ndcg=${s.ndcg_at_10?.toFixed(3)}` : rec.negative ? ` fp=${rec.false_positive}` : ""}`);
  await new Promise((r) => setTimeout(r, 20));
}
if (harness) harness.stop();
client.close();

// ---------------------------------------------------------------- aggregates
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const byLane = {};
for (const lane of [...new Set(results.map((r) => r.lane))]) {
  const rows = results.filter((r) => r.lane === lane);
  const scored = rows.filter((r) => r.score);
  const mustHit = rows.filter((r) => !r.negative && (r.must_hit || r.score));
  const negatives = rows.filter((r) => r.negative);
  const top3doc = scored.map((r) => {
    const t3 = r.retrieved.slice(0, 3);
    return t3.length ? t3.filter((p) => /\.(md|markdown)$/.test(p)).length / t3.length : null;
  }).filter((x) => x !== null);
  byLane[lane] = {
    n: rows.length,
    must_hit: mustHit.length,
    negatives: negatives.length,
    recall_at_10: mean(scored.map((r) => r.score.recall_at_10).filter((x) => x !== null)),
    success_recall_at_3: mean(scored.map((r) => r.score.success_recall_at_3).filter((x) => x !== null)),
    mrr_at_10: mean(scored.map((r) => r.score.mrr_at_10).filter((x) => x !== null)),
    ndcg_at_10: mean(scored.map((r) => r.score.ndcg_at_10).filter((x) => x !== null)),
    zero_result_rate: mustHit.length ? mustHit.filter((r) => r.zero_result).length / mustHit.length : null,
    false_positive_rate: negatives.length ? negatives.filter((r) => r.false_positive).length / negatives.length : null,
    ms_p50: (() => { const v = rows.map((r) => r.ms).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })(),
    ms_p95: (() => { const v = rows.map((r) => r.ms).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null; })(),
    top3_doc_share: mean(top3doc),
  };
}
const scoredAll = results.filter((r) => r.score);
const negativesAll = results.filter((r) => r.negative);
const mustHitAll = results.filter((r) => !r.negative && (r.must_hit || r.score));
const aggregates = {
  overall: {
    recall_at_10: mean(scoredAll.map((r) => r.score.recall_at_10).filter((x) => x !== null)),
    success_recall_at_3: mean(scoredAll.map((r) => r.score.success_recall_at_3).filter((x) => x !== null)),
    mrr_at_10: mean(scoredAll.map((r) => r.score.mrr_at_10).filter((x) => x !== null)),
    ndcg_at_10: mean(scoredAll.map((r) => r.score.ndcg_at_10).filter((x) => x !== null)),
    zero_result_rate: mustHitAll.length ? mustHitAll.filter((r) => r.zero_result).length / mustHitAll.length : null,
    false_positive_rate: negativesAll.length ? negativesAll.filter((r) => r.false_positive).length / negativesAll.length : null,
  },
  by_lane: byLane,
};

const out = {
  meta: {
    suite: "wave2-judgments",
    label: LABEL,
    repo: REPO,
    repo_commit: sh("git", ["rev-parse", "HEAD"]) || null,
    repo_branch: (() => { try { return execFileSync("git", ["branch", "--show-current"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { return null; } })(),
    mode: MODE,
    engine_bin: MODE === "harness" ? process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine/target/release/ultrasearch") : "live-daemon",
    judgments_sha256: crypto.createHash("sha256").update(fs.readFileSync(JUDGMENTS_PATH)).digest("hex"),
    corpus: { root: ROOT, id: judgments.corpus.id, files: judgments.corpus.files },
    environment: env,
    status: gatePass(env) ? "final" : "provisional",
    generated_at: new Date().toISOString(),
  },
  aggregates,
  queries: results,
};
function require0() {}

const file = path.join(OUT_DIR, `wave2-${LABEL}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nstatus=${out.meta.status}  raw JSON: ${file}`);
console.log("overall:", JSON.stringify(aggregates.overall));
for (const [lane, s] of Object.entries(byLane)) {
  console.log(`  ${lane.padEnd(20)} r@10=${s.recall_at_10?.toFixed(3)} s@3=${s.success_recall_at_3?.toFixed(3)} ndcg=${s.ndcg_at_10?.toFixed(3)} mrr=${s.mrr_at_10?.toFixed(3)} zero=${s.zero_result_rate} fp=${s.false_positive_rate} p50=${Math.round(s.ms_p50)}ms p95=${Math.round(s.ms_p95)}ms docshare=${s.top3_doc_share?.toFixed(2)}`);
}
