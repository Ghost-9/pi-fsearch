// bench/wave4/amendment.mjs — the wave-1 → v2 amendment table and the lane
// satisfiability rules the v2 validator and its tests share.
//
// The wave-3 audit (bench/wave3/results/final-expectation-audit.json) proved
// that 16 wave-1 must-hit expectations cannot be retrieved in the lane they are
// scored in, and that no engine change can close the `recall@10 == 1.00` gate
// without breaking pinned invariants:
//
//   absent-string (3)          the named file does not contain the query term
//   path-lane-content (6)      a path lane asked for a content mention
//                              (a content fallback would break RS01's pinned
//                              `not_expected` and the ranking-lane budget)
//   symbol-lane-reference (7)  declaration-only symbol mode asked for a file
//                              that references the identifier (wave 2 pins
//                              declarations-first: SY01/SY02 `not_expected`)
//
// v2 therefore amends the judgment set, never the metric and never the engine:
// every must-hit expectation must be satisfiable in the lane it is scored in.
// This module holds the decisions; `make-judgments-v2.mjs` writes the versioned
// file, `validate-judgments.mjs` proves them against the frozen corpus, and
// `bench/wave4/validate-judgments.test.mjs` proves the validator can fail.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The v1 file must never change; its bytes are the historical record. */
export const V1_SHA256 = "4af5fed8cc7ed23d561c5bfcd59a37bf3ec78edf27793df3702b934350185ea1";

export const V1_PATH = "bench/judgments/wave1-judgments.json";
export const V2_PATH = "bench/judgments/wave1-judgments.v2.json";

/** The lane taxonomy: which matching rule owns a lane's expectations. */
export const LANE_KIND = {
  path: "path",
  symbol: "declaration",
  "grep-literal": "content",
  "grep-regex": "content",
  semantic: "semantic",
  "ranking-frecency": "path",
  "ranking-proximity": "path",
  "ranking-boost-ab": "path",
  "ranking-symbol-intrafile": "declaration",
};

export const laneKind = (lane) => LANE_KIND[lane] ?? null;

// --------------------------------------------------------------- rules

