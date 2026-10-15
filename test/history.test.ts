process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_HISTORY_MAX,
  HISTORY_ENV,
  HISTORY_FILE_ENV,
  HISTORY_MAX_ENV,
  appendHistory,
  clearHistory,
  formatSuggestions,
  historyCorpus,
  loadHistory,
  resolveHistoryOptions,
  scrubQuery,
  suggestQueries,
  type HistoryOptions,
} from "../src/history.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-history-"));
test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function opts(overrides: Partial<HistoryOptions> = {}): HistoryOptions {
  return { enabled: true, maxEntries: DEFAULT_HISTORY_MAX, path: path.join(tmp, `h-${Math.random().toString(36).slice(2)}.json`), source: "env", ...overrides };
}

// ---------------------------------------------------------------------------
// opt-in and retention
// ---------------------------------------------------------------------------

test("history: disabled by default and nothing is written (opt-in)", () => {
  const options = opts({ enabled: false });
  appendHistory({ q: "find package.json", tool: "ultrasearch_query" }, options);
  assert.equal(fs.existsSync(options.path), false, "disabled history must not create a file");
  assert.deepEqual(loadHistory(options), []);
});

test("history: ULTRASEARCH_HISTORY enables, =0 is the explicit opt-out", () => {
  assert.equal(resolveHistoryOptions({ [HISTORY_ENV]: "1" } as NodeJS.ProcessEnv).enabled, true);
  assert.equal(resolveHistoryOptions({ [HISTORY_ENV]: "true" } as NodeJS.ProcessEnv).enabled, true);
  assert.equal(resolveHistoryOptions({ [HISTORY_ENV]: "0" } as NodeJS.ProcessEnv).enabled, false);
  assert.equal(resolveHistoryOptions({} as NodeJS.ProcessEnv).enabled, false, "unset is off");
  const capped = resolveHistoryOptions({ [HISTORY_ENV]: "1", [HISTORY_MAX_ENV]: "999999" } as NodeJS.ProcessEnv);
  assert.equal(capped.maxEntries, 5000, "retention cap is clamped");
  const floored = resolveHistoryOptions({ [HISTORY_ENV]: "1", [HISTORY_MAX_ENV]: "1" } as NodeJS.ProcessEnv);
  assert.equal(floored.maxEntries, 10);
});

test("history: ULTRASEARCH_HISTORY_FILE selects the store path", () => {
  const options = resolveHistoryOptions({ [HISTORY_ENV]: "1", [HISTORY_FILE_ENV]: path.join(tmp, "custom.json") } as NodeJS.ProcessEnv);
  assert.equal(options.path, path.join(tmp, "custom.json"));
});

test("history: retention cap keeps the newest entries and holds on disk", () => {
  const options = opts({ maxEntries: 10 });
  for (let i = 0; i < 25; i++) appendHistory({ q: `query-${i}`, tool: "ultrasearch_query" }, options);
  const entries = loadHistory(options);
  assert.equal(entries.length, 10);
  assert.equal(entries[0].q, "query-15");
  assert.equal(entries[9].q, "query-24");
  // The on-disk file respects the cap too: a reload cannot grow the store.
  const raw = JSON.parse(fs.readFileSync(options.path, "utf-8"));
  assert.equal(raw.entries.length, 10);
});

test("history: writes are atomic and private, and no temp file is left behind", () => {
  const options = opts();
  appendHistory({ q: "atomic-check", tool: "cli" }, options);
  const mode = fs.statSync(options.path).mode & 0o777;
  assert.equal(mode, 0o600, "history is private to the user");
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "no temp file survives a successful write");
});

test("history: a corrupt store is empty, then healed by the next append", () => {
  const options = opts();
  fs.writeFileSync(options.path, "{ not json at all");
  assert.deepEqual(loadHistory(options), []);
  appendHistory({ q: "after-corruption", tool: "cli" }, options);
  assert.deepEqual(
    loadHistory(options).map((e) => e.q),
    ["after-corruption"]
  );
});

test("history: a query carrying a credential is scrubbed before it touches disk", () => {
  const options = opts();
  const secret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.ok(!scrubQuery(`token ${secret}`).includes(secret), "scrubQuery must redact the secret");
  appendHistory({ q: `token ${secret}`, tool: "ultrasearch_query" }, options);
  const raw = fs.readFileSync(options.path, "utf-8");
  assert.equal(raw.includes(secret), false, "the credential must never be persisted");
  assert.equal(loadHistory(options)[0].q.includes(secret), false);
});

test("history: clearHistory removes the store", () => {
  const options = opts();
  appendHistory({ q: "remove-me", tool: "cli" }, options);
  assert.equal(fs.existsSync(options.path), true);
  assert.equal(clearHistory(options), true);
  assert.equal(fs.existsSync(options.path), false);
  assert.equal(clearHistory(options), false, "clearing twice is not an error");
});

test("history: blank queries are never stored", () => {
  const options = opts();
  appendHistory({ q: "   ", tool: "cli" }, options);
  appendHistory({ q: "", tool: "cli" }, options);
  assert.deepEqual(loadHistory(options), []);
});

// ---------------------------------------------------------------------------
// suggestions
// ---------------------------------------------------------------------------

const sample = [
  { q: "UltraSearchClient search", tool: "ultrasearch_query", ts: 1 },
  { q: "UltraSearchClient grep", tool: "ultrasearch_grep", ts: 2 },
  { q: "history retention", tool: "ultrasearch_query", ts: 3, hits: 4 },
  { q: "watch mode fixture", tool: "ultrasearch_watch", ts: 4 },
];

test("history: suggestions rank prefix matches ahead of recent queries", () => {
  const suggestions = suggestQueries(sample, "UltraSearchClient", 3);
  assert.equal(suggestions[0].query, "UltraSearchClient grep");
  assert.equal(suggestions[0].reason, "prefix");
  assert.ok(suggestions.every((s) => s.query !== "UltraSearchClient"));
});

test("history: an expanded variant (all input tokens present) is suggested", () => {
  const suggestions = suggestQueries(sample, "history");
  assert.ok(suggestions.some((s) => s.query === "history retention"), `got ${JSON.stringify(suggestions)}`);
});

test("history: no history means no suggestions; the exact query is never suggested", () => {
  assert.deepEqual(suggestQueries([], "anything"), []);
  const suggestions = suggestQueries(sample, "UltraSearchClient search");
  assert.equal(suggestions.some((s) => s.query === "UltraSearchClient search"), false);
});

test("history: suggestions are deterministic and capped", () => {
  const first = suggestQueries(sample, "UltraSearch", 2);
  const second = suggestQueries(sample, "UltraSearch", 2);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
});

test("history: formatSuggestions renders one line per suggestion", () => {
  const text = formatSuggestions([
    { query: "grep initializer", score: 100, reason: "prefix", ts: 1 },
    { query: "grep options", score: 90, reason: "tokens", ts: 2 },
  ]);
  assert.equal(text.split("\n").length, 2);
  assert.ok(text.includes("grep initializer"));
});

test("history: historyCorpus gives the learner a query -> uses mapping", () => {
  const corpus = historyCorpus([...sample, sample[0]]);
  assert.equal(corpus["UltraSearchClient search"], 2);
  assert.equal(corpus["watch mode fixture"], 1);
});
