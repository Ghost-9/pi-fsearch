import * as readline from "node:readline";
import * as path from "node:path";
import { FSearchClient } from "./client.ts";
import { formatGrepFiles } from "./formatter.ts";
import { summarizeAudit, formatAuditSummary } from "./telemetry.ts";
import { diagnoseEmptyQuery } from "./observer.ts";

/**
 * Enterprise Model Context Protocol (MCP) server speaking JSON-RPC 2.0 over stdio.
 * Supports Claude Desktop, Cursor, Windsurf, Zed, VS Code, Antigravity, and T3 Code.
 */
export class FSearchMcpServer {
  private client: FSearchClient;
  private cwd: string;

  constructor(client?: FSearchClient, cwd = process.cwd()) {
    this.client = client ?? new FSearchClient();
    this.cwd = cwd;
  }

  public start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed);
        const resp = await this.handleMessage(msg);
        if (resp) {
          process.stdout.write(JSON.stringify(resp) + "\n");
        }
      } catch (err: any) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error", data: err?.message },
          }) + "\n"
        );
      }
    });

    process.on("SIGINT", () => {
      this.client.close();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      this.client.close();
      process.exit(0);
    });
  }

  public async handleMessage(msg: any): Promise<any> {
    const { id, method, params } = msg;

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "pi-ultrasearch",
            version: "0.3.0",
          },
          capabilities: {
            tools: {},
          },
        },
      };
    }

    if (method === "notifications/initialized") {
      return null;
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "fsearch_query",
              description: "Instant indexed whole-disk or workspace file search (<0.1ms). Strict zero typo tolerance. Supports globs, extension filters, and git filters.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query, glob, or filter (e.g. 'Omnibox *.swift', 'git:modified')" },
                  limit: { type: "number", description: "Max results (default: 30)" },
                  global: { type: "boolean", description: "Search whole disk instead of workspace" },
                },
                required: ["query"],
              },
            },
            {
              name: "fsearch_grep",
              description: "Indexed trigram text search inside files (<1ms). Clean compact output with enterprise DLP credential masking.",
              inputSchema: {
                type: "object",
                properties: {
                  pattern: { type: "string", description: "Literal or identifier to search" },
                  path_filter: { type: "string", description: "Subdirectory or file filter" },
                  mode: { type: "string", enum: ["literal", "regex", "symbol"], description: "Search mode" },
                  limit: { type: "number", description: "Max files to return" },
                  compact: { type: "boolean", description: "Compact one-line format (default: true)" },
                  max_tokens: { type: "number", description: "Optional token budget ceiling" },
                  context: { type: "number", description: "Lines of surrounding code context (0-5, default: 0)" },
                  tag_symbols: { type: "boolean", description: "Tag matches with AST definition types like [def:fn], [def:class]" },
                },
                required: ["pattern"],
              },
            },
            {
              name: "fsearch_multi_grep",
              description: "Simultaneous multi-pattern OR content retrieval across trigram index in one call.",
              inputSchema: {
                type: "object",
                properties: {
                  patterns: { type: "array", items: { type: "string" }, description: "Array of search patterns" },
                  path_filter: { type: "string", description: "Subdirectory filter" },
                  compact: { type: "boolean", description: "Compact one-line format (default: true)" },
                  max_tokens: { type: "number", description: "Optional token budget ceiling" },
                },
                required: ["patterns"],
              },
            },
            {
              name: "fsearch_locate",
              description: "Instant O(1) filename lookup (e.g. 'package.json', 'Cargo.toml') within current workspace.",
              inputSchema: {
                type: "object",
                properties: {
                  filename: { type: "string", description: "Exact filename to locate" },
                  global: { type: "boolean", description: "Search entire disk" },
                },
                required: ["filename"],
              },
            },
            {
              name: "fsearch_recent",
              description: "Recently worked or edited files in current workspace (frecency ranked).",
              inputSchema: {
                type: "object",
                properties: {
                  limit: { type: "number", description: "Max recent files (default: 15)" },
                },
              },
            },
            {
              name: "fsearch_metrics",
              description: "Toolchain latency metrics (p50/p90/p95), error rates, zero-hit queries, and recursive self-learning advice.",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      const activeRoot = args.path ? path.resolve(this.cwd, args.path) : this.cwd;

      if (toolName === "fsearch_query") {
        const searchScope = args.global ? undefined : activeRoot;
        const res = await this.client.search(args.query, { in: searchScope, limit: args.limit ?? 30 });
        const hits = res.hits ?? [];
        if (hits.length === 0) {
          const hint = await diagnoseEmptyQuery(args.query, activeRoot, this.client);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `No files matching "${args.query}" found.\n💡 Hint: ${hint ?? "Verify exact symbol casing."}`,
                },
              ],
            },
          };
        }
        const formatted = hits.map((h) => `${h.path} (${h.kind}, score: ${h.score})`).join("\n");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatted }],
          },
        };
      }

      if (toolName === "fsearch_grep") {
        const searchScope = args.path_filter ? path.resolve(activeRoot, args.path_filter) : activeRoot;
        const ctxCount = typeof args.context === "number" ? args.context : 0;
        const res = await this.client.grep(args.pattern, {
          in: searchScope,
          mode: args.mode ?? "literal",
          limit: args.limit ?? 30,
          context: ctxCount,
        });
        const files = res.files ?? [];
        if (files.length === 0) {
          const hint = await diagnoseEmptyQuery(args.pattern, activeRoot, this.client);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `No occurrences of "${args.pattern}" found.\n💡 Hint: ${hint ?? "Strict exact zero-typo matching enforced."}`,
                },
              ],
            },
          };
        }
        const formatted = formatGrepFiles(files, {
          worktreeRoot: activeRoot,
          compact: args.compact ?? true,
          maxTokens: args.max_tokens,
          prioritizeSymbols: args.mode === "symbol",
          showContext: ctxCount > 0,
          tagSymbols: args.tag_symbols ?? (args.mode === "symbol"),
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatted.text }],
          },
        };
      }

      if (toolName === "fsearch_multi_grep") {
        const searchScope = args.path_filter ? path.resolve(activeRoot, args.path_filter) : activeRoot;
        const res = await this.client.multiGrep(args.patterns ?? [], {
          in: searchScope,
          limit: args.limit ?? 30,
        });
        const files = res.files ?? [];
        if (files.length === 0) {
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `No occurrences of [${(args.patterns ?? []).join(", ")}] found.\n💡 Hint: Exact zero-typo matching enforced across all patterns.` }] },
          };
        }
        const formatted = formatGrepFiles(files, {
          worktreeRoot: activeRoot,
          compact: args.compact ?? true,
          maxTokens: args.max_tokens,
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatted.text }],
          },
        };
      }

      if (toolName === "fsearch_locate") {
        const searchScope = args.global ? undefined : activeRoot;
        const res = await this.client.search(`'${args.filename}`, { in: searchScope, limit: 10 });
        const hits = res.hits ?? [];
        if (hits.length === 0) {
          const hint = await diagnoseEmptyQuery(args.filename, activeRoot, this.client);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `File "${args.filename}" not found in current scope.\n💡 Hint: ${hint ?? "Use fsearch_query for glob search across subdirectories."}`,
                },
              ],
            },
          };
        }
        const formatted = hits.map((h) => h.path).join("\n");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatted }],
          },
        };
      }

      if (toolName === "fsearch_recent") {
        const res = await this.client.recent(activeRoot, args.limit ?? 15);
        const hits = res.hits ?? [];
        const formatted = hits.map((h) => `${h.path} (score: ${h.score})`).join("\n");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatted || "No recent files recorded in scope." }],
          },
        };
      }

      if (toolName === "fsearch_metrics") {
        const summary = summarizeAudit(1000);
        const report = formatAuditSummary(summary);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: report }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool not found: ${toolName}` },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }
}
