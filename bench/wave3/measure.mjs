#!/usr/bin/env node
// bench/wave3/measure.mjs — run a frozen judgment set against an isolated daemon
// and emit a wave-3 measurement artifact.
//
//   PI_ULTRASEARCH_TEST=1 PI_ULTRASEARCH_SOCKET=<sock> \
//     node bench/wave3/measure.mjs --judgments <f> --corpus <d> --out <f> --label <n>
//
// Metric definitions are copied verbatim from the frozen wave-1 scorer
// (`bench/baseline/judgments.mjs`): grades 3/2/1, recall rel = grade>=1,
// success rel = grade>=2, nDCG gains 2^g-1 with 1/log2(rank+1) discount,
// reformulation = top-1 grade < 2. `recall_at_limit` is measured over the
// full returned list (the frozen wave-2 scorer clamped it to kMax=10 and so
// under-reported `glob_set_completeness`; see docs/wave3/W3-01).

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
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const JUDGMENTS_PATH = opt("judgments", path.join(REPO, "bench", "judgments", "wave1-judgments.json"));
const OUT = opt("out") ?? path.join(REPO, "bench", "wave3", "results", `${opt("label", "run")}.json`);
const LABEL = opt("label", path.basename(OUT, ".json"));
const judgments = JSON.parse(fs.readFileSync(JUDGMENTS_PATH, "utf8"));

