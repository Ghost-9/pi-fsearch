#!/usr/bin/env node
import { UltraSearchMcpServer, resolveMcpSurfaceConfig, type McpSurfaceConfig } from "../src/mcp.ts";
import { loadRootConfig } from "../src/roots.ts";

/**
 * stdio MCP entrypoint. Stdout is the protocol channel: this file must never
 * print anything that is not a JSON-RPC frame. Surface configuration comes
 * from CLI flags first, then the environment:
 *
 *   --prefix <name>        canonical name prefix (default `ultrasearch`)
 *   --alias <name>         expose the six tools under an extra prefix (repeatable)
 *   --aliases <a,b>        comma-separated alias prefixes
 *   ULTRASEARCH_MCP_PREFIX, ULTRASEARCH_MCP_ALIASES
 */
function parseSurfaceArgs(argv: string[], env: NodeJS.ProcessEnv): McpSurfaceConfig {
  const base = resolveMcpSurfaceConfig(env);
  const aliases = new Set<string>(base.aliases ?? []);
  let prefix = base.prefix;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = argv[i + 1];
    if (arg === "--prefix" && value) {
      prefix = value;
      i++;
    } else if (arg === "--alias" && value) {
      aliases.add(value);
      i++;
    } else if (arg === "--aliases" && value) {
      for (const a of value.split(",")) aliases.add(a);
      i++;
    } else if (arg.startsWith("--prefix=")) {
      prefix = arg.slice("--prefix=".length);
    } else if (arg.startsWith("--alias=")) {
      aliases.add(arg.slice("--alias=".length));
    } else if (arg.startsWith("--aliases=")) {
      for (const a of arg.slice("--aliases=".length).split(",")) aliases.add(a);
    }
  }
  const cleaned = [...aliases].map((a) => a.trim()).filter(Boolean);
  return {
    ...(prefix ? { prefix } : {}),
    ...(cleaned.length ? { aliases: cleaned } : {}),
  };
}

const server = new UltraSearchMcpServer(undefined, process.cwd(), {
  ...parseSurfaceArgs(process.argv.slice(2), process.env),
  roots: loadRootConfig().roots,
});
server.start();
