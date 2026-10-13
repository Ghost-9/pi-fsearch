import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FSearchAuditRow {
  ts: number;
  sessionId?: string;
  tool: "fsearch_query" | "fsearch_grep" | "fsearch_locate" | "fsearch_recent" | "fsearch_multi_grep" | "cli_bypass";
  query?: string;
  pattern?: string;
  scope?: string;
  ms: number;
  ok: boolean;
  hitCount: number;
  source: "index" | "scan" | "native_fallback" | "cli_subprocess";
  bypassCommand?: string;
  diagnosticHint?: string;
}

const AUDIT_FILE = join(homedir(), ".pi", "agent", "cache", "pi-fsearch", "audit.jsonl");
const MAX_LINES = 5000;

/**
 * Appends a telemetry row to the persistent audit log asynchronously/safely.
 * Never throws or blocks agent tool execution.
 */
export function recordAudit(row: FSearchAuditRow): void {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    if (existsSync(AUDIT_FILE)) {
      const content = readFileSync(AUDIT_FILE, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > MAX_LINES) {
        // Retain latest half of log file
        writeFileSync(AUDIT_FILE, lines.slice(-Math.floor(MAX_LINES / 2)).join("\n") + "\n", "utf-8");
      }
    }
    appendFileSync(AUDIT_FILE, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // Non-blocking telemetry
  }
}

/**
 * Loads recent audit rows from disk.
 */
export function loadAudit(limit = 1000): FSearchAuditRow[] {
  try {
    if (!existsSync(AUDIT_FILE)) return [];
    return readFileSync(AUDIT_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as FSearchAuditRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is FSearchAuditRow => r !== null);
  } catch {
    return [];
  }
}

export function resetAudit(): void {
  try {
    if (existsSync(AUDIT_FILE)) {
      writeFileSync(AUDIT_FILE, "", "utf-8");
    }
  } catch {}
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface FSearchSummary {
  totalCalls: number;
  since: number | null;
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

export function summarizeAudit(limit = 1000): FSearchSummary {
  const rows = loadAudit(limit);
  const byTool = new Map<string, FSearchAuditRow[]>();
  const cliBypasses: Array<{ command: string; ms: number; alternative: string }> = [];
  const zeroHitQueries: Array<{ query: string; tool: string; hint?: string }> = [];

  for (const row of rows) {
    if (row.tool === "cli_bypass" && row.bypassCommand) {
      cliBypasses.push({
        command: row.bypassCommand,
        ms: row.ms,
        alternative: row.diagnosticHint ?? "Use fsearch_query or fsearch_grep",
      });
      continue;
    }

    const list = byTool.get(row.tool) ?? [];
    list.push(row);
    byTool.set(row.tool, list);

    if (row.hitCount === 0 && (row.query || row.pattern)) {
      zeroHitQueries.push({
        query: row.query || row.pattern || "",
        tool: row.tool,
        hint: row.diagnosticHint,
      });
    }
  }

  const toolStats = Array.from(byTool.entries()).map(([tool, list]) => {
    const msList = list.map((r) => r.ms);
    const okCount = list.filter((r) => r.ok).length;
    const emptyCount = list.filter((r) => r.hitCount === 0).length;
    const fallbackCount = list.filter((r) => r.source === "native_fallback").length;

    return {
      tool,
      calls: list.length,
      okRate: list.length ? Number((okCount / list.length).toFixed(3)) : 0,
      emptyRate: list.length ? Number((emptyCount / list.length).toFixed(3)) : 0,
      p50Ms: Number(pct(msList, 50).toFixed(2)),
      p90Ms: Number(pct(msList, 90).toFixed(2)),
      p95Ms: Number(pct(msList, 95).toFixed(2)),
      fallbackCount,
    };
  });

  const advice: string[] = [];
  if (cliBypasses.length > 0) {
    advice.push(`Detected ${cliBypasses.length} CLI subprocess searches (find/rg). Directing agent to fsearch tools will save 10-40ms per call.`);
  }
  const multiGrepEligible = rows.filter((r) => r.tool === "fsearch_grep").length;
  if (multiGrepEligible >= 4) {
    advice.push("High frequency of sequential fsearch_grep calls detected. Suggest bundling queries into fsearch_multi_grep.");
  }
  const queryStats = toolStats.find((s) => s.tool === "fsearch_query");
  if (queryStats && queryStats.emptyRate > 0.3) {
    advice.push("High zero-hit rate on fsearch_query (>30%). Queries may be over-constrained by path filters or missing files outside worktree.");
  }

  return {
    totalCalls: rows.length,
    since: rows.length ? rows[0].ts : null,
    toolStats,
    cliBypasses: cliBypasses.slice(-10),
    zeroHitQueries: zeroHitQueries.slice(-10),
    optimizationAdvice: advice,
  };
}

export function formatAuditSummary(summary: FSearchSummary): string {
  const lines: string[] = [];
  lines.push("=== FSearch Observability & Toolchain Audit ===");
  lines.push(`Total recorded interactions: ${summary.totalCalls}`);
  if (summary.since) {
    lines.push(`Logging active since: ${new Date(summary.since).toISOString()}`);
  }
  lines.push("");

  lines.push("Per-Tool Performance Metrics:");
  lines.push("Tool                 Calls    OK%    Empty%   p50(ms)  p95(ms)  Fallbacks");
  lines.push("-------------------------------------------------------------------------");
  for (const s of summary.toolStats) {
    const toolName = s.tool.padEnd(20);
    const calls = String(s.calls).padEnd(8);
    const ok = `${(s.okRate * 100).toFixed(0)}%`.padEnd(7);
    const empty = `${(s.emptyRate * 100).toFixed(0)}%`.padEnd(9);
    const p50 = `${s.p50Ms.toFixed(2)}`.padEnd(9);
    const p95 = `${s.p95Ms.toFixed(2)}`.padEnd(9);
    const fallbacks = String(s.fallbackCount);
    lines.push(`${toolName} ${calls} ${ok} ${empty} ${p50} ${p95} ${fallbacks}`);
  }

  if (summary.cliBypasses.length > 0) {
    lines.push("");
    lines.push("Detected CLI Shell Bypasses (Missed Optimization Opportunities):");
    for (const b of summary.cliBypasses) {
      lines.push(`  • [${b.ms.toFixed(1)}ms] "${b.command}" -> Suggestion: ${b.alternative}`);
    }
  }

  if (summary.zeroHitQueries.length > 0) {
    lines.push("");
    lines.push("Recent 0-Hit Queries & Diagnostics:");
    for (const z of summary.zeroHitQueries) {
      const hintText = z.hint ? ` (${z.hint})` : "";
      lines.push(`  • [${z.tool}] "${z.query}"${hintText}`);
    }
  }

  if (summary.optimizationAdvice.length > 0) {
    lines.push("");
    lines.push("Self-Improvement & Recursive Learning Recommendations:");
    for (const a of summary.optimizationAdvice) {
      lines.push(`  ✓ ${a}`);
    }
  }

  return lines.join("\n");
}
