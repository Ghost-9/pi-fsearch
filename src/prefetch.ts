import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Prefetch on edit (issue #41).
 *
 * After an `edit`/`write` tool call, the first grep against that file can hit
 * a cold content segment. The extension's `tool_execution_end` hook calls
 * `touch(path)` here; the controller debounces (rapid saves collapse into one
 * request), caps the batch, and asks the daemon to warm the paths. The primary
 * request is the `prefetch` op; an engine that does not implement it yet
 * answers an error, so the controller falls back to a real content query for
 * one literal taken from each file — which is what forces the daemon to read
 * the file now. Either way the request is best-effort and never surfaces as a
 * tool error.
 *
 * Debounce is the load-bearing part: a formatter saving ten times in a second
 * must produce one warm-up, not ten (test: `prefetch: rapid edits coalesce`).
 */

/** The slice of the client the controller needs; a mock satisfies it. */
export interface PrefetchClient {
  prefetch?(paths: string[]): Promise<boolean>;
  grep?(pattern: string, options: Record<string, unknown>): Promise<unknown>;
}

export interface PrefetchWarmContext {
  /** The literal probed in fallback mode (one per file). */
  pattern: string;
  file: string;
}

export interface PrefetchOptions {
  client: PrefetchClient;
  /** Trailing debounce window in ms (default 150). */
  debounceMs?: number;
  /** Max paths warmed per flush (default 16). */
  maxBatch?: number;
  /** Max paths held while waiting for the timer (default 64). */
  maxPending?: number;
  /** Injectable warm implementation (tests and future engines). */
  warm?: (paths: string[]) => Promise<{ warmed: number; fallback: boolean; contexts?: PrefetchWarmContext[] }>;
}

export interface PrefetchStats {
  touched: number;
  coalesced: number;
  flushed: number;
  warmed: number;
  fallbackFlushes: number;
  failures: number;
  pending: number;
}

/** Extract the longest literal token from file text that the trigram index can serve. */
export function probeToken(text: string): string | null {
  const matches = text.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g);
  if (!matches || matches.length === 0) return null;
  return matches.reduce((best, token) => (token.length > best.length ? token : best));
}

function defaultWarm(client: PrefetchClient): (paths: string[]) => Promise<{ warmed: number; fallback: boolean; contexts?: PrefetchWarmContext[] }> {
  let prefetchUnsupported = false;
  return async (paths) => {
    if (!prefetchUnsupported && typeof client.prefetch === "function") {
      try {
        if (await client.prefetch(paths)) return { warmed: paths.length, fallback: false };
        prefetchUnsupported = true;
      } catch {
        prefetchUnsupported = true;
      }
    }
    if (typeof client.grep !== "function") return { warmed: 0, fallback: true };
    const contexts: PrefetchWarmContext[] = [];
    let warmed = 0;
    // Bounded: the probe is a nudge, not a second index build.
    for (const file of paths.slice(0, 4)) {
      try {
        const text = fs.readFileSync(file, "utf-8").slice(0, 64 * 1024);
        const token = probeToken(text);
        if (!token) continue;
        await client.grep(token, { in: path.dirname(file), mode: "literal", limit: 1, skipAudit: true, respectIgnore: false });
        contexts.push({ pattern: token, file });
        warmed++;
      } catch {
        // A file deleted between the edit hook and the probe is normal.
      }
    }
    return { warmed, fallback: true, contexts };
  };
}

export class PrefetchController {
  private readonly options: PrefetchOptions;
  private readonly warmFn: NonNullable<PrefetchOptions["warm"]>;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;
  private readonly counters = { touched: 0, coalesced: 0, flushed: 0, warmed: 0, fallbackFlushes: 0, failures: 0 };

  constructor(options: PrefetchOptions) {
    this.options = options;
    this.warmFn = options.warm ?? defaultWarm(options.client);
  }

  public getStats(): PrefetchStats {
    return { ...this.counters, pending: this.pending.size };
  }

  /** Record an edited file. Repeated touches inside the debounce window coalesce. */
  public touch(filePath: string): void {
    if (this.stopped || !filePath) return;
    const abs = path.resolve(filePath);
    this.counters.touched++;
    if (this.pending.has(abs)) {
      this.counters.coalesced++;
      return;
    }
    const cap = this.options.maxPending ?? 64;
    if (this.pending.size >= cap) {
      // Newest edits matter most: drop the oldest pending path.
      const oldest = this.pending.values().next().value as string | undefined;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.add(abs);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? 150);
    this.timer.unref?.();
  }

  /** Warm now: everything pending, capped, in one request per batch. */
  public async flush(): Promise<number> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.pending.size === 0) return 0;
    if (this.inflight) {
      await this.inflight;
      if (this.pending.size === 0) return 0;
    }
    const maxBatch = this.options.maxBatch ?? 16;
    const batch = [...this.pending].slice(0, maxBatch);
    for (const file of batch) this.pending.delete(file);
    const run = (async () => {
      try {
        const result = await this.warmFn(batch);
        this.counters.flushed++;
        this.counters.warmed += result.warmed;
        if (result.fallback) this.counters.fallbackFlushes++;
      } catch {
        this.counters.failures++;
      }
    })();
    this.inflight = run;
    await run;
    this.inflight = null;
    if (this.pending.size > 0 && !this.stopped) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.options.debounceMs ?? 150);
      this.timer.unref?.();
    }
    return batch.length;
  }

  /** Stop scheduling; pending paths are dropped (a stopped session warms nothing). */
  public stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
