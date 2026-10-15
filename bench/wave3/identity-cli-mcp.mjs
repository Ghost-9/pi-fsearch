#!/usr/bin/env node
// bench/wave3/identity-cli-mcp.mjs — the same query, the same set, through all
// three surfaces (client library, CLI, MCP server).
//
//   PI_ULTRASEARCH_TEST=1 PI_ULTRASEARCH_SOCKET=<sock> node bench/wave3/identity-cli-mcp.mjs \
//     [--corpus <dir>] [--query "src/**/*.ts"] [--limit 20] [--out <f>]
//
// Issue #47's acceptance asks for identical sets through client and MCP. All
// three surfaces build the same `UltraSearchClient` and send the same `op`, so
// this is a set comparison, not an argument: it runs each surface and diffs the
// three path sets.

process.env.PI_ULTRASEARCH_TEST = "1";

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const CORPUS = opt("corpus", [path.join(process.env.HOME, ".cache", "ultrasearch", "corpus", "wave2-8d1419d"), path.join(process.env.HOME, ".cache", "pi-ultrasearch-bench", "corpus-8d1419d-clean")].find((p) => fs.existsSync(p)));
const QUERY = opt("query", "src/**/*.ts");
const LIMIT = Number(opt("limit", 20));
const OUT = opt("out", path.join(REPO, "bench", "wave3", "results", "identity-cli-mcp.json"));
if (!fs.existsSync(CORPUS)) throw new Error(`corpus missing: ${CORPUS}`);

const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src", "client.ts")).href);
const { UltraSearchMcpServer } = await import(pathToFileURL(path.join(REPO, "src", "mcp.ts")).href);

const rel = (p) => path.relative(CORPUS, p).replace(/\\/g, "/");

// 1. client library ---------------------------------------------------------
const client = new UltraSearchClient({ timeoutMs: 20000 });
const libRes = await client.search(QUERY, { in: CORPUS, limit: LIMIT });
const lib = (libRes.hits ?? []).map((h) => rel(h.path));
client.close();

// 2. CLI --------------------------------------------------------------------
const cliOut = execFileSync("node", [path.join(REPO, "bin", "cli.ts"), "search", QUERY, "--in", CORPUS, "--limit", String(LIMIT)], {
  encoding: "utf8",
  timeout: 60000,
  env: { ...process.env, PI_ULTRASEARCH_TEST: "1" },
});
const cli = cliOut
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((l) => !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("💡"))
  .map((l) => rel(l.split(" [root:")[0]));

// 3. MCP server (in process, real JSON-RPC) ---------------------------------
const server = new UltraSearchMcpServer(new UltraSearchClient({ timeoutMs: 20000 }), CORPUS);
await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
const mcpRes = await server.handleMessage({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "ultrasearch_query", arguments: { query: QUERY, limit: LIMIT, in: CORPUS } },
});
const mcpText = mcpRes?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
const mcp = mcpText
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((l) => !l.startsWith("#") && !l.startsWith("💡") && !l.startsWith("No files matching"))
  .map((l) => rel(l.split(" (")[0].split(" [root:")[0]));

const set = (a) => [...new Set(a)].sort();
const [S, C, M] = [set(lib), set(cli), set(mcp)];
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const report = {
  meta: {
    suite: "wave3-identity-cli-mcp",
    generated_at: new Date().toISOString(),
    query: QUERY,
    limit: LIMIT,
    corpus: CORPUS,
    socket: process.env.PI_ULTRASEARCH_SOCKET ?? "(default)",
    engine: process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch"),
    note: "the CLI path is the `ultrasearch` bin over the same client; the MCP path is a real JSON-RPC tools/call in process",
  },
  counts: { library: S.length, cli: C.length, mcp: M.length },
  sets: { library: S, cli: C, mcp: M },
  identity: {
    library_equals_cli: same(S, C),
    library_equals_mcp: same(S, M),
    all_identical: same(S, C) && same(S, M),
  },
  diffs: { cli_only: C.filter((p) => !S.includes(p)), mcp_only: M.filter((p) => !S.includes(p)), library_only: S.filter((p) => !C.includes(p) || !M.includes(p)) },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ counts: report.counts, identity: report.identity, cli_only: report.diffs.cli_only, mcp_only: report.diffs.mcp_only, library_only: report.diffs.library_only }, null, 1));
console.log(`raw: ${OUT}`);
process.exit(report.identity.all_identical ? 0 : 1);
