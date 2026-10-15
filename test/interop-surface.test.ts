process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCP_CLIENT_PROFILES,
  MCP_TOOLS,
  UltraSearchMcpServer,
  buildToolSurface,
  canonicalNameForName,
  resolveMcpSurfaceConfig,
} from "../src/mcp.ts";
import { TOOL_SCHEMAS, canonicalToolNames, toolJsonSchema } from "../src/tool-schema.ts";
import { generateDeclarations, getUltraSearchCodemodeTools, runSearchGrepReadRecipe, CODEMODE_RECIPES, renderRecipeDocs } from "../src/codemode.ts";
import type { UltraSearchClient } from "../src/client.ts";
import { MockDaemon } from "./helpers/mock-daemon.ts";
import { loadPiHarness } from "./helpers/pi-harness.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-surface-"));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

/** Hermetic client double: no daemon, no socket, deterministic rows. */
function mockClient(overrides: Record<string, unknown> = {}): UltraSearchClient {
  return {
    search: async (_q: string, opts: any = {}) => ({
      ok: true,
      took_us: 42,
      source: "index",
      hits: [{ kind: "file", mtime: 0, path: path.join(opts.in ?? "/tmp", "match.ts"), score: 1, size: 10 }],
    }),
    grep: async (p: string, opts: any = {}) => ({
      ok: true,
      took_us: 42,
      source: "index",
      files: [{ path: path.join(opts.in ?? "/tmp", "match.ts"), matches: [{ line: 2, text: `${p} here` }] }],
    }),
    multiGrep: async (_ps: string[], opts: any = {}) => ({
      ok: true,
      took_us: 42,
      source: "index",
      files: [{ path: path.join(opts.in ?? "/tmp", "match.ts"), matches: [{ line: 1, text: "here" }] }],
    }),
    recent: async () => ({ ok: true, took_us: 10, source: "index", hits: [] }),
    close: () => {},
    ...overrides,
  } as unknown as UltraSearchClient;
}

async function initialized(server: UltraSearchMcpServer, protocolVersion = "2024-11-05"): Promise<void> {
  await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities: {} } });
  await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
}

// ---------------------------------------------------------------------------
// #29 declaration sync and drift
// ---------------------------------------------------------------------------

test("declarations: generated text matches the committed golden (drift fails the build)", () => {
  const goldenPath = path.join(repoRoot, "test", "fixtures", "codemode-declarations.txt");
  const golden = fs.readFileSync(goldenPath, "utf-8");
  const generated = generateDeclarations();
  assert.equal(
    generated,
    golden,
    "codemode declarations drifted from src/tool-schema.ts — run `npm run codemode:declarations`"
  );
});

