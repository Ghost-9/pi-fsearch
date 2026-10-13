import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FSearchClient } from "./src/client.ts";
import { scrubSecrets } from "./src/sanitize.ts";

export default function piFsearchExtension(pi: ExtensionAPI): void {
  const client = new FSearchClient();

  // 1. fsearch_query: Fast path/file discovery with fuzzy matching and globs
  pi.defineTool({
    name: "fsearch_query",
    label: "FSearch Query",
    description:
      "Instant indexed whole-disk or workspace file search (<0.1ms). Supports typos (forgives 1-2 typos), globs (src/**/*.{ts,tsx}), extension filters (*.rs), and git filters (git:modified, git:staged). By default scoped to current working directory.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search keywords, globs, or filters (e.g., 'Omnibox *.swift', 'git:modified', 'src/**/*.{ts,tsx} !test/').",
      }),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 30)." })),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk instead of restricting to current working directory." })),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number; global?: boolean }) => {
      try {
        const cwd = process.cwd();
        const searchScope = params.global ? undefined : cwd;
        const res = await client.search(params.query, {
          in: searchScope,
          limit: params.limit ?? 30,
          git: true,
          boost: true,
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
            const rel = h.path.startsWith(cwd) ? h.path.slice(cwd.length).replace(/^\//, "") : h.path;
            const gitTag = h.git ? ` [git:${h.git}]` : "";
            return `${rel}${gitTag} (${h.kind}, score: ${h.score})`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${hits.length} matches in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms:\n${formatted}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `FSearch unavailable (fallback recommended): ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 2. fsearch_grep: Instant indexed trigram text content search (<1ms)
  pi.defineTool({
    name: "fsearch_grep",
    label: "FSearch Grep",
    description:
      "Ultra-fast indexed trigram content search (<1ms). Searches inside text files for identifiers, function definitions, or literals without running slow recursive disk greps. Results scrubbed for credentials.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Literal text or identifier to search for." }),
      path_filter: Type.Optional(Type.String({ description: "Optional subfolder or file pattern (e.g. 'src/', 'Sources/Search')." })),
      mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex"), Type.Literal("symbol")], {
        description: "Search mode: 'literal' (default), 'regex', or 'symbol' (function/class definitions first).",
      })),
      limit: Type.Optional(Type.Number({ description: "Maximum files to match (default: 30)." })),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk instead of restricting to current working directory." })),
    }),
    execute: async (_toolCallId: string, params: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number; global?: boolean }) => {
      try {
        const cwd = process.cwd();
        const baseScope = params.global ? undefined : cwd;
        const searchScope = params.path_filter
          ? (params.path_filter.startsWith("/") ? params.path_filter : `${cwd}/${params.path_filter}`)
          : baseScope;

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
          const relPath = file.path.startsWith(cwd) ? file.path.slice(cwd.length).replace(/^\//, "") : file.path;
          outputParts.push(`\n=== ${relPath} ===`);
          for (const m of file.matches) {
            const scrubbed = scrubSecrets(m.text);
            outputParts.push(`  L${m.line}: ${scrubbed.trim()}`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Found matches across ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms (source: ${res.source ?? "index"}):\n${outputParts.join("\n")}`,
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

  // 3. fsearch_locate: O(1) exact file resolution
  pi.defineTool({
    name: "fsearch_locate",
    label: "FSearch Locate",
    description: "Instant O(1) lookup for exact filenames (e.g., 'package.json', 'Cargo.toml', 'ROADMAP.md') within the project or disk.",
    parameters: Type.Object({
      filename: Type.String({ description: "Exact filename to locate." }),
      global: Type.Optional(Type.Boolean({ description: "Search entire disk (default: false, scopes to project)." })),
    }),
    execute: async (_toolCallId: string, params: { filename: string; global?: boolean }) => {
      try {
        const cwd = process.cwd();
        const searchScope = params.global ? undefined : cwd;
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

  // 4. fsearch_recent: Recently worked files in the workspace / git branch
  pi.defineTool({
    name: "fsearch_recent",
    label: "FSearch Recent",
    description: "Returns files recently edited or touched in the current workspace or git branch (frecency-ranked).",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum recent files (default: 15)." })),
    }),
    execute: async (_toolCallId: string, params: { limit?: number }) => {
      try {
        const cwd = process.cwd();
        const res = await client.recent(cwd, params.limit ?? 15);
        const hits = res.hits ?? [];
        if (hits.length === 0) {
          return { content: [{ type: "text", text: "No recent activity recorded for this workspace." }] };
        }
        const lines = hits.map((h) => h.path.replace(cwd, "").replace(/^\//, "")).join("\n");
        return { content: [{ type: "text", text: `Recent workspace files:\n${lines}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Recent activity query error: ${err?.message ?? err}` }] };
      }
    },
  });

  // Track file opens to feed frecency engine
  if (typeof pi.on === "function") {
    pi.on("tool_execution_end", async (event: any) => {
      const toolName = event?.toolName;
      const filePath = event?.params?.path || event?.params?.target_file || event?.params?.file;
      if ((toolName === "read" || toolName === "edit" || toolName === "write") && typeof filePath === "string") {
        try {
          await client.open(filePath);
        } catch {
          // Non-blocking frecency recording
        }
      }
    });
  }
}
