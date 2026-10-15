/**
 * Single source of truth for the UltraSearch tool surface (issues #29, #30).
 *
 * Everything that describes a tool — the MCP `tools/list` schema, the Code Mode
 * TypeScript declarations, and the drift guard against the Pi extension's
 * registered tools — is derived from `TOOL_SCHEMAS` here. Nothing downstream
 * hand-maintains a second copy: a parameter added in one place and forgotten
 * in another is exactly the drift this module exists to make impossible.
 *
 * Names are canonical and carry the single `ultrasearch_` prefix. Alias
 * surfaces (issue #30) are generated at runtime from these names; they are not
 * written down here, so no alias can ever become the source of truth.
 */

/** JSON-schema-ish parameter shapes the surface currently needs. */
export type ToolParamType = "string" | "number" | "boolean" | "array";

export interface ToolParam {
  type: ToolParamType;
  /** Element type when `type: "array"`. */
  items?: "string";
  /** Closed value set, when the parameter is an enum. */
  enum?: readonly string[];
  description: string;
}

/** How the tool's result is shaped in Code Mode declarations. */
export type ToolReturnKind = "search" | "grep" | "multi_grep" | "text";

export interface UltraSearchToolSchema {
  name: string;
  description: string;
  params: Record<string, ToolParam>;
  required: readonly string[];
  returns: ToolReturnKind;
}

const QUERY: UltraSearchToolSchema = {
  name: "ultrasearch_query",
  description:
    "Instant indexed whole-disk or workspace file search (<0.1ms). Strict deterministic matching (zero typo tolerance) for exact symbol, glob, and path resolution. Supports globs (src/**/*.{ts,tsx}), extension filters (*.rs), git status filters (git:modified, git:staged, git:untracked), and proximity re-ranking (near: <path>). Scoped strictly to the active worktree root.",
  params: {
    query: { type: "string", description: "Search query, glob, or filter (e.g. 'Omnibox *.swift', 'git:modified')" },
    limit: { type: "number", description: "Max results (default: 30)" },
    global: { type: "boolean", description: "Search whole disk instead of workspace" },
    near: { type: "string", description: "Optional file path to re-rank results by folder proximity" },
    budget_ms: { type: "number", description: "Optional server-side deadline (ms); partial results carry complete:false" },
  },
  required: ["query"],
  returns: "search",
};

const GREP: UltraSearchToolSchema = {
  name: "ultrasearch_grep",
  description: "Indexed trigram text search inside files (<1ms). Clean compact output with enterprise DLP credential masking.",
  params: {
    pattern: { type: "string", description: "Literal or identifier to search" },
    path_filter: { type: "string", description: "Subdirectory or file filter" },
    global: { type: "boolean", description: "Search whole disk instead of restricting to the current scope" },
    mode: { type: "string", enum: ["literal", "regex", "symbol", "semantic"], description: "Search mode (semantic = intent keyword expansion)" },
    limit: { type: "number", description: "Max files to return" },
    compact: { type: "boolean", description: "Compact one-line format (default: true)" },
    max_tokens: { type: "number", description: "Optional token budget ceiling" },
    context: { type: "number", description: "Lines of surrounding code context (0-5, default: 0)" },
    tag_symbols: { type: "boolean", description: "Tag matches with AST definition types like [def:fn], [def:class]" },
    budget_ms: { type: "number", description: "Optional server-side deadline (ms); partial results carry complete:false" },
  },
  required: ["pattern"],
  returns: "grep",
};

const MULTI_GREP: UltraSearchToolSchema = {
  name: "ultrasearch_multi_grep",
  description: "Simultaneous multi-pattern OR content retrieval across trigram index in one call.",
  params: {
    patterns: { type: "array", items: "string", description: "Array of search patterns" },
    path_filter: { type: "string", description: "Subdirectory filter" },
    limit: { type: "number", description: "Max files to return" },
    compact: { type: "boolean", description: "Compact one-line format (default: true)" },
    max_tokens: { type: "number", description: "Optional token budget ceiling" },
    budget_ms: { type: "number", description: "Optional server-side deadline (ms); partial results carry complete:false" },
  },
  required: ["patterns"],
  returns: "multi_grep",
};

const LOCATE: UltraSearchToolSchema = {
  name: "ultrasearch_locate",
  description: "Instant O(1) filename lookup (e.g. 'package.json', 'Cargo.toml') within current workspace.",
  params: {
    filename: { type: "string", description: "Exact filename to locate" },
    global: { type: "boolean", description: "Search entire disk" },
  },
  required: ["filename"],
  returns: "text",
};

const RECENT: UltraSearchToolSchema = {
  name: "ultrasearch_recent",
  description: "Recently worked or edited files in current workspace (frecency ranked).",
  params: {
    limit: { type: "number", description: "Max recent files (default: 15)" },
  },
  required: [],
  returns: "text",
};

const METRICS: UltraSearchToolSchema = {
  name: "ultrasearch_metrics",
  description:
    "Toolchain latency metrics (p50/p90/p95), error rates, zero-hit queries, and recursive self-learning advice. Defaults to organic (non-gate) rows.",
  params: {
    view: { type: "string", enum: ["real", "synthetic", "all"], description: "Audit provenance view (default: real = organic sessions only)" },
    limit: { type: "number", description: "Number of audit rows to analyze (default 1000)" },
  },
  required: [],
  returns: "text",
};

/** The default MCP surface: exactly six canonical `ultrasearch_*` tools. */
export const TOOL_SCHEMAS: readonly UltraSearchToolSchema[] = [QUERY, GREP, MULTI_GREP, LOCATE, RECENT, METRICS];

/** Canonical names in registration order. */
export function canonicalToolNames(): string[] {
  return TOOL_SCHEMAS.map((t) => t.name);
}

export function toolByName(name: string): UltraSearchToolSchema | undefined {
  return TOOL_SCHEMAS.find((t) => t.name === name);
}

/** The MCP `inputSchema` for one tool, derived from its registry entry. */
export function toolJsonSchema(tool: UltraSearchToolSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(tool.params)) {
    properties[key] = {
      type: param.type,
      ...(param.items ? { items: { type: param.items } } : {}),
      ...(param.enum ? { enum: [...param.enum] } : {}),
      description: param.description,
    };
  }
  return { type: "object", properties, ...(tool.required.length ? { required: [...tool.required] } : {}), additionalProperties: false };
}
