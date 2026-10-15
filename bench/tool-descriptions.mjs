#!/usr/bin/env node
/**
 * Tool-description prompt tax (issue #38).
 *
 * Measures what the model is charged for the UltraSearch tool surface on both
 * surfaces, from the single source of truth:
 *
 *   - MCP: the `tools/list` entries the stdio server emits (name, description,
 *     inputSchema) — built with the same `toolJsonSchema` the server uses.
 *   - Pi: the tool descriptors `index.ts` registers (name, description,
 *     parameters as TypeBox JSON).
 *
 * Token counts are ESTIMATES from the documented estimator `ceil(chars / 4)`
 * (the same one bench/tokens.mjs and src/formatter.ts use), reported next to a
 * whitespace-sensitive `ceil(chars / 3.5)` sensitivity bound. They are not a
 * specific model tokenizer's count; the before/after comparison is exact
 * because it is the same estimator over the same surfaces.
 *
 * Usage: node bench/tool-descriptions.mjs [--json]
 */
process.env.PI_ULTRASEARCH_TEST = "1";

import { TOOL_SCHEMAS, toolJsonSchema } from "../src/tool-schema.ts";
import { loadPiTools } from "./lib/pi-tools.mjs";

/** Documented estimator, identical to bench/tokens.mjs and src/formatter.ts. */
export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

/** Whitespace/punctuation-sensitive alternative bound. */
export function estimateTokensAlt(chars) {
  return Math.ceil(chars / 3.5);
}

function mcpEntries() {
  return TOOL_SCHEMAS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolJsonSchema(tool),
  }));
}

async function piEntries() {
  const harness = await loadPiTools();
  return [...harness.tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? {},
  }));
}

function measure(label, entries) {
  const rows = entries.map((entry) => {
    const chars = JSON.stringify(entry).length;
    return { name: entry.name, chars, tokens: estimateTokens(chars), tokensAlt: estimateTokensAlt(chars) };
  });
  const chars = rows.reduce((n, r) => n + r.chars, 0);
  return {
    surface: label,
    tools: rows,
    chars,
    tokens: estimateTokens(chars),
    tokensAlt: estimateTokensAlt(chars),
  };
}

async function main() {
  const asJson = process.argv.includes("--json");
  const mcp = measure("mcp", mcpEntries());
  const pi = measure("pi", await piEntries());
  const report = {
    estimator: "ceil(chars/4); sensitivity ceil(chars/3.5)",
    surfaces: [mcp, pi],
    combined: {
      chars: mcp.chars + pi.chars,
      tokens: mcp.tokens + pi.tokens,
      tokensAlt: mcp.tokensAlt + pi.tokensAlt,
    },
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const surface of report.surfaces) {
    console.log(`--- ${surface.surface} surface: ${surface.chars} chars ~ ${surface.tokens} tok (alt ${surface.tokensAlt}) ---`);
    for (const row of surface.tools) console.log(`  ${row.name.padEnd(22)} ${String(row.chars).padStart(5)} chars ~ ${String(row.tokens).padStart(4)} tok`);
  }
  console.log(`combined: ${report.combined.chars} chars ~ ${report.combined.tokens} tok (alt ${report.combined.tokensAlt})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
