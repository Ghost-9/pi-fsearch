/**
 * Semantic / intent retrieval (issue #26 adjacent, wave 2 relevance).
 *
 * Wave 1 measured semantic nDCG@10 = 0.19: `expandIntentKeywords` kept every
 * word longer than two characters (questions, stopwords, articles) and OR-ed
 * them through `multiGrep`, so the result order was effectively random.
 *
 * Wave 2 keeps the same dispatch contract (one `multiGrep` call over expanded
 * tokens — `test/e2e-regressions.test.ts` asserts this) but adds:
 *   1. stopword removal and light stemming over split identifiers;
 *   2. a software-engineering concept lexicon (natural phrase -> code tokens);
 *   3. file-level scoring over the candidate set (token-boundary term coverage,
 *      within-candidate IDF, declaration and path bonuses, length normalisation);
 *   4. an honest-absence gate: a query whose distinctive terms are mostly absent
 *      from the scope returns nothing instead of the least-bad files.
 */

import * as fs from "node:fs";
import { UltraSearchClient } from "./client.ts";
import type { UltraSearchGrepFile } from "./types.ts";
import type { AuditTool } from "./telemetry.ts";
import { extractSymbolsRegex, indexFile } from "./symbols.ts";

export interface SemanticSearchResult {
  term: string;
  matchedTokens: string[];
  files: UltraSearchGrepFile[];
  confidence: number;
  /** Evidence summary for explain output and diagnostics. */
  evidence?: SemanticEvidence;
}

export interface SemanticEvidence {
  groups: Array<{ id: string; variants: string[]; present: boolean; df: number; weight: number; generic: boolean }>;
  coverage_ratio: number;
  abstained: boolean;
  reason: string;
  ranking: Array<{ path: string; score: number; coverage: number; path_hit: boolean; declared: string | null }>;
}

// ---------------------------------------------------------------- vocabulary

const STOPWORDS = new Set(
  (
    "a an and are as at be been being before after between both but by can could did do does doing during each few " +
    "for from further had has have having he her here hers herself him himself his how i if in into is it its itself " +
    "just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she " +
    "should so some such than that the their theirs them themselves then there these they this those through to too " +
    "under until up very was we were what when where which while who whom why will with would you your yours yourself " +
    "yourselves mid every across about above again against all am any because below down during get got into it's " +
    "doesn't don't isn't wasn't weren't won't wouldn't can't cannot could've should've would've"
  ).split(/\s+/)
);

/** Short identifiers that are real code vocabulary despite their length. */
const SHORT_ALLOWED = new Set(["ci", "db", "io", "os", "ui", "ip", "api", "mcp", "dlp", "cli", "tui", "pid", "sql", "jwt", "ttl", "sdk", "gl", "pr"]);

/**
 * Ubiquitous tokens that appear across a codebase for structural rather than
 * topical reasons. They never count as the "distinctive evidence" that makes a
 * query answerable, and they are down-weighted in scoring.
 */
const GENERIC_TOKENS = new Set(
  (
    "value values result results data file files code name names type types list item items string number numbers " +
    "error errors message messages config option options default example examples line lines text path paths test " +
    "tests run runs running use uses used using make makes made new set sets setting get gets getting add adds " +
    "added read reads write writes written output input content doc docs document documents index main size count " +
    "length start starts end ends time times case cases function functions method methods class classes object " +
    "objects array arrays true false null undefined return returns returned call calls called view views page pages " +
    "first last next previous current state states mode modes level levels kind kinds part parts item items thing " +
    "things way ways work works working way"
  ).split(/\s+/)
);