/** Translate a path glob (for example src/**\/*.ts) into an anchored relative-path regex. */
function globToRegExp(glob) {
  const segs = glob.toLowerCase().split("/");
  let out = "";
  for (const seg of segs) {
    const t = seg === "**" ? "\u0000" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    out += (out ? "/" : "") + t;
  }
  out = out.replace(/\/\u0000\//g, "/(?:.*/)?").replace(/^\u0000\//, "(?:.*/)?").replace(/\/\u0000$/g, "(?:/.*)?").replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${out}($|/)`);
}

/**
 * Does the file's path carry the query? Globs are matched as globs
 * (for example src/**\/*.ts); plain queries require every whitespace token to appear in
 * the path, case-insensitively (the wave-3 audit's `pathMatches` rule, with the
 * token lowercased too — the audit lowercased only the path).
 */
export function pathMatches(relPath, query) {
  const p = String(relPath).replace(/\\/g, "/").toLowerCase();
  const q = String(query).trim();
  if (!q) return false;
  if (/[*?\[]/.test(q)) return globToRegExp(q).test(p);
  const tokens = q.split(/\s+/).filter(Boolean).map((t) => t.replace(/^['^!]/, "").replace(/\$$/, "").replace(/[\\()|]/g, "").toLowerCase()).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => p.includes(t));
}

/** The engine's `mode: "literal"` rule: smart case (case-insensitive unless the
 *  pattern contains uppercase), substring matching — `Case::Smart` in
 *  engine/src/content.rs:3468. */
export function literalOccurs(text, term) {
  if (typeof text !== "string" || term.length === 0) return false;
  const insensitive = !/[A-Z]/.test(term);
  return insensitive ? text.toLowerCase().includes(term.toLowerCase()) : text.includes(term);
}

/** The engine's `mode: "regex"` rule, approximated with the JS engine. */
export function regexOccurs(text, pattern) {
  if (typeof text !== "string") return false;
  try {
    return new RegExp(pattern, "m").test(text);
  } catch {
    return false;
  }
}

/**
 * Is the identifier declared in the file? The same lexical test the wave-3
 * audit and the pre-AST engine use (SYMBOL_REGEX-style definers + access
 * modifiers). A *reference* is not a declaration; that is the wave-2 contract.
 */
export function declares(text, name) {
  if (typeof text !== "string") return false;
  const DEFINERS = "(fn|func|function|def|class|struct|enum|trait|interface|type|typealias|impl|let|const|var|val|static|module|mod|protocol|extension|define|typedef|union|object|record|namespace|actor)";
  const MODS = "(public|private|protected|internal|fileprivate|open|static|async|readonly|abstract|override|final|sealed|declare|export|default|pub|unsafe|extern)";
  const kw = new RegExp(`(?:${DEFINERS})(?:<[^>\\n]*>)?[ \\t*&]+(?:mut[ \\t]+)?${name}(?!\\w)`);
  const mod = new RegExp(`(?:${MODS})[ \\t]+${name}(?!\\w)`);
  return kw.test(text) || mod.test(text);
}

const STOPWORDS = new Set(["what", "when", "where", "which", "does", "every", "inside", "before", "after", "into", "than", "then", "that", "this", "with", "from", "have", "keep", "make", "they", "them", "there", "their", "would", "could", "should", "about", "reach", "results"]);
export const semanticTokens = (query) =>
  String(query).toLowerCase().split(/[^a-z0-9_-]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t));

/**
 * Semantic lane witness: the lane is an intent lane, so lexical containment is
 * not the requirement. Satisfiability is (a) a non-empty distinctive-token
 * intent and (b) the file existing in the corpus (checked by the caller). The
 * lexical overlap is reported as a warning, never as an error — an intent
 * answer can share no rare token with the question.
 */
export function semanticSatisfiable(_text, query) {
  return semanticTokens(query).length > 0;
}

/**
 * Is one expectation satisfiable in its lane?
 * @returns {{ok: boolean, kind: string, why: string}}
 */
export function satisfiable(row, expectedPath, text, exists) {
  const kind = laneKind(row.lane);
  const query = String(row.query ?? "");
  if (!exists) return { ok: false, kind, why: "file is not in the frozen corpus" };
  if (kind === "path") {
    const ok = pathMatches(expectedPath, query);
    return { ok, kind, why: ok ? `path matches query ${JSON.stringify(query)}` : `path does not match query ${JSON.stringify(query)}` };
  }
  if (kind === "content") {
    const mode = row.params?.mode === "regex" || row.lane === "grep-regex" ? "regex" : "literal";
    const ok = mode === "regex" ? regexOccurs(text, query) : literalOccurs(text, query);
    return { ok, kind, why: ok ? `${mode} match for ${JSON.stringify(query)}` : `no ${mode} match for ${JSON.stringify(query)} in content` };
  }
  if (kind === "declaration") {
    const ok = declares(text, query);
    return { ok, kind, why: ok ? `declares ${JSON.stringify(query)}` : `references ${JSON.stringify(query)} without declaring it` };
  }
  if (kind === "semantic") {
    const ok = semanticSatisfiable(text, query);
    return { ok, kind, why: ok ? `intent lane: satisfiability is the file's presence in the corpus (${semanticTokens(query).length} distinctive tokens; no lexical requirement)` : `intent has no distinctive token to search for` };
  }
  return { ok: false, kind: null, why: `unknown lane ${JSON.stringify(row.lane)}` };
}

// --------------------------------------------------------------- decisions

/**
 * Removed from must-hit. `absent-string` removals are label errors: the file
 * does not contain the term, so no implementation can return it for that query.
 * `content-mention-not-top10` is a window removal: the file *does* contain the
 * term, but no lane that can match it ranks it inside the gate's top-10 window.
 */
export const REMOVALS = [
  { id: "P6", lane: "path", query: "codemode", path: "OPTIMIZATIONS.md", grade: 1, class: "absent-string",
    why: "the file does not contain the query term; no lane can return it for `codemode`" },
  { id: "G4", lane: "grep-literal", query: "fsearch.sock", path: "README.md", grade: 1, class: "absent-string",
    why: "the file does not contain the literal `fsearch.sock`; the two files that do are returned" },
  { id: "K1", lane: "ranking-frecency", query: "readme", path: "CONTRIBUTING.md", grade: 1, class: "absent-string",
    why: "the file does not contain `readme` in any case; README.md (grade 3) is the row's answer" },
  { id: "K3", lane: "ranking-boost-ab", query: "client", path: "README.md", grade: 1, class: "content-mention-not-top10",
    why: "the file contains `client`, but the content lane ranks it outside the top 10 (rank 18 of 23 matches); a grade-1 adjacent prose mention is not a top-10 answer for a generic one-token query under the documented content ranking (decision 0014)" },
];

/**
 * Re-homed expectations: the companion row re-scores the same query intent in a
 * content lane, where every carried expectation occurs in the file's content.
 * The companion also carries the source row's expectations that are satisfiable
 * in the content lane (so the row keeps its grade-3 anchor where the lane has one).
 */
export const COMPANION_SPECS = [
  { from: "P3", id: "P3c", lane: "grep-literal", query: "client.ts", expected: [["test/client.test.ts", 2]] },
  { from: "P6", id: "P6c", lane: "grep-literal", query: "codemode", expected: [["src/codemode.ts", 3], ["AUDIT-2026-10-14.md", 1]] },
  { from: "K2", id: "K2c", lane: "grep-literal", query: "sanitize", expected: [["OPTIMIZATIONS.md", 1], ["AUDIT-2026-10-14.md", 1]] },
  { from: "K3", id: "K3c", lane: "grep-literal", query: "client", expected: [["src/mcp.ts", 1]] },
  { from: "S1", id: "S1c", lane: "grep-literal", query: "FSearchClient", expected: [["src/client.ts", 3], ["test/client.test.ts", 2], ["src/mcp.ts", 1], ["src/tui.ts", 1], ["index.ts", 1]] },
  { from: "S3", id: "S3c", lane: "grep-literal", query: "applyProximityRanking", expected: [["src/client.ts", 3], ["AUDIT-2026-10-14.md", 1]] },
  { from: "S4", id: "S4c", lane: "grep-literal", query: "resolveWorktreeRoot", expected: [["index.ts", 3], ["CHANGELOG.md", 1], ["AUDIT-2026-10-14.md", 1]] },
];

// --------------------------------------------------------------- corpus access

/** A small corpus reader the validator and generator share. */
export function corpusReader(root) {
  const cache = new Map();
  const abs = (rel) => path.join(root, rel);
  return {
    root,
    exists: (rel) => fs.existsSync(abs(rel)),
    text: (rel) => {
      if (!cache.has(rel)) cache.set(rel, fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), "utf8") : null);
      return cache.get(rel);
    },
    sha256: (rel) =>
      fs.existsSync(abs(rel)) ? crypto.createHash("sha256").update(fs.readFileSync(abs(rel))).digest("hex") : null,
  };
}

/** Locate the frozen wave-1 corpus, or throw with the reproduction command. */
export function findCorpus(explicit) {
  const candidates = [
    explicit,
    path.join(process.env.HOME ?? "", ".cache", "ultrasearch", "corpus", "wave1-0a16e50"),
    path.join(process.env.HOME ?? "", ".cache", "pi-ultrasearch-bench", "corpus-0a16e50"),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`frozen wave-1 corpus not found (tried: ${candidates.join(", ")}); run: npm run bench:wave3:corpora`);
  return found;
}