test("declarations: every registry tool appears exactly once, with no hand-written extra", () => {
  const generated = generateDeclarations();
  for (const tool of TOOL_SCHEMAS) {
    const occurrences = generated.split(`function ${tool.name}(`).length - 1;
    assert.equal(occurrences, 1, `${tool.name} must be declared exactly once`);
    for (const param of Object.keys(tool.params)) {
      assert.ok(generated.includes(param), `${tool.name} declaration is missing parameter ${param}`);
    }
  }
  const declaredNames = [...generated.matchAll(/function (ultrasearch_[a-z_]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(declaredNames, canonicalToolNames(), "declarations must equal the registry, in order");
});

test("mcp: MCP_TOOLS is generated from the registry, not hand-maintained", () => {
  assert.deepEqual(
    MCP_TOOLS.map((t) => t.name),
    canonicalToolNames()
  );
  for (const tool of MCP_TOOLS) {
    const schema = TOOL_SCHEMAS.find((s) => s.name === tool.name)!;
    assert.deepEqual(tool.inputSchema, toolJsonSchema(schema), `${tool.name} inputSchema drifted from the registry`);
    assert.equal(tool.description, schema.description);
  }
});

test("mcp: the Pi tool parameters match the registry parameter sets (surface drift guard)", async () => {
  const daemon = new MockDaemon({ reply: () => ({ ok: true }) });
  await daemon.listen();
  const harness = await loadPiHarness({ socketPath: daemon.socketPath });
  try {
    assert.ok(harness.tools.size >= TOOL_SCHEMAS.length, "Pi must register every registry tool");
    for (const schema of TOOL_SCHEMAS) {
      const registered = harness.tools.get(schema.name);
      assert.ok(registered, `Pi does not register ${schema.name}`);
      const registeredKeys = Object.keys(registered.parameters ?? {}).sort();
      const registryKeys = Object.keys(schema.params).sort();
      assert.deepEqual(
        registeredKeys,
        registryKeys,
        `${schema.name}: a parameter exists on one surface only (Pi: ${registeredKeys}; registry: ${registryKeys})`
      );
    }
  } finally {
    await daemon.close();
  }
});

// ---------------------------------------------------------------------------
// #29 recipes run end to end
// ---------------------------------------------------------------------------

test("recipes: search -> grep -> read executes end to end in the sandbox shim", async () => {
  const file = path.join(tmp, "recipe-target.ts");
  fs.writeFileSync(file, ["// header", "export function recipeSymbol() {", "  return 1;", "}", "// footer"].join("\n"));
  const client = mockClient({
    search: async () => ({
      ok: true,
      took_us: 10,
      hits: [{ kind: "file", mtime: 0, path: file, score: 5, size: 1 }],
    }),
    grep: async () => ({
      ok: true,
      took_us: 10,
      files: [{ path: file, matches: [{ line: 2, text: "export function recipeSymbol() {" }] }],
    }),
  });
  const tools = getUltraSearchCodemodeTools(client);
  const result = await runSearchGrepReadRecipe(tools, {
    query: "recipeSymbol",
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    contextLines: 1,
  });
  assert.deepEqual(result.steps, ["query", "grep", "read"], "all three pipeline stages must run, in order");
  assert.equal(result.file, file);
  assert.ok(result.read?.text.includes("export function recipeSymbol()"), "the read stage must return the matched code");
  assert.equal(result.read?.startLine, 1);
  assert.equal(result.read?.endLine, 3);
});

test("recipes: a query with no matching file stops before grep/read and says why", async () => {
  const tools = getUltraSearchCodemodeTools(mockClient({ search: async () => ({ ok: true, hits: [] }) }));
  const result = await runSearchGrepReadRecipe(tools, { query: "nothing", readFile: () => "" });
  assert.deepEqual(result.steps, ["query"]);
  assert.match(result.error ?? "", /no file matched/);
});

test("recipes: the shipped recipe list and docs are non-empty and free of retired naming", () => {
  assert.ok(CODEMODE_RECIPES.length >= 1);
  assert.ok(CODEMODE_RECIPES.every((r) => r.code.includes("tools.ultrasearch_")));
  const docs = renderRecipeDocs();
  assert.ok(docs.includes("search-grep-read"));
  assert.equal(/fsearch/i.test(docs), false);
});

// ---------------------------------------------------------------------------
// #30 alias surface and per-client parity
// ---------------------------------------------------------------------------

test("surface: the default is exactly one prefix and six tools", () => {
  const names = buildToolSurface().map((t) => t.name);
  assert.equal(names.length, 6);
  assert.deepEqual(names, canonicalToolNames());
  assert.equal(names.every((n) => n.startsWith("ultrasearch_")), true);
});

test("surface: an alias prefix adds copies without touching the canonical six", () => {
  const names = buildToolSurface({ aliases: ["ultra"] }).map((t) => t.name);
  assert.equal(names.length, 12);
  assert.deepEqual(names.slice(0, 6), canonicalToolNames(), "canonical tools stay first and unchanged");
  assert.ok(names.includes("ultra_query"));
  assert.ok(names.includes("ultra_metrics"));
  assert.equal(canonicalNameForName("ultra_grep", { aliases: ["ultra"] }), "ultrasearch_grep");
  assert.equal(canonicalNameForName("ultra_grep"), "ultra_grep", "an alias that was not configured is not remapped");
});

test("surface: resolveMcpSurfaceConfig reads the environment", () => {
  assert.deepEqual(resolveMcpSurfaceConfig({} as NodeJS.ProcessEnv), {});
  assert.deepEqual(resolveMcpSurfaceConfig({ ULTRASEARCH_MCP_PREFIX: "us" } as NodeJS.ProcessEnv), { prefix: "us" });
  assert.deepEqual(resolveMcpSurfaceConfig({ ULTRASEARCH_MCP_ALIASES: "a, b" } as NodeJS.ProcessEnv), { aliases: ["a", "b"] });
});

test("surface: a configured alias is listable and callable through tools/call", async () => {
  const calls: string[] = [];
  const client = mockClient({
    grep: async (p: string) => {
      calls.push(p);
      return { ok: true, files: [{ path: "/tmp/a.ts", matches: [{ line: 1, text: p }] }] };
    },
  });
  const server = new UltraSearchMcpServer(client, "/tmp", { aliases: ["ultra"] });
  await initialized(server);
  const list = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools.length, 12);
  assert.ok(list.result.tools.some((t: any) => t.name === "ultra_grep"));
  const call = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ultra_grep", arguments: { pattern: "needle" } } });
  assert.notEqual(call.result?.isError, true, JSON.stringify(call));
  assert.deepEqual(calls, ["needle"], "the alias must dispatch to the canonical tool implementation");
});

test("surface: an unconfigured alias prefix is unknown, not silently accepted", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  await initialized(server);
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ultra_query", arguments: { query: "x" } } });
  assert.equal(res.error.code, -32602);
});

test("surface: every registered client profile lists six tools and can call its representative tool", async () => {
  for (const profile of MCP_CLIENT_PROFILES) {
    const server = new UltraSearchMcpServer(mockClient(), "/tmp", { aliases: [...profile.aliases] });
    await initialized(server, profile.protocolVersion);
    const list = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(list.result.tools.length, 6, `${profile.client} must see the six-tool default`);
    assert.deepEqual(list.result.tools.map((t: any) => t.name), canonicalToolNames());
    const args = profile.representativeTool === "ultrasearch_grep" ? { pattern: "x" } : profile.representativeTool === "ultrasearch_multi_grep" ? { patterns: ["x"] } : profile.representativeTool === "ultrasearch_metrics" ? {} : { query: "x" };
    const call = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: profile.representativeTool, arguments: args } });
    assert.notEqual(call.result?.isError, true, `${profile.client}: ${profile.representativeTool} failed: ${JSON.stringify(call)}`);
  }
});

test("surface: bin/mcp-server.ts exposes a configured alias prefix over real stdio", async () => {
  const child = spawn(process.execPath, [path.join(repoRoot, "bin", "mcp-server.ts"), "--alias", "ultra"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_ULTRASEARCH_TEST: "1" },
  });
  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const started = Date.now();
    while (!stdout.includes('"id":2') && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
    const list = lines.find((l) => l.id === 2).result.tools.map((t: any) => t.name);
    assert.equal(list.length, 12);
    assert.ok(list.includes("ultra_locate"));
    assert.deepEqual(list.slice(0, 6), canonicalToolNames());
  } finally {
    child.kill("SIGKILL");
  }
});