/**
 * Software-engineering concept lexicon: a trigger token (stemmed) maps to code
 * tokens that commonly realise the concept. Keep this general (vocabulary of the
 * domain, not of a specific repository).
 */
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  credential: ["secret", "sanitize", "scrub", "redact", "mask", "dlp", "passwd", "password", "auth", "token"],
  secret: ["credential", "sanitize", "scrub", "redact", "mask", "dlp", "guard"],
  scrub: ["sanitize", "redact", "mask", "credential", "secret", "clean"],
  sanitize: ["scrub", "redact", "mask", "secret", "credential", "clean", "guard"],
  redact: ["sanitize", "scrub", "mask", "secret", "credential"],
  mask: ["redact", "sanitize", "secret", "credential"],
  leak: ["secret", "sanitize", "redact", "dlp", "guard"],
  token: ["tokens", "auth", "session", "credential"],
  session: ["token", "auth", "login", "cookie", "resident"],
  save: ["saving", "saved", "savings", "estimate", "telemetry", "metric", "saved"],
  saving: ["save", "saved", "savings", "estimate", "telemetry", "metric"],
  estimate: ["save", "saved", "token", "metric", "telemetry", "compute", "count"],
  compute: ["calculate", "formula", "estimate", "metric", "telemetry", "count", "derive"],
  formula: ["compute", "calculate", "estimate", "metric"],
  telemetry: ["metric", "audit", "estimate", "observe", "report"],
  metric: ["telemetry", "audit", "score", "count"],
  daemon: ["resident", "serve", "socket", "sock", "spawn", "reconnect", "retry", "fallback", "server"],
  socket: ["daemon", "sock", "reconnect", "retry", "fallback", "ipc", "connect", "unix"],
  sock: ["socket", "daemon", "ipc"],
  die: ["dead", "death", "exit", "crash", "reconnect", "retry", "fallback", "respawn", "restart", "kill"],
  dead: ["die", "exit", "crash", "fallback", "respawn"],
  crash: ["die", "dead", "exit", "fallback", "reconnect", "respawn"],
  reconnect: ["retry", "fallback", "socket", "dead", "respawn", "backoff"],
  retry: ["fallback", "reconnect", "backoff", "retries"],
  fallback: ["retry", "reconnect", "spawn", "scan", "rg", "native"],
  ci: ["workflow", "github", "action", "pipeline", "push", "job", "matrix", "build"],
  workflow: ["ci", "github", "action", "pipeline", "job", "workflow"],
  push: ["ci", "workflow", "github", "action", "commit", "merge"],
  github: ["ci", "workflow", "action", "push"],
  boundary: ["worktree", "root", "scope", "outside", "contain", "pathsafe", "escape", "traverse", "guard", "repository", "prefix"],
  repository: ["repo", "worktree", "root", "scope", "pathsafe", "boundary", "outside", "tree"],
  worktree: ["root", "scope", "repository", "pathsafe", "boundary", "git"],
  scope: ["worktree", "root", "boundary", "pathsafe", "repo", "limit"],
  contain: ["boundary", "outside", "pathsafe", "guard", "escape", "safe", "traverse"],
  path: ["scope", "worktree", "root", "boundary", "filter", "safe"],
  traversal: ["traverse", "escape", "outside", "boundary", "safe"],
  guard: ["sanitize", "secret", "boundary", "safe", "contain"],
  auth: ["authentication", "login", "token", "session", "password", "credential", "permission"],
  authentication: ["auth", "login", "token", "session", "password", "credential"],
  login: ["auth", "authentication", "token", "session", "signin"],
  index: ["trigram", "content", "resident", "cache"],
  trigram: ["index", "content", "grep", "fuzzy"],
  resident: ["daemon", "index", "resident"],
  buffered: ["buffer", "flush", "line"],
  compress: ["compaction", "compact", "truncate", "token"],
  compaction: ["compact", "compress", "truncate", "autocompact"],
  truncate: ["limit", "compaction", "token", "truncated"],
  ignore: ["gitignore", "rule", "filter", "exclude"],
  filter: ["ignore", "rule", "exclude", "match"],
  observe: ["telemetry", "metric", "audit", "monitor"],
  audit: ["telemetry", "metric", "record", "log"],
  learn: ["recursive", "mistake", "correction", "feedback"],
  mistake: ["record", "learn", "correction", "error"],
  code: ["sandbox", "pipeline", "recipe", "codemode"],
  sandbox: ["codemode", "pipeline", "recipe", "isolation"],
  benchmark: ["latency", "token", "bench", "measure", "percentile"],
  latency: ["benchmark", "measure", "percentile", "median"],
  dlp: ["redact", "secret", "sanitize", "guard"],
};

// ------------------------------------------------------------------ stemming

const IRREGULAR_STEMS: Record<string, string> = {
  savings: "save",
  saving: "save",
  saved: "save",
  saves: "save",
  dies: "die",
  died: "die",
  dying: "die",
  computed: "compute",
  values: "value",
  value: "value",
  credentials: "credential",
  secrets: "secret",
  policies: "policy",
  queries: "query",
  entries: "entry",
  properties: "property",
  dependencies: "dependency",
  binaries: "binary",
  utilities: "utility",
  strategies: "strategy",
  summaries: "summary",
  directories: "directory",
  processes: "process",
  indices: "index",
  matrices: "matrix",
  analyses: "analysis",
  leaves: "leaf",
  halves: "half",
  lives: "live",
  moves: "move",
  changes: "change",
  causes: "cause",
  uses: "use",
  cases: "case",
  classes: "class",
  passes: "pass",
  misses: "miss",
  matches: "match",
  caches: "cache",
  crashes: "crash",
  searches: "search",
  handles: "handle",
  files: "file",
  writes: "write",
  reads: "read",
  runs: "run",
  tokens: "token",
};

