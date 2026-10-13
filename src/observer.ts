import { recordAudit } from "./telemetry.ts";
import type { FSearchClient } from "./client.ts";
import { getLearnedCorrection } from "./recursive-learning.ts";

/**
 * Checks if a bash/powershell command is a search bypass that could have used fsearch.
 */
export function analyzeCommandForBypass(command: string, durationMs: number): void {
  const trimmed = command.trim();

  // Pattern checks for find, grep, ripgrep, rg
  if (/\b(?:find\s+[^\n|;&]+-name|find\s+\.\s+-name)/.test(trimmed)) {
    recordAudit({
      ts: Date.now(),
      tool: "cli_bypass",
      ms: durationMs,
      ok: true,
      hitCount: 1,
      source: "cli_subprocess",
      bypassCommand: trimmed.slice(0, 100),
      diagnosticHint: "Use fsearch_query: 45x faster file path search using resident radix index.",
    });
    return;
  }

  if (/\b(?:grep\s+-[rnEiwl]+|ripgrep|rg\s+-[rnEiwl]*|rg\s+["'])[\s\S]*/.test(trimmed)) {
    recordAudit({
      ts: Date.now(),
      tool: "cli_bypass",
      ms: durationMs,
      ok: true,
      hitCount: 1,
      source: "cli_subprocess",
      bypassCommand: trimmed.slice(0, 100),
      diagnosticHint: "Use fsearch_grep or fsearch_multi_grep: 12x faster trigram index search without spawning subprocesses.",
    });
    return;
  }
}

/**
 * Diagnoses 0-hit queries and provides actionable corrective guidance.
 */
export async function diagnoseEmptyQuery(
  query: string,
  worktreeRoot: string,
  client: FSearchClient
): Promise<string | undefined> {
  const cleanQ = query.trim().replace(/^['"]/, "").replace(/['"]$/, "");

  // 1. Check if a known typo pattern was learned by the recursive engine
  const learned = getLearnedCorrection(cleanQ);
  if (learned) {
    return `Learned correction pattern: Did you mean '${learned}'? Exact zero-typo matching is strictly enforced on code symbols.`;
  }

  // 2. Check if query is looking for a filename without path
  const baseNameMatch = /([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)$/.exec(cleanQ);
  if (baseNameMatch) {
    const filename = baseNameMatch[1];
    // Check if file exists globally or elsewhere in repo
    try {
      const locateRes = await client.search(`'${filename}`, { in: worktreeRoot, limit: 3 });
      if (locateRes.ok && locateRes.hits && locateRes.hits.length > 0) {
        const paths = locateRes.hits.map((h) => h.path.replace(worktreeRoot, "").replace(/^\//, "")).join(", ");
        return `Exact match exists at different path: ${paths}. Use fsearch_locate("${filename}") or adjust folder scope.`;
      }
    } catch {}
  }

  // Notice about strict exact matching
  return "Zero typo tolerance enforced. Ensure spelling and case matches exact symbol or filename. Use globs (e.g. '*keyword*') for broader matching.";
}
