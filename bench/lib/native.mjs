/**
 * Native baseline runners (rg / find) used by the A/B harness.
 * Async spawn only — the same spawner the client uses for fallback (issue #24),
 * so both arms pay comparable process costs and the event loop is never blocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnCapture } from "../../src/spawn.ts";

export function normalizePaths(paths) {
  const out = new Set();
  for (const p of paths) {
    if (!p) continue;
    let resolved = path.resolve(p);
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      // keep resolved
    }
    out.add(resolved);
  }
  return [...out].sort();
}

export function buildNativeCommand(spec, root) {
  switch (spec.kind) {
    case "find-name":
      return {
        bin: "find",
        args: [
          root,
          "(",
          "-name", ".*",
          "-o", "-name", "node_modules",
          "-o", "-name", "target",
          "-o", "-name", "dist",
          "-o", "-name", "build",
          ")",
          "-prune",
          "-o",
          "-iname", `*${spec.pattern}*`,
          "-print",
        ],
      };
    case "rg-files":
      return {
        bin: "rg",
        args: ["--files", "--glob", "!.git", "--glob", "!node_modules", "--iglob", `*${spec.glob ?? spec.pattern}*`, root],
      };
    case "rg-grep":
      return { bin: "rg", args: ["-n", "--no-heading", "--color", "never", "--glob", "!.git", "--glob", "!node_modules", spec.pattern, root] };
    default:
      throw new Error(`unknown native command kind '${spec.kind}'`);
  }
}

/**
 * Runs a native baseline and returns normalized output plus wall time.
 * For grep, `files` is the set of matching file paths.
 */
export async function runNative(spec, root, options = {}) {
  const { bin, args } = buildNativeCommand(spec, root);
  const started = performance.now();
  const result = await spawnCapture(bin, args, { timeoutMs: options.timeoutMs ?? 30000, maxBuffer: 64 * 1024 * 1024 });
  const ms = performance.now() - started;
  const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

  let paths;
  if (spec.kind === "rg-grep") {
    paths = normalizePaths(lines.map((l) => l.split(":")[0]));
  } else {
    paths = normalizePaths(lines);
  }

  if (result.notFound) {
    return { ok: false, bin, args, ms, paths: [], stdoutBytes: result.stdout.length, notFound: true, error: `${bin} not installed` };
  }
  // rg/find exit 1 for "no matches"; that is a valid empty result set.
  const acceptable = result.code === 0 || result.code === 1;
  return {
    ok: acceptable && !result.cancelled,
    bin,
    args,
    ms,
    paths,
    stdoutBytes: result.stdout.length,
    timedOut: result.timedOut,
    truncated: result.truncated,
    code: result.code,
    error: acceptable ? undefined : result.stderr || `exit ${result.code}`,
  };
}

/**
 * Output equivalence: the index result set must not invent paths, and may only
 * miss paths within the documented tolerance.
 */
export function compareSets(indexPaths, nativePaths, tolerance = {}) {
  const nativeOnlyTolerance = tolerance.nativeOnly ?? 0;
  const indexOnlyTolerance = tolerance.indexOnly ?? 0;
  const index = new Set(indexPaths);
  const native = new Set(nativePaths);
  const indexOnly = [...index].filter((p) => !native.has(p));
  const nativeOnly = [...native].filter((p) => !index.has(p));
  const union = new Set([...index, ...native]);
  const missRate = native.size === 0 ? 0 : nativeOnly.length / native.size;
  const extraRate = index.size === 0 ? 0 : indexOnly.length / index.size;
  const pass = extraRate <= indexOnlyTolerance && missRate <= nativeOnlyTolerance;
  return {
    pass,
    indexCount: index.size,
    nativeCount: native.size,
    indexOnly: indexOnly.slice(0, 10),
    nativeOnly: nativeOnly.slice(0, 10),
    indexOnlyCount: indexOnly.length,
    nativeOnlyCount: nativeOnly.length,
    missRate,
    extraRate,
    jaccard: union.size === 0 ? 1 : [...index].filter((p) => native.has(p)).length / union.size,
    tolerance,
  };
}
