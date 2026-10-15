#!/usr/bin/env node
// bench/wave4/probe-companions.mjs — measure the proposed v2 companion rows
// against an isolated daemon on the frozen wave-1 corpus, before they are
// written into the versioned judgment set.
//
//   PI_ULTRASEARCH_TEST=1 PI_ULTRASEARCH_SOCKET=<sock> \
//     node bench/wave4/probe-companions.mjs [--out f]
//
// Prints, for each proposed companion query, the files the engine returns and
// where each re-homed expectation lands. A companion row whose expectations are
// not all inside the top 10 is not added to v2: satisfiability is necessary but
// not sufficient — the gate also measures top-10 retrieval.
//
// A second pass reads the same queries with limit 50 so the artifact carries the
// full ordering: the rank evidence for every expectation that stays out of the
// top 10 in every lane (the `content-mention-not-top10` removal).
process.env.PI_ULTRASEARCH_TEST = "1";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = opt("out", path.join(HERE, "companion-probe.json"));

const CORPUS = opt(
  "corpus",
  [
    path.join(os.homedir(), ".cache", "ultrasearch", "corpus", "wave1-0a16e50"),
    path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", "corpus-0a16e50"),
  ].find((p) => fs.existsSync(p)),
);
if (!CORPUS) throw new Error("frozen wave-1 corpus not found; run: npm run bench:wave3:corpora");
const ROOT = path.resolve(CORPUS);
const norm = (p) => {
  const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p);
  const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? abs : rel;
};

// The amendment table: each entry is the source query (v1 row) whose
// expectations cannot be satisfied in its lane, and the companion row that
// re-scores the same intent in a lane that can satisfy every expectation.
// Rule: the companion carries the moved expectations plus the source query's
// expectations that are ALSO satisfiable in the companion's lane (so the row
// keeps the intent's grade-3 anchor when the lane can produce it).
const COMPANIONS = [
  { from: "P3", id: "P3c", lane: "grep-literal", query: "client.ts", mode: "literal",
    expected: [["test/client.test.ts", 2]] },
  { from: "P6", id: "P6c", lane: "grep-literal", query: "codemode", mode: "literal",
    expected: [["src/codemode.ts", 3], ["AUDIT-2026-10-14.md", 1]] },
  { from: "K2", id: "K2c", lane: "grep-literal", query: "sanitize", mode: "literal",
    expected: [["OPTIMIZATIONS.md", 1], ["AUDIT-2026-10-14.md", 1]] },
  { from: "K3", id: "K3c", lane: "grep-literal", query: "client", mode: "literal",
    expected: [["src/mcp.ts", 1]] },
  { from: "S1", id: "S1c", lane: "grep-literal", query: "FSearchClient", mode: "literal",
    expected: [["src/client.ts", 3], ["test/client.test.ts", 2], ["src/mcp.ts", 1], ["src/tui.ts", 1], ["index.ts", 1]] },
  { from: "S3", id: "S3c", lane: "grep-literal", query: "applyProximityRanking", mode: "literal",
    expected: [["src/client.ts", 3], ["AUDIT-2026-10-14.md", 1]] },
  { from: "S4", id: "S4c", lane: "grep-literal", query: "resolveWorktreeRoot", mode: "literal",
    expected: [["index.ts", 3], ["CHANGELOG.md", 1], ["AUDIT-2026-10-14.md", 1]] },
];

// Paths deliberately NOT carried into a companion, with the lane they stay in.
// Each is measured here so the artifact can state its status as data rather
// than as an assertion.
const EXCLUDED = [
  { id: "P3", path: "src/client.ts", query: "client.ts", lane: "path", why: "stays in the path lane; not a literal content match in the corpus" },
  { id: "K2", path: "src/sanitize.ts", query: "sanitize", lane: "path", why: "stays in the path lane; the corpus file does not contain the literal term" },
  { id: "K3", path: "src/client.ts", query: "client", lane: "path", why: "stays in the path lane; it is a smart-case content match too but ranks 19th of 23 there" },
  { id: "K3", path: "test/client.test.ts", query: "client", lane: "path", why: "stays in the path lane where it is retrieved; it is also a literal content match but ranks 11th there" },
  { id: "K3", path: "README.md", query: "client", lane: "grep-literal", why: "content-mention-not-top10: literal content match, rank outside the top 10" },
];

