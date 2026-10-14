process.env.PI_ULTRASEARCH_TEST = "1";

import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeAudit,
  summarizeAuditViews,
  formatAuditSummary,
  classifyAuditOrigin,
  recordAudit,
  loadAudit,
  resetAudit,
  GATE_SIGNATURE_QUERIES,
  estimateTokensSaved,
  type UltraSearchAuditRow,
} from "../src/telemetry.ts";

const rows: UltraSearchAuditRow[] = [
  { ts: 3, tool: "ultrasearch_query", query: "readme", ms: 5, ok: true, hitCount: 2, source: "index", origin: "organic" },
  { ts: 2, tool: "ultrasearch_grep", pattern: "x", ms: 20, ok: true, hitCount: 0, source: "native_fallback", origin: "synthetic" },
  { ts: 1, tool: "ultrasearch_query", query: "package.json", ms: 3, ok: true, hitCount: 1, source: "index" },
];

test("telemetry views: real is the default and excludes synthetic rows", () => {
  const real = summarizeAudit(100, { rows });
  assert.equal(real.view, "real");
  assert.equal(real.totalCalls, 2);
  assert.deepEqual(real.originCounts, { organic: 2, synthetic: 1, unmarked: 1 });
  assert.equal(real.filteredOutRows, 1);

  const all = summarizeAudit(100, { rows, view: "all" });
  assert.equal(all.totalCalls, 3);

  const synthetic = summarizeAudit(100, { rows, view: "synthetic" });
  assert.equal(synthetic.totalCalls, 1);
  assert.equal(synthetic.toolStats[0].fallbackCount, 1);
});

test("telemetry views: summarizeAuditViews splits all three provenance slices", () => {
  const views = summarizeAuditViews(rows);
  assert.equal(views.real.totalCalls, 2);
  assert.equal(views.synthetic.totalCalls, 1);
  assert.equal(views.all.totalCalls, 3);
  assert.equal(views.all.originCounts?.organic, 2);
  assert.equal(views.all.originCounts?.synthetic, 1);
  assert.equal(views.all.originCounts?.unmarked, 1);
});

test("telemetry views: explicit origin wins over the legacy query heuristic", () => {
  assert.equal(classifyAuditOrigin({ ...rows[0] }), "organic");
  assert.equal(classifyAuditOrigin({ ...rows[2] }, { legacySyntheticQueries: true }), "synthetic");
  assert.equal(classifyAuditOrigin({ ...rows[2] }, { legacySyntheticQueries: false }), "organic");
  assert.ok(GATE_SIGNATURE_QUERIES.includes("package.json"));
});

test("telemetry: recordAudit stamps synthetic provenance inside PI_ULTRASEARCH_TEST", () => {
  resetAudit();
  recordAudit({ ts: Date.now(), tool: "ultrasearch_query", query: "prov", ms: 1, ok: true, hitCount: 1, source: "index" });
  const stored = loadAudit(10);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].origin, "synthetic");
  resetAudit();
});

test("tokens-saved is labelled an estimate everywhere it is displayed", () => {
  const summary = summarizeAudit(100, { rows, view: "real" });
  const text = formatAuditSummary(summary);
  assert.match(text, /ESTIMATE ONLY/);
  assert.match(text, /not measured/);
  assert.match(text, /View: real sessions only/);
  assert.match(text, /Provenance/);
  assert.equal(estimateTokensSaved("ultrasearch_grep", 4), 150 + 4 * 75);
});
