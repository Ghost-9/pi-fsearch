import type { AuditTool } from "./telemetry.ts";

export interface UltraSearchHit {
  kind: "file" | "dir" | "link" | "other";
  mtime: number;
  path: string;
  score: number;
  size: number;
  git?: string;
  distance?: number;
  /**
   * The nearness component the daemon added to `score` (issue: one owner for
   * proximity). Scale: +12 in the `near` file's folder, -3 per folder of
   * distance, clamped at 0; the `near` file itself is -20. Absent when no
   * `near` was given or nothing was added.
   */
  near?: number;
  /** The frecency component the daemon added to `score` (`boost: true`). */
  boost?: number;
  /** The query's own match score, before `near`/`boost` were added (engine-owned vector). */
  match?: number;
  /** Definition component: 8 when this row declares the queried symbol, else 0/absent. */
  def?: number;
}

/**
 * Machine-readable accounting attached to every search/grep/multi-grep result.
 * `complete` is true only when the engine explicitly reported completeness;
 * a response without an explicit `complete: true` is not guaranteed to cover
 * the full scope (issues #16, #25, #37).
 */
export interface SearchResultMeta {
  complete: boolean;
  /** The result set was clipped (by `limit` or the scan ceiling). */
  truncated: boolean;
  /**
   * Number of matching items the client dropped to honour `limit` (known count).
   * When `filteredCount > 0` and the result is shorter than `limit`, the caller
   * can raise `limit`: the client over-fetches by a bounded margin but never
   * issues a second round trip.
   */
  truncatedCount: number;
  /** The engine returned exactly the requested limit, so more matches may exist (count unknown). */
  engineCapped?: boolean;
  /** Number of items removed by ignore rules or exact-match post-filtering. */
  filteredCount: number;
  /** Estimated prompt tokens for the result payload: ceil(charCount / 4). ESTIMATE. */
  tokenCount: number;
  /** Estimated prompt characters for the result payload. */
  charCount: number;
  source?: "index" | "scan" | "native_fallback";
  /** Budget requested for this call, when the caller supplied one. */
  budgetMs?: number;
  /** The client-side deadline fired before the engine answered. */
  deadlineExceeded?: boolean;
  /** Non-fatal diagnostics, e.g. a regex backtracking warning. */
  warning?: string;
  /** Raw item count returned by the engine before client-side filtering. */
  rawCount?: number;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** Milliseconds the index was behind a replay for this answer (#19); 0/absent when caught up. */
  staleMs?: number;
}

export interface UltraSearchSearchResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  hits?: UltraSearchHit[];
  source?: "index" | "scan" | "native_fallback";
  complete?: boolean;
  truncated?: boolean;
  truncatedCount?: number;
  filteredCount?: number;
  meta?: SearchResultMeta;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** Milliseconds the index was behind a replay for this answer (#19); 0/absent when caught up. */
  stale_ms?: number;
  error?: string;
}

export interface UltraSearchGrepMatch {
  line: number;
  text: string;
  col?: number;
  before?: string[];
  after?: string[];
  ranges?: Array<[number, number]>;
  /** Engine verdict: this line declares the queried name (`mode: "symbol"`). */
  def?: boolean;
}

export interface UltraSearchGrepFile {
  path: string;
  matches: UltraSearchGrepMatch[];
  /** Definition component for the file (engine symbol mode): 8 declares the name, 0 does not. */
  def?: number;
}

export interface UltraSearchGrepResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  source?: "index" | "scan" | "native_fallback";
  candidates?: number;
  read?: number;
  complete?: boolean;
  truncated?: boolean;
  truncatedCount?: number;
  filteredCount?: number;
  indexing?: number;
  files?: UltraSearchGrepFile[];
  meta?: SearchResultMeta;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** Milliseconds the index was behind a replay for this answer (#19); 0/absent when caught up. */
  stale_ms?: number;
  error?: string;
}

export interface UltraSearchMultiGrepResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  source?: "index" | "scan" | "native_fallback";
  patterns: string[];
  /** Results the daemon's policy held back across the fan-out (#23). */
  withheld?: number;
  /** The longest replay lag seen across the fan-out (#19). */
  stale_ms?: number;
  complete?: boolean;
  truncated?: boolean;
  truncatedCount?: number;
  filteredCount?: number;
  files?: UltraSearchGrepFile[];
  meta?: SearchResultMeta;
  error?: string;
}

export interface UltraSearchStatusResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  version?: string;
  entries?: number;
  index_bytes?: number;
  content_files?: number;
  content_bytes?: number;
  content_segments?: number;
  total_content_segments?: number;
  event_id?: number;
  full_disk_access?: boolean;
  owner?: boolean;
  overlay?: number;
  removed?: number;
  error?: string;
  /**
   * Milliseconds the index has been behind a replay when this answer was
   * made (issue #19). Absent or 0: the index is caught up. Non-zero: the
   * result may miss changes made during that window.
   */
  stale_ms?: number;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
}

export interface SearchOptions {
  in?: string;
  limit?: number;
  near?: string;
  /**
   * The caller's allowed boundary (an absolute path). The daemon refuses a
   * scope outside it and drops any hit outside it, so a bug in a caller's own
   * containment check cannot widen the search. Omit for a deliberate
   * disk-wide (`global`) query. See issue #23.
   */
  root?: string;
  fuzzy?: boolean;
  git?: boolean;
  /** Ranking boost (frecency + git + mtime). Omitted means the engine default applies. */
  boost?: boolean;
  skipAudit?: boolean;
  /** Tool name recorded in the audit log (single-recording layer). Defaults to ultrasearch_query. */
  auditTool?: AuditTool;
  /** Respect local .gitignore/.ignore rules declared in the scope root (default: true). */
  respectIgnore?: boolean;
  /** Server-side deadline in milliseconds; partial results carry complete:false. */
  budget_ms?: number;
  /** Cancellation for fallback work (agent turn aborted). */
  signal?: AbortSignal;
}

export interface GrepOptions {
  in?: string;
  mode?: "literal" | "regex" | "symbol";
  limit?: number;
  budget_ms?: number;
  /** The caller's allowed boundary; see `SearchOptions.root`. */
  root?: string;
  context?: number;
  skipAudit?: boolean;
  /** Tool name recorded in the audit log (single-recording layer). Defaults to ultrasearch_grep. */
  auditTool?: AuditTool;
  /** Respect local .gitignore/.ignore rules declared in the scope root (default: true). */
  respectIgnore?: boolean;
  /** Cancellation for fallback work (agent turn aborted). */
  signal?: AbortSignal;
  /** Ask the engine for its definition verdicts (`def`) so matches can be tagged. */
  tagSymbols?: boolean;
}
