import type { UltraSearchClient } from "./client.ts";
import { TOOL_SCHEMAS, type ToolParam, type UltraSearchToolSchema } from "./tool-schema.ts";

/**
 * Code Mode declarations and pipeline recipes (issue #29).
 *
 * `renderUltraSearchDeclarations()` is generated from `TOOL_SCHEMAS` — the same
 * registry the MCP surface is built from — so a hand-edited declaration is not
 * possible and a schema change cannot leave the sandbox autocomplete lying.
 * `test/interop-surface.test.ts` compares the generated text against the
 * committed golden and fails the build on drift.
 */

function tsType(param: ToolParam): string {
  if (param.enum && param.enum.length > 0) return param.enum.map((v) => `"${v}"`).join(" | ");
  if (param.type === "array") return param.items === "string" ? "string[]" : "unknown[]";
  return param.type;
}

/** The result shape a tool returns inside the sandbox, keyed by registry `returns`. */
export function returnTypeFor(kind: UltraSearchToolSchema["returns"]): string {
  switch (kind) {
    case "search":
      return `{
    matches: Array<{
      path: string;
      relPath: string;
      kind: "file" | "dir" | "link";
      score: number;
      git?: string;
    }>;
    took_us: number;
  }`;
    case "grep":
    case "multi_grep":
      return `{
    files: Array<{
      path: string;
      matches: Array<{ line: number; text: string }>;
    }>;
    took_us: number;
  }`;
    case "text":
      return `{ content: Array<{ type: "text"; text: string }> }`;
  }
}

function renderTool(tool: UltraSearchToolSchema): string {
  const props = Object.entries(tool.params)
    .map(([key, param]) => {
      const optional = tool.required.includes(key) ? "" : "?";
      return `    /** ${param.description} */\n    ${key}${optional}: ${tsType(param)};`;
    })
    .join("\n");
  const args = props ? `{\n${props}\n  }` : "Record<string, never> | undefined";
  return `  /**\n   * ${tool.description}\n   */\n  function ${tool.name}(args${tool.required.length ? "" : "?"}: ${args}): Promise<${returnTypeFor(tool.returns)}>;`;
}

/** Generate the full `declare namespace tools` block from the registry. */
export function generateDeclarations(tools: readonly UltraSearchToolSchema[] = TOOL_SCHEMAS): string {
  return `\ndeclare namespace tools {\n${tools.map(renderTool).join("\n\n")}\n}\n`;
}

/**
 * TypeScript declarations exported for QuickJS WASM Code Mode.
 * Enables zero-shot type checking and autocomplete in Pi Agent code execution.
 * Generated from the registry; see `generateDeclarations`.
 */
export function renderUltraSearchDeclarations(): string {
  return generateDeclarations();
}

/**
 * Pipeline recipes shipped with the extension (issue #29). Each recipe is a
 * single sandbox turn that chains tools: `search -> grep -> read`.
 */
export const CODEMODE_RECIPES: ReadonlyArray<{ name: string; description: string; code: string }> = [
  {
    name: "search-grep-read",
    description: "Resolve a symbol to a file, confirm the exact lines, then read the surrounding code — one sandbox turn.",
    code: `const found = await tools.ultrasearch_query({ query: symbol, limit: 5 });
const file = found.matches.find((m) => m.kind === "file");
if (!file) return { error: \`no file matched \${symbol}\` };
const hits = await tools.ultrasearch_grep({ pattern: symbol, path_filter: file.path, limit: 5, context: 2 });
return { file: file.path, hits: hits.files };`,
  },
  {
    name: "search-symbol-then-context",
    description: "Locate a definition by symbol mode, then pull tagged matches with AST definition labels.",
    code: `const hits = await tools.ultrasearch_grep({ pattern: symbol, mode: "symbol", tag_symbols: true, limit: 10 });
return hits.files.map((f) => ({ file: f.path, first: f.matches[0] }));`,
  },
];

/** Render the recipes as Markdown for docs and tests. */
export function renderRecipeDocs(): string {
  return CODEMODE_RECIPES.map((r) => `### ${r.name}\n\n${r.description}\n\n\`\`\`js\n${r.code}\n\`\`\``).join("\n\n");
}

