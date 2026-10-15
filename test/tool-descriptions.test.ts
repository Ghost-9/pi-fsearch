process.env.PI_ULTRASEARCH_TEST = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_SCHEMAS, toolJsonSchema } from "../src/tool-schema.ts";

/**
 * Prompt-tax budget for the MCP tool surface (issue #38).
 *
 * The measured before/after is in `bench/results/tool-descriptions.md`:
 * 1056 -> 938 estimated tokens for the six `tools/list` entries (estimator
 * `ceil(chars/4)`, the same one bench/tokens.mjs uses). This test keeps a
 * regression from silently re-inflating the descriptions; it is a budget with
 * headroom, not a demand to shave every byte.
 */
const MCP_SURFACE_BUDGET_TOKENS = 1000;
const MAIN_DESCRIPTIONS_BUDGET_CHARS = 850;

test("tool descriptions: the MCP surface stays within the #38 prompt budget", () => {
  const entries = TOOL_SCHEMAS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toolJsonSchema(tool),
  }));
  const chars = entries.reduce((n, entry) => n + JSON.stringify(entry).length, 0);
  const tokens = Math.ceil(chars / 4);
  assert.ok(
    tokens <= MCP_SURFACE_BUDGET_TOKENS,
    `MCP tool surface is ${tokens} estimated tokens (${chars} chars) > ${MCP_SURFACE_BUDGET_TOKENS}; see bench/results/tool-descriptions.md before raising the budget`
  );

  const mainChars = TOOL_SCHEMAS.reduce((n, tool) => n + tool.name.length + tool.description.length, 0);
  assert.ok(
    mainChars <= MAIN_DESCRIPTIONS_BUDGET_CHARS,
    `main tool descriptions are ${mainChars} chars > ${MAIN_DESCRIPTIONS_BUDGET_CHARS}`
  );
});

test("tool descriptions: every parameter keeps a non-empty description", () => {
  for (const tool of TOOL_SCHEMAS) {
    assert.ok(tool.description.length > 0, `${tool.name} has no description`);
    for (const [key, param] of Object.entries(tool.params)) {
      assert.ok(param.description.trim().length > 0, `${tool.name}.${key} has no description`);
    }
  }
});
