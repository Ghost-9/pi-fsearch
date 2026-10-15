/**
 * The CLI surface, declared against the tool registry (issue #50).
 *
 * `src/tool-schema.ts` is the single source for the MCP, Code Mode and Pi
 * surfaces; the CLI is the fourth surface and the one a non-MCP harness uses.
 * This table is what the conformance test compares against the registry, so a
 * tool added to the registry but reachable on no CLI command fails the build.
 */

/** Canonical tool name -> the CLI commands that invoke it. */
export const CLI_TOOL_SURFACE: Readonly<Record<string, readonly string[]>> = {
  ultrasearch_query: ["query", "search"],
  ultrasearch_grep: ["grep"],
  ultrasearch_multi_grep: ["multi-grep"],
  ultrasearch_locate: ["locate"],
  ultrasearch_recent: ["recent"],
  ultrasearch_metrics: ["metrics"],
};

/**
 * CLI commands that are lifecycle/admin rather than tool calls. Kept explicit
 * so a new `case` in `bin/cli.ts` has to be classified here deliberately.
 */
export const CLI_NON_TOOL_COMMANDS: readonly string[] = [
  "policy",
  "watch",
  "history",
  "compact",
  "learning",
  "tui",
  "install",
  "daemon",
  "authorize",
  "permissions",
  "help",
];

/** Every CLI command the conformance test expects to find a `case` for. */
export function cliCommands(): string[] {
  const mapped = Object.values(CLI_TOOL_SURFACE).flat();
  return [...new Set([...mapped, ...CLI_NON_TOOL_COMMANDS])];
}