export interface CodemodeSearchHit {
  path: string;
  relPath?: string;
  kind: "file" | "dir" | "link";
  score?: number;
  git?: string;
}
export interface CodemodeGrepFile {
  path: string;
  matches: Array<{ line: number; text: string }>;
}
export interface CodemodeSearchResult {
  matches: CodemodeSearchHit[];
  took_us?: number;
}
export interface CodemodeGrepResult {
  files: CodemodeGrepFile[];
  took_us?: number;
}

/**
 * The callable tool names a recipe may use. Matches the keys of
 * `getUltraSearchCodemodeTools`, so a recipe runs unchanged in a test and in
 * the sandbox.
 */
export interface CodemodeSandboxTools {
  ultrasearch_query(args: { query: string; limit?: number }): Promise<CodemodeSearchResult>;
  ultrasearch_grep(args: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number }): Promise<CodemodeGrepResult>;
  ultrasearch_multi_grep?(args: { patterns: string[]; path_filter?: string; limit?: number }): Promise<CodemodeGrepResult>;
}

export interface SearchGrepReadOptions {
  /** Query for step 1 (symbol, glob or text). */
  query: string;
  /** Pattern for step 2; defaults to the query. */
  pattern?: string;
  /** Read the file's text. Injected so the recipe works with any sandbox fs. */
  readFile: (path: string) => string | Promise<string>;
  /** Lines of context around the first grep hit in the read result (default 3). */
  contextLines?: number;
}

export interface SearchGrepReadResult {
  /** The pipeline order actually executed, e.g. ["query", "grep", "read"]. */
  steps: string[];
  query: string;
  pattern: string;
  file?: string;
  files: string[];
  /** Snippet of the file around the first matching line. */
  read?: { path: string; startLine: number; endLine: number; text: string };
  error?: string;
}

/**
 * Execute the `search -> grep -> read` recipe end to end. `steps` is the audit
 * trail the drift test asserts, so deleting a stage fails the test rather than
 * silently weakening the recipe.
 */
export async function runSearchGrepReadRecipe(
  tools: CodemodeSandboxTools,
  options: SearchGrepReadOptions
): Promise<SearchGrepReadResult> {
  const steps: string[] = [];
  const pattern = options.pattern ?? options.query;

  steps.push("query");
  const found = await tools.ultrasearch_query({ query: options.query, limit: 5 });
  const file = (found.matches ?? []).find((m) => m.kind === "file");
  if (!file) {
    return { steps, query: options.query, pattern, files: [], error: `no file matched ${options.query}` };
  }

  steps.push("grep");
  const hits = await tools.ultrasearch_grep({ pattern, path_filter: file.path, limit: 5 });

  steps.push("read");
  const text = await options.readFile(file.path);
  const lines = text.split("\n");
  const matchLine = hits.files?.flatMap((f) => f.matches)[0]?.line ?? 1;
  const context = options.contextLines ?? 3;
  const start = Math.max(1, matchLine - context);
  const end = Math.min(lines.length, matchLine + context);
  return {
    steps,
    query: options.query,
    pattern,
    file: file.path,
    files: (hits.files ?? []).map((f) => f.path),
    read: { path: file.path, startLine: start, endLine: end, text: lines.slice(start - 1, end).join("\n") },
  };
}

/**
 * Sandbox helper returning callable JavaScript function wrappers around UltraSearchClient
 * for execution inside a QuickJS WASM runtime.
 */
export function getUltraSearchCodemodeTools(client: UltraSearchClient) {
  return {
    ultrasearch_query: async (args: { query: string; limit?: number; global?: boolean; near?: string }) => {
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
    ultrasearch_grep: async (args: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol"; limit?: number }) => {
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
    ultrasearch_multi_grep: async (args: { patterns: string[]; path_filter?: string; limit?: number }) => {
      return await client.multiGrep(args.patterns, {
        in: args.path_filter ?? process.cwd(),
        limit: args.limit ?? 30,
      });
    },
    ultrasearch_locate: async (args: { filename: string }) => {
      return await client.search(`'${args.filename}`, { in: process.cwd(), limit: 10 });
    },
    ultrasearch_recent: async (args?: { limit?: number }) => {
      return await client.recent(process.cwd(), args?.limit ?? 15);
    },
  };
}
