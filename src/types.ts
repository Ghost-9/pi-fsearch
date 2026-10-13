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
  entries?: number;
  dirs?: number;
  index_bytes?: number;
  content_bytes?: number;
  content_docs?: number;
  content_pending?: number;
  content_segments?: number;
  event_id?: number;
  full_disk_access?: boolean;
  owner?: boolean;
  error?: string;
}

export interface SearchOptions {
  in?: string;
  limit?: number;
  git?: boolean | string;
  boost?: boolean;
  near?: string;
  sort?: "score" | "mtime" | "path" | "frecency";
}

export interface GrepOptions {
  in?: string;
  mode?: "literal" | "regex" | "symbol";
  limit?: number;
  budget_ms?: number;
  context?: number;
}
