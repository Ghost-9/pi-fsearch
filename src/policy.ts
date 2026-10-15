/**
 * Per-harness directive injection (issue #53, plan phase 3).
 *
 * Generates one short, marker-delimited block that tells an agent to use
 * UltraSearch before falling back to `grep -rn` / `find`, in the file the
 * chosen harness actually reads. Everything here is pure planning plus one
 * explicit write path: `planPolicy` never touches the filesystem, and
 * `applyPolicy` writes only when asked, after taking a timestamped backup.
 *
 * The measured "why" in the block comes from the verified wave-1 rows
 * (`bench/verification/wave1-summary.json`), not from a marketing number.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Marker framing the injected block. Both lines must appear, in order. */
export const POLICY_BEGIN = "<!-- ultrasearch-policy:begin -->";
export const POLICY_END = "<!-- ultrasearch-policy:end -->";

export type PolicyHarnessId = "pi" | "codex" | "claude-code" | "cursor" | "vscode" | "antigravity" | "generic";

export interface PolicyHarness {
  id: PolicyHarnessId;
  label: string;
  /** Target path, relative to the project root the operator passes. */
  file: string;
  /** YAML frontmatter prepended only when the file is created. */
  frontmatter?: string;
  /** Where a user-scope variant lives, printed for discoverability. */
  globalPath?: string;
}

/** The directive body. Identical for every harness so it reads the same. */
const DIRECTIVE_BODY = `## File search: use UltraSearch before \`grep -rn\` / \`find\`

This project is indexed by UltraSearch (a resident daemon with a path index and a trigram content
index). Prefer it over shell file search:

- **\`ultrasearch_query\`** (MCP) / **\`ultrasearch query <glob|name>\`** (CLI) — path search over
  the index, with globs, extension filters and \`git:modified\` filters. Measured ≈**9–29× faster
  than \`rg --files\` / \`find\`** on the verified wave-1 rows (0.45–0.77 ms vs 6.3–17.7 ms per call,
  \`bench/verification/wave1-summary.json\`): what you remove is the subprocess spawn and the disk
  walk, not the grep itself.
- **\`ultrasearch_grep\`** / **\`ultrasearch grep <pattern> --in <dir>\`** — trigram content search
  (literal, regex, symbol, semantic). Speed is context-dependent — fastest over an indexed scope,
  close to native on a cold or unindexed one — but it never pays a process spawn per call.
- **\`ultrasearch_multi_grep\`** / **\`ultrasearch multi-grep <p1> <p2>\`** — several patterns in one
  round trip; **\`ultrasearch_locate <filename>\`** for an exact filename; **\`ultrasearch_recent\`**
  for recently touched files.

Keep \`rg\`/\`find\` for what the index does not cover (outside the indexed roots, a daemon that is
down) and say so when you fall back.`;

/**
 * The harness → file table. Paths are project-relative because policy is a
 * per-repo choice; `globalPath` records the user-scope alternative the operator
 * can point the same block at.
 */
export const POLICY_HARNESSES: Readonly<Record<PolicyHarnessId, PolicyHarness>> = {
  pi: { id: "pi", label: "Pi Agent", file: "AGENTS.md", globalPath: "~/.pi/agent/AGENTS.md" },
  codex: { id: "codex", label: "Codex CLI", file: "AGENTS.md", globalPath: "~/.codex/AGENTS.md" },
  "claude-code": { id: "claude-code", label: "Claude Code", file: "CLAUDE.md", globalPath: "~/.claude/CLAUDE.md" },
  cursor: {
    id: "cursor",
    label: "Cursor",
    file: ".cursor/rules/ultrasearch.mdc",
    frontmatter: [
      "---",
      "description: Use UltraSearch for file and content search in this repo (indexed, faster than grep -rn/find).",
      "alwaysApply: true",
      "---",
      "",
    ].join("\n"),
  },
  vscode: {
    id: "vscode",
    label: "VS Code (Copilot)",
    file: ".github/instructions/ultrasearch.instructions.md",
    frontmatter: [
      "---",
      "name: 'UltraSearch'",
      "description: 'Use UltraSearch (indexed search) instead of grep -rn/find for file and content search.'",
      "applyTo: '**'",
      "---",
      "",
    ].join("\n"),
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    file: ".agents/rules/ultrasearch.md",
    frontmatter: [
      "---",
      "trigger: always_on",
      "description: 'Use UltraSearch (indexed search) instead of grep -rn/find for file and content search.'",
      "---",
      "",
    ].join("\n"),
    globalPath: "~/.gemini/AGENTS.md",
  },
  // CONTRIBUTING.md is where a human contributor (and their agent) reads the
  // house rules; the marker block keeps it removable.
  generic: { id: "generic", label: "Generic (CONTRIBUTING.md)", file: "CONTRIBUTING.md" },
};

