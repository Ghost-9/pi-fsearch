/**
 * Client-side validation for user-supplied regex patterns (issue #36).
 *
 * Invalid patterns are rejected before they reach the daemon socket, and
 * patterns with an obvious catastrophic-backtracking shape produce a warning
 * the caller can surface to the agent. The validator only *compiles* the
 * pattern — it never executes it against input.
 */

export type RegexValidation = { ok: true; warning?: string } | { ok: false; error: string };

/**
 * Obvious nested-quantifier shape: a quantified group that itself contains a
 * quantifier, e.g. `(a+)+`, `(\w*)*`, `(.*)+`. This is the classic
 * exponential-backtracking shape and is REJECTED client-side (verifier finding
 * R3: `(a+)+$` previously reached the daemon and returned files).
 */
const NESTED_QUANTIFIER = /\((?:\\.|[^()\\])*(?:[*+?]|\{\d*,?\d*\})(?:\\.|[^()\\])*\)\s*(?:[*+]|\{\d*,?\d*\})/;

/** Alternation repeated by a quantifier: `(a|aa)+`-style risk shape. */
const QUANTIFIED_ALTERNATION = /\((?:\\.|[^()\\])*\|(?:\\.|[^()\\])*\)\s*(?:[*+]|\{\d*,?\d*\})/;

export function validateRegexPattern(pattern: string): RegexValidation {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    return { ok: false, error: "regex pattern is empty: provide a non-empty regular expression or use mode: \"literal\"." };
  }

  try {
    new RegExp(pattern);
  } catch (err: any) {
    return {
      ok: false,
      error: `invalid regex pattern: ${err?.message ?? String(err)}. Escape metacharacters or use mode: "literal".`,
    };
  }

  if (NESTED_QUANTIFIER.test(pattern)) {
    return {
      ok: false,
      error:
        'rejected regex pattern: a quantified group contains an inner quantifier (e.g. "(a+)+$"), which can backtrack exponentially on long inputs. Narrow the pattern or use mode: "literal".',
    };
  }

  if (QUANTIFIED_ALTERNATION.test(pattern)) {
    return {
      ok: true,
      warning:
        "pattern repeats an alternation (e.g. (a|b)+), which can backtrack heavily on long inputs; consider a character class or a literal search.",
    };
  }

  return { ok: true };
}