export function stemToken(token: string): string {
  if (token.length <= 3) return token;
  const irregular = IRREGULAR_STEMS[token];
  if (irregular) return irregular;
  let t = token;
  if (t.endsWith("ing") && t.length > 5) {
    t = t.slice(0, -3);
    if (/([bdfglmnprt])\1$/.test(t)) t = t.slice(0, -1);
    return t;
  }
  if (t.endsWith("ed") && t.length > 4) {
    t = t.slice(0, -2);
    if (/([bdfglmnprt])\1$/.test(t)) t = t.slice(0, -1);
    return t;
  }
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("es") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) return t.slice(0, -1);
  return t;
}

/** Split an identifier or natural-language chunk into lowercase tokens. */
export function tokenizeIdentifier(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/[^A-Za-z0-9_$]+/);
  for (const part of parts) {
    if (!part) continue;
    const sub = part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/);
    for (const s of sub) {
      const t = s.toLowerCase().replace(/[^a-z0-9$]/g, "");
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}

function queryContentTokens(query: string): string[] {
  const raw = tokenizeIdentifier(query);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length >= 3 || SHORT_ALLOWED.has(t)) {
      if (STOPWORDS.has(t)) continue;
      out.push(t);
    }
  }
  return out;
}

interface ConceptGroup {
  id: string;
  variants: string[];
  generic: boolean;
}

function conceptFor(token: string): string[] {
  if (CONCEPT_SYNONYMS[token]) return CONCEPT_SYNONYMS[token];
  const stem = stemToken(token);
  if (CONCEPT_SYNONYMS[stem]) return CONCEPT_SYNONYMS[stem];
  // Longest trigger that the token starts with (authentication -> auth).
  let best: string | null = null;
  for (const key of Object.keys(CONCEPT_SYNONYMS)) {
    if (key.length < 4) continue;
    if ((token.startsWith(key) || key.startsWith(token)) && (!best || key.length > best.length)) best = key;
  }
  return best ? CONCEPT_SYNONYMS[best] : [];
}

function groupFor(token: string): ConceptGroup {
  const stem = stemToken(token);
  const variants = new Set<string>([stem]);
  for (const s of conceptFor(token)) variants.add(stemToken(s));
  return { id: stem, variants: Array.from(variants), generic: GENERIC_TOKENS.has(stem) || GENERIC_TOKENS.has(token) };
}

export function buildConceptGroups(query: string): ConceptGroup[] {
  const tokens = queryContentTokens(query);
  const groups: ConceptGroup[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const g = groupFor(t);
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    groups.push(g);
  }
  return groups;
}

/**
 * Expanded patterns for the multiGrep dispatch. Preserves the wave 1 contract
 * (content tokens plus concept synonyms; no raw grep fallback).
 */
export function expandIntentKeywords(naturalQuery: string): string[] {
  const groups = buildConceptGroups(naturalQuery);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const v of g.variants) {
      if (v.length < 2 || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= 14) return out;
    }
  }
  return out;
}

// --------------------------------------------------------------- file tokens

const MAX_SCORE_BYTES = 2 * 1024 * 1024;
const tokenCache = new Map<string, { mtimeMs: number; size: number; tokens: string[] }>();

function contentTokensOf(filePath: string): string[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (!st.isFile() || st.size > MAX_SCORE_BYTES) return [];
  const cached = tokenCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.tokens;
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const tokens = tokenizeIdentifier(text);
  tokenCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, tokens });
  return tokens;
}

function tokenMatchesVariant(token: string, variant: string): boolean {
  if (token === variant) return true;
  // Morphological suffix only: "scrubbed" -> scrub + "bed" does NOT match, but
  // "scrubbed" stems to "scrub" before comparison, so this path is for plurals
  // and -ing/-ed forms that survived tokenisation.
  if (variant.length >= 4 && token.startsWith(variant)) {
    const rest = token.slice(variant.length);
    if (rest.length <= 4 && /^(s|es|ed|d|ing|ings|er|ers|ion|ions|or|ors|al|ally|ment|ments|ness|able|ible|ize|ized|izes|ing)$/.test(rest)) return true;
  }
  return false;
}

