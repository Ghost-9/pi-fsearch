process.env.PI_ULTRASEARCH_TEST = "1";

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAuditSummary,
  loadAudit,
  recordAudit,
  resetAudit,
  resolveHarness,
  sanitizeHarness,
  storedHarness,
  summarizeAudit,
  type UltraSearchAuditRow,
} from "../src/telemetry.ts";

/**
 * Phase 4: rows carry the harness that produced them. Two harnesses must be
 * distinguishable in one report, and the provenance view filter must still
 * apply before the grouping.
 */
const rows: UltraSearchAuditRow[] = [
  { ts: 10, tool: "ultrasearch_query", query: "a", ms: 4, ok: true, hitCount: 3, source: "index", origin: "organic", harness: "pi", tokensSaved: 190 },
  { ts: 11, tool: "ultrasearch_grep", pattern: "b", ms: 8, ok: true, hitCount: 1, source: "index", origin: "organic", harness: "pi", tokensSaved: 225 },
  { ts: 12, tool: "ultrasearch_query", query: "c", ms: 6, ok: false, hitCount: 0, source: "index", origin: "organic", harness: "mcp" },
  { ts: 13, tool: "ultrasearch_grep", pattern: "d", ms: 9, ok: true, hitCount: 0, source: "native_fallback", origin: "organic", harness: "mcp", tokensSaved: 50 },
  { ts: 14, tool: "ultrasearch_query", query: "e", ms: 1, ok: true, hitCount: 1, source: "index", origin: "synthetic", harness: "test" },
];

test("harness: --by harness attributes calls, latency, fallback, zero-hit and estimate per harness", () => {
  const summary = summarizeAudit(100, { rows, view: "real", by: "harness" });
  assert.equal(summary.by, "harness");
  assert.equal(summary.totalCalls, 4, "synthetic row must not enter the real view");
  const pi = summary.harnessStats?.find((h) => h.harness === "pi");
  const mcp = summary.harnessStats?.find((h) => h.harness === "mcp");
  assert.ok(pi, "pi block missing");
  assert.ok(mcp, "mcp block missing");
  assert.equal(summary.harnessStats?.length, 2, "only the two real harnesses are grouped");
  assert.equal(pi!.calls, 2);
  assert.equal(pi!.p50Ms, 4);
  assert.equal(pi!.p95Ms, 8);
  assert.equal(pi!.fallbackRate, 0);
  assert.equal(pi!.zeroHitRate, 0);
  assert.equal(pi!.tokensSaved, 415, "per-harness tokens saved is the stored estimate");

  assert.equal(mcp!.calls, 2);
  assert.equal(mcp!.fallbackCount, 1);
  assert.equal(mcp!.fallbackRate, 50);
  assert.equal(mcp!.zeroHitCount, 1, "the ok search with 0 hits counts; the failed call does not");
  assert.equal(mcp!.zeroHitRate, 100, "the failed call is not in the denominator");
});

test("harness: two harnesses produce two distinguishable formatted blocks", () => {
  const text = formatAuditSummary(summarizeAudit(100, { rows, view: "real", by: "harness" }));
  assert.match(text, /Per-Harness Attribution/);
  assert.match(text, /• pi\s*: 2 calls/);
  assert.match(text, /• mcp\s*: 2 calls/);
  assert.match(text, /ESTIMATE ONLY/);
  assert.match(text, /Tokens saved \(estimate\)/);
});

test("harness: the synthetic view groups the test harness only", () => {
  const synthetic = summarizeAudit(100, { rows, view: "synthetic", by: "harness" });
  assert.deepEqual(synthetic.harnessStats?.map((h) => h.harness), ["test"]);
  assert.equal(synthetic.harnessStats?.[0].calls, 1);
});

test("harness: sanitizer is deterministic and rejects empty ids", () => {
  assert.equal(sanitizeHarness("  Pi Agent!! "), "pi-agent");
  assert.equal(sanitizeHarness("MCP"), "mcp");
  assert.equal(sanitizeHarness("a/b\\c"), "a-b-c");
  assert.equal(sanitizeHarness("---"), null);
  assert.equal(sanitizeHarness(undefined), null);
  assert.ok((sanitizeHarness("x".repeat(80)) ?? "").length <= 32);
});

test("harness: resolveHarness precedence is env > explicit > test env > unknown", () => {
  const saved = process.env.ULTRASEARCH_HARNESS;
  try {
    delete process.env.ULTRASEARCH_HARNESS;
    assert.equal(resolveHarness("pi"), "pi", "explicit surface default wins under the test env");
    assert.equal(resolveHarness(), "test", "the test env stamps test");

    process.env.ULTRASEARCH_HARNESS = "Codex CLI";
    assert.equal(resolveHarness("mcp"), "codex-cli", "operator override relabels any surface");
  } finally {
    if (saved === undefined) delete process.env.ULTRASEARCH_HARNESS;
    else process.env.ULTRASEARCH_HARNESS = saved;
  }
});

test("harness: recordAudit stamps harness; storedHarness never consults the current env", () => {
  const saved = process.env.ULTRASEARCH_HARNESS;
  try {
    resetAudit();
    delete process.env.ULTRASEARCH_HARNESS;
    recordAudit({ ts: Date.now(), tool: "ultrasearch_query", query: "prov", ms: 1, ok: true, hitCount: 1, source: "index" });
    let stored = loadAudit(10);
    assert.equal(stored[0].harness, "test");

    recordAudit({ ts: Date.now(), tool: "ultrasearch_query", query: "explicit", ms: 1, ok: true, hitCount: 1, source: "index", harness: "pi" });
    stored = loadAudit(10);
    assert.equal(stored[1].harness, "pi");

    process.env.ULTRASEARCH_HARNESS = "codex";
    recordAudit({ ts: Date.now(), tool: "ultrasearch_query", query: "override", ms: 1, ok: true, hitCount: 1, source: "index", harness: "pi" });
    stored = loadAudit(10);
    assert.equal(stored[2].harness, "codex");

    // A report run must never relabel stored history from its own environment.
    assert.equal(storedHarness({ harness: "pi" }), "pi");
    assert.equal(storedHarness({}), "unknown");
    resetAudit();
  } finally {
    if (saved === undefined) delete process.env.ULTRASEARCH_HARNESS;
    else process.env.ULTRASEARCH_HARNESS = saved;
  }
});
