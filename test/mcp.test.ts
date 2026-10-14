process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UltraSearchMcpServer,
  MCP_TOOLS,
  SERVER_VERSION,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSON_RPC_ERRORS,
} from "../src/mcp.ts";
import type { UltraSearchClient } from "../src/client.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
      files: [{ path: path.join(opts.in ?? "/tmp", "match.ts"), matches: [{ line: 1, text: `${p} here` }] }],
    }),
    multiGrep: async (_ps: string[], opts: any = {}) => ({
      ok: true,
      took_us: 42,
      source: "index",
      files: [{ path: path.join(opts.in ?? "/tmp", "match.ts"), matches: [{ line: 1, text: "here" }] }],
    }),
    recent: async () => ({
      ok: true,
      took_us: 10,
      source: "index",
      hits: [{ kind: "file", mtime: 0, path: "/tmp/recent.ts", score: 5, size: 1 }],
    }),
    close: () => {},
    ...overrides,
  } as unknown as UltraSearchClient;
}

/** Server whose stdio output is captured instead of written to process.stdout. */
class CapturingServer extends UltraSearchMcpServer {
  public lines: string[] = [];
  protected write(response: unknown): void {
    this.lines.push(JSON.stringify(response));
  }
  public response(index = 0): any {
    return JSON.parse(this.lines[index]);
  }
}

async function initialized(server: UltraSearchMcpServer): Promise<void> {
  await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("mcp: initialize negotiates the requested protocol version and reports serverInfo", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.equal(res.result.serverInfo.name, "pi-ultrasearch");
  assert.equal(res.result.serverInfo.version, SERVER_VERSION);
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(server.isInitialized, true);
});

test("mcp: initialize falls back to the newest supported protocol version", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(res.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(res.result.protocolVersion));
});

test("mcp: notifications/initialized produces no response", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  const res = await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res, null);
});

test("mcp: notifications are never answered, even when the method is unknown", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  assert.equal(await server.handleMessage({ jsonrpc: "2.0", method: "notifications/whatever" }), null);
  assert.equal(await server.handleMessage({ jsonrpc: "2.0", method: "nope" }), null);
  assert.equal(await server.handleMessage({ jsonrpc: "2.0" }), null);
});

test("mcp: a non-object frame is an invalid request answered with a null id", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  const scalar = await server.handleMessage(42);
  assert.equal(scalar.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);
  assert.equal(scalar.id, null);
  const array = await server.handleMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.equal(array.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);
  assert.equal(array.id, null);
});

test("mcp: requests before initialize are rejected with -32002 and ping still works", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  const before = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(before.error.code, JSON_RPC_ERRORS.NOT_INITIALIZED);
  assert.equal(before.id, 1);

  const ping = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(ping.result, {});
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test("mcp: tools/list returns the single ultrasearch_* surface with valid schemas", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  await initialized(server);

  const res = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const tools = res.result.tools;
  assert.equal(tools.length, 6);
  assert.equal(tools.length, MCP_TOOLS.length);

  const names = tools.map((t: any) => t.name);
  for (const expected of [
    "ultrasearch_query",
    "ultrasearch_grep",
    "ultrasearch_multi_grep",
    "ultrasearch_locate",
    "ultrasearch_recent",
    "ultrasearch_metrics",
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.equal(names.filter((n: string) => !n.startsWith("ultrasearch_")).length, 0, "every tool must be ultrasearch_*");
  assert.equal(names.filter((n: string) => n.startsWith("fsearch_")).length, 0, "fsearch aliases must be gone");
  assert.equal(new Set(names).size, names.length, "tool names must be unique");

  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.inputSchema.properties, "object");
  }
  const query = tools.find((t: any) => t.name === "ultrasearch_query");
  assert.deepEqual(query.inputSchema.required, ["query"]);
});

test("mcp: tools/list surface matches the Pi extension's registered tools (parity)", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  await initialized(server);
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });

  const indexSource = fs.readFileSync(path.join(repoRoot, "index.ts"), "utf-8");
  const registered = (indexSource.match(/name: "(ultrasearch_[a-z_]+)"/g) ?? []).map((m) => m.slice(7, -1));
  const expected = [
    "ultrasearch_query",
    "ultrasearch_grep",
    "ultrasearch_multi_grep",
    "ultrasearch_locate",
    "ultrasearch_recent",
    "ultrasearch_metrics",
  ];

  // The Pi extension's registered tool set is exactly these six names, in this order.
  assert.deepEqual(registered, expected, "Pi extension must register exactly the ultrasearch_* tool set");
  // And the MCP surface must be the same set - never a superset with aliases.
  assert.deepEqual(res.result.tools.map((t: any) => t.name), expected, "MCP tools/list must equal the Pi tool set");
});

