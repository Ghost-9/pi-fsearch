#!/usr/bin/env node
// bench/wave3/expectation-audit.mjs — ground-truth every expected path the frozen
// wave-1 judgment set asks for, against the corpus the verifier scores.
//
//   node bench/wave3/expectation-audit.mjs [--results <artifact.json>] [--out <f>]
//
// Why: the gate `recall@10 == 1.00 on all must_hit queries` counts every
// expectation with grade >= 1. Some of those expectations name a file that does
// not contain the query term, or ask a path lane for a content mention. Those
// are unreachable for any implementation, and the gate cannot distinguish them
// from a file the tool failed to find. This script separates the two, with a
// reproduction for each verdict, so a recall number can be read honestly.
//
// Classifications (per missing expected path):
//   absent-file          the path is not in the corpus
//   absent-string        the file is in the corpus and the query term is not in
//                        it (for a grep lane: no literal/regex match; for a
//                        symbol lane: the identifier never appears)
//   path-lane-content    a path lane whose expected file only mentions the term
//                        in its content, never in its path
//   symbol-lane-reference a symbol lane whose expected file references the
//                        identifier but does not declare it
//   reachable            the file exists and holds the term; a real recall miss
//
// `audited_recall_at_10` recomputes the metric over the expectations that are
// reachable.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const JUDGMENTS = JSON.parse(fs.readFileSync(opt("judgments", path.join(REPO, "bench", "judgments", "wave1-judgments.json")), "utf8"));
const CORPUS = opt(
  "corpus",
  [
    path.join(process.env.HOME, ".cache", "ultrasearch", "corpus", "wave1-0a16e50"),
    path.join(process.env.HOME, ".cache", "pi-ultrasearch-bench", "corpus-0a16e50"),
  ].find((p) => fs.existsSync(p)),
);
const RESULTS = opt("results", path.join(REPO, "bench", "wave3", "results", "rank-r2.json"));
const OUT = opt("out", path.join(REPO, "bench", "wave3", "results", "expectation-audit.json"));
const artifact = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
const rows = new Map(artifact.rows.map((r) => [r.id, r]));

const exists = (rel) => fs.existsSync(path.join(CORPUS, rel));
const read = (rel) => (exists(rel) ? fs.readFileSync(path.join(CORPUS, rel), "utf8") : null);