// The declared root is the advisor's original worktree (gone); the frozen clean
// archive is the corpus the verifier actually scores against.
const CLEAN_ARCHIVE = path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", "corpus-0a16e50");
const declaredRoot = opt("corpus", judgments.corpus?.root);
const ROOT = declaredRoot && fs.existsSync(declaredRoot) ? declaredRoot : CLEAN_ARCHIVE;
if (!fs.existsSync(ROOT)) throw new Error(`corpus root missing: ${ROOT} (declared: ${declaredRoot})`);

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
const tryExec = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
};

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
    h.update(path.relative(ROOT, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------- scoring (frozen definitions)

function scoreQuery(retrieved, expected, kMax = 10) {
  const grades = new Map(expected.map((e) => [norm(e.path), e.grade]));
  const top = retrieved.slice(0, kMax).map((p, i) => ({ rank: i + 1, path: p, grade: grades.get(p) ?? 0 }));
  const rel1 = expected.filter((e) => e.grade >= 1).map((e) => norm(e.path));
  const rel2 = expected.filter((e) => e.grade >= 2).map((e) => norm(e.path));
  const set1 = new Set(rel1);
  const set2 = new Set(rel2);
  const recallAt = (k, relSet, set) => {
    if (!relSet.length) return null;
    return top.slice(0, k).filter((r) => set.has(r.path)).length / relSet.length;
  };
  const firstRank = (min) => top.find((x) => x.grade >= min)?.rank ?? null;
  const gain = (g) => Math.pow(2, g) - 1;
  const dcg = (list) => list.reduce((a, r, i) => a + gain(r.grade) / Math.log2(i + 2), 0);
  const ideal = [...expected.map((e) => e.grade)].sort((a, b) => b - a).map((g) => ({ grade: g }));
  const idcg = dcg(ideal);
  const r1 = firstRank(1);
  const r2 = firstRank(2);
  return {
    top10: top,
    recall_at_1: recallAt(1, rel1, set1),
    recall_at_3: recallAt(3, rel1, set1),
    recall_at_5: recallAt(5, rel1, set1),
    recall_at_10: recallAt(10, rel1, set1),
    success_recall_at_10: recallAt(10, rel2, set2),
    mrr_at_10_rel1: r1 ? 1 / r1 : 0,
    mrr_at_10_rel2: r2 ? 1 / r2 : 0,
    ndcg_at_10: idcg > 0 ? dcg(top) / idcg : null,
    top1_grade: top[0]?.grade ?? 0,
    reformulation_signal: (top[0]?.grade ?? 0) < 2,
    // Over the FULL returned list: the quantity `glob_set_completeness` means.
    recall_at_limit: rel1.length ? retrieved.filter((p) => set1.has(p)).length / rel1.length : null,
    // The frozen wave-2 scorer's value, kept so the drift is auditable.
    recall_at_limit_frozen_kmax10: rel1.length ? retrieved.slice(0, kMax).filter((p) => set1.has(p)).length / rel1.length : null,
  };
}

// ---------------------------------------------------------------- runner
// Dispatch copied from the frozen wave-1 runner (bench/baseline/judgments.mjs):
// the four path-style lanes use `search`; the `symbol` lane's `path_filter` row
// greps one file; every other lane greps with `mode` defaulting to `literal`.

async function runOne(client, q) {
  const limit = q.params?.limit ?? 10;
  const lane = q.lane;
  const rec = {
    id: q.id,
    lane,
    difficulty: q.difficulty ?? null,
    must_hit: q.must_hit === true,
    negative: q.negative === true,
    query: q.query,
    params: q.params ?? {},
    call: null,
    ms: null,
    source: null,
    error: null,
    retrieved: [],
    matches: {},
    extra: null,
    control: null,
  };
  const t0 = performance.now();
  try {
    if (lane === "path" || lane === "ranking-frecency" || lane === "ranking-proximity" || lane === "ranking-boost-ab") {
      const opts = { in: ROOT, limit, git: true };
      if (q.params?.near) opts.near = path.resolve(ROOT, q.params.near);
      if (q.params?.boost === true) opts.boost = true;
      rec.call = `search(${JSON.stringify(q.query)}, in=<root>, limit=${limit}${opts.near ? ", near=" + q.params.near : ""}${opts.boost ? ", boost=true" : ""})`;
      const res = await client.search(q.query, opts);
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.hits ?? []).map((h) => norm(h.path));
      if (lane === "ranking-boost-ab" && q.control_params) {
        const cres = await client.search(q.query, { ...opts, boost: q.control_params.boost === true });
        rec.control = { params: q.control_params, retrieved: (cres.hits ?? []).map((h) => norm(h.path)) };
      }
    } else if (lane === "symbol" && q.params?.path_filter) {
      const fileScope = path.resolve(ROOT, q.params.path_filter);
      rec.call = `grep(${JSON.stringify(q.query)}, in=${q.params.path_filter}, mode=symbol, limit=${limit})`;
      let used = "file_scope";
      let res;
      try {
        res = await client.grep(q.query, { in: fileScope, limit, mode: "symbol", budget_ms: 2500, context: 0, tag_symbols: true });
        if (!res.ok || !(res.files ?? []).length) throw new Error("file scope empty");
      } catch {
        used = "root_scope";
        res = await client.grep(q.query, { in: ROOT, limit, mode: "symbol", budget_ms: 2500, context: 0, tag_symbols: true });
      }
      rec.source = res.source ?? null;
      rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
      rec.retrieved = (res.files ?? []).map((f) => norm(f.path));
      if (used === "root_scope") rec.retrieved = rec.retrieved.filter((p) => p.endsWith("src/client.ts"));
      const target = (res.files ?? []).find((f) => norm(f.path).endsWith("src/client.ts"));
      const lineOrder = target ? [...(target.matches ?? [])].sort((a, b) => a.line - b.line).slice(0, 3).map((m) => (m.text ?? "").trim().slice(0, 120)) : null;
      rec.extra = { scope_used: used, line_order: lineOrder, first_match_is_class_decl: /class\s+FSearchClient/.test(lineOrder?.[0] ?? "") };
    } else {
      const mode = q.params?.mode ?? "literal";
      if (mode === "semantic") {
        rec.call = `searchSemanticIntent(${JSON.stringify(q.query)}, in=<root>, limit=${limit})`;
        const sem = await searchSemanticIntent(client, q.query, { in: ROOT, limit });
        rec.source = "semantic_intent";
        rec.retrieved = (sem.files ?? []).map((f) => norm(f.path));
        rec.matches = Object.fromEntries((sem.files ?? []).map((f) => [norm(f.path), (f.matches ?? []).map((m) => (m.text ?? "").trim())]));
      } else {
        rec.call = `grep(${JSON.stringify(q.query)}, in=<root>, mode=${mode}, limit=${limit})`;
        const res = await client.grep(q.query, { in: ROOT, limit, mode, budget_ms: 2500, context: 0, tag_symbols: mode === "symbol" });
        rec.source = res.source ?? null;
        rec.error = res.ok === false ? String(res.error ?? "not ok") : null;
        rec.retrieved = (res.files ?? []).map((f) => norm(f.path));
        rec.matches = Object.fromEntries((res.files ?? []).map((f) => [norm(f.path), (f.matches ?? []).map((m) => (m.text ?? "").trim())]));
      }
    }
  } catch (e) {
    rec.error = String(e?.message ?? e);
  }
  rec.ms = performance.now() - t0;
  rec.zero_result = rec.retrieved.length === 0;
  rec.false_positive = q.negative ? rec.retrieved.length > 0 : null;
  return rec;
}

// ---------------------------------------------------------------- run

const client = new UltraSearchClient({ timeoutMs: 20000 });
// A freshly spawned daemon answers `status` before it has built its content
// index, so a grep can legitimately return 0. Wait for the index to appear and
// stop growing before measuring anything.
const wantDocs = Number(opt("wait-docs", 0));
{
  const deadline = Date.now() + Number(opt("wait-ms", 60000));
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const s = await client.status().catch(() => null);
    const docs = s?.content_docs ?? 0;
    const pending = s?.content_pending ?? 0;
    if (docs === last && docs >= wantDocs && pending === 0) {
      if (++stable >= 3) break;
    } else stable = 0;
    last = docs;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (wantDocs > 0 && last < wantDocs) throw new Error(`content index did not reach ${wantDocs} docs (saw ${last})`);
  process.stderr.write(`[w3] warm-up: content_docs=${last}\n`);
}

const status = await client.status().catch(() => null);
const rows = [];
let seq = 0;
for (const q of judgments.queries) {
  const rec = await runOne(client, q);
  rec.score = scoreQuery(rec.retrieved, (q.expected ?? []).map((e) => ({ path: e.path, grade: e.grade })));
  rows.push(rec);
  process.stderr.write(`[w3] ${rec.id} ${rec.lane} n=${rec.retrieved.length} ms=${rec.ms.toFixed(2)}${rec.error ? " ERR " + rec.error.slice(0, 60) : ""}\n`);
  if (++seq % 10 === 0) await new Promise((r) => setTimeout(r, 50));
}
client.close();

const laneNames = [...new Set(rows.map((r) => r.lane))];
const mustHit = rows.filter((r) => r.must_hit && !r.negative);
const negatives = rows.filter((r) => r.negative);
const metricBlock = (rs) => ({
  n: rs.length,
  recall10: mean(rs.map((r) => r.score.recall_at_10).filter((v) => v !== null)),
  recall5: mean(rs.map((r) => r.score.recall_at_5).filter((v) => v !== null)),
  recall3: mean(rs.map((r) => r.score.recall_at_3).filter((v) => v !== null)),
  success3: mean(rs.map((r) => r.score.recall_at_3).filter((v) => v !== null)),
  success10: mean(rs.map((r) => r.score.success_recall_at_10).filter((v) => v !== null)),
  mrr10: mean(rs.map((r) => r.score.mrr_at_10_rel1)),
  ndcg10: mean(rs.map((r) => r.score.ndcg_at_10).filter((v) => v !== null)),
  zero_result_rate: rs.length ? rs.filter((r) => r.zero_result).length / rs.length : null,
  ms_p50: pct(rs.map((r) => r.ms), 50),
  ms_p95: pct(rs.map((r) => r.ms), 95),
  ms_max: Math.max(...rs.map((r) => r.ms), 0),
});
const agg = {
  all: metricBlock(mustHit),
  recall_at_10: mean(mustHit.map((r) => r.score.recall_at_10).filter((v) => v !== null)),
  ndcg_at_10: mean(mustHit.map((r) => r.score.ndcg_at_10).filter((v) => v !== null)),
  mrr_at_10_rel1: mean(mustHit.map((r) => r.score.mrr_at_10_rel1)),
  zero_result_rate: mustHit.length ? mustHit.filter((r) => r.zero_result).length / mustHit.length : null,
  false_positive_rate: negatives.length ? negatives.filter((r) => r.false_positive).length / negatives.length : null,
  reformulation_signal: mean(mustHit.map((r) => (r.score.reformulation_signal ? 1 : 0))),
  reformulation_by_lane: {},
  ndcg_by_lane: {},
  recall10_by_lane: {},
  ms_p50: pct(mustHit.map((r) => r.ms), 50),
  ms_p95: pct(mustHit.map((r) => r.ms), 95),
  negatives: negatives.length,
  neg_rows: negatives.filter((r) => r.false_positive).map((r) => ({ id: r.id, returned: r.retrieved.slice(0, 5) })),
};
for (const lane of laneNames) {
  const ls = mustHit.filter((r) => r.lane === lane);
  agg.reformulation_by_lane[lane] = mean(ls.map((r) => (r.score.reformulation_signal ? 1 : 0)));
  agg.ndcg_by_lane[lane] = mean(ls.map((r) => r.score.ndcg_at_10).filter((v) => v !== null));
  agg.recall10_by_lane[lane] = mean(ls.map((r) => r.score.recall_at_10).filter((v) => v !== null));
}

// ---------------------------------------------------------------- gate + provenance

const pmset = tryExec("pmset", ["-g", "batt"]);
const onAc = /AC Power/.test(pmset);
const [l1] = os.loadavg();
const competing = tryExec("ps", ["-Ao", "comm="]).split("\n").map((s) => s.trim().split("/").pop()).filter((b) => b === "cargo" || b === "rustc");
const gatePass = onAc && l1 < 1.5 && competing.length === 0;
const gate = {
  status: gatePass ? "final" : "provisional",
  gate_pass: gatePass,
  rule: "AC power AND 1-min load < 1.5 AND no cargo/rustc process",
  on_ac: onAc,
  load1: Number(l1.toFixed(2)),
  competing_processes: competing,
  checked_at: new Date().toISOString(),
};

const SOCKET = process.env.PI_ULTRASEARCH_SOCKET ?? path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock");
const owners = tryExec("lsof", ["-t", SOCKET]).split("\n").filter(Boolean);
const servers = tryExec("pgrep", ["-f", "ultrasearch serve"]).split("\n").filter(Boolean);
const st = status ?? {};
const daemon = {
  socket: SOCKET,
  socket_owner_pid: owners.length ? Number(owners[0]) : null,
  socket_owner_count: owners.length,
  serve_process_count: servers.length,
  single_socket_owner: owners.length === 1 && servers.length === 1,
  entries: st.entries ?? null,
  content_docs: st.content_docs ?? null,
  content_pending: st.content_pending ?? null,
  index_bytes: st.index_bytes ?? null,
  full_disk_access: st.full_disk_access ?? null,
  staleness_ms: st.staleness_ms ?? null,
};
const corpusFiles = walk(ROOT).filter((f) => path.basename(f) !== ".corpus-meta.json");
const corpus = {
  root: ROOT,
  files: corpusFiles.length,
  bytes: corpusFiles.reduce((a, f) => a + fs.statSync(f).size, 0),
  tree_sha256: treeHash(corpusFiles),
};
const engineBin = process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch");
const engineSha = fs.existsSync(engineBin) ? crypto.createHash("sha256").update(fs.readFileSync(engineBin)).digest("hex") : null;

const artifact = {
  meta: {
    suite: "wave3-measure",
    label: LABEL,
    generated_at: new Date().toISOString(),
    status: gate.status === "final" && daemon.single_socket_owner ? "final" : "provisional",
    gate,
    daemon_provenance: daemon,
    head_commit: tryExec("git", ["-C", REPO, "rev-parse", "HEAD"]) || null,
    engine: { bin: engineBin, sha256: engineSha },
    client_tree_dirty: tryExec("git", ["-C", REPO, "status", "--porcelain"]).length > 0,
    judgments: { path: path.relative(REPO, JUDGMENTS_PATH), sha256: crypto.createHash("sha256").update(fs.readFileSync(JUDGMENTS_PATH)).digest("hex"), queries: judgments.queries.length },
    corpus,
    metric_definitions: {
      recall10: "mean over must-hit rows of |expected(grade>=1) ∩ top10| / |expected(grade>=1)|",
      ndcg10: "mean nDCG@10, gains 2^g-1, discount 1/log2(rank+1), IDCG over all expected grades",
      reformulation_signal: "share of must-hit rows whose top-1 grade < 2",
      recall_at_limit: "over the FULL returned list (no kMax clamp)",
    },
  },
  aggregates: agg,
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
      engine_sha: engineSha?.slice(0, 16),
      corpus_files: corpus.files,
      recall10: agg.recall_at_10,
      ndcg10: agg.ndcg_at_10,
      mrr: agg.mrr_at_10_rel1,
      zero: agg.zero_result_rate,
      fp: agg.false_positive_rate,
      reformulation: agg.reformulation_signal,
      reformulation_by_lane: agg.reformulation_by_lane,
      ms_p50: agg.ms_p50,
      ms_p95: agg.ms_p95,
    },
    null,
    1,
  ),
);