function variantInTokens(tokens: string[], variant: string): number {
  let n = 0;
  for (const t of tokens) if (tokenMatchesVariant(t, variant)) n++;
  return n;
}

// ------------------------------------------------------------------- scoring

export interface ScoredFile {
  file: UltraSearchGrepFile;
  score: number;
  coverage: number;
  pathHit: boolean;
  declared: string | null;
  contributions: Array<{ group: string; primary: number; synonym: number; path: number; declared: number }>;
}

export interface RankContentOptions {
  /** Scope root, used only for path display/diagnostics. */
  root?: string;
  /** Max files to read for scoring (perf guard). */
  maxFiles?: number;
}

export interface RankContentResult {
  scored: ScoredFile[];
  evidence: SemanticEvidence;
  abstain: boolean;
}

/**
 * Score grep candidates against the intent of `query`.
 *
 * Evidence model: every content token of the query becomes a concept group
 * (itself plus lexicon synonyms). A group is *present* when a file contains a
 * token that realises one of its variants. A query is answerable only when at
 * least 40% of its groups are present somewhere in the candidate set —
 * otherwise the remaining hits are coincidence ("values" in a kubernetes
 * question) and the honest answer is nothing.
 *
 * Ranking signals, in descending strength:
 *   - a declaration in the file realises the group (AST/regex symbol index);
 *   - the group is present in the file name;
 *   - primary-token frequency (synonyms are a fallback, not an equal);
 *   - coverage across groups, discounted by file length.
 */
export async function rankContentCandidates(
  files: UltraSearchGrepFile[],
  query: string,
  options: RankContentOptions = {}
): Promise<RankContentResult> {
  const groups = buildConceptGroups(query);
  const maxFiles = Math.min(options.maxFiles ?? 300, files.length);
  const tokenized: Array<{ file: UltraSearchGrepFile; tokens: string[]; declaredNames: string[] }> = [];
  for (let i = 0; i < maxFiles; i++) {
    const file = files[i];
    const tokens = contentTokensOf(file.path);
    const entry = await indexFile(file.path);
    const declaredNames = entry ? entry.definitions.map((d) => d.name.toLowerCase()) : [];
    tokenized.push({ file, tokens, declaredNames });
  }

  const df = new Map<string, number>();
  const present = new Set<string>();
  for (const g of groups) {
    let count = 0;
    for (const f of tokenized) {
      let hit = false;
      for (const v of g.variants) {
        if (variantInTokens(f.tokens, v) > 0) {
          hit = true;
          break;
        }
      }
      if (hit) count++;
    }
    df.set(g.id, count);
    if (count > 0) present.add(g.id);
  }
  const n = tokenized.length || 1;
  const weights = new Map<string, number>();
  for (const g of groups) {
    const d = df.get(g.id) ?? 0;
    const idf = Math.log(1 + n / (d + 1));
    weights.set(g.id, idf * (g.generic ? 0.25 : 1));
  }

  const scored: ScoredFile[] = [];
  for (const f of tokenized) {
    const base = f.file.path.split("/").pop() ?? "";
    const baseTokens = new Set(tokenizeIdentifier(base + " " + f.file.path));
    let score = 0;
    let coverage = 0;
    let pathHit = false;
    let declared: string | null = null;
    const contributions: Array<{ group: string; primary: number; synonym: number; path: number; declared: number }> = [];
    for (const g of groups) {
      const w = weights.get(g.id) ?? 0;
      const primaryHits = variantInTokens(f.tokens, g.id);
      let synonymHits = 0;
      for (const v of g.variants) {
        if (v === g.id) continue;
        synonymHits = Math.max(synonymHits, variantInTokens(f.tokens, v));
      }
      let pathMatch = false;
      for (const v of g.variants) if (baseTokens.has(v)) pathMatch = true;
      const declVariants = g.variants.filter((v) => v.length >= 4 && !GENERIC_TOKENS.has(v));
      const declaredMatches = new Set<string>();
      for (const name of f.declaredNames) {
        for (const v of declVariants) if (name.includes(v)) declaredMatches.add(name);
      }
      const declaredHit = declaredMatches.size > 0;
      if (primaryHits === 0 && synonymHits === 0 && !pathMatch && !declaredHit) continue;
      coverage++;
      const cPrimary = primaryHits > 0 ? w * (1 + Math.log2(1 + primaryHits)) : 0;
      const cSynonym = primaryHits === 0 && synonymHits > 0 ? w * 0.4 * (1 + Math.log2(1 + synonymHits)) : 0;
      const cMix = synonymHits > 0 && primaryHits > 0 ? w * 0.1 * Math.min(synonymHits, 6) : 0;
      const cPath = pathMatch ? w * 2.0 : 0;
      const cDeclared = declaredHit ? w * 1.6 * Math.min(3, declaredMatches.size) : 0;
      score += cPrimary + cSynonym + cMix + cPath + cDeclared;
      if (pathMatch) pathHit = true;
      if (declaredHit && !declared) declared = g.id;
      contributions.push({ group: g.id, primary: cPrimary, synonym: cSynonym + cMix, path: cPath, declared: cDeclared });
    }
    const lengthPenalty = 0.6 * Math.log2(1 + f.tokens.length / 200);
    score += 0.5 * coverage - lengthPenalty;
    if (score > 0) scored.push({ file: f.file, score, coverage, pathHit, declared, contributions });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    return a.file.path.localeCompare(b.file.path);
  });

  const coverageRatio = groups.length ? present.size / groups.length : 0;
  // A present, non-generic group is required: an answer made only of words that
  // are ubiquitous in code (values, results, data) is not an answer.
  const strong = [...present].some((id) => {
    const g = groups.find((x) => x.id === id)!;
    return !g.generic;
  });
  const abstain = groups.length === 0 || present.size === 0 || coverageRatio < 0.4 || !strong;
  return {
    scored,
    abstain,
    evidence: {
      groups: groups.map((g) => ({
        id: g.id,
        variants: g.variants,
        present: present.has(g.id),
        df: df.get(g.id) ?? 0,
        weight: weights.get(g.id) ?? 0,
        generic: g.generic,
      })),
      coverage_ratio: coverageRatio,
      abstained: abstain,
      reason: abstain
        ? groups.length === 0
          ? "no content terms"
          : `distinctive terms absent (coverage ${coverageRatio.toFixed(2)}, ${present.size}/${groups.length} groups)`
        : "terms present",
      ranking: scored.slice(0, 10).map((s) => ({
        path: s.file.path,
        score: Math.round(s.score * 1000) / 1000,
        coverage: s.coverage,
        path_hit: s.pathHit,
        declared: s.declared,
        contributions: s.contributions.map((c) => ({ ...c, primary: Math.round(c.primary * 100) / 100, synonym: Math.round(c.synonym * 100) / 100, path: Math.round(c.path * 100) / 100, declared: Math.round(c.declared * 100) / 100 })),
      })),
    },
  };
}

