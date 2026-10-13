import * as readline from "node:readline";
import { FSearchClient } from "./client.ts";
import { scrubSecrets } from "./sanitize.ts";

/**
 * Lightweight native Model Context Protocol (MCP) server speaking JSON-RPC 2.0 over stdio.
 * Can be run via `npx tsx bin/mcp-server.ts` in Claude Desktop, Antigravity, or T3 Code.
 */
export class FSearchMcpServer {
  private client: FSearchClient;
  private cwd: string;

  constructor(client?: FSearchClient, cwd = process.cwd()) {
    this.client = client ?? new FSearchClient();
    this.cwd = cwd;
  }

  public start(): void {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        const res = await this.handleRpc(req);
        if (res) {
          process.stdout.write(JSON.stringify(res) + "\n");
        }
      } catch (err: any) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: `Parse error: ${err?.message ?? err}` },
          }) + "\n"
        );
      }
    });
  }

  private async handleRpc(req: any): Promise<any> {
    const { id, method, params } = req;

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "pi-fsearch-mcp", version: "0.2.0" },
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
              description: "Fast indexed file search with globs, typo forgiveness, and git filters.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query or glob" },
                  limit: { type: "number", description: "Maximum results (default: 30)" },
                  near: { type: "string", description: "Proximity re-ranking file target" },
                },
                required: ["query"],
              },
            },
            {
              name: "fsearch_grep",
              description: "Instant indexed trigram text content search (<1ms) inside code files.",
              inputSchema: {
                type: "object",
                properties: {
                  pattern: { type: "string", description: "String or regex to search" },
                  path_filter: { type: "string", description: "Folder filter" },
                  mode: { type: "string", enum: ["literal", "regex", "symbol"] },
                  limit: { type: "number" },
                },
                required: ["pattern"],
              },
            },
            {
              name: "fsearch_locate",
              description: "O(1) exact filename resolution.",
              inputSchema: {
                type: "object",
                properties: {
                  filename: { type: "string", description: "Filename to find" },
                },
                required: ["filename"],
              },
            },
            {
              name: "fsearch_multi_grep",
              description: "Simultaneous multi-pattern OR content retrieval.",
              inputSchema: {
                type: "object",
                properties: {
                  patterns: { type: "array", items: { type: "string" } },
                  path_filter: { type: "string" },
                },
                required: ["patterns"],
              },
            },
          ],
        },
      };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      try {
        if (toolName === "fsearch_query") {
          const res = await this.client.search(args.query, { in: this.cwd, limit: args.limit ?? 30, near: args.near });
          const text = (res.hits ?? []).map((h) => `${h.path} (${h.kind}, score: ${h.score})`).join("\n");
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: text || "No matches." }] },
          };
        }

        if (toolName === "fsearch_grep") {
          const res = await this.client.grep(args.pattern, {
            in: args.path_filter ? `${this.cwd}/${args.path_filter}` : this.cwd,
            mode: args.mode,
            limit: args.limit ?? 30,
          });
          const lines: string[] = [];
          for (const f of res.files ?? []) {
            lines.push(`=== ${f.path} ===`);
            for (const m of f.matches) lines.push(`  L${m.line}: ${scrubSecrets(m.text).trim()}`);
          }
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: lines.join("\n") || "No matches." }] },
          };
        }

        if (toolName === "fsearch_locate") {
          const res = await this.client.search(`'${args.filename}`, { in: this.cwd, limit: 10 });
          const text = (res.hits ?? []).map((h) => h.path).join("\n");
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: text || "Not found." }] },
          };
        }

        if (toolName === "fsearch_multi_grep") {
          const res = await this.client.multiGrep(args.patterns ?? [], {
            in: args.path_filter ? `${this.cwd}/${args.path_filter}` : this.cwd,
          });
          const lines: string[] = [];
          for (const f of res.files ?? []) {
            lines.push(`=== ${f.path} ===`);
            for (const m of f.matches) lines.push(`  L${m.line}: ${scrubSecrets(m.text).trim()}`);
          }
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: lines.join("\n") || "No matches." }] },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Tool '${toolName}' not found.` },
        };
      } catch (err: any) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${err?.message ?? err}` }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method '${method}' not found.` },
    };
  }
}
