import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UltraSearchGrepFile, UltraSearchHit } from "./types.ts";

/**
 * Multi-root workspaces and worktree dedupe (issue #28).
 *
 * The Pi extension and the daemon are single-root by design: one client, one
 * active worktree. Stacked worktrees and monorepos need more than that, so a
 * caller can configure extra roots; searches fan out over them and the merge
 * step deduplicates by **realpath** (a linked worktree is a symlink to the
 * same inode, so string paths differ while the file is one) and attributes
 * every surviving hit to the root it came from. When the same file exists
 * under several roots the copy under the active worktree wins.
 *
 * Configuration (see README):
 *   ULTRASEARCH_ROOTS            path-delimiter-separated extra roots
 *   ULTRASEARCH_ROOTS_FILE       config file path
 *   ~/.config/ultrasearch/roots.json  { "roots": [...], "preferActiveWorktree": true }
 *
 * With no configuration this module is inert: callers see the active root
 * alone and no extra daemon round trips happen.
 */

export const ROOTS_ENV = "ULTRASEARCH_ROOTS";
export const ROOTS_FILE_ENV = "ULTRASEARCH_ROOTS_FILE";

export interface RootConfig {
  /** Extra roots (absolute, deduplicated by realpath). */
  roots: string[];
  /** Keep the active worktree's copy when two roots resolve to the same file. */
  preferActiveWorktree: boolean;
  /** Where the configuration came from, for diagnostics. */
  source: "env" | "file" | "none";
}

export function defaultRootsConfigPath(home = os.homedir()): string {
  return path.join(home, ".config", "ultrasearch", "roots.json");
}

/** Parse a config file's JSON body; returns null when it is unusable. */
export function parseRootsConfig(raw: string): { roots?: string[]; preferActiveWorktree?: boolean } | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    let roots: string[] | undefined;
    if (parsed.roots !== undefined) {
      if (!Array.isArray(parsed.roots)) return null;
      const filtered: string[] = parsed.roots.filter((r: unknown): r is string => typeof r === "string" && r.trim().length > 0);
      if (filtered.length !== parsed.roots.length) return null;
      roots = filtered;
    }
    const prefer = typeof parsed.preferActiveWorktree === "boolean" ? parsed.preferActiveWorktree : undefined;
    return { ...(roots ? { roots } : {}), ...(prefer !== undefined ? { preferActiveWorktree: prefer } : {}) };
  } catch {
    return null;
  }
}

export function loadRootConfig(options: { env?: NodeJS.ProcessEnv; configPath?: string } = {}): RootConfig {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env[ROOTS_FILE_ENV] ?? defaultRootsConfigPath();
  const fromEnv = (env[ROOTS_ENV] ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) {
    return { roots: normalizeRoots(fromEnv), preferActiveWorktree: true, source: "env" };
  }
  try {
    const parsed = parseRootsConfig(fs.readFileSync(configPath, "utf-8"));
    if (parsed && parsed.roots && parsed.roots.length > 0) {
      return {
        roots: normalizeRoots(parsed.roots),
        preferActiveWorktree: parsed.preferActiveWorktree ?? true,
        source: "file",
      };
    }
  } catch {
    // No file, unreadable file, or invalid JSON: single-root behaviour.
  }
  return { roots: [], preferActiveWorktree: true, source: "none" };
}