test("mcp: no fsearch alias is registered on any surface (source-level guard)", async () => {
  // Guard against reintroducing aliases: the shipped sources must not contain a
  // registered fsearch_* tool name or a /fsearch slash command.
  for (const rel of ["index.ts", "src/mcp.ts", "src/codemode.ts"]) {
    const source = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
    assert.equal(/name: *"fsearch_/.test(source), false, `${rel} registers an fsearch_* tool`);
    assert.equal(/registerCommand\("fsearch"/.test(source), false, `${rel} registers a /fsearch command`);
    assert.equal(/registerCommand\('fsearch'/.test(source), false, `${rel} registers a /fsearch command`);
  }
});

test("mcp: codemode declarations match the MCP tool names", async () => {
  const { renderUltraSearchDeclarations } = await import("../src/codemode.ts");
  const decls = renderUltraSearchDeclarations();
  for (const tool of MCP_TOOLS) {
    assert.ok(decls.includes(tool.name), `codemode declaration missing ${tool.name}`);
  }
  assert.ok(!decls.includes("fsearch_"));
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

test("mcp: tools/call runs each tool through the client and returns text content", async () => {
  const server = new UltraSearchMcpServer(mockClient(), "/tmp");
  await initialized(server);

  const cases: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "ultrasearch_query", arguments: { query: "package.json" } },
    { name: "ultrasearch_grep", arguments: { pattern: "UltraSearchMcpServer" } },
    { name: "ultrasearch_multi_grep", arguments: { patterns: ["a", "b"] } },
    { name: "ultrasearch_locate", arguments: { filename: "package.json" } },
    { name: "ultrasearch_recent", arguments: { limit: 3 } },
    { name: "ultrasearch_metrics", arguments: {} },
  ];

  for (const [i, c] of cases.entries()) {
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: c });
    assert.ok(res.result, `${c.name} should succeed`);
    assert.ok(Array.isArray(res.result.content), `${c.name} content must be an array`);
    assert.equal(res.result.content[0].type, "text");
    assert.equal(typeof res.result.content[0].text, "string");
    assert.notEqual(res.result.isError, true, `${c.name} reported isError`);
  }
});

test("mcp: unknown tools and malformed params use JSON-RPC error codes", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  await initialized(server);

  const unknownTool = await server.handleMessage({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "fsearch_query", arguments: { query: "x" } } });
  assert.equal(unknownTool.error.code, JSON_RPC_ERRORS.INVALID_PARAMS);

  const missingName = await server.handleMessage({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { arguments: {} } });
  assert.equal(missingName.error.code, JSON_RPC_ERRORS.INVALID_PARAMS);

  const badArgs = await server.handleMessage({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "ultrasearch_query", arguments: "not-an-object" } });
  assert.equal(badArgs.error.code, JSON_RPC_ERRORS.INVALID_PARAMS);
});

test("mcp: tool-level validation failures return isError results, not protocol errors", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  await initialized(server);
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "ultrasearch_query", arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes("Invalid params"));
});

test("mcp: a throwing client becomes an isError result, never a transport crash", async () => {
  const throwing = mockClient({
    search: async () => {
      throw new Error("daemon exploded");
    },
  });
  const server = new UltraSearchMcpServer(throwing);
  await initialized(server);
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "ultrasearch_query", arguments: { query: "x" } } });
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.includes("daemon exploded"));
});

// ---------------------------------------------------------------------------
// protocol errors
// ---------------------------------------------------------------------------

test("mcp: unknown method is -32601 and invalid request is -32600", async () => {
  const server = new UltraSearchMcpServer(mockClient());
  await initialized(server);

  const unknown = await server.handleMessage({ jsonrpc: "2.0", id: 30, method: "resources/list" });
  assert.equal(unknown.error.code, JSON_RPC_ERRORS.METHOD_NOT_FOUND);

  const noMethod = await server.handleMessage({ jsonrpc: "2.0", id: 31 });
  assert.equal(noMethod.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);

  const badShape = await server.handleMessage([{ jsonrpc: "2.0", id: 32, method: "ping" }]);
  assert.equal(badShape.error.code, JSON_RPC_ERRORS.INVALID_REQUEST);
});

test("mcp: dispatch answers malformed JSON with -32700 and stays alive", async () => {
  const server = new CapturingServer(mockClient());
  await server.dispatch("{not json");
  assert.equal(server.lines.length, 1);
  const parsed = server.response(0);
  assert.equal(parsed.error.code, JSON_RPC_ERRORS.PARSE);
  assert.equal(parsed.id, null);

  // A malformed line must not poison the following well-formed frames.
  await server.dispatch("");
  await server.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await server.dispatch(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(server.lines.length, 2, "notification must not be answered");
  assert.equal(server.response(1).result.serverInfo.name, "pi-ultrasearch");
});

// ---------------------------------------------------------------------------
// stdio framing (real process)
// ---------------------------------------------------------------------------

test("mcp: stdio framing survives split writes, batched messages, CRLF and blank lines", async () => {
  const child = spawn(process.execPath, [path.join(repoRoot, "bin", "mcp-server.ts")], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_ULTRASEARCH_TEST: "1" },
  });

  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const waitFor = async (predicate: () => boolean, ms = 5000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > ms) throw new Error(`timed out; stdout=${JSON.stringify(stdout)} stderr=${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  try {
    // 1. a single message delivered in two fragments must still parse
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    child.stdin.write(init.slice(0, 12));
    await new Promise((r) => setTimeout(r, 50));
    child.stdin.write(init.slice(12) + "\n");

    // 2. two messages batched into one write, one CRLF-terminated, blank lines between
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" });
    child.stdin.write("\n" + list + "\r\n" + ping + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write("not json at all\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "no/such/method" }) + "\n");

    await waitFor(() => stdout.trim().split("\n").length >= 5);

    const responses = stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(responses.length, 5, `expected 5 responses, got ${responses.length}: ${stdout}`);
    assert.deepEqual(
      responses.map((r) => r.id),
      [1, 2, 3, null, 4],
      "responses must leave in request order (parse error has a null id)",
    );
    assert.equal(responses[0].result.serverInfo.name, "pi-ultrasearch");
    assert.equal(responses[1].id, 2);
    assert.ok(responses[1].result.tools.every((t: any) => t.name.startsWith("ultrasearch_")));
    assert.equal(responses[2].id, 3);
    assert.deepEqual(responses[2].result, {});
    assert.equal(responses[3].error.code, JSON_RPC_ERRORS.PARSE);
    assert.equal(responses[4].id, 4);
    assert.equal(responses[4].error.code, JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  } finally {
    child.kill("SIGKILL");
  }
});
