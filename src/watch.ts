import * as fs from "node:fs";
import * as path from "node:path";
import type { UltraSearchClient } from "./client.ts";
import type { UltraSearchHit } from "./types.ts";
import { realpathOr } from "./roots.ts";

/**
 * Watch mode (issue #27): `ultrasearch watch "<query>" --in <dir>`.
 *
 * The daemon owns the filesystem journal (FSEvents) and the index; this module
 * does not duplicate it. It subscribes to the directory with `fs.watch` for a
 * cheap change signal, waits for the daemon's index to catch up (via `status`,
 * #19), then re-runs the query through the same socket every other tool uses
 * and streams only the diff. A file that already matched is never printed
 * twice; a deleted file is reported once.
 *
 * Shutdown is explicit: `stop()` clears the debounce timer, closes the
 * directory watcher, removes signal handlers and (when asked) closes the
 * daemon client, so a stopped session holds no watcher inode and no socket.
 */

export interface WatchEvent {
  type: "baseline" | "add" | "remove" | "ready" | "error";
  path?: string;
  root?: string;
  realPath?: string;
  kind?: string;
  score?: number;
  git?: string;
  staleMs?: number;
  entries?: number;
  /**
   * How the change was detected: the directory watcher (`watch`), the
   * silence watchdog's polling fallback (`poll`), or the initial query
   * (`baseline`). A `poll` event means `fs.watch` was silent past the window.
   */
  via?: "baseline" | "watch" | "poll";
  message?: string;
  at: number;
}

export interface WatcherLike {
  close(): void;
}

