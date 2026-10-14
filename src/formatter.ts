import { scrubSecrets, isSensitiveFile } from "./sanitize.ts";
import type { UltraSearchGrepFile } from "./types.ts";

export interface FormatOptions {
  worktreeRoot: string;
  compact?: boolean;
  maxTokens?: number;
  prioritizeSymbols?: boolean;
  showContext?: boolean;
  tagSymbols?: boolean;
}

const SYMBOL_REGEX = /^\s*(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(?:func|fn|function|class|struct|interface|type|trait|enum|def|protocol|actor|extension)\b/;

export function detectSymbolTag(lineText: string): string | null {
  const t = lineText.trim();
  if (/^(?:pub\s+)?(?:async\s+)?(?:export\s+)?(?:default\s+)?(?:function|fn|func|def)\b/.test(t)) return "def:fn";
  if (/^(?:pub\s+)?(?:export\s+)?(?:class)\b/.test(t)) return "def:class";
  if (/^(?:pub\s+)?(?:export\s+)?(?:interface|struct|trait)\b/.test(t)) return "def:type";
  if (/^(?:pub\s+)?(?:export\s+)?(?:type|enum)\b/.test(t)) return "def:type";
  if (/^(?:pub\s+)?(?:export\s+)?(?:const|let|var)\b/.test(t)) return "def:var";
  return null;
}

/**
 * Formats grep file matches.
 * - Defaults to `compact: true` (clean one-line `file:line: text` format).
 * - Enterprise DLP Protection: Completely redacts environment variables & private keys from `.env*`, `.pem`, `.key`, `id_rsa`.
 * - Prioritizes AST symbol declarations (`class`, `func`, `struct`, `interface`, etc.) when `prioritizeSymbols` is enabled.
 * - Supports surrounding code context (`showContext: true`) and symbol tagging (`tagSymbols: true`).
 */
export function formatGrepFiles(
  files: UltraSearchGrepFile[],
  options: FormatOptions
): { text: string; tokenCount: number; truncatedCount: number } {
  const {
    worktreeRoot,
    compact = true,
    maxTokens,
    prioritizeSymbols = false,
    showContext = false,
    tagSymbols = false,
  } = options;
  const maxChars = maxTokens !== undefined ? maxTokens * 4 : Infinity;

  const lines: string[] = [];
  let currentChars = 0;
  let totalMatches = 0;
  let printedMatches = 0;

  for (const f of files) {
    totalMatches += f.matches.length;
  }

  for (const file of files) {
    const relPath = file.path.startsWith(worktreeRoot)
      ? file.path.slice(worktreeRoot.length).replace(/^\//, "")
      : file.path;

    const isSensitive = isSensitiveFile(file.path);

    // Sort matches in file if symbol prioritization is enabled
    let sortedMatches = [...file.matches];
    if (prioritizeSymbols && !isSensitive) {
      sortedMatches.sort((a, b) => {
        const aIsDef = SYMBOL_REGEX.test(a.text) ? 1 : 0;
        const bIsDef = SYMBOL_REGEX.test(b.text) ? 1 : 0;
        return bIsDef - aIsDef;
      });
    }

    if (compact) {
      for (const m of sortedMatches) {
        let scrubbed = scrubSecrets(m.text).trim();
        if (isSensitive) {
          scrubbed = "[DLP_PROTECTED: Environment credential / key masked to prevent secret leakage]";
        }

        const tag = (tagSymbols && !isSensitive) ? detectSymbolTag(m.text) : null;
        const tagPrefix = tag ? `[${tag}] ` : "";

        // If context lines exist and showContext is requested
        if (showContext && !isSensitive) {
          if (m.before && m.before.length > 0) {
            for (let bIdx = 0; bIdx < m.before.length; bIdx++) {
              const bLineNum = m.line - m.before.length + bIdx;
              const bLine = `${relPath}-${bLineNum}- ${scrubSecrets(m.before[bIdx]).trim()}`;
              lines.push(bLine);
              currentChars += bLine.length + 1;
            }
          }
        }

        const lineStr = `${relPath}:${m.line}: ${tagPrefix}${scrubbed}`;
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

        if (showContext && !isSensitive) {
          if (m.after && m.after.length > 0) {
            for (let aIdx = 0; aIdx < m.after.length; aIdx++) {
              const aLineNum = m.line + 1 + aIdx;
              const aLine = `${relPath}-${aLineNum}- ${scrubSecrets(m.after[aIdx]).trim()}`;
              lines.push(aLine);
              currentChars += aLine.length + 1;
            }
          }
        }
      }
    } else {
      const defCount = sortedMatches.filter((m) => SYMBOL_REGEX.test(m.text)).length;
      const fileHeader = `\n=== ${relPath} (${sortedMatches.length} matches${defCount > 0 ? `, ${defCount} defs` : ""})${isSensitive ? " [DLP PROTECTED FILE]" : ""} ===`;
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
        let scrubbed = scrubSecrets(m.text).trim();
        if (isSensitive) {
          scrubbed = "[DLP_PROTECTED: Environment credential / key masked to prevent secret leakage]";
        }

        const tag = (!isSensitive) ? detectSymbolTag(m.text) : null;
        const tagPrefix = tag ? `[${tag}] ` : "";

        if (showContext && !isSensitive && m.before && m.before.length > 0) {
          for (let bIdx = 0; bIdx < m.before.length; bIdx++) {
            const bLineNum = m.line - m.before.length + bIdx;
            lines.push(`  L${bLineNum}- ${scrubSecrets(m.before[bIdx]).trim()}`);
          }
        }

        const lineStr = `  L${m.line}: ${tagPrefix}${scrubbed}`;
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

        if (showContext && !isSensitive && m.after && m.after.length > 0) {
          for (let aIdx = 0; aIdx < m.after.length; aIdx++) {
            const aLineNum = m.line + 1 + aIdx;
            lines.push(`  L${aLineNum}- ${scrubSecrets(m.after[aIdx]).trim()}`);
          }
        }
      }
    }
  }

  return {
    text: lines.join("\n").trim(),
    tokenCount: Math.ceil(currentChars / 4),
    truncatedCount: totalMatches - printedMatches,
  };
}
