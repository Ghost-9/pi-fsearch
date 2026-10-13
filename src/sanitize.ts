/**
 * Secret redaction patterns to prevent leaking credentials into LLM contexts.
 */
const SECRET_PATTERNS: RegExp[] = [
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|private[_-]?key|jwt)[\s:=]+['"]?)([a-zA-Z0-9_\-\.]{12,})(['"]?)/gi,
  /(gh[pousr]_[A-Za-z0-9_]{36,255})/g,
  /(xox[baprs]-[A-Za-z0-9_\-]{10,})/g,
  /(AKIA[0-9A-Z]{16})/g,
  /(-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----)/g,
];

/**
 * Scrub sensitive credentials from text lines before LLM prompt injection.
 */
export function scrubSecrets(line: string): string {
  let cleaned = line;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match, prefix, secret, suffix) => {
      if (secret && typeof secret === "string") {
        return `${prefix}[REDACTED_${secret.slice(0, 4)}...]${suffix ?? ""}`;
      }
      return "[REDACTED_SECRET]";
    });
  }
  return cleaned;
}

/**
 * Ensures path is within allowed boundaries if scope is enforced.
 */
export function isPathSafe(filePath: string, allowedRoot?: string): boolean {
  if (!allowedRoot) return true;
  const normalizedPath = filePath.replace(/\/+/g, "/");
  const normalizedRoot = allowedRoot.replace(/\/+/g, "/");
  return normalizedPath.startsWith(normalizedRoot);
}
