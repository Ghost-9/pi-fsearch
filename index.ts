import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { FSearchClient } from "./src/client.ts";
import { scrubSecrets, isPathSafe } from "./src/sanitize.ts";

/**
 * Resolves the top-level repository worktree root to prevent cross-repo context leaks.
 */
function resolveWorktreeRoot(startDir = process.cwd()): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return root;
  } catch {
    // Not a git repo or git unavailable
  }
  return startDir;
}

export default function piFsearchExtension(pi: ExtensionAPI): void {
  const client = new FSearchClient();

  // Helper to register tools cleanly across all Pi versions
  const register = (toolDef: any) => {
    if (typeof (pi as any).registerTool === "function") {
      (pi as any).registerTool(toolDef);
    }
  };

  // 1. fsearch_query: Fast path/file discovery with fuzzy matching, globs, git filters, and proximity ranking
  register({
    name: "fsearch_query",
    label: "FSearch Query",
    description:
      "Instant indexed whole-disk or workspace file search (<0.1ms). Supports typos (forgives 1-2 typos), globs (src/**/*.{ts,tsx}), extension filters (*.rs), git status filters (git:modified, git:staged, git:untracked), and proximity re-ranking (near: <path>). Scoped strictly to the active worktree root.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search keywords, globs, or filters (e.g. 'Omnibox *.swift', 'git:modified', 'near:index.ts', 'src/**/*.{ts,tsx} !test/').",
      }),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 30)." })),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk instead of restricting to current repository worktree." })),
      near: Type.Optional(Type.String({ description: "Optional active file path to re-rank results by folder proximity." })),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number; global?: boolean; near?: string }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.global ? undefined : worktreeRoot;

        // Parse optional inline near: filter if present in query string
        let cleanedQuery = params.query;
        let proximityTarget = params.near;
        const nearMatch = /\bnear:([^\s]+)/.exec(cleanedQuery);
        if (nearMatch) {
          proximityTarget = nearMatch[1];
          cleanedQuery = cleanedQuery.replace(nearMatch[0], "").trim();
        }

        const res = await client.search(cleanedQuery, {
          in: searchScope,
          limit: params.limit ?? 30,
          git: true,
          boost: true,
          near: proximityTarget ? path.resolve(worktreeRoot, proximityTarget) : undefined,
        });

        if (!res.ok && res.error) {
          return { content: [{ type: "text", text: `FSearch error: ${res.error}` }] };
        }

        const hits = res.hits ?? [];
        if (hits.length === 0) {
          return { content: [{ type: "text", text: `No files matching "${params.query}" found.` }] };
        }

        const formatted = hits
          .map((h) => {
            const rel = h.path.startsWith(worktreeRoot) ? h.path.slice(worktreeRoot.length).replace(/^\//, "") : h.path;
            const gitTag = h.git ? ` [git:${h.git}]` : "";
            const distTag = h.distance !== undefined ? ` [dist:${h.distance}]` : "";
            return `${rel}${gitTag}${distTag} (${h.kind}, score: ${h.score})`;
          })
          .join("\n");

        const sourceNotice = res.source === "native_fallback" ? " (via native fallback)" : "";
        return {
          content: [
            {
              type: "text",
              text: `Found ${hits.length} matches in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms${sourceNotice}:\n${formatted}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `FSearch query unavailable: ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 2. fsearch_grep: Instant indexed trigram text content search (<1ms)
  register({
    name: "fsearch_grep",
    label: "FSearch Grep",
    description:
      "Ultra-fast indexed trigram content search (<1ms). Searches inside text files for identifiers, function definitions, or literals without running slow recursive disk walks. Results scrubbed for credentials.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Literal text or identifier to search for." }),
      path_filter: Type.Optional(Type.String({ description: "Optional subfolder or file pattern (e.g. 'src/', 'Sources/Search')." })),
      mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex"), Type.Literal("symbol")], {
        description: "Search mode: 'literal' (default), 'regex', or 'symbol' (function/class definitions first).",
      })),
      limit: Type.Optional(Type.Number({ description: "Maximum files to match (default: 30)." })),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk instead of restricting to current repository." })),
    }),
    execute: async (_toolCallId: string, params: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number; global?: boolean }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const baseScope = params.global ? undefined : worktreeRoot;
        const searchScope = params.path_filter
          ? (path.isAbsolute(params.path_filter) ? params.path_filter : path.join(worktreeRoot, params.path_filter))
          : baseScope;

        // Path safety containment check
        if (searchScope && !isPathSafe(searchScope, worktreeRoot) && !params.global) {
          return { content: [{ type: "text", text: "Security violation: path filter cannot escape workspace root." }] };
        }

        const res = await client.grep(params.pattern, {
          in: searchScope,
          mode: params.mode ?? "literal",
          limit: params.limit ?? 30,
          budget_ms: 2500,
          context: 1,
        });

        if (!res.ok && res.error) {
          return { content: [{ type: "text", text: `FSearch grep error: ${res.error}` }] };
        }

        const files = res.files ?? [];
        if (files.length === 0) {
          return { content: [{ type: "text", text: `No occurrences of "${params.pattern}" found.` }] };
        }

        const outputParts: string[] = [];
        for (const file of files) {
          const relPath = file.path.startsWith(worktreeRoot) ? file.path.slice(worktreeRoot.length).replace(/^\//, "") : file.path;
          outputParts.push(`\n=== ${relPath} ===`);
          for (const m of file.matches) {
            const scrubbed = scrubSecrets(m.text);
            outputParts.push(`  L${m.line}: ${scrubbed.trim()}`);
          }
        }

        const sourceNotice = res.source === "native_fallback" ? " (native fallback)" : "";
        return {
          content: [
            {
              type: "text",
              text: `Found matches across ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms${sourceNotice}:\n${outputParts.join("\n")}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `FSearch grep unavailable: ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 3. fsearch_multi_grep: Simultaneous multi-pattern OR content retrieval
  register({
    name: "fsearch_multi_grep",
    label: "FSearch Multi Grep",
    description: "Simultaneous multi-pattern OR content retrieval across trigram index in one call.",
    parameters: Type.Object({
      patterns: Type.Array(Type.String({ description: "Identifiers or literals to search concurrently." })),
      path_filter: Type.Optional(Type.String({ description: "Optional folder filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum files to match." })),
    }),
    execute: async (_toolCallId: string, params: { patterns: string[]; path_filter?: string; limit?: number }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.path_filter ? path.join(worktreeRoot, params.path_filter) : worktreeRoot;

        const res = await client.multiGrep(params.patterns, {
          in: searchScope,
          limit: params.limit ?? 30,
        });

        if (!res.ok && res.error) {
          return { content: [{ type: "text", text: `Multi-grep error: ${res.error}` }] };
        }

        const files = res.files ?? [];
        if (files.length === 0) {
          return { content: [{ type: "text", text: `No occurrences of [${params.patterns.join(", ")}] found.` }] };
        }

        const outputParts: string[] = [];
        for (const file of files) {
          const relPath = file.path.startsWith(worktreeRoot) ? file.path.slice(worktreeRoot.length).replace(/^\//, "") : file.path;
          outputParts.push(`\n=== ${relPath} ===`);
          for (const m of file.matches) {
            outputParts.push(`  L${m.line}: ${scrubSecrets(m.text).trim()}`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Multi-grep matched ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms:\n${outputParts.join("\n")}`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Multi-grep error: ${err?.message ?? err}` }] };
      }
    },
  });

  // 4. fsearch_locate: O(1) exact file resolution
  register({
    name: "fsearch_locate",
    label: "FSearch Locate",
    description: "Instant O(1) lookup for exact filenames (e.g., 'package.json', 'Cargo.toml', 'ROADMAP.md') within current workspace.",
    parameters: Type.Object({
      filename: Type.String({ description: "Exact filename to locate." }),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk (default: false, scopes to project)." })),
    }),
    execute: async (_toolCallId: string, params: { filename: string; global?: boolean }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.global ? undefined : worktreeRoot;
        const res = await client.search(`'${params.filename}`, {
          in: searchScope,
          limit: 10,
        });

        const hits = res.hits ?? [];
        if (hits.length === 0) {
          return { content: [{ type: "text", text: `File "${params.filename}" not found.` }] };
        }

        const lines = hits.map((h) => h.path).join("\n");
        return { content: [{ type: "text", text: `Located:\n${lines}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Locate error: ${err?.message ?? err}` }] };
      }
    },
  });

  // 5. fsearch_recent: Recently worked files in the workspace / git branch
  register({
    name: "fsearch_recent",
    label: "FSearch Recent",
    description: "Returns files recently edited or touched in the current workspace or git branch (frecency-ranked).",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum recent files (default: 15)." })),
    }),
    execute: async (_toolCallId: string, params: { limit?: number }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const res = await client.recent(worktreeRoot, params.limit ?? 15);
        const hits = res.hits ?? [];
        if (hits.length === 0) {
          return { content: [{ type: "text", text: "No recent activity recorded for this workspace." }] };
        }
        const lines = hits.map((h) => h.path.replace(worktreeRoot, "").replace(/^\//, "")).join("\n");
        return { content: [{ type: "text", text: `Recent workspace files:\n${lines}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Recent activity query error: ${err?.message ?? err}` }] };
      }
    },
  });

  // 6. Automated file-touch lifecycle tracking via tool_execution_end
  if (typeof (pi as any).on === "function") {
    (pi as any).on("tool_execution_end", async (event: any) => {
      const toolName = event?.toolName;
      const filePath =
        event?.params?.path ||
        event?.params?.target_file ||
        event?.params?.file ||
        event?.params?.absolute_path;

      if (
        (toolName === "read" ||
          toolName === "edit" ||
          toolName === "write" ||
          toolName === "view_file" ||
          toolName === "edit_file" ||
          toolName === "create_file" ||
          toolName === "client_view_file" ||
          toolName === "client_edit_file" ||
          toolName === "client_create_file") &&
        typeof filePath === "string"
      ) {
        try {
          const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
          await client.open(resolved);
        } catch {
          // Non-blocking frecency recording
        }
      }
    });
  }
}