export interface WatchSessionOptions {
  query: string;
  /** Directory to watch and search. */
  dir: string;
  client: Pick<UltraSearchClient, "search" | "status" | "close">;
  limit?: number;
  /** Change-burst debounce (default 60 ms). */
  debounceMs?: number;
  /** How long to wait for `status().stale_ms` to clear before answering (default 750 ms). */
  settleTimeoutMs?: number;
  /** Stop automatically after this many ms (unref'd timer). */
  durationMs?: number;
  /** Emit the baseline and stop; used by `--once` and tests. */
  once?: boolean;
  /**
   * Silence watchdog period (default 1000 ms). When no `fs.watch` signal has
   * arrived for `watchSilenceMs`, the session polls the query instead, so a
   * watcher that never fires (FSEvents latency, a dropped watcher) cannot
   * leave watch mode permanently blind. Polling is bounded by
   * `watchSilenceMs`, so a healthy watcher never causes poll traffic.
   */
  pollIntervalMs?: number;
  /** How long `fs.watch` may be silent before the polling fallback runs (default 750 ms). */
  watchSilenceMs?: number;
  /**
   * Freshness probe run before a change/poll answer. Default: ask the daemon
   * `status` and wait for `stale_ms` to clear. Pass a function to inject the
   * probe, or `null` to skip it (tests, and callers that do not want the
   * extra round trip).
   */
  freshnessCheck?: (() => Promise<number | undefined>) | null;
  onEvent?: (event: WatchEvent) => void;
  /**
   * Injectable for tests; defaults to `fs.watch(dir, {recursive:true})` with
   * an error listener. `onError` keeps a watcher failure from becoming an
   * uncaught exception; the session stays alive on the polling fallback.
   */
  watcherFactory?: (dir: string, listener: (eventType: string, filename: string | null) => void, onError: (err: Error) => void) => WatcherLike;
  /** Close the client in `stop()` (the CLI owns the client, so it does this). */
  closeClientOnStop?: boolean;
  /** Attach SIGINT/SIGTERM handlers (default true; tests pass false). */
  installSignalHandlers?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface WatchSessionStats {
  baseline: number;
  added: number;
  removed: number;
  refreshes: number;
  errors: number;
  /** Refreshes triggered by the polling fallback (fs.watch was silent). */
  pollRefreshes: number;
  stopped: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WatchSession {
  private readonly options: WatchSessionOptions;
  private readonly now: () => number;
  private watcher: WatcherLike | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private starting = false;
  /** Armed once the baseline has run and watching should be live. */
  private armed = false;
  /** Last time `fs.watch` delivered a signal (or the watcher was armed). */
  private lastSignalAt = 0;
  private seen = new Map<string, UltraSearchHit>();
  private refreshing = false;
  private dirty = false;
  private stopResolvers: Array<(stats: WatchSessionStats) => void> = [];
  private readonly signalHandler = () => {
    this.stop();
  };
  private readonly stats: WatchSessionStats = { baseline: 0, added: 0, removed: 0, refreshes: 0, errors: 0, pollRefreshes: 0, stopped: false };

  constructor(options: WatchSessionOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  public getStats(): WatchSessionStats {
    return { ...this.stats };
  }

  private emit(event: Omit<WatchEvent, "at"> & { at?: number }): void {
    this.options.onEvent?.({ ...event, at: event.at ?? this.now() });
  }

  /** Baseline query, then arm the watcher (or stop immediately for `--once`). */
  public async start(): Promise<void> {
    if (this.starting || this.watcher || this.stopped) return;
    this.starting = true;
    try {
      await this.refresh("baseline");
      this.stats.baseline = this.seen.size;
      if (this.options.once || this.stopped) {
        this.stop();
        return;
      }
      const factory =
        this.options.watcherFactory ??
        ((dir, listener, onError) => {
          const watcher = fs.watch(dir, { recursive: true }, listener);
          // Without a listener an `error` event is an uncaught exception.
          watcher.on("error", onError);
          return watcher as unknown as WatcherLike;
        });
      try {
        this.watcher = factory(this.options.dir, () => this.scheduleRefresh(), (err) => this.onWatcherError(err));
      } catch (err: any) {
        this.stats.errors++;
        this.emit({ type: "error", message: `cannot watch ${this.options.dir}: ${err?.message ?? err}` });
        this.stop();
        return;
      }
      this.armed = true;
      this.lastSignalAt = this.now();
      this.startPollWatchdog();
      if (this.options.durationMs && this.options.durationMs > 0) {
        this.durationTimer = setTimeout(() => this.stop(), this.options.durationMs);
        this.durationTimer.unref?.();
      }
      if (this.options.installSignalHandlers !== false) {
        process.on("SIGINT", this.signalHandler);
        process.on("SIGTERM", this.signalHandler);
      }
      this.emit({ type: "ready", path: this.options.dir });
    } finally {
      this.starting = false;
    }
  }

  /** Resolves when the session stops. */
  public wait(): Promise<WatchSessionStats> {
    if (this.stopped) return Promise.resolve(this.getStats());
    return new Promise((resolve) => this.stopResolvers.push(resolve));
  }

  /** `start()` + `wait()`; the shape the CLI awaits. */
  public async run(): Promise<WatchSessionStats> {
    await this.start();
    return await this.wait();
  }

  /** Idempotent shutdown: no timer, no watcher, no signal handler, no socket. */
  public stop(): WatchSessionStats {
    if (this.stopped) return this.getStats();
    this.stopped = true;
    this.armed = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = null;
    this.drainTimer = null;
    this.durationTimer = null;
    this.pollTimer = null;
    try {
      this.watcher?.close();
    } catch {
      // An already-closed watcher is not an error.
    }
    this.watcher = null;
    if (this.options.installSignalHandlers !== false) {
      process.removeListener("SIGINT", this.signalHandler);
      process.removeListener("SIGTERM", this.signalHandler);
    }
    if (this.options.closeClientOnStop) {
      try {
        this.options.client.close();
      } catch {
        // Closing an already-closed client is not an error.
      }
    }
    this.stats.stopped = true;
    const resolvers = this.stopResolvers;
    this.stopResolvers = [];
    for (const resolve of resolvers) resolve(this.getStats());
    return this.getStats();
  }

  /**
   * The silence watchdog: when `fs.watch` has delivered nothing for
   * `watchSilenceMs`, poll the query instead. This is the durability net for
   * watchers that are late, coalesced away or dead — watch mode must degrade
   * to polling, never to silence. A healthy watcher keeps `lastSignalAt`
   * fresh, so this costs no daemon traffic.
   */
  private startPollWatchdog(): void {
    if (this.pollTimer) return;
    const interval = Math.max(10, this.options.pollIntervalMs ?? 1000);
    this.pollTimer = setInterval(() => {
      if (this.stopped || !this.armed) return;
      const now = this.now();
      if (now - this.lastSignalAt < (this.options.watchSilenceMs ?? 750)) return;
      this.lastSignalAt = now;
      void this.refresh("poll");
    }, interval);
  }

  /** A watcher failure is news, not the end: polling keeps the session alive. */
  private onWatcherError(err: Error): void {
    if (this.stopped) return;
    this.stats.errors++;
    this.emit({ type: "error", message: `directory watcher failed (polling continues): ${err?.message ?? err}` });
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = null;
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    this.lastSignalAt = this.now();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh("change");
    }, this.options.debounceMs ?? 60);
  }

  /**
   * Wait for the daemon to report a caught-up index (#19). A daemon that
   * cannot answer `status` (indexing, restarting) is not an error: the query
   * proceeds and the result's own `staleMs` note tells the truth. The probe
   * is injectable (`freshnessCheck`) or skippable (`null`) so tests and
   * callers that do not want the extra round trip can opt out.
   */
  private async waitForFreshness(): Promise<number | undefined> {
    if (this.options.freshnessCheck === null) return undefined;
    if (this.options.freshnessCheck) return await this.options.freshnessCheck();
    const timeout = this.options.settleTimeoutMs ?? 750;
    const started = this.now();
    for (;;) {
      let stale: number | undefined;
      try {
        const status = await this.options.client.status();
        stale = typeof status?.stale_ms === "number" ? status.stale_ms : undefined;
      } catch {
        return undefined;
      }
      if (!stale || stale <= 0) return stale ?? 0;
      if (this.stopped || this.now() - started >= timeout) return stale;
      await sleep(25);
    }
  }

  private async refresh(reason: "baseline" | "change" | "poll"): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.dirty = true;
      return;
    }
    this.refreshing = true;
    try {
      const via = reason === "change" ? "watch" : reason === "poll" ? "poll" : "baseline";
      const staleMs = reason === "baseline" ? undefined : await this.waitForFreshness();
      if (this.stopped) return;
      const res = await this.options.client.search(this.options.query, { in: this.options.dir, limit: this.options.limit ?? 30 });
      if (this.stopped) return;
      if (res.error && !res.hits) {
        this.stats.errors++;
        this.emit({ type: "error", message: res.error, staleMs, via });
        return;
      }
      const hits = res.hits ?? [];
      const next = new Map<string, UltraSearchHit>();
      for (const hit of hits) next.set(realpathOr(hit.path), hit);
      this.stats.refreshes++;
      if (reason === "poll") this.stats.pollRefreshes++;
      for (const [real, hit] of next) {
        if (!this.seen.has(real)) {
          if (reason !== "baseline") this.stats.added++;
          this.emit({
            type: reason === "baseline" ? "baseline" : "add",
            path: hit.path,
            realPath: real,
            root: this.options.dir,
            kind: hit.kind,
            score: hit.score,
            git: hit.git,
            staleMs,
            via,
          });
        }
      }
      if (reason !== "baseline") {
        for (const [real, hit] of this.seen) {
          if (!next.has(real)) {
            this.stats.removed++;
            this.emit({ type: "remove", path: hit.path, realPath: real, kind: hit.kind, staleMs, via });
          }
        }
      }
      this.seen = next;
    } catch (err: any) {
      this.stats.errors++;
      this.emit({ type: "error", message: String(err?.message ?? err) });
    } finally {
      this.refreshing = false;
      if (this.dirty && !this.stopped) {
        this.dirty = false;
        // A debounced watcher signal arrived during the refresh: it is a
        // `watch` change even though it shares this code path.
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          void this.refresh("change");
        }, 0);
      }
    }
  }
}

