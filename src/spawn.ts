import { spawn, type ChildProcess } from "node:child_process";

/**
 * Async child-process execution with timeout, cancellation and output capping.
 *
 * Replaces `execFileSync` in the native-fallback request path (issue #24):
 * a synchronous spawn blocks the extension event loop for the whole kernel
 * search, which is exactly the ~29% of real calls the audit measured.
 */

export interface SpawnCaptureResult {
  /** True when the process ran to completion with exit code 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The timeout fired and the child was killed. */
  timedOut: boolean;
  /** The caller-provided AbortSignal fired and the child was killed. */
  cancelled: boolean;
  /** Output exceeded maxBuffer and was cut off. */
  truncated: boolean;
  /** The executable does not exist (ENOENT) — callers use this to try a different binary. */
  notFound: boolean;
  ms: number;
  error?: string;
}

export interface SpawnCaptureOptions {
  cwd?: string;
  /** Wall-clock limit for the child. Default 4000 ms. */
  timeoutMs?: number;
  /** stdout+stderr byte cap before killing the child. Default 32 MiB. */
  maxBuffer?: number;
  /** Cancellation, e.g. an aborted agent turn. */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

const activeChildren = new Set<ChildProcess>();

/** Number of child processes currently owned by this module (leak check). */
export function activeChildCount(): number {
  return activeChildren.size;
}

/** Kill every tracked child process. Used by client shutdown paths. */
export function killAllChildren(): void {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  activeChildren.clear();
}

export async function spawnCapture(
  command: string,
  args: string[],
  options: SpawnCaptureOptions = {}
): Promise<SpawnCaptureResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? 4000;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;

  if (options.signal?.aborted) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      truncated: false,
      notFound: false,
      ms: Math.round((performance.now() - started) * 100) / 100,
      error: "cancelled before spawn",
    };
  }

  return await new Promise<SpawnCaptureResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        truncated: false,
        notFound: err?.code === "ENOENT",
        ms: Math.round((performance.now() - started) * 100) / 100,
        error: err?.message ?? String(err),
      });
      return;
    }

    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let notFound = false;
    let spawnError: string | undefined;

    const killTree = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      // Escalate if SIGTERM is ignored; unref'd so it never holds the loop open.
      const hardKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 250);
      hardKill.unref?.();
    };

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs) : null;

    const onAbort = () => {
      cancelled = true;
      killTree();
    };
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      resolve({
        ok: !timedOut && !cancelled && !notFound && !spawnError && code === 0,
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        cancelled,
        truncated,
        notFound,
        ms: Math.round((performance.now() - started) * 100) / 100,
        error: spawnError ?? (timedOut ? `timed out after ${timeoutMs}ms` : cancelled ? "cancelled" : undefined),
      });
    };

    const append = (chunk: Buffer, which: "out" | "err") => {
      const bytes = chunk.length;
      if (outBytes + bytes > maxBuffer) {
        truncated = true;
        killTree();
        return;
      }
      outBytes += bytes;
      const text = chunk.toString("utf-8");
      if (which === "out") stdout += text;
      else stderr += text;
    };

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "err"));
    child.on("error", (err: any) => {
      if (err?.code === "ENOENT") notFound = true;
      spawnError = err?.message ?? String(err);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