export function policyHarnessIds(): PolicyHarnessId[] {
  return Object.keys(POLICY_HARNESSES) as PolicyHarnessId[];
}

export function isPolicyHarnessId(value: string): value is PolicyHarnessId {
  return Object.prototype.hasOwnProperty.call(POLICY_HARNESSES, value);
}

/** The directive body (no markers), as injected. */
export function policyDirective(harness: PolicyHarnessId = "generic"): string {
  return DIRECTIVE_BODY;
}

/** The marker-delimited block written into the target file. */
export function policyBlock(harness: PolicyHarnessId = "generic"): string {
  return `${POLICY_BEGIN}\n${policyDirective(harness)}\n${POLICY_END}\n`;
}

export class PolicyError extends Error {}

// ---------------------------------------------------------------------------
// Text surgery: frontmatter, marker location, insert/strip
// ---------------------------------------------------------------------------

export interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

/** Split a leading YAML frontmatter block from the body, preserving it verbatim. */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[0], body: text.slice(m[0].length) };
}

/** Byte span of a complete marker block, including the trailing newline. */
export function locatePolicyBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(POLICY_BEGIN);
  if (start === -1) {
    if (text.includes(POLICY_END)) throw new PolicyError(`found ${POLICY_END} without ${POLICY_BEGIN}`);
    return null;
  }
  const endMarker = text.indexOf(POLICY_END, start + POLICY_BEGIN.length);
  if (endMarker === -1) throw new PolicyError(`found ${POLICY_BEGIN} without ${POLICY_END}`);
  let end = endMarker + POLICY_END.length;
  if (text[end] === "\n") end++;
  return { start, end };
}

/**
 * Remove the block and the blank line that separated it, leaving one trailing
 * newline. Text before and after the block is preserved in order.
 */
export function stripPolicyBlock(text: string): string {
  const found = locatePolicyBlock(text);
  if (!found) return text;
  const before = text.slice(0, found.start).replace(/\n+$/, "");
  const after = text.slice(found.end).replace(/^\n+/, "\n");
  if (!before && !after) return "";
  const joined = before + (after.startsWith("\n") || !after ? after : `\n${after}`);
  return `${joined.replace(/\s+$/, "")}\n`;
}

/** Insert the block at the end of a non-empty body, separated by one blank line. */
export function insertPolicyBlock(body: string, block: string): string {
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) return block;
  return `${trimmed}\n\n${block}`;
}

