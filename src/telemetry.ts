import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UltraSearchAuditRow {
  ts: number;
  sessionId?: string;
  tool: "ultrasearch_query" | "ultrasearch_grep" | "ultrasearch_locate" | "ultrasearch_recent" | "ultrasearch_multi_grep" | "ultrasearch_compact" | "cli_bypass";
  query?: string;
  pattern?: string;
  scope?: string;
  ms: number;
  ok: boolean;
  hitCount: number;
  tokensSaved?: number;
  source: "index" | "scan" | "native_fallback" | "cli_subprocess";
  bypassCommand?: string;
  diagnosticHint?: string;
}

export type AuditTool = UltraSearchAuditRow["tool"];

export function getAuditFilePath(): string {
  if (process.env.PI_ULTRASEARCH_TEST === "1") {
    return join(homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "test_audit.jsonl");
  }
  return join(homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "audit.jsonl");
}

const LEGACY_AUDIT_FILE = join(homedir(), ".pi", "agent", "cache", "pi-fsearch", "audit.jsonl");
const MAX_LINES = 5000;

let estimatedLineCount = -1;

/**
 * Estimates LLM context tokens saved by using index-accelerated surgical search
 * vs loading whole files or raw recursive directory dumps into context.
 */
export function estimateTokensSaved(
  tool: string,
  hitCount: number
): number {
  if (tool === "cli_bypass" || tool === "ultrasearch_compact") return 0;
  if (tool === "ultrasearch_grep" || tool === "ultrasearch_multi_grep") {
    // A grep hit avoids loading entire files into agent context.
    // Average source file: 1,200 tokens. Surgical grep match: ~30 tokens.
    // Conservative estimated savings: ~75 tokens per hit, plus base 150 tokens for targeted hit list.
    return hitCount > 0 ? 150 + hitCount * 75 : 50;
  }
  if (tool === "ultrasearch_query" || tool === "ultrasearch_locate") {
    // Avoids massive recursive directory listings or find dumps in agent context.
    return hitCount > 0 ? 100 + hitCount * 30 : 25;
  }
  if (tool === "ultrasearch_recent") {
    return hitCount > 0 ? 120 + hitCount * 25 : 20;
  }
  return 0;
}

/**
 * Appends a telemetry row to the persistent audit log asynchronously/safely.
 * Never throws or blocks agent tool execution (<0.05ms).
 */
