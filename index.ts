import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FSearchClient } from "./src/client.ts";
import { isPathSafe } from "./src/sanitize.ts";
import { formatGrepFiles } from "./src/formatter.ts";
import { recordAudit, summarizeAudit, formatAuditSummary, resetAudit } from "./src/telemetry.ts";
import { analyzeCommandForBypass, diagnoseEmptyQuery } from "./src/observer.ts";

const worktreeCache = new Map<string, { root: string; timestamp: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Resolves the top-level repository worktree root in <0.1ms using upward filesystem inspection,
 * caching results to avoid expensive child process spawns on every query.
 */
function resolveWorktreeRoot(startDir = process.cwd()): string {
  const cached = worktreeCache.get(startDir);
  const now = performance.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.root;
  }

  try {
    let curr = startDir;
    while (curr && curr !== path.dirname(curr)) {
      const gitPath = path.join(curr, ".git");
      if (fs.existsSync(gitPath)) {
        try {
          const stat = fs.statSync(gitPath);
          if (stat.isDirectory() || stat.isFile()) {
            worktreeCache.set(startDir, { root: curr, timestamp: now });
            return curr;
          }
        } catch {}
      }
      curr = path.dirname(curr);
    }

    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) {
      worktreeCache.set(startDir, { root, timestamp: now });
      return root;
    }
  } catch {
    // Not a git repo or git unavailable
  }

  worktreeCache.set(startDir, { root: startDir, timestamp: now });
  return startDir;
}