/** Does the file's path carry the query as a component substring? */
function pathMatches(relPath, query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['^!]/, "").replace(/\$$/, "").replace(/[\\()|]/g, ""));
  const p = relPath.toLowerCase();
  return tokens.length > 0 && tokens.every((t) => t.length > 0 && p.includes(t.toLowerCase()));
}

/** Does the file's content hold the query, under that lane's matching rule? */
function contentMatches(lane, query, text, mode) {
  if (text === null) return false;
  if (lane === "grep-regex" || mode === "regex") {
    let re;
    try {
      re = new RegExp(query, "m");
    } catch {
      return false;
    }
    return re.test(text);
  }
  const needle = query.trim();
  const insensitive = !/[A-Z]/.test(needle);
  return insensitive ? text.toLowerCase().includes(needle.toLowerCase()) : text.includes(needle);
}

/** Is the identifier declared in the file (the same lexical test the engine uses)? */
function declares(text, name) {
  if (text === null) return false;
  const DEFINERS = "(fn|func|function|def|class|struct|enum|trait|interface|type|typealias|impl|let|const|var|val|static|module|mod|protocol|extension|define|typedef|union|object|record|namespace|actor)";
  const MODS = "(public|private|protected|internal|fileprivate|open|static|async|readonly|abstract|override|final|sealed|declare|export|default|pub|unsafe|extern)";
  const kw = new RegExp(`(?:${DEFINERS})(?:<[^>\\n]*>)?[ \\t*&]+(?:mut[ \\t]+)?${name}(?!\\w)`);
  const mod = new RegExp(`(?:${MODS})[ \\t]+${name}(?!\\w)`);
  return kw.test(text) || mod.test(text);
}

const audited = [];
const summary = { total_missing: 0, by_class: {}, rows_affected: 0, audited_recall_at_10: 0 };

for (const q of JUDGMENTS.queries) {
  if (q.must_hit !== true || q.negative === true) continue;
  const rec = rows.get(q.id);
  if (!rec) continue;
  const rel = (q.expected ?? []).filter((e) => e.grade >= 1);
  const got = new Set(rec.retrieved);
  const top10 = new Set(rec.retrieved.slice(0, 10));
  const laneIsPath = ["path", "ranking-frecency", "ranking-proximity", "ranking-boost-ab"].includes(q.lane);
  const laneIsSymbol = q.lane === "symbol";
  const misses = [];
  for (const e of rel) {
    if (top10.has(e.path)) continue;
    const text = read(e.path);
    let klass;
    if (!exists(e.path)) klass = "absent-file";
    else if (laneIsSymbol && !declares(text, q.query) && text.includes(q.query)) klass = "symbol-lane-reference";
    else if (laneIsSymbol && !text.includes(q.query)) klass = "absent-string";
    else if (laneIsPath && !pathMatches(e.path, q.query) && contentMatches(q.lane, q.query, text, q.params?.mode)) klass = "path-lane-content";
    else if (laneIsPath && !pathMatches(e.path, q.query) && !contentMatches(q.lane, q.query, text, q.params?.mode)) klass = "absent-string";
    else if (!contentMatches(q.lane, q.query, text, q.params?.mode)) klass = "absent-string";
    else klass = "reachable";
    summary.total_missing += 1;
    summary.by_class[klass] = (summary.by_class[klass] ?? 0) + 1;
    misses.push({
      id: q.id,
      lane: q.lane,
      query: q.query,
      expected: e.path,
      grade: e.grade,
      in_returned: got.has(e.path),
      rank_in_returned: got.has(e.path) ? [...got].indexOf(e.path) + 1 : null,
      class: klass,
      path_matches_query: pathMatches(e.path, q.query),
      content_matches_query: contentMatches(q.lane, q.query, text, q.params?.mode),
      declares_query: laneIsSymbol ? declares(text, q.query) : null,
      reproduce: `${laneIsSymbol ? "rg -n" : "rg -l"} '${q.query.replace(/'/g, "'\\''")}' ${CORPUS}/${e.path}   # see also: ls ${CORPUS}/${e.path}`,
    });
  }
  const reachable = new Set(rel.filter((e) => !misses.some((m) => m.expected === e.path && m.class !== "reachable")).map((e) => e.path));
  const hitReachable = [...top10].filter((p) => reachable.has(p)).length;
  audited.push({
    id: q.id,
    lane: q.lane,
    query: q.query,
    expected_rel: rel.length,
    returned: rec.retrieved.length,
    recall_at_10: rec.score.recall_at_10,
    unreachable_expected: rel.length - reachable.size,
    reachable_expected: reachable.size,
    audited_recall_at_10: reachable.size ? hitReachable / reachable.size : null,
    misses,
  });
  if (misses.length) summary.rows_affected += 1;
}

const mustHit = audited.filter((r) => r.expected_rel > 0);
summary.audited_recall_at_10 = mustHit.reduce((a, r) => a + (r.audited_recall_at_10 ?? 0), 0) / mustHit.length;
summary.reported_recall_at_10 = mustHit.reduce((a, r) => a + r.recall_at_10, 0) / mustHit.length;
summary.rows = mustHit.length;

const report = {
  meta: {
    suite: "wave3-expectation-audit",
    generated_at: new Date().toISOString(),
    corpus: CORPUS,
    judgments: path.relative(REPO, opt("judgments", "bench/judgments/wave1-judgments.json")),
    results: path.relative(REPO, RESULTS),
    engine_sha256: artifact.meta?.engine?.sha256 ?? null,
    head_commit: artifact.meta?.head_commit ?? null,
    method: "every expectation with grade>=1 that is absent from the top 10 is classified against the corpus file itself (exists / path match / content match / declares)",
  },
  summary,
  rows: audited,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

console.log(`reported  recall@10 = ${summary.reported_recall_at_10.toFixed(4)}`);
console.log(`audited   recall@10 = ${summary.audited_recall_at_10.toFixed(4)}  (over ${summary.rows} must-hit rows)`);
console.log(`missing expectations: ${summary.total_missing} across ${summary.rows_affected} rows`);
for (const [k, v] of Object.entries(summary.by_class)) console.log(`  ${k.padEnd(22)} ${v}`);
console.log(`\nmisses (class != reachable):`);
for (const r of audited) {
  for (const m of r.misses) {
    if (m.class !== "reachable") console.log(`  ${m.id.padEnd(4)} ${m.lane.padEnd(16)} ${m.class.padEnd(22)} ${m.expected}`);
  }
}
console.log(`\nreachable misses (real recall failures):`);
for (const r of audited) {
  for (const m of r.misses) {
    if (m.class === "reachable") console.log(`  ${m.id.padEnd(4)} ${m.lane.padEnd(16)} rank=${m.rank_in_returned} ${m.expected}`);
  }
}
console.log(`\nraw: ${OUT}`);
