// bench/verification/wave4/metrics.mjs — the wave-4 verifier's own metric and
// lane-satisfiability implementation.
//
// Deliberately NOT imported from the author's scorer
// (bench/verification/checks/scoring.mjs) or the author's amendment rules
// (bench/wave4/amendment.mjs): the point of an independent verification is that
// the numbers are re-derived from the documented definitions, and only then
// cross-checked against the shipped implementation.
//
// Documented definitions (bench/verification/checks/scoring.mjs header, mirrored
// in bench/wave3/measure.mjs and the wave-1 acceptance block):
//   recall@k       rel = expected grade >= 1; |rel ∩ top-k| / |rel|
//   nDCG@k         gain 2^grade-1, discount 1/log2(rank+1), IDCG over all grades
//   reformulation  top-1 grade < 2 (a row with no hits counts)
//   zero-result    no hits returned
//   false-positive negative row with any hit
//
// Lane satisfiability (docs/wave4/wave1-v2-mapping.md rule R1):
//   path lane       the expectation's path matches the query
//   content lane    the query occurs in the content (literal = smart case,
//                   regex = a matching line)
//   symbol lane     the file contains a declaration, not a reference
//   semantic lane   the file exists (intent lanes have no lexical witness)

import * as fs from "node:fs";
import * as path from "node:path";

export const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** My own metric implementation. Identical semantics to the frozen definition. */
export function scoreQuery(retrieved, expected, kMax = 10) {
  const grade = new Map(expected.map((e) => [norm(e.path), e.grade]));
  const top = retrieved.slice(0, kMax).map((p, i) => ({ rank: i + 1, path: p, grade: grade.get(p) ?? 0 }));
  const rel1 = expected.filter((e) => e.grade >= 1).map((e) => norm(e.path));
  const set1 = new Set(rel1);
  const rel2 = expected.filter((e) => e.grade >= 2).map((e) => norm(e.path));
  const set2 = new Set(rel2);
  const gain = (g) => Math.pow(2, g) - 1;
  const dcg = (list) => list.reduce((a, r, i) => a + gain(r.grade ?? r) / Math.log2(i + 2), 0);
  const idcg = dcg([...expected.map((e) => e.grade)].sort((a, b) => b - a));
  const first = (min) => top.find((r) => r.grade >= min)?.rank ?? null;
  return {
    top10: top,
    recall_at_10: rel1.length ? top.filter((r) => set1.has(r.path)).length / rel1.length : null,
    success_recall_at_10: rel2.length ? top.filter((r) => set2.has(r.path)).length / rel2.length : null,
    mrr_at_10: first(1) ? 1 / first(1) : 0,
    ndcg_at_10: idcg > 0 ? dcg(top) / idcg : null,
    top1_grade: top[0]?.grade ?? 0,
    reformulation_signal: (top[0]?.grade ?? 0) < 2,
    zero_result: retrieved.length === 0,
    recall_at_limit: rel1.length ? retrieved.filter((p) => set1.has(p)).length / rel1.length : null,
  };
}

// ---------------------------------------------------------- lane satisfiability

/** Glob -> anchored regex (for path lanes whose query is a glob). */
function globRe(glob) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = esc(glob.toLowerCase()).replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${body.replace(/\u0000/g, ".*")}($|/)`);
}

/** Path-lane rule: every query token appears in the path, or the query is a glob. */
export function pathSatisfiable(relPath, query) {
  const p = norm(relPath).toLowerCase();
  const q = String(query).trim();
  if (!q) return false;
  if (/[*?[]/.test(q)) return globRe(q).test(p);
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/^['^!]/, "").replace(/\$$/, "").replace(/[\\()|]/g, "").toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => p.includes(t));
}

/**
 * Content-literal rule: the engine's smart case (case-insensitive unless the
 * pattern contains an uppercase character).
 */
export function literalSatisfiable(text, term) {
  if (typeof text !== "string" || !term.length) return false;
  return /[A-Z]/.test(term) ? text.includes(term) : text.toLowerCase().includes(term.toLowerCase());
}

/** Content-regex rule: a matching line, approximated with JS RegExp. */
export function regexSatisfiable(text, pattern) {
  if (typeof text !== "string") return false;
  try {
    return new RegExp(pattern, "m").test(text);
  } catch {
    return false;
  }
}

/**
 * Declaration rule. Independent variant of the wave-3 audit's lexical test:
 * a keyword or modifier followed by the identifier (not a `.name` reference,
 * not an import). Deliberately written from the language shapes rather than
 * copied.
 */
const DECL_KEYWORDS = [
  "fn", "func", "function", "def", "class", "struct", "enum", "trait", "interface", "type",
  "typealias", "impl", "let", "const", "var", "val", "static", "module", "mod", "protocol",
  "extension", "define", "typedef", "union", "object", "record", "namespace", "actor",
];
const DECL_MODIFIERS = [
  "public", "private", "protected", "internal", "fileprivate", "open", "static", "async",
  "readonly", "abstract", "override", "final", "sealed", "declare", "export", "default",
  "pub", "unsafe", "extern",
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function declarationSatisfiable(text, name) {
  if (typeof text !== "string" || !name) return false;
  const n = escapeRe(name);
  for (const kw of DECL_KEYWORDS) {
    const kwRe = new RegExp(`\\b${kw}\\b(?:<[^>\\n]*>)?[ \\t*&]+(?:mut[ \\t]+)?${n}(?![\\w$])`);
    if (kwRe.test(text)) return true;
  }
  for (const mod of DECL_MODIFIERS) {
    const modRe = new RegExp(`\\b${mod}\\b[ \\t*&]+(?:mut[ \\t]+)?${n}(?![\\w$])`);
    if (modRe.test(text)) return true;
  }
  return false;
}

const kindOfLane = (lane) =>
  ({
    path: "path",
    "ranking-frecency": "path",
    "ranking-proximity": "path",
    "ranking-boost-ab": "path",
    "grep-literal": "content",
    "grep-regex": "content",
    symbol: "declaration",
    "ranking-symbol-intrafile": "declaration",
    semantic: "semantic",
  })[lane] ?? null;

/**
 * Independent satisfiability verdict for one expectation.
 * @returns {{ok: boolean, kind: string|null, why: string}}
 */
export function laneSatisfiable(row, expectedPath, text, corpusExists) {
  const kind = kindOfLane(row.lane);
  const query = String(row.query ?? "");
  if (!corpusExists) return { ok: false, kind, why: "not in the frozen corpus" };
  if (kind === "path") {
    const ok = pathSatisfiable(expectedPath, query);
    return { ok, kind, why: ok ? "path matches" : "path does not match the query" };
  }
  if (kind === "content") {
    const regex = row.params?.mode === "regex" || row.lane === "grep-regex";
    const ok = regex ? regexSatisfiable(text, query) : literalSatisfiable(text, query);
    return { ok, kind, why: ok ? "content matches" : `no ${regex ? "regex" : "literal"} match in content` };
  }
  if (kind === "declaration") {
    const ok = declarationSatisfiable(text, query);
    return { ok, kind, why: ok ? "declaration present" : "reference without declaration" };
  }
  if (kind === "semantic") return { ok: true, kind, why: "intent lane: file presence is the witness" };
  return { ok: false, kind: null, why: `unknown lane ${JSON.stringify(row.lane)}` };
}

/** Corpus reader with no dependency on the author's helper. */
export function corpusReader(root) {
  return {
    root,
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    text: (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : null),
  };
}
