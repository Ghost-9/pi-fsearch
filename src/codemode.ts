import type { FSearchClient } from "./client.ts";

/**
 * TypeScript declarations exported for QuickJS WASM Code Mode.
 * Enables zero-shot type checking and autocomplete in Pi Agent code execution.
 */
export function renderUltraSearchDeclarations(): string {
  return `
declare namespace tools {
  /**
   * Fast whole-disk or workspace indexed file discovery (<0.5ms).
   * Supports globs, extension filters, git status filters, and strict zero typo tolerance.
   */
  function fsearch_query(args: {
    /** Search query, glob, or filter (e.g. 'Omnibox *.swift', 'git:modified', 'src/**/*.{ts,tsx}') */
    query: string;
    /** Maximum results (default: 30) */
    limit?: number;
    /** Search whole disk instead of workspace */
    global?: boolean;
    /** Target file path for proximity re-ranking */
    near?: string;
  }): Promise<{
    matches: Array<{
      path: string;
      relPath: string;
      kind: "file" | "dir" | "link";
      score: number;
      git?: string;
    }>;
    took_us: number;
  }>;

  /**
   * Ultra-fast indexed trigram text content search (<1ms).
   * Searches inside text files for identifiers, function definitions, or literals.
   */
  function fsearch_grep(args: {
    /** Literal string or regex identifier to locate */
    pattern: string;
    /** Subdirectory or file path filter */
    path_filter?: string;
    /** Search mode: 'literal' | 'regex' | 'symbol' */
    mode?: "literal" | "regex" | "symbol";
    /** Maximum files to return */
    limit?: number;
    /** Search whole disk instead of workspace */
    global?: boolean;
    /** Compact one-line formatting */
    compact?: boolean;
    /** Token budget limit */
    max_tokens?: number;
  }): Promise<{
    files: Array<{
      path: string;
      matches: Array<{ line: number; text: string }>;
    }>;
    took_us: number;
  }>;

  /**
   * Multi-pattern OR content retrieval across trigram index in one roundtrip.
   */
  function fsearch_multi_grep(args: {
    patterns: string[];
    path_filter?: string;
    limit?: number;
    compact?: boolean;
    max_tokens?: number;
  }): Promise<{
    files: Array<{ path: string; matches: Array<{ line: number; text: string }> }>;
  }>;

  /**
   * Instant O(1) lookup for exact filenames in current workspace.
   */
  function fsearch_locate(args: {
    filename: string;
    global?: boolean;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }>;

  /**
   * Returns recently edited or touched files in the workspace (frecency-ranked).
   */
  function fsearch_recent(args: {
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }>;

  /**
   * Returns telemetry profiler metrics (p50/p90/p95 latency) and toolchain advice.
   */
  function fsearch_metrics(args?: {
    limit?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}
`;
}

/**
 * Backwards compatibility alias for renderUltraSearchDeclarations.
 */
export const renderFSearchDeclarations = renderUltraSearchDeclarations;

/**
 * Sandbox helper returning callable JavaScript function wrappers around FSearchClient
 * for execution inside a QuickJS WASM runtime.
 */
export function getFSearchCodemodeTools(client: FSearchClient) {
  return {
    fsearch_query: async (args: { query: string; limit?: number; global?: boolean; near?: string }) => {
      const res = await client.search(args.query, {
        limit: args.limit ?? 30,
        in: args.global ? undefined : process.cwd(),
        near: args.near,
      });
      return {
        matches: (res.hits ?? []).map((h) => ({
          path: h.path,
          relPath: h.path.replace(process.cwd(), "").replace(/^\//, ""),
          kind: h.kind,
          score: h.score,
          git: h.git,
        })),
        took_us: res.took_us ?? 0,
      };
    },
    fsearch_grep: async (args: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number }) => {
      const res = await client.grep(args.pattern, {
        in: args.path_filter ?? process.cwd(),
        mode: args.mode ?? "literal",
        limit: args.limit ?? 30,
      });
      return {
        files: res.files ?? [],
        took_us: res.took_us ?? 0,
      };
    },
    fsearch_multi_grep: async (args: { patterns: string[]; path_filter?: string; limit?: number }) => {
      return await client.multiGrep(args.patterns, {
        in: args.path_filter ?? process.cwd(),
        limit: args.limit ?? 30,
      });
    },
    fsearch_locate: async (args: { filename: string }) => {
      return await client.search(`'${args.filename}`, { in: process.cwd(), limit: 10 });
    },
    fsearch_recent: async (args?: { limit?: number }) => {
      return await client.recent(process.cwd(), args?.limit ?? 15);
    },
  };
}