export default function piUltraSearchExtension(pi: ExtensionAPI): void {
  const client = new FSearchClient();

  // Helper to register tools cleanly across all Pi versions
  const register = (toolDef: any) => {
    if (typeof (pi as any).registerTool === "function") {
      (pi as any).registerTool(toolDef);
    }
  };

  // 1. fsearch_query: Fast path/file discovery with strict zero typo tolerance, globs, git filters, and proximity ranking
  register({
    name: "fsearch_query",
    label: "UltraSearch Query",
    description:
      "Instant indexed whole-disk or workspace file search (<0.1ms). Strict deterministic matching (zero typo tolerance) for exact symbol, glob, and path resolution. Supports globs (src/**/*.{ts,tsx}), extension filters (*.rs), git status filters (git:modified, git:staged, git:untracked), and proximity re-ranking (near: <path>). Scoped strictly to the active worktree root.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search keywords, globs, or filters (e.g. 'Omnibox *.swift', 'git:modified', 'near:index.ts', 'src/**/*.{ts,tsx} !test/'). Zero typo tolerance enforced.",
      }),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 30)." })),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk instead of restricting to current repository worktree." })),
      near: Type.Optional(Type.String({ description: "Optional active file path to re-rank results by folder proximity." })),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number; global?: boolean; near?: string }) => {
      const start = performance.now();
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

        const elapsed = performance.now() - start;

        if (!res.ok && res.error) {
          recordAudit({
            ts: Date.now(),
            tool: "fsearch_query",
            query: params.query,
            scope: searchScope,
            ms: elapsed,
            ok: false,
            hitCount: 0,
            source: res.source ?? "index",
          });
          return { content: [{ type: "text", text: `UltraSearch error: ${res.error}` }] };
        }

        const hits = res.hits ?? [];

        // Telemetry & Diagnostic hint when 0 hits occur
        let hintText = "";
        if (hits.length === 0) {
          const hint = await diagnoseEmptyQuery(params.query, worktreeRoot, client);
          if (hint) hintText = `\n[UltraSearch Diagnostic: ${hint}]`;
        }

        recordAudit({
          ts: Date.now(),
          tool: "fsearch_query",
          query: params.query,
          scope: searchScope,
          ms: elapsed,
          ok: true,
          hitCount: hits.length,
          source: res.source ?? "index",
          diagnosticHint: hintText.trim() || undefined,
        });

        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files matching "${params.query}" found (zero typo tolerance enforced).${hintText}`,
              },
            ],
          };
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
          content: [{ type: "text", text: `UltraSearch query unavailable: ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 2. fsearch_grep: Instant indexed trigram text content search (<1ms)
  register({
    name: "fsearch_grep",
    label: "UltraSearch Grep",
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
      compact: Type.Optional(Type.Boolean({ description: "Return compact 'file:line: match' format (default: true). Set false for verbose blocks." })),
      max_tokens: Type.Optional(Type.Number({ description: "Optional token budget ceiling. Omit for complete, uncapped results." })),
    }),
    execute: async (_toolCallId: string, params: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number; global?: boolean; compact?: boolean; max_tokens?: number }) => {
      const start = performance.now();
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const baseScope = params.global ? undefined : worktreeRoot;
        const searchScope = params.path_filter
          ? (path.isAbsolute(params.path_filter) ? params.path_filter : path.join(worktreeRoot, params.path_filter))
          : baseScope;

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

        const elapsed = performance.now() - start;

        if (!res.ok && res.error) {
          recordAudit({
            ts: Date.now(),
            tool: "fsearch_grep",
            pattern: params.pattern,
            scope: searchScope,
            ms: elapsed,
            ok: false,
            hitCount: 0,
            source: res.source ?? "index",
          });
          return { content: [{ type: "text", text: `UltraSearch grep error: ${res.error}` }] };
        }

        const files = res.files ?? [];
        recordAudit({
          ts: Date.now(),
          tool: "fsearch_grep",
          pattern: params.pattern,
          scope: searchScope,
          ms: elapsed,
          ok: true,
          hitCount: files.length,
          source: res.source ?? "index",
        });

        if (files.length === 0) {
          return { content: [{ type: "text", text: `No occurrences of "${params.pattern}" found.` }] };
        }

        const formatted = formatGrepFiles(files, {
          worktreeRoot,
          compact: params.compact,
          maxTokens: params.max_tokens,
          prioritizeSymbols: params.mode === "symbol",
        });
        const sourceNotice = res.source === "native_fallback" ? " (native fallback)" : "";
        return {
          content: [
            {
              type: "text",
              text: `Found matches across ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms${sourceNotice} (~${formatted.tokenCount} tokens):\n${formatted.text}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `UltraSearch grep unavailable: ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 3. fsearch_multi_grep: Simultaneous multi-pattern OR content retrieval
  register({
    name: "fsearch_multi_grep",
    label: "UltraSearch Multi Grep",
    description: "Simultaneous multi-pattern OR content retrieval across trigram index in one call.",
    parameters: Type.Object({
      patterns: Type.Array(Type.String({ description: "Identifiers or literals to search concurrently." })),
      path_filter: Type.Optional(Type.String({ description: "Optional folder filter." })),
      limit: Type.Optional(Type.Number({ description: "Maximum files to match." })),
      compact: Type.Optional(Type.Boolean({ description: "Return compact 'file:line: match' format (default: true). Set false for verbose blocks." })),
      max_tokens: Type.Optional(Type.Number({ description: "Optional token budget ceiling. Omit for complete, uncapped results." })),
    }),
    execute: async (_toolCallId: string, params: { patterns: string[]; path_filter?: string; limit?: number; compact?: boolean; max_tokens?: number }) => {
      const start = performance.now();
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.path_filter ? path.join(worktreeRoot, params.path_filter) : worktreeRoot;

        const res = await client.multiGrep(params.patterns, {
          in: searchScope,
          limit: params.limit ?? 30,
        });

        const elapsed = performance.now() - start;
        const files = res.files ?? [];

        recordAudit({
          ts: Date.now(),
          tool: "fsearch_multi_grep",
          pattern: params.patterns.join(" | "),
          scope: searchScope,
          ms: elapsed,
          ok: res.ok,
          hitCount: files.length,
          source: res.source ?? "index",
        });

        if (!res.ok && res.error) {
          return { content: [{ type: "text", text: `Multi-grep error: ${res.error}` }] };
        }

        if (files.length === 0) {
          return { content: [{ type: "text", text: `No occurrences of [${params.patterns.join(", ")}] found.` }] };
        }

        const formatted = formatGrepFiles(files, {
          worktreeRoot,
          compact: params.compact,
          maxTokens: params.max_tokens,
        });
        return {
          content: [
            {
              type: "text",
              text: `Multi-grep matched ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms (~${formatted.tokenCount} tokens):\n${formatted.text}`,
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
    label: "UltraSearch Locate",
    description: "Instant O(1) lookup for exact filenames (e.g., 'package.json', 'Cargo.toml', 'ROADMAP.md') within current workspace.",
    parameters: Type.Object({
      filename: Type.String({ description: "Exact filename to locate." }),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk (default: false, scopes to project)." })),
    }),
    execute: async (_toolCallId: string, params: { filename: string; global?: boolean }) => {
      const start = performance.now();
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.global ? undefined : worktreeRoot;
        const res = await client.search(`'${params.filename}`, {
          in: searchScope,
          limit: 10,
        });

        const elapsed = performance.now() - start;
        const hits = res.hits ?? [];

        recordAudit({
          ts: Date.now(),
          tool: "fsearch_locate",
          query: params.filename,
          scope: searchScope,
          ms: elapsed,
          ok: res.ok,
          hitCount: hits.length,
          source: res.source ?? "index",
        });

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
    label: "UltraSearch Recent",
    description: "Returns files recently edited or touched in the current workspace or git branch (frecency-ranked).",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum recent files (default: 15)." })),
    }),
    execute: async (_toolCallId: string, params: { limit?: number }) => {
      const start = performance.now();
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const res = await client.recent(worktreeRoot, params.limit ?? 15);
        const elapsed = performance.now() - start;
        const hits = res.hits ?? [];

        recordAudit({
          ts: Date.now(),
          tool: "fsearch_recent",
          scope: worktreeRoot,
          ms: elapsed,
          ok: res.ok,
          hitCount: hits.length,
          source: res.source ?? "index",
        });

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

  // 6. fsearch_metrics: Observability toolchain audit profiler & self-learning advice
  register({
    name: "fsearch_metrics",
    label: "UltraSearch Metrics",
    description: "Observability profiler: returns per-tool latencies (p50/p90/p95), error rates, 0-hit diagnostics, CLI bypasses (find/rg), and recursive self-learning recommendations.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Number of audit rows to analyze (default: 1000)." })),
    }),
    execute: async () => {
      const summary = summarizeAudit();
      return {
        content: [{ type: "text", text: formatAuditSummary(summary) }],
      };
    },
  });

  // Slash commands: /ultrasearch and /fsearch (alias) [metrics|audit|reset|status]
  if (typeof (pi as any).registerCommand === "function") {
    const handleCommand = async (args: string, ctx: any) => {
      const action = args.trim().toLowerCase();
      if (action === "metrics" || action === "audit") {
        const summary = summarizeAudit();
        ctx?.ui?.notify(formatAuditSummary(summary), "info");
      } else if (action === "reset") {
        resetAudit();
        ctx?.ui?.notify("UltraSearch audit log cleared.", "info");
      } else {
        const status = await client.status();
        ctx?.ui?.notify(
          `UltraSearch v0.2.2 daemon active: ${status.entries ?? 0} files indexed; index size: ${((status.index_bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`,
          "info"
        );
      }
    };

    (pi as any).registerCommand("ultrasearch", {
      description: "UltraSearch telemetry, toolchain audit, and status.",
      handler: handleCommand,
    });
    (pi as any).registerCommand("fsearch", {
      description: "UltraSearch telemetry, toolchain audit, and status (alias).",
      handler: handleCommand,
    });
  }

  // 7. Toolchain Shadow Detector & File Touch lifecycle tracking via tool_execution_end
  if (typeof (pi as any).on === "function") {
    (pi as any).on("tool_execution_end", async (event: any) => {
      const toolName = event?.toolName;

      // Shadow Detector: check if agent bypassed fsearch with bash/powershell find or rg
      if (toolName === "bash" || toolName === "powershell") {
        const cmd = event?.params?.command || event?.params?.cmd;
        const duration = event?.durationMs ?? 20;
        if (typeof cmd === "string") {
          analyzeCommandForBypass(cmd, duration);
        }
      }

      // Frecency touch tracking
      const filePath =
        event?.params?.path ||
        event?.params?.target_file ||
        event?.params?.file ||
        event?.params?.absolute_path;

      if (
        (toolName === "read" ||
          toolName === "edit" ||
          toolName === "write" ||
          toolName === "client_view_file" ||
          toolName === "client_edit_file" ||
          toolName === "client_create_file") &&
        typeof filePath === "string"
      ) {
        client.open(filePath).catch(() => {});
      }
    });
  }
}
