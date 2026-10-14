import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

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
  // RSA, EC, OpenSSH, PGP private keys, body included.
  //
  // The body is `[\s\S]*?` (any character, including newlines, lazily).
  // It used to be written `[[\s\S]*?` — a malformed character class that
  // happened to match the same characters, but which was never *intended* to.
  // The real defect it hid: this pattern needs the whole block, while grep
  // output is scrubbed line by line, where it can never match. See
  // `SecretGuard` for that path.
  /(-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----)/g,
  // An armour line alone: a grep can return the header (or the footer)
  // without the other half of the block. Marking it is cheap and makes the
  // presence of key material visible instead of looking like a normal line.
  /(-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----)/g,
  /(-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----)/g,
  // A bare PEM body line: the whole line is base64 with no whitespace, long
  // enough that it is a key fragment or a blob, and not a hex digest. A git
  // SHA, checksum or hex id is deliberately *not* matched (it is not key
  // material, and redacting it would corrupt ordinary output).
  /^(?![0-9a-f]{2,}$)[A-Za-z0-9+/=]{64,}$/gm,
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
 * A line from a file: the PEM-body test above, but for a single line that may
 * have surrounding whitespace.
 */
export function looksLikePemBody(line: string): boolean {
  const t = line.trim();
  if (t.length < 64) return false;
  // A hex digest (git SHA, checksum, id) is not key material.
  if (/^[0-9a-f]+$/.test(t)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(t);
}

/**
 * Scrubber for line-oriented output (grep matches, context lines, listings).
 *
 * `scrubSecrets` needs a whole text to redact a private-key block; grep gives
 * one line at a time, so a key body could never match and every body line was
 * emitted verbatim. The guard closes that: it tracks whether the lines it is
 * fed are inside a PEM block and redacts them until the footer, with a bounded
 * budget so a stray `BEGIN` in unrelated output cannot blank a whole result.
 *
 * One guard per file (or per logical unit of output): the state is positional.
 */
export class SecretGuard {
  private inPem = false;
  private budget = 0;

  /** Redact one line, in order. */
  line(text: string): string {
    const trimmed = text.trim();
    const hasEnd = /-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----/.test(trimmed);
    if (this.inPem) {
      // Inside a block every line is key material until the footer. The
      // footer itself goes through the pattern scrubber so the marker still
      // reads as a key; the body is replaced wholesale.
      const out = scrubSecrets(text);
      this.budget--;
      if (hasEnd || this.budget <= 0) {
        this.inPem = false;
        this.budget = 0;
      }
      return hasEnd ? out : "[REDACTED_PRIVATE_KEY_BODY]";
    }
    const hasBegin = /-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----/.test(trimmed);
    if (hasBegin && !hasEnd) {
      this.inPem = true;
      // 200 lines: a real PEM body is ~25-60 lines at 64 columns.
      this.budget = 200;
    }
    const out = scrubSecrets(text);
    if (out !== text) return out;
    return looksLikePemBody(trimmed) ? "[REDACTED_PRIVATE_KEY_BODY]" : text;
  }

  /** True while this guard believes it is inside a PEM block. */
  get insidePrivateKey(): boolean {
    return this.inPem;
  }
}

/**
 * The `in:` scopes a query string carries. The daemon's query language has its
 * own `in:<path>` filter, so a query is a second way to name a search scope —
 * one that a check applied only to the tool's parameters would miss.
 */
export function queryScopes(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/(?:^|\s)in:(\S+)/g)) {
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v.startsWith("~") || v.startsWith("/")) out.push(v);
  }
  // `in:"/a b"` and other quoted forms the token regex cannot split.
  for (const m of query.matchAll(/(?:^|\s)in:(["'])(.*?)\1/g)) {
    if (m[2].startsWith("~") || m[2].startsWith("/")) out.push(m[2]);
  }
  return [...new Set(out)];
}

/**
 * The first `in:` scope of `query` that escapes `allowedRoot`, or null.
 *
 * The client checks this before dispatch so the agent gets an actionable
 * error; the daemon enforces the same boundary again on the way out (a caller
 * bug must not widen a search). `~` is resolved against `home`.
 */
export function unsafeQueryScope(query: string, allowedRoot: string, home: string = os.homedir()): string | null {
  for (const scope of queryScopes(query)) {
    const abs = scope.startsWith("~") ? path.join(home, scope.slice(1)) : scope;
    if (!isPathSafe(abs, allowedRoot)) return scope;
  }
  return null;
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
 * Simple glob-to-regex converter for gitignore patterns.
 * `**` is replaced through a placeholder so the later `*` pass cannot mangle it.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(?:^|/)${escaped}(?:/|$)`);
}

function matchesIgnorePatternSingle(normalized: string, pattern: string): boolean {
  // Directory patterns (`node_modules/`, `build/`, `dist/`) ignore the directory
  // and everything beneath it. Verifier finding F1: the old matcher only handled
  // suffix/segment text, so `node_modules/` never matched `.../node_modules/pkg.js`.
  if (pattern.endsWith("/")) {
    const dir = pattern.replace(/\/+$/, "").replace(/^\/+/, "");
    if (!dir) return false;
    const pathSegs = normalized.split("/").filter(Boolean);
    const dirSegs = pathSegs.slice(0, -1);
    if (!dir.includes("/")) {
      if (dirSegs.includes(dir)) return true;
      return pathSegs.length > 0 && pathSegs[pathSegs.length - 1] === dir;
    }
    try {
      if (globToRegExp(dir).test(normalized)) return true;
    } catch {
      // invalid pattern falls through to the textual checks
    }
    return normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`);
  }

  if (normalized.endsWith(pattern) || normalized.includes(`/${pattern}/`)) return true;

  try {
    const re = globToRegExp(pattern);
    if (re.test(normalized)) return true;
  } catch {
    // Ignore invalid regex
  }
  return false;
}

/**
 * Gitignore-style ordered evaluation: the last matching rule wins and `!pattern`
 * re-includes a path. Returns true when the path is ignored.
 */
export function matchesIgnoreRules(filePath: string, ignorePatterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  let ignored = false;
  for (const raw of ignorePatterns) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    const pattern = negated ? trimmed.slice(1).trim() : trimmed;
    if (!pattern) continue;
    if (matchesIgnorePatternSingle(normalized, pattern)) ignored = !negated;
  }
  return ignored;
}

/**
 * Checks if a relative or absolute file path matches any .gitignore / .ignore pattern.
 * Backwards-compatible wrapper over the ordered rule evaluation.
 */
export function matchesIgnorePattern(filePath: string, ignorePatterns: string[]): boolean {
  return matchesIgnoreRules(filePath, ignorePatterns);
}

/**
 * Loads ignore patterns from a directory if .gitignore or .ignore exists.
 * Built-in defaults can be disabled with { includeDefaults: false } so callers
 * only honour rules the user actually declared in the workspace.
 */
export function loadIgnoreRules(dirPath: string, options: { includeDefaults?: boolean } = {}): string[] {
  const includeDefaults = options.includeDefaults !== false;
  const patterns: string[] = includeDefaults
    ? ["node_modules", ".git", ".DS_Store", "target", "dist", "build"]
    : [];
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
