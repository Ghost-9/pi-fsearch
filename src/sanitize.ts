import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Enterprise Secret redaction patterns to prevent leaking credentials into LLM contexts.
 */
const BASE_SECRET_PATTERNS: RegExp[] = [
  // OpenAI & Anthropic API Keys
  /(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,255})/g,
  // HuggingFace & Kaggle tokens
  /(hf_[A-Za-z0-9]{34,})/g,
  // Generic token / key assignments with prefix, secret, suffix
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|jwt|bearer)[\s:=]+['"]?)([a-zA-Z0-9_\-\.]{12,})(['"]?)/gi,
  // Database connection strings with credentials (postgres, mysql, mongodb, redis)
  /((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|mariadb):\/\/[^:\s\/]+:)([^@\s\/]+)(@)/gi,
  // Environment variable secret assignments (KEY=secret)
  /^([A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASS|AUTH|CREDS|PRIVATE)[A-Z0-9_]*[\s:=]+['"]?)([^'"\s\r\n]{8,})(['"]?)/gim,
  // GitHub classic & fine-grained PATs
  /(gh[pousr]_[A-Za-z0-9_]{36,255})/g,
  /(github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59})/g,
  // Slack Bot & User Tokens
  /(xox[baprs]-[A-Za-z0-9_\-]{10,})/g,
  // AWS Access Keys (IAM & Temporary STS)
  /(AKIA[0-9A-Z]{16})/g,
  /(ASIA[0-9A-Z]{16})/g,
  // Stripe live & restricted keys
  /(sk_live_[0-9a-zA-Z]{24,})/g,
  /(rk_live_[0-9a-zA-Z]{24,})/g,
  // Google Cloud API Keys
  /(AIza[0-9A-Za-z\-_]{35})/g,
  // RSA, EC, OpenSSH, PGP Private keys
  /(-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----)/g,
];

/**
 * Sensitive filename patterns that must NEVER leak raw contents to LLM agents.
 */
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.env$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.netrc$/i,
  /\.dockercfg$/i,
  /id_rsa(?:\.pub)?$/i,
  /id_ed25519(?:\.pub)?$/i,
  /id_ecdsa(?:\.pub)?$/i,
  /id_dsa(?:\.pub)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /service-account.*\.json$/i,
  /client_secret.*\.json$/i,
  /credentials\.json$/i,
  /\.kdbx$/i,
];

/**
 * Checks if a file path is a sensitive credentials or environment file.
 */
export function isSensitiveFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Scrub sensitive credentials from text lines before LLM prompt injection.
 */
export function scrubSecrets(line: string, customPatterns: RegExp[] = []): string {
  let cleaned = line;
  const allPatterns = [...BASE_SECRET_PATTERNS, ...customPatterns];

  for (const pattern of allPatterns) {
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, (...args: any[]) => {
      // If regex has 3 capture groups (prefix, secret, suffix)
      if (typeof args[2] === "string" && typeof args[3] === "string") {
        const prefix = args[1];
        const secret = args[2];
        const suffix = args[3];
        return `${prefix}[REDACTED_${secret.slice(0, 4)}...]${suffix}`;
      }
      // Single capture group or full token match
      if (typeof args[1] === "string") {
        const token = args[1];
        return `[REDACTED_${token.slice(0, 4)}...]`;
      }
      return "[REDACTED_SECRET]";
    });
  }
  return cleaned;
}

/**
 * Ensures path is within allowed boundaries if scope is enforced.
 * Defends against directory traversal attacks (e.g. `../../etc/passwd`)
 * and resolves filesystem symlinks via `realpathSync` to defeat jailbreak escapes.
 */
export function isPathSafe(filePath: string, allowedRoot?: string): boolean {
  if (!allowedRoot) return true;

  try {
    const resolvedTarget = path.resolve(filePath);
    const resolvedRoot = path.resolve(allowedRoot);

    // 1. Textual path boundary check
    const relative = path.relative(resolvedRoot, resolvedTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return false;
    }

    // 2. Filesystem inode realpath check (symlink escape defense)
    if (fs.existsSync(resolvedTarget)) {
      const realTarget = fs.realpathSync(resolvedTarget);
      const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Simple glob-to-regex converter for gitignore patterns
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`(?:^|/)${escaped}(?:/|$)`);
}

/**
 * Checks if a relative or absolute file path matches any .gitignore / .ignore pattern.
 */
export function matchesIgnorePattern(filePath: string, ignorePatterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of ignorePatterns) {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (normalized.endsWith(trimmed) || normalized.includes(`/${trimmed}/`)) {
      return true;
    }

    try {
      const re = globToRegExp(trimmed);
      if (re.test(normalized)) return true;
    } catch {
      // Ignore invalid regex
    }
  }
  return false;
}

/**
 * Loads ignore patterns from a directory if .gitignore or .ignore exists.
 */
export function loadIgnoreRules(dirPath: string): string[] {
  const patterns: string[] = ["node_modules", ".git", ".DS_Store", "target", "dist", "build"];
  for (const filename of [".gitignore", ".ignore"]) {
    const p = path.join(dirPath, filename);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        const lines = content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        patterns.push(...lines);
      } catch {
        // Fall back to default patterns
      }
    }
  }
  return patterns;
}
