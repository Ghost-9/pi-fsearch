import { scrubSecrets } from "./sanitize.ts";
import type { FSearchGrepFile } from "./types.ts";

export interface FormatOptions {
  worktreeRoot: string;
  compact?: boolean;
  maxTokens?: number;
  prioritizeSymbols?: boolean;
}

const SYMBOL_REGEX = /^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(?:func|fn|function|class|struct|interface|type|trait|enum|def|protocol|actor|extension)\b/;

/**
 * Formats grep file matches with optional compact one-line formatting,
 * AST symbol declaration prioritization, and strict token budget safety.
 */
export function formatGrepFiles(files: FSearchGrepFile[], options: FormatOptions): { text: string; tokenCount: number; truncatedCount: number } {
  const { worktreeRoot, compact = false, maxTokens = 1500, prioritizeSymbols = false } = options;
  const maxChars = maxTokens * 4;

  const lines: string[] = [];
  let currentChars = 0;
  let totalMatches = 0;
  let printedMatches = 0;

  // Count total matches
  for (const f of files) {
    totalMatches += f.matches.length;
  }

  for (const file of files) {
    const relPath = file.path.startsWith(worktreeRoot)
      ? file.path.slice(worktreeRoot.length).replace(/^\//, "")
      : file.path;

    // Sort matches in file if symbol prioritization is enabled
    let sortedMatches = [...file.matches];
    if (prioritizeSymbols) {
      sortedMatches.sort((a, b) => {
        const aIsDef = SYMBOL_REGEX.test(a.text) ? 1 : 0;
        const bIsDef = SYMBOL_REGEX.test(b.text) ? 1 : 0;
        return bIsDef - aIsDef;
      });
    }

    if (compact) {
      for (const m of sortedMatches) {
        const scrubbed = scrubSecrets(m.text).trim();
        const lineStr = `${relPath}:${m.line}: ${scrubbed}`;
        if (currentChars + lineStr.length > maxChars && printedMatches > 0) {
          const omitted = totalMatches - printedMatches;
          lines.push(`\n[... Truncated: ${omitted} additional matches omitted to conserve context budget. Refine path_filter or increase max_tokens]`);
          return {
            text: lines.join("\n"),
            tokenCount: Math.ceil(currentChars / 4),
            truncatedCount: omitted,
          };
        }
        lines.push(lineStr);
        currentChars += lineStr.length + 1;
        printedMatches++;
      }
    } else {
      const fileHeader = `\n=== ${relPath} ===`;
      if (currentChars + fileHeader.length > maxChars && printedMatches > 0) {
        const omitted = totalMatches - printedMatches;
        lines.push(`\n[... Truncated: ${omitted} additional matches omitted to conserve context budget. Refine path_filter or increase max_tokens]`);
        return {
          text: lines.join("\n"),
          tokenCount: Math.ceil(currentChars / 4),
          truncatedCount: omitted,
        };
      }
      lines.push(fileHeader);
      currentChars += fileHeader.length + 1;

      for (const m of sortedMatches) {
        const scrubbed = scrubSecrets(m.text).trim();
        const lineStr = `  L${m.line}: ${scrubbed}`;
        if (currentChars + lineStr.length > maxChars && printedMatches > 0) {
          const omitted = totalMatches - printedMatches;
          lines.push(`  [... ${omitted} additional matches omitted to conserve context budget]`);
          return {
            text: lines.join("\n"),
            tokenCount: Math.ceil(currentChars / 4),
            truncatedCount: omitted,
          };
        }
        lines.push(lineStr);
        currentChars += lineStr.length + 1;
        printedMatches++;
      }
    }
  }

  return {
    text: lines.join("\n").trim(),
    tokenCount: Math.ceil(currentChars / 4),
    truncatedCount: totalMatches - printedMatches,
  };
}