export interface WatchCliArgs {
  query: string;
  dir: string;
  limit: number;
  debounceMs: number;
  durationMs?: number;
  once: boolean;
  json: boolean;
}

const WATCH_USAGE = 'Usage: ultrasearch watch "<query>" --in <dir> [--limit n] [--debounce ms] [--duration ms] [--once] [--json]';

/** Parse `watch` argv (no `watch` command word). Throws with the usage text. */
export function parseWatchArgs(argv: string[], cwd = process.cwd()): WatchCliArgs {
  const positional: string[] = [];
  let dir = cwd;
  let limit = 30;
  let debounceMs = 60;
  let durationMs: number | undefined;
  let once = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = argv[i + 1];
    if (arg === "--in" && value) {
      dir = path.resolve(cwd, value);
      i++;
    } else if (arg.startsWith("--in=")) {
      dir = path.resolve(cwd, arg.slice("--in=".length));
    } else if (arg === "--limit" && value) {
      limit = Math.max(1, Number.parseInt(value, 10) || 30);
      i++;
    } else if (arg === "--debounce" && value) {
      debounceMs = Math.max(5, Number.parseInt(value, 10) || 60);
      i++;
    } else if (arg === "--duration" && value) {
      durationMs = Math.max(1, Number.parseInt(value, 10) || 0);
      i++;
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  const query = positional.join(" ").trim();
  if (!query) throw new Error(WATCH_USAGE);
  return { query, dir, limit, debounceMs, ...(durationMs !== undefined ? { durationMs } : {}), once, json };
}

function relative(dir: string, file: string): string {
  const rel = path.relative(realpathOr(dir), realpathOr(file));
  return rel.startsWith("..") ? file : rel;
}

/** One human-readable line per event; JSON mode is a single object per line. */
export function formatWatchEvent(event: WatchEvent, dir: string, json = false): string {
  if (json) return JSON.stringify(event);
  const tag = event.type === "add" || event.type === "baseline" ? "+" : event.type === "remove" ? "-" : "·";
  if (event.type === "ready") return `# watching ${event.path} (Ctrl-C to stop)`;
  if (event.type === "error") return `! ${event.message}`;
  const where = event.path ? relative(dir, event.path) : "";
  const meta = [
    event.kind,
    event.git ? `git:${event.git}` : "",
    typeof event.score === "number" ? `score ${event.score}` : "",
    event.staleMs ? `stale ${event.staleMs}ms` : "",
    event.via === "poll" ? "via poll" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${tag} ${where}${meta ? ` (${meta})` : ""}`;
}
