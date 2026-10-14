import * as readline from "node:readline";
import * as path from "node:path";
import { UltraSearchClient } from "./client.ts";
import { formatGrepFiles } from "./formatter.ts";
import { searchSemanticIntent } from "./semantic.ts";
import { summarizeAudit, formatAuditSummary } from "./telemetry.ts";
import { diagnoseEmptyQuery } from "./observer.ts";

/**
 * Version reported in `initialize.serverInfo`. Keep in sync with package.json.
 */
export const SERVER_VERSION = "0.3.1";

/**
 * MCP protocol revisions this server understands, newest first. The server
 * echoes the client's requested revision when it is in this list, and answers
 * with the newest supported revision otherwise (MCP lifecycle negotiation).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes used by this server. */
export const JSON_RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** MCP: request received before the initialize handshake. */
  NOT_INITIALIZED: -32002,
} as const;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function err(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * The UltraSearch MCP tool surface. Exactly one prefix (`ultrasearch_`); the
 * historical `fsearch_*` aliases are deliberately gone, so `tools/list` is the
 * single source of truth for every client.
 */
export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "ultrasearch_query",
    description:
      "Instant indexed whole-disk or workspace file search (<0.1ms). Strict zero typo tolerance. Supports globs, extension filters, and git filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, glob, or filter (e.g. 'Omnibox *.swift', 'git:modified')" },
        limit: { type: "number", description: "Max results (default: 30)" },
        global: { type: "boolean", description: "Search whole disk instead of workspace" },
        near: { type: "string", description: "Optional file path to re-rank results by folder proximity" },
        budget_ms: { type: "number", description: "Optional server-side deadline (ms); partial results carry complete:false" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "ultrasearch_grep",
    description: "Indexed trigram text search inside files (<1ms). Clean compact output with enterprise DLP credential masking.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Literal or identifier to search" },
        path_filter: { type: "string", description: "Subdirectory or file filter" },
        mode: { type: "string", enum: ["literal", "regex", "symbol", "semantic"], description: "Search mode (semantic = intent keyword expansion)" },
        limit: { type: "number", description: "Max files to return" },
        compact: { type: "boolean", description: "Compact one-line format (default: true)" },
        max_tokens: { type: "number", description: "Optional token budget ceiling" },
        context: { type: "number", description: "Lines of surrounding code context (0-5, default: 0)" },
        tag_symbols: { type: "boolean", description: "Tag matches with AST definition types like [def:fn], [def:class]" },
        budget_ms: { type: "number", description: "Optional server-side deadline (ms); partial results carry complete:false" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "ultrasearch_multi_grep",
    description: "Simultaneous multi-pattern OR content retrieval across trigram index in one call.",
    inputSchema: {
      type: "object",
      properties: {
        patterns: { type: "array", items: { type: "string" }, description: "Array of search patterns" },
        path_filter: { type: "string", description: "Subdirectory filter" },
        compact: { type: "boolean", description: "Compact one-line format (default: true)" },
        max_tokens: { type: "number", description: "Optional token budget ceiling" },
        budget_ms: { type: "number", description: "Optional server-side deadline (ms); partial results carry complete:false" },
      },
      required: ["patterns"],
      additionalProperties: false,
    },
  },
  {
    name: "ultrasearch_locate",
    description: "Instant O(1) filename lookup (e.g. 'package.json', 'Cargo.toml') within current workspace.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Exact filename to locate" },
        global: { type: "boolean", description: "Search entire disk" },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "ultrasearch_recent",
    description: "Recently worked or edited files in current workspace (frecency ranked).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max recent files (default: 15)" } },
      additionalProperties: false,
    },
  },
  {
    name: "ultrasearch_metrics",
    description: "Toolchain latency metrics (p50/p90/p95), error rates, zero-hit queries, and recursive self-learning advice. Defaults to organic (non-gate) rows.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["real", "synthetic", "all"], description: "Audit provenance view (default: real = organic sessions only)" },
        limit: { type: "number", description: "Number of audit rows to analyze (default 1000)" },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Model Context Protocol server speaking JSON-RPC 2.0 over stdio.
 * Supports Claude Desktop, Cursor, Windsurf, Zed, VS Code, Antigravity, and T3 Code.
 *
 * Conformance: newline-delimited JSON (one message per line), notifications are
 * never answered, requests before `initialize` are rejected with -32002, and
 * transport/protocol failures use the JSON-RPC error codes.
 */
export class UltraSearchMcpServer {
  private client: UltraSearchClient;
  private cwd: string;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(client?: UltraSearchClient, cwd = process.cwd()) {
    this.client = client ?? new UltraSearchClient();
    this.cwd = cwd;
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  /** Attach to process stdio. One JSON message per line; blank lines ignored. */
  public start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", (line) => {
      // Serialize handling: a later frame must never overtake an earlier one,
      // so responses leave in request order (a sync parse-error reply would
      // otherwise jump ahead of an awaited request).
      this.queue = this.queue.then(() => this.dispatch(line));
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

  /**
   * Parse and answer one framed stdio message. Never throws, never writes for a
   * notification, and answers malformed JSON with a -32700 parse error.
   */
  public async dispatch(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch (parseErr: any) {
      this.write(err(null, JSON_RPC_ERRORS.PARSE, "Parse error", parseErr?.message ?? String(parseErr)));
      return;
    }

    const response = await this.handleMessage(msg);
    if (response) this.write(response);
  }

  protected write(response: unknown): void {
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  /** Pure message handler: returns the response, or null for notifications. */
  public async handleMessage(msg: any): Promise<any> {
    // JSON-RPC: a message without an `id` member is a notification. It must
    // never be answered, whatever its method or shape.
    const isNotification = msg !== null && typeof msg === "object" && !Array.isArray(msg) && !("id" in msg);

    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return isNotification ? null : err(null, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request");
    }

    const { id, method, params } = msg;

    if (typeof method !== "string" || method.length === 0) {
      return isNotification ? null : err(id ?? null, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request: method must be a string");
    }

    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
    const fail = (code: number, message: string, data?: unknown) => err(id ?? null, code, message, data);

    // --- lifecycle -----------------------------------------------------------
    if (method === "initialize") {
      this.initialized = true;
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return reply({
        protocolVersion,
        serverInfo: { name: "pi-ultrasearch", version: SERVER_VERSION },
        capabilities: { tools: { listChanged: false } },
      });
    }

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }

    if (method === "ping") {
      return reply({});
    }

    // Everything below the handshake is rejected until `initialize` arrives.
    if (!this.initialized) {
      return isNotification ? null : fail(JSON_RPC_ERRORS.NOT_INITIALIZED, "Server not initialized");
    }

    if (method === "tools/list") {
      return reply({ tools: MCP_TOOLS });
    }

    if (method === "tools/call") {
      const rawName = params?.name;
      if (typeof rawName !== "string" || rawName.length === 0) {
        return fail(JSON_RPC_ERRORS.INVALID_PARAMS, "Invalid params: 'name' must be a string");
      }
      if (params?.arguments !== undefined && (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments))) {
        return fail(JSON_RPC_ERRORS.INVALID_PARAMS, "Invalid params: 'arguments' must be an object");
      }
      if (!MCP_TOOLS.some((t) => t.name === rawName)) {
        return fail(JSON_RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${rawName}`);
      }
      try {
        return reply(await this.callTool(rawName, params?.arguments ?? {}));
      } catch (toolErr: any) {
        // A tool that ran and failed is a result, not a protocol error.
        return reply({
          content: [{ type: "text", text: `UltraSearch error: ${toolErr?.message ?? toolErr}` }],
          isError: true,
        });
      }
    }

    return isNotification ? null : fail(JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  private async callTool(
    name: string,
    args: any
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }> {
    const activeRoot = typeof args.path === "string" ? path.resolve(this.cwd, args.path) : this.cwd;
    const text = (t: string, isError = false, meta?: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: t }],
      ...(isError ? { isError: true } : {}),
      ...(meta ? { _meta: meta } : {}),
    });

    if (name === "ultrasearch_query") {
      if (typeof args.query !== "string" || args.query.length === 0) {
        return text("Invalid params: 'query' must be a non-empty string", true);
      }
      const searchScope = args.global ? undefined : activeRoot;
      const res = await this.client.search(args.query, {
        in: searchScope,
        limit: args.limit ?? 30,
        near: args.near,
        budget_ms: args.budget_ms,
      });
      const hits = res.hits ?? [];
      const meta = { ...(res.meta ?? { complete: false }), tool: "ultrasearch_query", hitCount: hits.length };
      if (hits.length === 0) {
        const hint = await diagnoseEmptyQuery(args.query, activeRoot, this.client);
        return text(`No files matching "${args.query}" found.\n💡 Hint: ${hint ?? "Verify exact symbol casing."}`, false, meta);
      }
      return text(hits.map((h) => `${h.path} (${h.kind}, score: ${h.score})`).join("\n"), false, meta);
    }

    if (name === "ultrasearch_grep") {
      if (typeof args.pattern !== "string" || args.pattern.length === 0) {
        return text("Invalid params: 'pattern' must be a non-empty string", true);
      }
      const searchScope = args.path_filter ? path.resolve(activeRoot, args.path_filter) : activeRoot;
      const ctxCount = typeof args.context === "number" ? args.context : 0;
      let files: any[] = [];
      let resultMeta: any = undefined;
      if (args.mode === "semantic") {
        const semantic = await searchSemanticIntent(this.client, args.pattern, { in: searchScope, limit: args.limit ?? 30, auditTool: "ultrasearch_grep" });
        files = semantic.files ?? [];
      } else {
        const res = await this.client.grep(args.pattern, {
          in: searchScope,
          mode: args.mode ?? "literal",
          limit: args.limit ?? 30,
          context: ctxCount,
          budget_ms: args.budget_ms,
        });
        if (!res.ok && res.error) {
          return text(`grep error: ${res.error}`, true, {
            ...(res.meta ?? { complete: false }),
            tool: "ultrasearch_grep",
            error: res.error,
            regexWarning: res.meta?.warning,
          });
        }
        files = res.files ?? [];
        resultMeta = res.meta;
      }
      if (files.length === 0) {
        const hint = await diagnoseEmptyQuery(args.pattern, activeRoot, this.client);
        return text(`No occurrences of "${args.pattern}" found.\n💡 Hint: ${hint ?? "Strict exact zero-typo matching enforced."}`, false, {
          ...(resultMeta ?? { complete: false }),
          tool: "ultrasearch_grep",
          fileCount: 0,
        });
      }
      const formatted = formatGrepFiles(files, {
        worktreeRoot: activeRoot,
        compact: args.compact ?? true,
        maxTokens: args.max_tokens,
        prioritizeSymbols: args.mode === "symbol",
        showContext: ctxCount > 0,
        tagSymbols: args.tag_symbols ?? (args.mode === "symbol"),
      });
      const warningText = resultMeta?.warning ? `\n[regex warning: ${resultMeta.warning}]` : "";
      return text(`${formatted.text}${warningText}`, false, {
        ...(resultMeta ?? { complete: false }),
        tool: "ultrasearch_grep",
        fileCount: files.length,
        tokenCount: formatted.tokenCount,
        truncatedCount: Math.max(formatted.truncatedCount, resultMeta?.truncatedCount ?? 0),
      });
    }

    if (name === "ultrasearch_multi_grep") {
      if (!Array.isArray(args.patterns) || args.patterns.length === 0 || !args.patterns.every((p: unknown) => typeof p === "string")) {
        return text("Invalid params: 'patterns' must be an array of strings", true);
      }
      const searchScope = args.path_filter ? path.resolve(activeRoot, args.path_filter) : activeRoot;
      const res = await this.client.multiGrep(args.patterns, { in: searchScope, limit: args.limit ?? 30, budget_ms: args.budget_ms });
      const files = res.files ?? [];
      const meta = { ...(res.meta ?? { complete: false }), tool: "ultrasearch_multi_grep", fileCount: files.length };
      if (files.length === 0) {
        return text(`No occurrences of [${args.patterns.join(", ")}] found.\n💡 Hint: Exact zero-typo matching enforced across all patterns.`, false, meta);
      }
      const formatted = formatGrepFiles(files, { worktreeRoot: activeRoot, compact: args.compact ?? true, maxTokens: args.max_tokens });
      return text(formatted.text, false, {
        ...meta,
        tokenCount: formatted.tokenCount,
        truncatedCount: Math.max(formatted.truncatedCount, res.meta?.truncatedCount ?? 0),
      });
    }

    if (name === "ultrasearch_locate") {
      if (typeof args.filename !== "string" || args.filename.length === 0) {
        return text("Invalid params: 'filename' must be a non-empty string", true);
      }
      const searchScope = args.global ? undefined : activeRoot;
      const res = await this.client.search(`'${args.filename}`, { in: searchScope, limit: 10, auditTool: "ultrasearch_locate" });
      const hits = res.hits ?? [];
      if (hits.length === 0) {
        const hint = await diagnoseEmptyQuery(args.filename, activeRoot, this.client);
        return text(`File "${args.filename}" not found in current scope.\n💡 Hint: ${hint ?? "Use ultrasearch_query for glob search across subdirectories."}`);
      }
      return text(hits.map((h) => h.path).join("\n"), false, {
        ...(res.meta ?? { complete: false }),
        tool: "ultrasearch_locate",
        hitCount: hits.length,
      });
    }

    if (name === "ultrasearch_recent") {
      const res = await this.client.recent(activeRoot, args.limit ?? 15);
      const hits = res.hits ?? [];
      return text(
        hits.map((h) => `${h.path} (score: ${h.score})`).join("\n") || "No recent files recorded in scope.",
        false,
        { ...(res.meta ?? { complete: false }), tool: "ultrasearch_recent", hitCount: hits.length }
      );
    }

    if (name === "ultrasearch_metrics") {
      const view = args.view === "all" || args.view === "synthetic" || args.view === "real" ? args.view : "real";
      const summary = summarizeAudit(typeof args.limit === "number" ? args.limit : 1000, { view });
      return text(formatAuditSummary(summary), false, {
        tool: "ultrasearch_metrics",
        view: summary.view,
        originCounts: summary.originCounts,
        totalCalls: summary.totalCalls,
      });
    }

    return text(`Unknown tool: ${name}`, true);
  }
}
