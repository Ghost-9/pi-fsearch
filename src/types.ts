import type { AuditTool } from "./telemetry.ts";

export interface FSearchHit {
  kind: "file" | "dir" | "link" | "other";
  mtime: number;
  path: string;
  score: number;
  size: number;
  git?: string;
  distance?: number;
}

export interface FSearchSearchResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  hits?: FSearchHit[];
  source?: "index" | "scan" | "native_fallback";
  error?: string;
}

export interface FSearchGrepMatch {
  line: number;
  text: string;
  col?: number;
  before?: string[];
  after?: string[];
  ranges?: Array<[number, number]>;
}

export interface FSearchGrepFile {
  path: string;
  matches: FSearchGrepMatch[];
}

export interface FSearchGrepResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  source?: "index" | "scan" | "native_fallback";
  candidates?: number;
  read?: number;
  complete?: boolean;
  indexing?: number;
  files?: FSearchGrepFile[];
  error?: string;
}

export interface FSearchMultiGrepResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  source?: "index" | "scan" | "native_fallback";
  patterns: string[];
  files?: FSearchGrepFile[];
  error?: string;
}

export interface FSearchStatusResponse {
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
}

export interface SearchOptions {
  in?: string;
  limit?: number;
  near?: string;
  fuzzy?: boolean;
  sort?: "score" | "mtime" | "path" | "frecency";
  git?: boolean;
  boost?: boolean;
  skipAudit?: boolean;
  /** Tool name recorded in the audit log (single-recording layer). Defaults to fsearch_query. */
  auditTool?: AuditTool;
  /** Respect local .gitignore/.ignore rules declared in the scope root (default: true). */
  respectIgnore?: boolean;
}

export interface GrepOptions {
  in?: string;
  mode?: "literal" | "regex" | "symbol";
  limit?: number;
  budget_ms?: number;
  context?: number;
  skipAudit?: boolean;
  /** Tool name recorded in the audit log (single-recording layer). Defaults to fsearch_grep. */
  auditTool?: AuditTool;
  /** Respect local .gitignore/.ignore rules declared in the scope root (default: true). */
  respectIgnore?: boolean;
}
