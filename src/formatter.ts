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
 * Formats grep file matches.
 * - Defaults to `compact: true` (clean one-line `file:line: text` format, saving 30-50% tokens without dropping any matches).
 * - Defaults to uncapped context (`maxTokens: undefined`), ensuring the AI agent NEVER misses any matching files or definitions.
 * - Prioritizes AST symbol declarations (`class`, `func`, `struct`, `interface`, etc.) when `prioritizeSymbols` is enabled.
 */
export function formatGrepFiles(files: FSearchGrepFile[], options: FormatOptions): { text: string; tokenCount: number; truncatedCount: number } {
  const { worktreeRoot, compact = true, maxTokens, prioritizeSymbols = false } = options;
  const maxChars = maxTokens !== undefined ? maxTokens * 4 : Infinity;

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
          lines.push(`\n[... Truncated: ${omitted} additional matches omitted to protect token ceiling. Omit max_tokens or refine path_filter to see more]`);
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
        lines.push(`\n[... Truncated: ${omitted} additional matches omitted. Omit max_tokens or refine path_filter to see more]`);
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
          lines.push(`  [... ${omitted} additional matches omitted]`);
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