/** Replace an existing block (or append one) in a body that may hold other text. */
export function patchBody(body: string, block: string): string {
  return insertPolicyBlock(stripPolicyBlock(body), block);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type PolicyAction = "create" | "update" | "unchanged" | "remove" | "remove-missing";

export interface PolicyPlan {
  harness: PolicyHarnessId;
  harnessLabel: string;
  relativePath: string;
  path: string;
  exists: boolean;
  action: PolicyAction;
  /** What the file will contain; empty when the file is deleted. */
  content: string;
  /** True when applying removes the file (it held only our block). */
  deleteFile: boolean;
  /** Unified-style diff from the current bytes; empty when nothing changes. */
  diff: string;
}

export interface PlanPolicyOptions {
  harness: PolicyHarnessId;
  /** Project root the harness-relative path is resolved against. */
  root: string;
  /** Strip the block instead of inserting it. */
  remove?: boolean;
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * A line diff with two lines of context. Enough for `--dry-run` to show
 * exactly what will change without pulling in a diff dependency.
 */
export function unifiedDiff(oldText: string, newText: string, label: string): string {
  if (oldText === newText) return "";
  const oldLines = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const newLines = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  const oldCount = oldLines.length - prefix - suffix;
  const newCount = newLines.length - prefix - suffix;
  const contextBefore = oldLines.slice(Math.max(0, prefix - 2), prefix).map((l) => ` ${l}`);
  const contextAfter = oldLines.slice(oldLines.length - suffix, oldLines.length - Math.max(0, suffix - 2)).map((l) => ` ${l}`);
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map((l) => `-${l}`);
  const added = newLines.slice(prefix, newLines.length - suffix).map((l) => `+${l}`);
  return [
    `--- ${oldText.length ? `a/${label}` : "/dev/null"}`,
    `+++ b/${label}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...contextBefore,
    ...removed,
    ...added,
    ...contextAfter,
    "",
  ].join("\n");
}

/**
 * Compute the target content and the diff without writing anything. Refuses a
 * file with a half-written marker pair rather than guessing where it ends.
 */
export function planPolicy(opts: PlanPolicyOptions): PolicyPlan {
  const harness = POLICY_HARNESSES[opts.harness];
  if (!harness) throw new PolicyError(`unknown harness: ${opts.harness}`);
  const target = path.resolve(opts.root, harness.file);
  const existing = readIfExists(target);
  const block = policyBlock(harness.id);
  const { frontmatter, body } = splitFrontmatter(existing ?? "");

  if (opts.remove) {
    const rebuiltBody = existing === null ? "" : stripPolicyBlock(body);
    let content = frontmatter + rebuiltBody;
    // A file that held only our block (and the frontmatter we added) goes away.
    const ourFrontmatterOnly = harness.frontmatter !== undefined && content.trim() === harness.frontmatter.trim();
    const deleteFile = existing !== null && (content.trim() === "" || ourFrontmatterOnly) && locatePolicyBlock(body) !== null;
    if (deleteFile) content = "";
    const changed = existing !== null && content !== existing;
    return {
      harness: harness.id,
      harnessLabel: harness.label,
      relativePath: harness.file,
      path: target,
      exists: existing !== null,
      action: existing === null ? "remove-missing" : changed ? "remove" : "unchanged",
      content,
      deleteFile,
      diff: changed ? unifiedDiff(existing, content, harness.file) : "",
    };
  }

  const newBody = patchBody(existing === null ? "" : body, block);
  const content = existing === null ? (harness.frontmatter ?? "") + newBody : frontmatter + newBody;
  if (existing === content) {
    return {
      harness: harness.id,
      harnessLabel: harness.label,
      relativePath: harness.file,
      path: target,
      exists: true,
      action: "unchanged",
      content,
      deleteFile: false,
      diff: "",
    };
  }
  return {
    harness: harness.id,
    harnessLabel: harness.label,
    relativePath: harness.file,
    path: target,
    exists: existing !== null,
    action: existing === null ? "create" : "update",
    content,
    deleteFile: false,
    diff: unifiedDiff(existing ?? "", content, harness.file),
  };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface ApplyPolicyOptions {
  /** Tests pin the backup timestamp; production uses the wall clock. */
  now?: Date;
}

function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** A non-colliding backup path next to the file: `<file>.bak-<YYYYMMDD-HHMMSS>`. */
export function backupPathFor(file: string, now: Date): string {
  const base = `${file}.bak-${stamp(now)}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export interface PolicyApplyResult extends PolicyPlan {
  wrote: boolean;
  /** Timestamped backup taken before an existing file was changed. */
  backup?: string;
}

/**
 * Execute a plan. Does nothing for `unchanged` / `remove-missing`, and backs
 * up an existing file before overwriting or deleting it.
 */
export function applyPolicy(plan: PolicyPlan, opts: ApplyPolicyOptions = {}): PolicyApplyResult {
  if (plan.action === "unchanged" || plan.action === "remove-missing") {
    return { ...plan, wrote: false };
  }
  const now = opts.now ?? new Date();
  fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  let backup: string | undefined;
  if (plan.exists) {
    backup = backupPathFor(plan.path, now);
    fs.copyFileSync(plan.path, backup);
  }
  if (plan.deleteFile) fs.rmSync(plan.path, { force: true });
  else fs.writeFileSync(plan.path, plan.content, "utf8");
  return { ...plan, wrote: true, ...(backup ? { backup } : {}) };
}