export function recordAudit(row: UltraSearchAuditRow): void {
  try {
    if (row.tokensSaved === undefined) {
      row.tokensSaved = estimateTokensSaved(row.tool, row.hitCount);
    }

    const auditFile = getAuditFilePath();
    mkdirSync(dirname(auditFile), { recursive: true });

    // Initialize line count once
    if (estimatedLineCount === -1) {
      if (!existsSync(auditFile) && existsSync(LEGACY_AUDIT_FILE) && process.env.PI_ULTRASEARCH_TEST !== "1") {
        try {
          const legacy = readFileSync(LEGACY_AUDIT_FILE, "utf-8");
          writeFileSync(auditFile, legacy, "utf-8");
        } catch {}
      }
      if (existsSync(auditFile)) {
        const content = readFileSync(auditFile, "utf-8");
        estimatedLineCount = content.split("\n").filter(Boolean).length;
      } else {
        estimatedLineCount = 0;
      }
    }

    // Rotate only when exceeding threshold
    if (estimatedLineCount >= MAX_LINES) {
      try {
        const content = readFileSync(auditFile, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const retained = lines.slice(-Math.floor(MAX_LINES / 2));
        writeFileSync(auditFile, retained.join("\n") + "\n", "utf-8");
        estimatedLineCount = retained.length;
      } catch {}
    }

    appendFileSync(auditFile, JSON.stringify(row) + "\n", "utf-8");
    estimatedLineCount++;
  } catch {
    // Non-blocking telemetry
  }
}

/**
 * Loads recent audit rows from disk.
 */
export function loadAudit(limit = 1000): UltraSearchAuditRow[] {
  try {
    const auditFile = getAuditFilePath();
    const target = existsSync(auditFile)
      ? auditFile
      : (process.env.PI_ULTRASEARCH_TEST !== "1" && existsSync(LEGACY_AUDIT_FILE))
      ? LEGACY_AUDIT_FILE
      : null;
    if (!target) return [];
    return readFileSync(target, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as UltraSearchAuditRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is UltraSearchAuditRow => r !== null);
  } catch {
    return [];
  }
}

export function resetAudit(): void {
  try {
    const auditFile = getAuditFilePath();
    if (existsSync(auditFile)) {
      writeFileSync(auditFile, "", "utf-8");
    }
    if (process.env.PI_ULTRASEARCH_TEST !== "1" && existsSync(LEGACY_AUDIT_FILE)) {
      writeFileSync(LEGACY_AUDIT_FILE, "", "utf-8");
    }
    estimatedLineCount = 0;
  } catch {}
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface UltraSearchSummary {
  totalCalls: number;
  totalTokensSaved: number;
  since: number | null;
  lastUsed: {
    ts: number | null;
    tool: string | null;
    query: string | null;
    ms: number;
    hitCount: number;
  } | null;
  toolStats: Array<{
    tool: string;
    calls: number;
    okRate: number;
    emptyRate: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    fallbackCount: number;
  }>;
  cliBypasses: Array<{
    command: string;
    ms: number;
    alternative: string;
  }>;
  zeroHitQueries: Array<{
    query: string;
    tool: string;
    hint?: string;
  }>;
  optimizationAdvice: string[];
}

export function summarizeAudit(limit = 1000): UltraSearchSummary {
  const rows = loadAudit(limit);
  const totalCalls = rows.length;
  const since = rows.length > 0 ? rows[0].ts : null;

  let totalTokensSaved = 0;
  let lastUsed: UltraSearchSummary["lastUsed"] = null;

  const byTool = new Map<string, UltraSearchAuditRow[]>();
  const cliBypasses: UltraSearchSummary["cliBypasses"] = [];
  const zeroHitQueries: UltraSearchSummary["zeroHitQueries"] = [];

  for (const r of rows) {
    const saved = r.tokensSaved ?? estimateTokensSaved(r.tool, r.hitCount);
    totalTokensSaved += saved;

    if (r.tool === "cli_bypass") {
      cliBypasses.push({
        command: r.bypassCommand ?? "unknown",
        ms: r.ms,
        alternative: r.diagnosticHint ?? "Use ultrasearch_query or ultrasearch_grep",
      });
      continue;
    }

    if (!byTool.has(r.tool)) {
      byTool.set(r.tool, []);
    }
    byTool.get(r.tool)!.push(r);

    if (r.ok && r.hitCount === 0 && (r.query || r.pattern)) {
      zeroHitQueries.push({
        query: r.query ?? r.pattern ?? "",
        tool: r.tool,
        hint: r.diagnosticHint,
      });
    }
  }

  // Find the latest active tool call (prefer actual ultrasearch query tools over test/cli bypasses if available)
  const nonBypassRows = rows.filter((r) => r.tool !== "cli_bypass");
  const latestRow = nonBypassRows.length > 0 ? nonBypassRows[nonBypassRows.length - 1] : rows[rows.length - 1];
  if (latestRow) {
    lastUsed = {
      ts: latestRow.ts,
      tool: latestRow.tool,
      query: latestRow.query ?? latestRow.pattern ?? latestRow.bypassCommand ?? null,
      ms: latestRow.ms,
      hitCount: latestRow.hitCount,
    };
  }

  const toolStats: UltraSearchSummary["toolStats"] = [];
  for (const [tool, toolRows] of byTool.entries()) {
    const latencies = toolRows.map((r) => r.ms);
    const okCount = toolRows.filter((r) => r.ok).length;
    const emptyCount = toolRows.filter((r) => r.ok && r.hitCount === 0).length;
    const fallbackCount = toolRows.filter((r) => r.source === "native_fallback").length;

    toolStats.push({
      tool,
      calls: toolRows.length,
      okRate: toolRows.length > 0 ? (okCount / toolRows.length) * 100 : 0,
      emptyRate: okCount > 0 ? (emptyCount / okCount) * 100 : 0,
      p50Ms: pct(latencies, 50),
      p90Ms: pct(latencies, 90),
      p95Ms: pct(latencies, 95),
      fallbackCount,
    });
  }

  const advice: string[] = [];

  if (cliBypasses.length > 0) {
    advice.push(`Detected ${cliBypasses.length} CLI subprocess searches (find/rg). Directing agent to ultrasearch tools will save 10-40ms per call.`);
  }

  for (const stat of toolStats) {
    if (stat.tool === "ultrasearch_compact") {
      // Compaction is a disk maintenance operation over millions of files; evaluate against 2.5s gate
      if (stat.p95Ms > 2500) {
        advice.push(
          `LSM Compaction p95 latency is ${stat.p95Ms.toFixed(1)}ms (>2500ms maintenance threshold). Daemon memory or disk I/O may be saturated.`
        );
      }
      continue;
    }

    if (stat.p95Ms > 10) {
      advice.push(
        `Tool ${stat.tool} has p95 latency of ${stat.p95Ms.toFixed(1)}ms (>10ms target). Ensure scope paths are narrowed or UltraSearch daemon content index is warm.`
      );
    }
    if (stat.emptyRate > 35) {
      advice.push(
        `Tool ${stat.tool} has a ${stat.emptyRate.toFixed(1)}% zero-hit rate. Queries may be over-constrained. Suggest verifying exact file casing or using ultrasearch_locate.`
      );
    }
  }

  if (advice.length === 0) {
    advice.push("Toolchain running optimally. Sub-10ms CI gates maintained and zero CLI bypasses detected.");
  }

  return {
    totalCalls,
    totalTokensSaved,
    since,
    lastUsed,
    toolStats,
    cliBypasses: cliBypasses.slice(-10),
    zeroHitQueries: zeroHitQueries.slice(-10),
    optimizationAdvice: advice,
  };
}

export function formatAuditSummary(summary: UltraSearchSummary): string {
  const parts: string[] = [];
  parts.push("=== Pi-UltraSearch Observability & Toolchain Audit ===");
  parts.push(`Total Monitored Calls: ${summary.totalCalls}`);
  parts.push(`Estimated Tokens Saved: ${summary.totalTokensSaved.toLocaleString()}`);
  if (summary.lastUsed && summary.lastUsed.ts) {
    parts.push(`Last Used: ${new Date(summary.lastUsed.ts).toISOString()} (${summary.lastUsed.tool})`);
  }
  if (summary.since) {
    parts.push(`Recording Since: ${new Date(summary.since).toISOString()}`);
  }
  parts.push("");

  parts.push("--- Latency & Quality Metrics ---");
  for (const s of summary.toolStats) {
    parts.push(
      `• ${s.tool.padEnd(18)}: ${s.calls} calls | p50: ${s.p50Ms.toFixed(2)}ms | p90: ${s.p90Ms.toFixed(2)}ms | p95: ${s.p95Ms.toFixed(2)}ms | Success: ${s.okRate.toFixed(1)}% | 0-Hit: ${s.emptyRate.toFixed(1)}% | Fallbacks: ${s.fallbackCount}`
    );
  }
  parts.push("");

  if (summary.cliBypasses.length > 0) {
    parts.push(`--- Detected CLI Bypasses (${summary.cliBypasses.length} instances) ---`);
    for (const b of summary.cliBypasses) {
      parts.push(`  ❌ [${b.ms.toFixed(1)}ms] "${b.command}" -> Hint: ${b.alternative}`);
    }
    parts.push("");
  }

  if (summary.zeroHitQueries.length > 0) {
    parts.push(`--- Recent 0-Hit Queries (${summary.zeroHitQueries.length}) ---`);
    for (const z of summary.zeroHitQueries) {
      parts.push(`  ⚠️  [${z.tool}] "${z.query}" ${z.hint ? `(Hint: ${z.hint})` : ""}`);
    }
    parts.push("");
  }

  parts.push("--- Recursive Learning & Actionable Advice ---");
  for (const a of summary.optimizationAdvice) {
    parts.push(`  💡 ${a}`);
  }

  return parts.join("\n");
}