// ------------------------------------------------------------------ retrieval

export async function searchSemanticIntent(
  client: UltraSearchClient,
  naturalQuery: string,
  options: { in?: string; limit?: number; auditTool?: AuditTool } = {}
): Promise<SemanticSearchResult> {
  const expanded = expandIntentKeywords(naturalQuery);
  const limit = options.limit ?? 20;
  if (expanded.length === 0) {
    return { term: naturalQuery, matchedTokens: [], files: [], confidence: 0 };
  }

  // Candidate generation stays on the multiGrep lane (one dispatch; see the
  // e2e regression test). Over-fetch so ranking has the full candidate set.
  const candidateLimit = Math.max(60, limit * 6);
  const grepRes = await client.multiGrep(expanded, {
    in: options.in,
    limit: candidateLimit,
    auditTool: options.auditTool,
  });
  const candidates = grepRes.files ?? [];
  if (candidates.length === 0) {
    return { term: naturalQuery, matchedTokens: expanded, files: [], confidence: 0 };
  }

  const ranked = await rankContentCandidates(candidates, naturalQuery, { root: options.in });
  if (ranked.abstain) {
    return {
      term: naturalQuery,
      matchedTokens: expanded,
      files: [],
      confidence: 0,
      evidence: ranked.evidence,
    };
  }
  const kept = ranked.scored.slice(0, limit).map((s) => s.file);
  const top = ranked.scored[0]?.score ?? 0;
  const confidence = Math.min(1, Math.max(0.05, top / (top + 4)));
  return { term: naturalQuery, matchedTokens: expanded, files: kept, confidence, evidence: ranked.evidence };
}

/** Test seam. */
export function clearSemanticCaches(): void {
  tokenCache.clear();
}

// Re-export for callers that want declaration detection without the AST module.
export { extractSymbolsRegex };