const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src", "client.ts")).href);
const client = new UltraSearchClient({ timeoutMs: 20000 });
const status = await client.status().catch(() => null);

const rows = [];
for (const c of COMPANIONS) {
  const res = await client.grep(c.query, { in: ROOT, limit: 10, mode: c.mode, budget_ms: 2500, context: 0, tag_symbols: false });
  const retrieved = (res.files ?? []).map((f) => norm(f.path));
  const positions = {};
  for (const [p] of c.expected) positions[p] = retrieved.indexOf(p) + 1 || null;
  // Full ordering (limit 50): where does each expectation sit when the page is
  // not truncated, and how many files match the term at all?
  const full = await client.grep(c.query, { in: ROOT, limit: 50, mode: c.mode, budget_ms: 2500, context: 0, tag_symbols: false });
  const fullOrder = (full.files ?? []).map((f) => norm(f.path));
  rows.push({
    id: c.id, from: c.from, lane: c.lane, query: c.query, mode: c.mode,
    source: res.source ?? null, ok: res.ok !== false,
    retrieved, positions,
    all_in_top10: c.expected.every(([p]) => retrieved.slice(0, 10).includes(p)),
    full_match_count: fullOrder.length,
    full_rank: Object.fromEntries(c.expected.map(([p]) => [p, fullOrder.indexOf(p) + 1 || null])),
    full_order: fullOrder,
    expected: c.expected.map(([p, grade]) => ({ path: p, grade })),
    matches: Object.fromEntries((res.files ?? []).map((f) => [norm(f.path), (f.matches ?? []).slice(0, 3).map((m) => (m.text ?? "").trim().slice(0, 100))])),
  });
  process.stderr.write(`[w4] ${c.id} ${c.lane} ${JSON.stringify(c.query)} n=${retrieved.length} all_top10=${rows.at(-1).all_in_top10}${JSON.stringify(positions)}\n`);
}

// Second pass: where does each excluded path sit in its own lane (full page)?
const excluded = [];
for (const x of EXCLUDED) {
  const res = await client.grep(x.query, { in: ROOT, limit: 50, mode: "literal", budget_ms: 2500, context: 0, tag_symbols: false });
  const order = (res.files ?? []).map((f) => norm(f.path));
  const raw = fs.readFileSync(path.join(ROOT, x.path), "utf8");
  const smartCase = (needle, text) => {
    const insensitive = !/[A-Z]/.test(needle);
    const hay = insensitive ? text.toLowerCase() : text;
    const n = insensitive ? needle.toLowerCase() : needle;
    return hay.split(n).length - 1;
  };
  excluded.push({
    ...x,
    literal_occurrences_smart_case: smartCase(x.query, raw),
    literal_occurrences_case_sensitive: raw.split(x.query).length - 1,
    match_count: order.length,
    rank: order.indexOf(x.path) + 1 || null,
    in_top10: order.slice(0, 10).includes(x.path),
    order,
  });
  process.stderr.write(`[w4] excluded ${x.id}/${x.path} rank=${excluded.at(-1).rank}/${order.length} occurrences=${excluded.at(-1).literal_occurrences_smart_case}(smart)\n`);
}
client.close();

const report = {
  meta: {
    suite: "wave4-companion-probe",
    generated_at: new Date().toISOString(),
    corpus: ROOT,
    socket: process.env.PI_ULTRASEARCH_SOCKET ?? null,
    engine: { entries: status?.entries ?? null, content_docs: status?.content_docs ?? null },
    purpose: "measure the proposed v2 companion rows before they are written into the judgment set",
  },
  all_pass: rows.every((r) => r.all_in_top10),
  rows,
  excluded,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, all_pass: report.all_pass, rows: rows.map((r) => ({ id: r.id, n: r.retrieved.length, all_top10: r.all_in_top10, positions: r.positions })) }, null, 2));
