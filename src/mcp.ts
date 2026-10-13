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
          serverInfo: { name: "pi-ultrasearch-mcp", version: "0.2.2" },
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
              description: "Fast indexed file and path discovery (<0.1ms). Supports globs, git filters, and zero typo tolerance.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query or glob" },
                  limit: { type: "number", description: "Max results" },
                },
                required: ["query"],
              },
            },
            {
              name: "fsearch_grep",
              description: "Indexed trigram text search inside files (<1ms).",
              inputSchema: {
                type: "object",
                properties: {
                  pattern: { type: "string", description: "Literal or identifier to search" },
                  path_filter: { type: "string", description: "Subdirectory filter" },
                },
                required: ["pattern"],
              },
            },
          ],
        },
      };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "fsearch_query") {
        const res = await this.client.search(args.query, { in: this.cwd, limit: args.limit ?? 20 });
        const hits = res.hits ?? [];
        const formatted = hits.map((h) => `${h.path} (${h.kind})`).join("\n");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatted || "No matches found." }],
          },
        };
      }

      if (toolName === "fsearch_grep") {
        const res = await this.client.grep(args.pattern, { in: this.cwd, limit: 20 });
        const files = res.files ?? [];
        const out = files.map((f) => `${f.path}:\n` + f.matches.map((m) => `  L${m.line}: ${scrubSecrets(m.text)}`).join("\n")).join("\n");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: out || "No occurrences found." }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${toolName}` },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported method: ${method}` },
    };
  }
}
