import type { FSearchClient } from "./client.ts";

/**
 * TypeScript declarations exported for QuickJS WASM Code Mode.
 * Enables zero-shot type checking and autocomplete in Pi Agent code execution.
 */
export function renderFSearchDeclarations(): string {
  return `
declare namespace tools {
  /**
   * Fast whole-disk or workspace indexed file discovery (<0.5ms).
   * Supports globs, typo forgiveness, extension filters, and git status filters.
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
  }): Promise<{
    files: Array<{
      path: string;
      relPath: string;
      matches: Array<{ line: number; text: string }>;
    }>;
    took_us: number;
    source: "index" | "scan" | "native_fallback";
  }>;

  /**
   * O(1) exact file resolution by filename (e.g. 'package.json', 'Cargo.toml').
   */
  function fsearch_locate(args: {
    /** Exact filename to find */
    filename: string;
    /** Search whole disk instead of workspace */
    global?: boolean;
  }): Promise<string[]>;

  /**
   * Returns files recently touched or edited in current workspace / git branch.
   */
  function fsearch_recent(args: {
    /** Maximum recent files to return */
    limit?: number;
  }): Promise<string[]>;

  /**
   * Multi-pattern OR content retrieval across trigram index in one IPC pass.
   */
  function fsearch_multi_grep(args: {
    /** Array of literal or regex patterns to search for */
    patterns: string[];
    /** Subdirectory or file path filter */
    path_filter?: string;
    /** Maximum files to return */
    limit?: number;
  }): Promise<{
    files: Array<{
      path: string;
      relPath: string;
      matches: Array<{ line: number; text: string }>;
    }>;
  }>;
}
`;
}

/**
 * Creates Codemode-compatible tool descriptors for @earendil-works/pi-codemode
 */
export function getFSearchCodemodeTools(client: FSearchClient, cwd = process.cwd()) {
  return [
    {
      name: "fsearch_query",
      description: "Fast indexed file search with globs and typo tolerance",
      execute: async (args: { query: string; limit?: number; global?: boolean; near?: string }) => {
        const res = await client.search(args.query, {
          in: args.global ? undefined : cwd,
          limit: args.limit ?? 30,
          near: args.near,
        });
        const hits = res.hits ?? [];
        return {
          took_us: res.took_us ?? 0,
          matches: hits.map((h) => ({
            ...h,
            relPath: h.path.startsWith(cwd) ? h.path.slice(cwd.length).replace(/^\//, "") : h.path,
          })),
        };
      },
    },
    {
      name: "fsearch_grep",
      description: "Indexed trigram content search inside files (<1ms)",
      execute: async (args: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number }) => {
        const res = await client.grep(args.pattern, {
          in: args.path_filter ? `${cwd}/${args.path_filter}` : cwd,
          mode: args.mode,
          limit: args.limit ?? 30,
        });
        const files = res.files ?? [];
        return {
          took_us: res.took_us ?? 0,
          source: res.source ?? "index",
          files: files.map((f) => ({
            ...f,
            relPath: f.path.startsWith(cwd) ? f.path.slice(cwd.length).replace(/^\//, "") : f.path,
          })),
        };
      },
    },
  ];
}
