import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrubSecrets } from "./sanitize.ts";

/**
 * Opt-in local query history and suggestions (issue #40).
 *
 * **Off by default.** Recording starts only when `ULTRASEARCH_HISTORY` is a
 * truthy value (`1`, `true`, `on`, `yes`) — an agent or user who never asked
 * for a history file never gets one. `ULTRASEARCH_HISTORY=0` is the explicit
 * opt-out once a config or shell profile enabled it.
 *
 * Retention: the newest `ULTRASEARCH_HISTORY_MAX` entries (default 200,
 * clamped to 10..5000) survive. Queries are scrubbed with the same
 * credential redactor the tool output uses before they touch disk. Writes are
 * atomic (temp file + rename) with mode 0600, so a crash cannot leave a
 * half-written history and a partially written file is never read as truth.
 */

export const HISTORY_ENV = "ULTRASEARCH_HISTORY";
export const HISTORY_MAX_ENV = "ULTRASEARCH_HISTORY_MAX";
export const HISTORY_FILE_ENV = "ULTRASEARCH_HISTORY_FILE";
export const DEFAULT_HISTORY_MAX = 200;
export const MIN_HISTORY_MAX = 10;
export const MAX_HISTORY_MAX = 5000;

export interface HistoryEntry {
  /** Scrubbed query text. */
  q: string;
  /** Tool that ran it (ultrasearch_query, ultrasearch_grep, CLI `query`, ...). */
  tool: string;
  /** Epoch ms. */
  ts: number;
  /** Match count when known; feeds suggestion ranking and the learner. */
  hits?: number;
  /** Root the query ran against, when known. */
  root?: string;
}

export interface HistoryOptions {
  enabled: boolean;
  maxEntries: number;
  path: string;
  /** Why history is on or off. */
  source: "env" | "default" | "off";
}

export function defaultHistoryPath(home = os.homedir()): string {
  return path.join(home, ".cache", "ultrasearch", "history.json");
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}

function falsy(value: string | undefined): boolean {
  return /^(0|false|off|no)$/i.test((value ?? "").trim());
}

/** Resolve history settings from the environment. Opt-in unless explicitly disabled. */
export function resolveHistoryOptions(env: NodeJS.ProcessEnv = process.env): HistoryOptions {
  const raw = env[HISTORY_ENV];
  const enabled = truthy(raw);
  const off = falsy(raw);
  const parsedMax = Number.parseInt((env[HISTORY_MAX_ENV] ?? "").trim(), 10);
  const maxEntries = Number.isFinite(parsedMax) ? Math.min(MAX_HISTORY_MAX, Math.max(MIN_HISTORY_MAX, parsedMax)) : DEFAULT_HISTORY_MAX;
  return {
    enabled,
    maxEntries,
    path: env[HISTORY_FILE_ENV] || defaultHistoryPath(),
    source: enabled ? "env" : off ? "off" : "default",
  };
}

/** Read the history file, newest last. A missing or corrupt file is empty, never an error. */
export function loadHistory(options: HistoryOptions = resolveHistoryOptions()): HistoryEntry[] {
  try {
    const raw = fs.readFileSync(options.path, "utf-8");
    const parsed = JSON.parse(raw);
    const entries: unknown = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries)) return [];
    const clean = entries.filter(
      (e): e is HistoryEntry => Boolean(e) && typeof e === "object" && typeof (e as any).q === "string" && typeof (e as any).ts === "number"
    );
    return clean.slice(-options.maxEntries);
  } catch {
    return [];
  }
}

/** Scrub a query before it is persisted; blank queries are not history. */
export function scrubQuery(query: string): string {
  return scrubSecrets(query).trim().slice(0, 500);
}

function writeAtomic(options: HistoryOptions, entries: HistoryEntry[]): void {
  const dir = path.dirname(options.path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.history.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 0), { mode: 0o600 });
  fs.renameSync(tmp, options.path);
}

/**
 * Append one scrubbed entry, enforcing the retention cap. Returns the stored
 * history. Disabled history and empty queries are no-ops.
 */
export function appendHistory(entry: Omit<HistoryEntry, "ts"> & { ts?: number }, options: HistoryOptions = resolveHistoryOptions()): HistoryEntry[] {
  const q = scrubQuery(entry.q ?? "");
  if (!options.enabled || q.length === 0) return loadHistory(options);
  const existing = loadHistory(options);
  const next: HistoryEntry = {
    q,
    tool: entry.tool || "unknown",
    ts: entry.ts ?? Date.now(),
    ...(typeof entry.hits === "number" ? { hits: entry.hits } : {}),
    ...(entry.root ? { root: entry.root } : {}),
  };
  const entries = [...existing, next].slice(-options.maxEntries);
  try {
    writeAtomic(options, entries);
  } catch {
    // A full disk or read-only home must not break a search.
  }
  return entries;
}

/** Remove the history file (opt-out of stored data, not just recording). */
export function clearHistory(options: HistoryOptions = resolveHistoryOptions()): boolean {
  try {
    fs.unlinkSync(options.path);
    return true;
  } catch {
    return false;
  }
}

export interface Suggestion {
  query: string;
  score: number;
  reason: "prefix" | "recent" | "tokens";
  hits?: number;
  ts: number;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s:/]+/)
    .filter((t) => t.length > 0);
}

/**
 * Deterministic suggestions from stored history: prefix matches first, then
 * queries that contain every token of the input (an expanded variant), then
 * the most recent queries. No fuzzy matching — this surface promises none.
 */
export function suggestQueries(entries: HistoryEntry[], input: string, limit = 3): Suggestion[] {
  const needle = input.trim().toLowerCase();
  if (!entries.length) return [];
  const seen = new Map<string, Suggestion>();
  const inputTokens = tokens(needle);
  const newest = Math.max(...entries.map((e) => e.ts), 1);
  entries.forEach((entry, index) => {
    const q = entry.q.trim();
    if (!q || q.toLowerCase() === needle) return;
    const lower = q.toLowerCase();
    let score = 0;
    let reason: Suggestion["reason"] | null = null;
    if (needle.length > 0 && lower.startsWith(needle)) {
      score = 100;
      reason = "prefix";
    } else if (inputTokens.length > 1 && inputTokens.every((t) => tokens(lower).includes(t))) {
      score = 70;
      reason = "tokens";
    } else if (needle.length > 2 && lower.includes(needle)) {
      score = 50;
      reason = "prefix";
    }
    if (reason === null) {
      // Recency-only candidates: useful when the input is empty or unmatched.
      score = 10 + Math.floor((entry.ts / newest) * 9);
      reason = "recent";
    }
    // Recency tiebreak within a reason band; the store is newest-last.
    score += index / Math.max(entries.length, 1);
    const prev = seen.get(lower);
    if (!prev || score >= prev.score) {
      seen.set(lower, { query: q, score, reason, hits: entry.hits, ts: entry.ts });
    }
  });
  return [...seen.values()].sort((a, b) => b.score - a.score || b.ts - a.ts || a.query.localeCompare(b.query)).slice(0, limit);
}

/** One-line CLI rendering of suggestions. */
export function formatSuggestions(suggestions: Suggestion[]): string {
  if (!suggestions.length) return "";
  return suggestions.map((s) => `  ${s.query}  (${s.reason})`).join("\n");
}

/** The corpus shape the recursive learner can consume (query -> uses). */
export function historyCorpus(entries: HistoryEntry[]): Record<string, number> {
  const corpus: Record<string, number> = {};
  for (const entry of entries) {
    const key = entry.q.trim();
    if (key) corpus[key] = (corpus[key] ?? 0) + 1;
  }
  return corpus;
}