/** Resolve symlinks; fall back to the lexical path when the target is gone. */
export function realpathOr(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

/** Realpath-normalize, dedupe and drop a root that only duplicates another. */
export function normalizeRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const real = realpathOr(path.resolve(root));
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/** Nearest ancestor (or self) holding a `.git` entry — the same rule as `resolveWorktreeRoot`. */
export function findGitRoot(startDir = process.cwd()): string | null {
  let curr = path.resolve(startDir);
  while (curr && curr !== path.dirname(curr)) {
    try {
      if (fs.existsSync(path.join(curr, ".git"))) return curr;
    } catch {
      // keep walking
    }
    curr = path.dirname(curr);
  }
  return null;
}

/** The scope list a multi-root search runs over: active worktree first. */
export function rootScope(activeRoot: string, config: RootConfig): string[] {
  const active = realpathOr(path.resolve(activeRoot));
  const extra = normalizeRoots(config.roots).filter((r) => r !== active);
  return [active, ...extra];
}

/** Which configured root contains `realPath` (longest match wins). */
export function attributeRoot(realPath: string, roots: string[], activeRoot: string): { root: string; active: boolean } {
  const activeReal = realpathOr(path.resolve(activeRoot));
  const isUnder = (root: string) => realPath === root || realPath.startsWith(root + path.sep);
  if (isUnder(activeReal)) return { root: activeReal, active: true };
  let best: string | null = null;
  for (const root of roots) {
    if (isUnder(root) && (best === null || root.length > best.length)) best = root;
  }
  return { root: best ?? activeReal, active: false };
}

export interface AttributedHit extends UltraSearchHit {
  /** Root the file was attributed to (realpath). */
  root: string;
  /** Realpath of the hit; the dedupe key. */
  realPath: string;
  /** True when the hit lies under the active worktree. */
  active: boolean;
  /** When dropped as a duplicate, the realpath that won instead. */
  duplicateOf?: string;
}

export interface DedupeResult<H> {
  hits: H[];
  duplicates: number;
}

/**
 * Deduplicate hits by realpath, keeping the active worktree's copy when set.
 * Order is preserved otherwise (the daemon owns ranking).
 */
export function dedupeHits(
  hits: UltraSearchHit[],
  options: { activeRoot: string; roots?: string[]; preferActiveWorktree?: boolean }
): DedupeResult<AttributedHit> {
  const roots = options.roots ?? [];
  const prefer = options.preferActiveWorktree ?? true;
  const byReal = new Map<string, AttributedHit>();
  let duplicates = 0;
  for (const hit of hits) {
    const realPath = realpathOr(hit.path);
    const { root, active } = attributeRoot(realPath, roots, options.activeRoot);
    const candidate: AttributedHit = { ...hit, root, realPath, active };
    const existing = byReal.get(realPath);
    if (!existing) {
      byReal.set(realPath, candidate);
      continue;
    }
    duplicates++;
    if (prefer && candidate.active && !existing.active) byReal.set(realPath, candidate);
  }
  return { hits: [...byReal.values()], duplicates };
}

export interface AttributedGrepFile extends UltraSearchGrepFile {
  root: string;
  realPath: string;
  active: boolean;
}

/** Deduplicate grep files by realpath, keeping the active worktree's copy. */
export function dedupeGrepFiles(
  files: UltraSearchGrepFile[],
  options: { activeRoot: string; roots?: string[]; preferActiveWorktree?: boolean }
): { files: AttributedGrepFile[]; duplicates: number } {
  const roots = options.roots ?? [];
  const prefer = options.preferActiveWorktree ?? true;
  const byReal = new Map<string, AttributedGrepFile>();
  let duplicates = 0;
  for (const file of files) {
    const realPath = realpathOr(file.path);
    const { root, active } = attributeRoot(realPath, roots, options.activeRoot);
    const candidate: AttributedGrepFile = { ...file, root, realPath, active };
    const existing = byReal.get(realPath);
    if (!existing) {
      byReal.set(realPath, candidate);
      continue;
    }
    duplicates++;
    if (prefer && candidate.active && !existing.active) byReal.set(realPath, candidate);
  }
  return { files: [...byReal.values()], duplicates };
}

export interface MultiRootSearchOptions {
  activeRoot: string;
  roots?: string[];
  preferActiveWorktree?: boolean;
  limit?: number;
  search: (query: string, scope: string) => Promise<{ hits?: UltraSearchHit[]; error?: string }>;
}

export interface MultiRootSearchResult {
  hits: AttributedHit[];
  roots: string[];
  duplicates: number;
  errors: Array<{ root: string; error: string }>;
  /** True when more than one root was actually queried. */
  multi: boolean;
}

/**
 * Fan a search out over every configured root and merge. One root (the
 * default, unconfigured case) short-circuits to a single round trip.
 */
export async function multiRootSearch(query: string, options: MultiRootSearchOptions): Promise<MultiRootSearchResult> {
  const config: RootConfig = { roots: options.roots ?? [], preferActiveWorktree: options.preferActiveWorktree ?? true, source: "none" };
  const roots = rootScope(options.activeRoot, config);
  if (roots.length === 1) {
    const res = await options.search(query, roots[0]);
    const { hits, duplicates } = dedupeHits(res.hits ?? [], { activeRoot: options.activeRoot, roots: [], preferActiveWorktree: true });
    return { hits, roots, duplicates, errors: res.error ? [{ root: roots[0], error: res.error }] : [], multi: false };
  }
  const responses = await Promise.all(
    roots.map(async (root) => {
      try {
        return { root, res: await options.search(query, root) };
      } catch (err: any) {
        return { root, res: { hits: [], error: String(err?.message ?? err) } };
      }
    })
  );
  const all: UltraSearchHit[] = [];
  const errors: Array<{ root: string; error: string }> = [];
  for (const { root, res } of responses) {
    if (res.error) errors.push({ root, error: res.error });
    all.push(...(res.hits ?? []));
  }
  const { hits, duplicates } = dedupeHits(all, {
    activeRoot: options.activeRoot,
    roots,
    preferActiveWorktree: options.preferActiveWorktree ?? true,
  });
  return { hits, roots, duplicates, errors, multi: true };
}

export interface MultiRootGrepOptions {
  activeRoot: string;
  roots?: string[];
  preferActiveWorktree?: boolean;
  grep: (pattern: string, scope: string) => Promise<{ files?: UltraSearchGrepFile[]; error?: string }>;
}

export interface MultiRootGrepResult {
  files: AttributedGrepFile[];
  roots: string[];
  duplicates: number;
  errors: Array<{ root: string; error: string }>;
  multi: boolean;
}

/** Fan a grep out over every configured root and merge (realpath dedupe). */
export async function multiRootGrep(pattern: string, options: MultiRootGrepOptions): Promise<MultiRootGrepResult> {
  const config: RootConfig = { roots: options.roots ?? [], preferActiveWorktree: options.preferActiveWorktree ?? true, source: "none" };
  const roots = rootScope(options.activeRoot, config);
  if (roots.length === 1) {
    const res = await options.grep(pattern, roots[0]);
    const { files, duplicates } = dedupeGrepFiles(res.files ?? [], { activeRoot: options.activeRoot, roots: [], preferActiveWorktree: true });
    return { files, roots, duplicates, errors: res.error ? [{ root: roots[0], error: res.error }] : [], multi: false };
  }
  const responses = await Promise.all(
    roots.map(async (root) => {
      try {
        return { root, res: await options.grep(pattern, root) };
      } catch (err: any) {
        return { root, res: { files: [], error: String(err?.message ?? err) } };
      }
    })
  );
  const all: UltraSearchGrepFile[] = [];
  const errors: Array<{ root: string; error: string }> = [];
  for (const { root, res } of responses) {
    if (res.error) errors.push({ root, error: res.error });
    all.push(...(res.files ?? []));
  }
  const { files, duplicates } = dedupeGrepFiles(all, {
    activeRoot: options.activeRoot,
    roots,
    preferActiveWorktree: options.preferActiveWorktree ?? true,
  });
  return { files, roots, duplicates, errors, multi: true };
}
