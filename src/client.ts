import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as child_process from "node:child_process";
import type {
  UltraSearchSearchResponse,
  UltraSearchGrepResponse,
  UltraSearchMultiGrepResponse,
  UltraSearchStatusResponse,
  UltraSearchHit,
  UltraSearchGrepFile,
  SearchResultMeta,
  SearchOptions,
  GrepOptions,
} from "./types.ts";
import { recordAudit } from "./telemetry.ts";
import { loadIgnoreRules, matchesIgnorePattern } from "./sanitize.ts";
import { killAllChildren, spawnCapture } from "./spawn.ts";
import { validateRegexPattern } from "./validate.ts";

export function resolveDefaultSocketPath(): string {
  if (process.env.PI_ULTRASEARCH_SOCKET) return process.env.PI_ULTRASEARCH_SOCKET;
  const home = os.homedir();
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\ultrasearch";
  }
  if (process.platform === "linux") {
    if (process.env.XDG_RUNTIME_DIR) {
      return path.join(process.env.XDG_RUNTIME_DIR, "ultrasearch.sock");
    }
    return path.join(home, ".local/share/ultrasearch/ultrasearch.sock");
  }
  return path.join(home, "Library/Application Support/UltraSearch/ultrasearch.sock");
}

export interface UltraSearchClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxReconnectRetries?: number;
  enableFallback?: boolean;
  /** Connection lanes (2–4 recommended). 1 keeps the legacy single-socket path. */
  lanes?: number;
  /** Wall-clock budget for native fallback subprocesses. Default 4000 ms. */
  fallbackTimeoutMs?: number;
  /** Grace added to the server budget before the client-side deadline fires. Default 400 ms. */
  deadlineSlackMs?: number;
  /** Upper bound on over-fetching for filter-then-limit ordering. Default 500. */
  maxOverscan?: number;
  /** Attempt to launch the daemon binary when the socket is unreachable. Default true. */
  autoSpawnDaemon?: boolean;
}

export interface RequestOptions {
  /** Per-request deadline in milliseconds (overrides the client default timeout). */
  deadlineMs?: number;
}

export interface LaneStats {
  lanes: number;
  open: number;
  inFlight: number;
  created: number;
  closed: number;
  activeFallbacks: number;
  fallbackEnabled: boolean;
}

/** Raised when a request exceeds its deadline (client timeout or `budget_ms` + slack). */
export class RequestDeadlineError extends Error {
  readonly timedOut = true;
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`UltraSearch request exceeded deadline of ${deadlineMs}ms`);
    this.name = "RequestDeadlineError";
    this.deadlineMs = deadlineMs;
  }
}

interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Lane {
  id: number;
  socket: net.Socket | null;
  rl: readline.Interface | null;
  connecting: Promise<net.Socket> | null;
  inflight: number;
  pending: Map<number | string, PendingRequest>;
  opened: number;
  closed: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RECONNECT_RETRIES = 3;
const DEFAULT_LANES = 3;
const MAX_LANES = 8;
const DEFAULT_FALLBACK_TIMEOUT_MS = 4000;
const DEFAULT_DEADLINE_SLACK_MS = 400;
const DEFAULT_MAX_OVERSCAN = 500;
const DEFAULT_GREP_BUDGET_MS = 2500;
const DEFAULT_MULTI_GREP_BUDGET_MS = 3000;
const IGNORE_TTL_MS = 60_000;

/**
 * Extracts plain words that must be strictly matched in exact mode.
 */
export function extractExactWords(query: string): string[] {
  let cleanQuery = query.trim();
  if (
    (cleanQuery.startsWith('"') && cleanQuery.endsWith('"')) ||
    (cleanQuery.startsWith("'") && cleanQuery.endsWith("'"))
  ) {
    cleanQuery = cleanQuery.slice(1, -1).trim();
  }
  return cleanQuery
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => !tok.includes(":") && !tok.startsWith("!") && !tok.includes("*") && !tok.includes("?"))
    .map((tok) => {
      let t = tok;
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1);
      }
      return t.replace(/^['^]/, "").replace(/\$$/, "").toLowerCase();
    })
    .filter(Boolean);
}

/**
 * Transforms plain words in query into exact match mode (prefixing ''),
 * ensuring ZERO typo tolerance and strict deterministic token matching.
 */
export function enforceExactQuery(query: string): string {
  let cleanQuery = query.trim();
  if (
    (cleanQuery.startsWith('"') && cleanQuery.endsWith('"')) ||
    (cleanQuery.startsWith("'") && cleanQuery.endsWith("'"))
  ) {
    cleanQuery = cleanQuery.slice(1, -1).trim();
  }
  const tokens = cleanQuery.split(/\s+/).filter(Boolean);
  const transformed = tokens.map((tok) => {
    let t = tok;
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      t = t.slice(1, -1);
    }
    if (
      t.includes(":") ||
      t.startsWith("'") ||
      t.startsWith("!") ||
      t.startsWith("^") ||
      t.endsWith("$") ||
      t.includes("*") ||
      t.includes("?")
    ) {
      return t;
    }
    return `'${t}`;
  });
  return transformed.join(" ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class UltraSearchClient {
  private socketPath: string;
  private timeoutMs: number;
  private maxReconnectRetries: number;
  private enableFallback: boolean;
  private maxLanes: number;
  private fallbackTimeoutMs: number;
  private deadlineSlackMs: number;
  private maxOverscan: number;
  private nextId = 1;
  private lanes: Lane[] = [];
  private rrIndex = 0;
  private spawnAttempted = false;
  private autoSpawnDaemon: boolean;
  private activeFallbacks = new Set<AbortController>();

  constructor(options: UltraSearchClientOptions = {}) {
    this.socketPath = options.socketPath ?? resolveDefaultSocketPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReconnectRetries = options.maxReconnectRetries ?? DEFAULT_MAX_RECONNECT_RETRIES;
    this.enableFallback = options.enableFallback ?? true;
    this.maxLanes = Math.max(1, Math.min(MAX_LANES, Math.floor(options.lanes ?? DEFAULT_LANES)));
    this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
    this.deadlineSlackMs = options.deadlineSlackMs ?? DEFAULT_DEADLINE_SLACK_MS;
    this.maxOverscan = options.maxOverscan ?? DEFAULT_MAX_OVERSCAN;
    this.autoSpawnDaemon = options.autoSpawnDaemon ?? true;
    for (let i = 0; i < this.maxLanes; i++) this.lanes.push(this.createLane(i));
  }

  private createLane(id: number): Lane {
    return { id, socket: null, rl: null, connecting: null, inflight: 0, pending: new Map(), opened: 0, closed: 0 };
  }

  private isLaneLive(lane: Lane): boolean {
    const s = lane.socket;
    return Boolean(s && !s.destroyed && !s.connecting && s.writable);
  }

  private ignoreCache = new Map<string, { rules: string[]; ts: number }>();
  private realScopeCache = new Map<string, { root: string; ts: number }>();

  /** Cached per-scope .gitignore/.ignore evaluation (declared rules only). */
  private getIgnoreRules(dir: string): string[] {
    const cached = this.ignoreCache.get(dir);
    const now = Date.now();
    if (cached && now - cached.ts < IGNORE_TTL_MS) return cached.rules;
    const rules = loadIgnoreRules(dir, { includeDefaults: false });
    this.ignoreCache.set(dir, { rules, ts: now });
    return rules;
  }

  /** Canonical scope root: macOS /tmp is a symlink to /private/tmp, so raw string prefixing lies. */
  private realScope(scope: string): string {
    const cached = this.realScopeCache.get(scope);
    const now = Date.now();
    if (cached && now - cached.ts < IGNORE_TTL_MS) return cached.root;
    let root = path.resolve(scope);
    try {
      root = fs.realpathSync(root);
    } catch {
      // keep the resolved path when the scope does not exist
    }
    this.realScopeCache.set(scope, { root, ts: now });
    return root;
  }

  private isIgnoredPath(absOrRel: string, scope: string): boolean {
    if (!absOrRel) return false;
    const rules = this.getIgnoreRules(scope);
    if (rules.length === 0) return false;
    if (!path.isAbsolute(absOrRel)) {
      return matchesIgnorePattern(absOrRel, rules);
    }

    // Scope and target can disagree textually (/tmp vs /private/tmp), and the
    // target may not exist on disk. Try the cheap textual roots first — a
    // realpath per hit is what made filtering cost ~1ms per result.
    const resolved = path.resolve(absOrRel);
    const roots = [path.resolve(scope), this.realScope(scope)];
    for (const root of roots) {
      const rel = path.relative(root, resolved);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      return matchesIgnorePattern(rel, rules);
    }

    // Only when no root contains the target textually, resolve symlinks.
    try {
      const realTarget = fs.realpathSync(resolved);
      for (const root of roots) {
        const rel = path.relative(root, realTarget);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
        return matchesIgnorePattern(rel, rules);
      }
    } catch {
      // target does not exist: nothing more to try
    }
    return false;
  }

  private filterIgnoredHits(hits: UltraSearchHit[], scope: string): UltraSearchHit[] {
    return hits.filter((h) => !this.isIgnoredPath(h.path, scope));
  }

  private filterIgnoredFiles(files: UltraSearchGrepFile[], scope: string): UltraSearchGrepFile[] {
    return files.filter((f) => !this.isIgnoredPath(f.path, scope));
  }

  private trySpawnDaemon(): void {
    try {
      // Never spawn from ~/Applications: that path historically held a stale
      // pre-rename build that bound the legacy socket and started a second,
      // divergent index (issue #45). Only spawn from a known-fresh install.
      const candidates = [
        "/Applications/UltraSearch.app/Contents/MacOS/UltraSearch",
        path.join(os.homedir(), ".local/bin/ultrasearch-daemon"),
        "/usr/local/bin/ultrasearch-daemon",
        "/opt/homebrew/bin/ultrasearch-daemon",
      ];
      for (const bin of candidates) {
        if (fs.existsSync(bin)) {
          const child = child_process.spawn(bin, ["serve"], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          break;
        }
      }
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Connection lanes (issue #18)
  // ---------------------------------------------------------------------------

  private pickLane(): Lane {
    if (this.lanes.length <= 1) return this.lanes[0];

    // Connected and idle: reuse without a new connection.
    const idleLive = this.lanes.filter((l) => l.inflight === 0 && this.isLaneLive(l));
    if (idleLive.length > 0) return idleLive[this.rrIndex++ % idleLive.length];

    // Never touched: a concurrent burst must fan out instead of queueing behind
    // one connection that is still being established.
    const fresh = this.lanes.filter((l) => l.inflight === 0 && !l.connecting && !this.isLaneLive(l));
    if (fresh.length > 0) return fresh[0];

    const connecting = this.lanes.filter((l) => l.inflight === 0 && l.connecting);
    if (connecting.length > 0) return connecting[this.rrIndex++ % connecting.length];

    // Every lane is busy and we can still widen: spread the next request.
    if (this.lanes.length < this.maxLanes) {
      const lane = this.createLane(this.lanes.length);
      this.lanes.push(lane);
      return lane;
    }

    // Pool exhausted: least-outstanding lane (never worse than the legacy single socket).
    return this.lanes.reduce((a, b) => (b.inflight < a.inflight ? b : a));
  }

  private openLaneSocket(lane: Lane): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      let settled = false;
      const sock = net.createConnection({ path: this.socketPath });
      lane.socket = sock;

      const done = (kind: "resolve" | "reject", value: any) => {
        if (settled) return;
        settled = true;
        lane.connecting = null;
        if (kind === "resolve") resolve(value);
        else reject(value);
      };

      sock.once("connect", () => {
        lane.opened++;
        lane.rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
        lane.rl.on("line", (line) => this.dispatchLine(lane, line));
        done("resolve", sock);
      });

      sock.on("error", (err) => {
        this.handleLaneClosed(lane);
        done("reject", err);
      });

      sock.on("close", () => {
        this.handleLaneClosed(lane);
      });
    });
  }

  private async connectLane(lane: Lane, retryCount = 0): Promise<net.Socket> {
    if (this.isLaneLive(lane)) return lane.socket!;
    if (!lane.connecting) lane.connecting = this.openLaneSocket(lane);
    try {
      return await lane.connecting;
    } catch (err) {
      if (retryCount === 0) this.trySpawnDaemon();
      if (retryCount >= this.maxReconnectRetries) throw err;
      await sleep(Math.min(100 * Math.pow(2, retryCount), 500));
      return this.connectLane(lane, retryCount + 1);
    }
  }

  private dispatchLine(lane: Lane, line: string): void {
    if (!line.trim()) return;
    try {
      const data = JSON.parse(line);
      const id = data.id;
      if (id !== undefined && lane.pending.has(id)) {
        const req = lane.pending.get(id)!;
        clearTimeout(req.timer);
        lane.pending.delete(id);
        lane.inflight = Math.max(0, lane.inflight - 1);
        req.resolve(data);
      }
    } catch {
      // Drop unparseable lines gracefully
    }
  }

  private handleLaneClosed(lane: Lane, err?: Error): void {
    if (lane.rl) {
      try {
        lane.rl.close();
      } catch {}
      lane.rl = null;
    }
    if (lane.socket) {
      try {
        lane.socket.destroy();
      } catch {}
      lane.socket = null;
      lane.closed++;
    }
    const reason = err ?? new Error("UltraSearch daemon connection closed");
    for (const req of lane.pending.values()) {
      clearTimeout(req.timer);
      req.reject(reason);
    }
    lane.pending.clear();
    lane.inflight = 0;
  }

  public close(): void {
    for (const lane of this.lanes) this.handleLaneClosed(lane);
    this.lanes = [];
    for (const controller of this.activeFallbacks) {
      try {
        controller.abort();
      } catch {}
    }
    this.activeFallbacks.clear();
    killAllChildren();
  }

  public poolStats(): LaneStats {
    return {
      lanes: this.lanes.length,
      open: this.lanes.filter((l) => this.isLaneLive(l)).length,
      inFlight: this.lanes.reduce((acc, l) => acc + l.inflight, 0),
      created: this.lanes.reduce((acc, l) => acc + l.opened, 0),
      closed: this.lanes.reduce((acc, l) => acc + l.closed, 0),
      activeFallbacks: this.activeFallbacks.size,
      fallbackEnabled: this.enableFallback,
    };
  }

  public async request<T = any>(payload: Record<string, any>, opts: RequestOptions = {}): Promise<T> {
    const deadlineMs = opts.deadlineMs ?? this.timeoutMs;
    let lane = this.pickLane();
    let sock: net.Socket;
    try {
      sock = await this.connectLane(lane);
    } catch (err) {
      // Safe degradation: reuse an already-open lane instead of failing the call.
      const alt = this.lanes.find((l) => l !== lane && this.isLaneLive(l));
      if (!alt) throw err;
      lane = alt;
      sock = alt.socket!;
    }

    const id = this.nextId++;
    const message = { ...payload, id };

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!lane.pending.has(id)) return;
        lane.pending.delete(id);
        lane.inflight = Math.max(0, lane.inflight - 1);
        reject(new RequestDeadlineError(deadlineMs));
      }, deadlineMs);

      lane.pending.set(id, { resolve, reject, timer });
      lane.inflight++;

      const settleReject = (err: Error) => {
        if (!lane.pending.has(id)) return;
        clearTimeout(timer);
        lane.pending.delete(id);
        lane.inflight = Math.max(0, lane.inflight - 1);
        reject(err);
      };

      try {
        sock.write(JSON.stringify(message) + "\n", (err) => {
          if (err) settleReject(err);
        });
      } catch (err: any) {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public async ping(): Promise<boolean> {
    try {
      const res = await this.request({ op: "ping" });
      return res.ok === true;
    } catch {
      return false;
    }
  }

  public async status(): Promise<UltraSearchStatusResponse> {
    return await this.request({ op: "status" });
  }

  // ---------------------------------------------------------------------------
  // Result accounting (issues #16, #25, #37)
  // ---------------------------------------------------------------------------

  private buildMeta(params: {
    complete: boolean;
    rawCount: number;
    filteredCount: number;
    truncatedCount: number;
    truncated: boolean;
    engineCapped?: boolean;
    charCount: number;
    source?: "index" | "scan" | "native_fallback";
    budgetMs?: number;
    deadlineExceeded?: boolean;
    warning?: string;
    /** A wider re-query was issued because ignore filtering dropped results. */
    refetched?: boolean;
  }): SearchResultMeta {
    return {
      complete: params.complete,
      truncated: params.truncated,
      truncatedCount: params.truncatedCount,
      engineCapped: params.engineCapped ?? false,
      filteredCount: params.filteredCount,
      tokenCount: Math.ceil(params.charCount / 4),
      charCount: params.charCount,
      source: params.source,
      budgetMs: params.budgetMs,
      deadlineExceeded: params.deadlineExceeded ?? false,
      warning: params.warning,
      refetched: params.refetched ?? false,
      rawCount: params.rawCount,
    };
  }

  private static countGrepChars(files: UltraSearchGrepFile[]): number {
    let chars = 0;
    for (const f of files) {
      chars += f.path.length + 4;
      for (const m of f.matches) chars += (m.text?.length ?? 0) + String(m.line).length + 4;
    }
    return chars;
  }

  /**
   * Search over-fetch: path results are cheap, and a single wider request keeps
   * the filter-then-limit guarantee for `query` (issue #25). Grep uses the
   * re-query-on-shortfall path instead, because its cost grows with `limit`.
   */
  private overscanLimit(limit: number, respectIgnore: boolean, scope?: string, kind: "search" | "grep" = "grep"): number {
    if (!respectIgnore || !scope) return limit;
    if (this.getIgnoreRules(scope).length === 0) return limit;
    if (kind === "grep") return limit;
    return Math.min(Math.max(limit * 2, limit + 20), this.maxOverscan);
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /**
   * Fast file search with STRICT ZERO TYPO TOLERANCE, globs, proximity ranking, and fail-open native fallback.
   */
  public async search(query: string, options: SearchOptions = {}): Promise<UltraSearchSearchResponse> {
    const start = performance.now();
    const limit = options.limit ?? 30;
    const budgetMs = options.budget_ms;
    const respectIgnore = options.respectIgnore !== false;
    const scoped = typeof options.in === "string" && options.in.length > 0;
    const overscan = this.overscanLimit(limit, respectIgnore, options.in, "search");
    const finalQuery = options.fuzzy ? query : enforceExactQuery(query);
    const exactWords = options.fuzzy ? [] : extractExactWords(query);

    try {
      const payload: Record<string, any> = {
        op: "search",
        q: finalQuery,
        query: finalQuery,
        path: options.in,
        in: options.in,
        limit: overscan,
        git: options.git ?? true,
      };
      // Advisor finding #5 / verifier K3: boost is not forced on. It is sent only
      // when the caller asks, so the engine default applies and the A/B can measure it.
      if (options.boost !== undefined) payload.boost = options.boost;
      if (options.near) payload.near = options.near;
      // Advisor finding #4: `sort` was declared but never forwarded on the wire.
      if (options.sort) payload.sort = options.sort;
      if (budgetMs !== undefined) payload.budget_ms = budgetMs;

      let res: UltraSearchSearchResponse = await this.request<UltraSearchSearchResponse>(
        payload,
        budgetMs !== undefined ? { deadlineMs: budgetMs + this.deadlineSlackMs } : {}
      );
      let usedFallback = false;

      // Native fallback when the daemon knows nothing in a consent-gated scope.
      if (
        res.ok &&
        (!res.hits || res.hits.length === 0) &&
        scoped &&
        !usedFallback &&
        this.isConsentGatedPath(options.in) &&
        this.enableFallback
      ) {
        const fallbackRes = await this.nativeFallbackSearch(query, options, budgetMs);
        if (fallbackRes.ok && fallbackRes.hits && fallbackRes.hits.length > 0) {
          res = fallbackRes;
          usedFallback = true;
        }
      }

      const rawHits = res.hits ?? [];
      let hits = rawHits;
      let filteredCount = 0;

      if (res.ok && hits.length > 0 && exactWords.length > 0) {
        const before = hits.length;
        hits = hits.filter((h) => {
          const pathLower = h.path.toLowerCase();
          return exactWords.every((word) => pathLower.includes(word));
        });
        filteredCount += before - hits.length;
      }

      // Advisor finding #7: the engine is authoritative for `near`. Client-side
      // post-ranking is only a fix-up for native fallback results, which have no
      // server ranking at all. Re-ranking daemon rows would double-apply proximity.
      const isNativeFallback = usedFallback || res.source === "native_fallback";
      if (res.ok && hits.length > 0 && options.near && isNativeFallback) {
        hits = this.applyProximityRanking(hits, options.near);
      }

      if (res.ok && hits.length > 0 && respectIgnore && scoped) {
        const before = hits.length;
        hits = this.filterIgnoredHits(hits, options.in!);
        filteredCount += before - hits.length;
      }

      const truncatedCount = Math.max(0, hits.length - limit);
      const kept = hits.slice(0, limit);
      const engineCapped = rawHits.length >= overscan && kept.length >= limit;
      const truncated = truncatedCount > 0 || engineCapped;
      const meta = this.buildMeta({
        complete: res.complete === true,
        rawCount: rawHits.length,
        filteredCount,
        truncatedCount,
        truncated,
        engineCapped,
        charCount: kept.reduce((acc, h) => acc + h.path.length + 1, 0),
        source: res.source ?? "index",
        budgetMs,
      });

      const elapsed = round2(performance.now() - start);
      if (!options.skipAudit) {
        recordAudit({
          ts: Date.now(),
          tool: options.auditTool ?? "ultrasearch_query",
          query,
          scope: options.in,
          ms: elapsed,
          ok: res.ok,
          hitCount: kept.length,
          source: res.source ?? "index",
        });
      }

      return {
        ...res,
        hits: kept,
        complete: meta.complete,
        truncated: meta.truncated,
        truncatedCount: meta.truncatedCount,
        filteredCount: meta.filteredCount,
        meta,
      };
    } catch (err) {
      if (err instanceof RequestDeadlineError && budgetMs !== undefined) {
        const elapsed = round2(performance.now() - start);
        const meta = this.buildMeta({
          complete: false,
          rawCount: 0,
          filteredCount: 0,
          truncatedCount: 0,
          truncated: false,
          charCount: 0,
          source: "index",
          budgetMs,
          deadlineExceeded: true,
        });
        if (!options.skipAudit) {
          recordAudit({
            ts: Date.now(),
            tool: options.auditTool ?? "ultrasearch_query",
            query,
            scope: options.in,
            ms: elapsed,
            ok: false,
            hitCount: 0,
            source: "index",
          });
        }
        return { ok: true, hits: [], source: "index", took_us: Math.round(elapsed * 1000), complete: false, meta };
      }

      if (this.enableFallback) {
        const fallbackRes = await this.nativeFallbackSearch(query, options, budgetMs);
        const elapsed = round2(performance.now() - start);
        if (!options.skipAudit) {
          recordAudit({
            ts: Date.now(),
            tool: options.auditTool ?? "ultrasearch_query",
            query,
            scope: options.in,
            ms: elapsed,
            ok: fallbackRes.ok,
            hitCount: fallbackRes.hits?.length ?? 0,
            source: "native_fallback",
          });
        }
        return fallbackRes;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Grep
  // ---------------------------------------------------------------------------

  /**
   * Fast indexed trigram content search with fail-open fallback.
   */
  public async grep(pattern: string, options: GrepOptions = {}): Promise<UltraSearchGrepResponse> {
    const start = performance.now();
    const limit = options.limit ?? 30;
    const mode = options.mode ?? "literal";
    const budgetMs = options.budget_ms ?? DEFAULT_GREP_BUDGET_MS;
    const respectIgnore = options.respectIgnore !== false;
    const scoped = typeof options.in === "string" && options.in.length > 0;
    const overscan = this.overscanLimit(limit, respectIgnore, options.in, "grep");

    // Issue #36: reject invalid regex client-side; never reach the socket.
    let warning: string | undefined;
    if (mode === "regex") {
      const validation = validateRegexPattern(pattern);
      if (!validation.ok) {
        return {
          ok: false,
          files: [],
          complete: false,
          error: validation.error,
          meta: this.buildMeta({
            complete: false,
            rawCount: 0,
            filteredCount: 0,
            truncatedCount: 0,
            truncated: false,
            charCount: 0,
            source: "index",
            budgetMs,
            warning: validation.error,
          }),
        };
      }
      warning = validation.warning;
    }

    try {
      const payload: Record<string, any> = {
        op: "grep",
        pattern,
        in: options.in,
        mode,
        limit: overscan,
        budget_ms: budgetMs,
        context: options.context ?? 1,
      };
      const deadlineOpts = budgetMs > 0 ? { deadlineMs: budgetMs + this.deadlineSlackMs } : {};

      let res: UltraSearchGrepResponse = await this.request<UltraSearchGrepResponse>(payload, deadlineOpts);
      let usedFallback = false;

      if (
        res.ok &&
        (!res.files || res.files.length === 0) &&
        scoped &&
        !usedFallback &&
        this.isConsentGatedPath(options.in) &&
        this.enableFallback
      ) {
        const fallbackRes = await this.nativeFallbackGrep(pattern, options, budgetMs);
        if (fallbackRes.ok && fallbackRes.files && fallbackRes.files.length > 0) {
          res = fallbackRes;
          usedFallback = true;
        }
      }

      const rawFiles = res.files ?? [];
      let files = rawFiles;
      let filteredCount = 0;

      if (res.ok && files.length > 0 && respectIgnore && scoped) {
        const before = files.length;
        files = this.filterIgnoredFiles(files, options.in!);
        filteredCount += before - files.length;
      }

      let truncatedCount = Math.max(0, files.length - limit);
      let kept = files.slice(0, limit);
      let engineCapped = rawFiles.length >= overscan && kept.length >= limit;
      let truncated = truncatedCount > 0 || engineCapped;
      let rawCount = rawFiles.length;
      let refetched = false;

      // Issue #25 without the over-fetch tax: only when ignore filtering pushed
      // the result below `limit` do we pay for one wider re-query.
      if (
        res.ok &&
        respectIgnore &&
        scoped &&
        kept.length < limit &&
        rawFiles.length >= overscan &&
        filteredCount > 0
      ) {
        const refetchLimit = Math.min(limit + filteredCount + 5, this.maxOverscan);
        if (refetchLimit > overscan) {
          const res2 = await this.request<UltraSearchGrepResponse>({ ...payload, limit: refetchLimit }, deadlineOpts);
          if (res2.ok) {
            res = res2;
            refetched = true;
            const raw2 = res2.files ?? [];
            let files2 = raw2;
            filteredCount = 0;
            if (respectIgnore && scoped && files2.length > 0) {
              const before = files2.length;
              files2 = this.filterIgnoredFiles(files2, options.in!);
              filteredCount = before - files2.length;
            }
            rawCount = raw2.length;
            truncatedCount = Math.max(0, files2.length - limit);
            kept = files2.slice(0, limit);
            engineCapped = raw2.length >= refetchLimit && kept.length >= limit;
            truncated = truncatedCount > 0 || engineCapped;
          }
        }
      }

      const meta = this.buildMeta({
        complete: res.complete === true,
        rawCount,
        filteredCount,
        truncatedCount,
        truncated,
        engineCapped,
        charCount: UltraSearchClient.countGrepChars(kept),
        source: res.source ?? "index",
        budgetMs,
        warning,
        refetched,
      });

      const elapsed = round2(performance.now() - start);
      if (!options.skipAudit) {
        const totalMatches = kept.reduce((acc, f) => acc + f.matches.length, 0);
        recordAudit({
          ts: Date.now(),
          tool: options.auditTool ?? "ultrasearch_grep",
          pattern,
          scope: options.in,
          ms: elapsed,
          ok: res.ok,
          hitCount: totalMatches,
          source: res.source ?? "index",
        });
      }

      return {
        ...res,
        files: kept,
        complete: meta.complete,
        truncated: meta.truncated,
        truncatedCount: meta.truncatedCount,
        filteredCount: meta.filteredCount,
        meta,
      };
    } catch (err) {
      if (err instanceof RequestDeadlineError && budgetMs > 0) {
        const elapsed = round2(performance.now() - start);
        const meta = this.buildMeta({
          complete: false,
          rawCount: 0,
          filteredCount: 0,
          truncatedCount: 0,
          truncated: false,
          charCount: 0,
          source: "index",
          budgetMs,
          deadlineExceeded: true,
          warning,
        });
        if (!options.skipAudit) {
          recordAudit({
            ts: Date.now(),
            tool: options.auditTool ?? "ultrasearch_grep",
            pattern,
            scope: options.in,
            ms: elapsed,
            ok: false,
            hitCount: 0,
            source: "index",
          });
        }
        return { ok: true, files: [], source: "index", took_us: Math.round(elapsed * 1000), complete: false, meta };
      }

      if (this.enableFallback) {
        const fallbackRes = await this.nativeFallbackGrep(pattern, options, budgetMs);
        const elapsed = round2(performance.now() - start);
        if (!options.skipAudit) {
          recordAudit({
            ts: Date.now(),
            tool: options.auditTool ?? "ultrasearch_grep",
            pattern,
            scope: options.in,
            ms: elapsed,
            ok: fallbackRes.ok,
            hitCount: fallbackRes.files?.reduce((acc, f) => acc + f.matches.length, 0) ?? 0,
            source: "native_fallback",
          });
        }
        return fallbackRes;
      }
      throw err;
    }
  }

  /**
   * Multi-pattern OR content search (ultrasearch_multi_grep)
   */
  public async multiGrep(patterns: string[], options: GrepOptions = {}): Promise<UltraSearchMultiGrepResponse> {
    const start = performance.now();
    const limit = options.limit ?? 30;
    const mode = options.mode ?? "literal";
    const budgetMs = options.budget_ms ?? DEFAULT_MULTI_GREP_BUDGET_MS;
    const respectIgnore = options.respectIgnore !== false;
    const scoped = typeof options.in === "string" && options.in.length > 0;
    const overscan = this.overscanLimit(limit, respectIgnore, options.in, "grep");

    if (mode === "regex") {
      for (const p of patterns) {
        const validation = validateRegexPattern(p);
        if (!validation.ok) {
          return { ok: false, patterns, error: validation.error, complete: false };
        }
      }
    }

    const finalize = (res: UltraSearchMultiGrepResponse, rawFiles: UltraSearchGrepFile[], source: UltraSearchMultiGrepResponse["source"], requestLimit: number): UltraSearchMultiGrepResponse => {
      let files = rawFiles;
      let filteredCount = 0;
      if (respectIgnore && scoped && files.length > 0) {
        const before = files.length;
        files = this.filterIgnoredFiles(files, options.in!);
        filteredCount = before - files.length;
      }
      const truncatedCount = Math.max(0, files.length - limit);
      const kept = files.slice(0, limit);
      const engineCapped = rawFiles.length >= requestLimit && kept.length >= limit;
      const truncated = truncatedCount > 0 || engineCapped;
      const meta = this.buildMeta({
        complete: res.complete === true,
        rawCount: rawFiles.length,
        filteredCount,
        truncatedCount,
        truncated,
        engineCapped,
        charCount: UltraSearchClient.countGrepChars(kept),
        source,
        budgetMs,
      });
      return {
        ...res,
        files: kept,
        source,
        complete: meta.complete,
        truncated: meta.truncated,
        truncatedCount: meta.truncatedCount,
        filteredCount: meta.filteredCount,
        meta,
      };
    };

    const audit = (result: UltraSearchMultiGrepResponse, source: "index" | "native_fallback"): void => {
      if (options.skipAudit) return;
      const elapsed = round2(performance.now() - start);
      const totalMatches = (result.files ?? []).reduce((acc, f) => acc + f.matches.length, 0);
      recordAudit({
        ts: Date.now(),
        tool: options.auditTool ?? "ultrasearch_multi_grep",
        pattern: patterns.join(" | "),
        scope: options.in,
        ms: elapsed,
        ok: result.ok,
        hitCount: totalMatches,
        source,
      });
    };

    try {
      const deadlineOpts = budgetMs > 0 ? { deadlineMs: budgetMs + this.deadlineSlackMs } : {};
      const res: UltraSearchMultiGrepResponse = await this.request<UltraSearchMultiGrepResponse>(
        {
          op: "multi_grep",
          patterns,
          in: options.in,
          mode,
          limit: overscan,
          budget_ms: budgetMs,
        },
        deadlineOpts
      );

      if (res.ok) {
        let finalized = finalize(res, res.files ?? [], "index", overscan);
        // Same re-query-on-shortfall rule as grep (issue #25).
        if (
          respectIgnore &&
          scoped &&
          (finalized.files ?? []).length < limit &&
          (res.files ?? []).length >= overscan &&
          (finalized.filteredCount ?? 0) > 0
        ) {
          const refetchLimit = Math.min(limit + (finalized.filteredCount ?? 0) + 5, this.maxOverscan);
          if (refetchLimit > overscan) {
            const res2 = await this.request<UltraSearchMultiGrepResponse>(
              { op: "multi_grep", patterns, in: options.in, mode, limit: refetchLimit, budget_ms: budgetMs },
              deadlineOpts
            );
            if (res2.ok) finalized = finalize(res2, res2.files ?? [], "index", refetchLimit);
          }
        }
        audit(finalized, "index");
        return finalized;
      }
    } catch {
      // Fallback: run individual greps concurrently and merge unique files
    }

    try {
      const results = await Promise.all(
        patterns.map((p) =>
          this.grep(p, {
            ...options,
            skipAudit: true,
            limit: Math.max(10, Math.floor((limit * 4) / Math.max(1, patterns.length))),
          })
        )
      );

      const fileMap = new Map<string, { path: string; matches: any[] }>();
      for (const r of results) {
        if (!r.ok || !r.files) continue;
        for (const f of r.files) {
          if (!fileMap.has(f.path)) {
            fileMap.set(f.path, { path: f.path, matches: [...f.matches] });
          } else {
            const existing = fileMap.get(f.path)!;
            const seenLines = new Set(existing.matches.map((m) => m.line));
            for (const m of f.matches) {
              if (!seenLines.has(m.line)) {
                existing.matches.push(m);
                seenLines.add(m.line);
              }
            }
          }
        }
      }

      const elapsed = round2(performance.now() - start);
      const merged = finalize(
        {
          ok: true,
          took_us: Math.round(elapsed * 1000),
          patterns,
          source: "native_fallback",
        },
        Array.from(fileMap.values()),
        "native_fallback",
        Math.max(10, Math.floor((limit * 4) / Math.max(1, patterns.length)))
      );
      audit(merged, "native_fallback");
      return merged;
    } catch (err: any) {
      return {
        ok: false,
        patterns,
        error: err?.message ?? String(err),
      };
    }
  }

  public async open(filePath: string): Promise<boolean> {
    try {
      const res = await this.request({ op: "open", path: filePath });
      return res.ok === true;
    } catch {
      return false;
    }
  }

  public async recent(scopeDir: string, limit = 15): Promise<UltraSearchSearchResponse> {
    const start = performance.now();
    try {
      const res: UltraSearchSearchResponse = await this.request({ op: "recent", in: scopeDir, limit });
      const hits = res.hits ?? [];
      const meta = this.buildMeta({
        complete: res.complete === true,
        rawCount: hits.length,
        filteredCount: 0,
        truncatedCount: 0,
        truncated: false,
        charCount: hits.reduce((acc, h) => acc + h.path.length + 1, 0),
        source: res.source ?? "index",
      });
      const elapsed = round2(performance.now() - start);
      recordAudit({
        ts: Date.now(),
        tool: "ultrasearch_recent",
        query: `recent:${limit}`,
        scope: scopeDir,
        ms: elapsed,
        ok: res.ok,
        hitCount: hits.length,
        source: res.source ?? "index",
      });
      return { ...res, complete: meta.complete, meta };
    } catch (err) {
      if (this.enableFallback) {
        return this.nativeFallbackSearch("", { in: scopeDir, limit, sort: "mtime" });
      }
      throw err;
    }
  }

  /**
   * Computes proximity distance and boosts hits closer in the folder tree to target path.
   */
  public isConsentGatedPath(p?: string): boolean {
    if (!p) return false;
    const abs = this.realScope(p);
    const home = os.homedir();
    return (
      abs.startsWith(path.join(home, "Downloads")) ||
      abs.startsWith(path.join(home, "Documents")) ||
      abs.startsWith(path.join(home, "Desktop"))
    );
  }

  public applyProximityRanking(hits: UltraSearchHit[], nearPath: string): UltraSearchHit[] {
    const targetDir = path.dirname(path.resolve(nearPath));
    const targetParts = targetDir.split(path.sep);

    return hits
      .map((hit) => {
        const hitDir = path.dirname(path.resolve(hit.path));
        const hitParts = hitDir.split(path.sep);

        let common = 0;
        while (common < targetParts.length && common < hitParts.length && targetParts[common] === hitParts[common]) {
          common++;
        }
        const distance = (targetParts.length - common) + (hitParts.length - common);
        const proximityBoost = Math.max(0, 100 - distance * 10);
        return {
          ...hit,
          distance,
          score: hit.score + proximityBoost,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------------------
  // Native fallback (async, cancellable — issue #24)
  // ---------------------------------------------------------------------------

  /**
   * Registers a fallback operation so shutdown/abort cancels it and tests can
   * assert there are no leaked child processes.
   */
  private beginFallback(signal?: AbortSignal): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController();
    this.activeFallbacks.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return {
      signal: combined,
      end: () => this.activeFallbacks.delete(controller),
    };
  }

  private remainingBudget(budgetMs: number | undefined, elapsedMs: number): number | undefined {
    if (budgetMs === undefined) return undefined;
    if (budgetMs <= 0) return undefined;
    return budgetMs + this.deadlineSlackMs - elapsedMs;
  }

  private async nativeFallbackSearch(
    query: string,
    options: SearchOptions,
    budgetMs?: number
  ): Promise<UltraSearchSearchResponse> {
    const start = performance.now();
    const scope = options.in ? path.resolve(options.in) : process.cwd();
    const limit = options.limit ?? 30;
    const overscan = this.overscanLimit(limit, options.respectIgnore !== false, options.in, "search");
    const cleanQ = query.trim().replace(/^['"]/, "").replace(/['"]$/, "");
    const remaining = this.remainingBudget(budgetMs, 0);
    const timeoutMs = remaining !== undefined ? Math.max(0, Math.min(remaining, this.fallbackTimeoutMs)) : this.fallbackTimeoutMs;

    if (timeoutMs <= 0) {
      return { ok: false, hits: [], source: "native_fallback", complete: false, error: "budget exhausted before native fallback" };
    }

    const { signal, end } = this.beginFallback(options.signal);
    try {
      const excludes = ["!.git", "!node_modules", "!target", "!dist", "!build"];
      let stdout = "";
      let timedOut = false;
      let cancelled = false;

      // Prefer rg --files (case-insensitive glob, honours VCS ignores); fall back to find.
      if (cleanQ) {
        const rgArgs = ["--files", ...excludes.flatMap((g) => ["--glob", g]), "--iglob", `*${cleanQ}*`, scope];
        const rg = await spawnCapture("rg", rgArgs, { signal, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        if (rg.notFound) {
          const findArgs = [
            scope,
            "-not", "-path", "*/.*",
            "-not", "-path", "*/node_modules/*",
            "-not", "-path", "*/target/*",
            "-not", "-path", "*/dist/*",
            "-not", "-path", "*/build/*",
            "-iname", `*${cleanQ}*`,
            "-print",
          ];
          const find = await spawnCapture("find", findArgs, { signal, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          stdout = find.stdout;
          timedOut = find.timedOut;
          cancelled = find.cancelled;
        } else {
          stdout = rg.stdout;
          timedOut = rg.timedOut;
          cancelled = rg.cancelled;
        }
      } else {
        const rg = await spawnCapture("rg", ["--files", ...excludes.flatMap((g) => ["--glob", g]), scope], { signal, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        if (rg.notFound) {
          const find = await spawnCapture("find", [scope, "-not", "-path", "*/.*", "-print"], { signal, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          stdout = find.stdout;
          timedOut = find.timedOut;
          cancelled = find.cancelled;
        } else {
          stdout = rg.stdout;
          timedOut = rg.timedOut;
          cancelled = rg.cancelled;
        }
      }

      if (cancelled) {
        return { ok: false, hits: [], source: "native_fallback", complete: false, error: "native fallback cancelled" };
      }

      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const hits: UltraSearchHit[] = lines.slice(0, overscan).map((p) => ({
        kind: "file",
        mtime: Math.floor(Date.now() / 1000),
        path: p,
        score: cleanQ && p.toLowerCase().endsWith(cleanQ.toLowerCase()) ? 100 : 50,
        size: 0,
      }));

      const charCount = hits.reduce((acc, h) => acc + h.path.length + 1, 0);
      const meta = this.buildMeta({
        complete: !timedOut,
        rawCount: hits.length,
        filteredCount: 0,
        truncatedCount: Math.max(0, hits.length - limit),
        truncated: timedOut || lines.length > overscan,
        charCount,
        source: "native_fallback",
        budgetMs,
      });

      return {
        ok: true,
        took_us: Math.round((performance.now() - start) * 1000),
        hits,
        source: "native_fallback",
        complete: meta.complete,
        truncated: meta.truncated,
        meta,
      };
    } catch (err: any) {
      return {
        ok: false,
        hits: [],
        source: "native_fallback",
        complete: false,
        error: `Fallback search failed: ${err?.message ?? err}`,
      };
    } finally {
      end();
    }
  }

  private async nativeFallbackGrep(
    pattern: string,
    options: GrepOptions,
    budgetMs?: number
  ): Promise<UltraSearchGrepResponse> {
    const start = performance.now();
    const scope = options.in ? path.resolve(options.in) : process.cwd();
    const limit = options.limit ?? 30;
    const overscan = this.overscanLimit(limit, options.respectIgnore !== false, options.in, "grep");
    const remaining = this.remainingBudget(budgetMs, 0);
    const timeoutMs = remaining !== undefined ? Math.max(0, Math.min(remaining, this.fallbackTimeoutMs)) : this.fallbackTimeoutMs;

    if (timeoutMs <= 0) {
      return { ok: false, files: [], source: "native_fallback", complete: false, error: "budget exhausted before native fallback" };
    }

    const { signal, end } = this.beginFallback(options.signal);
    try {
      const rgArgs = [
        "-n", "--no-heading", "--color", "never",
        "--glob", "!.git", "--glob", "!node_modules",
        "--glob", "!target", "--glob", "!dist", "--glob", "!build",
        pattern, scope,
      ];
      const grepArgs = [
        "-rn",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        "--exclude-dir=target",
        "--exclude-dir=dist",
        "--exclude-dir=build",
        pattern,
        scope,
      ];

      let out = "";
      let timedOut = false;
      let cancelled = false;
      let notFound = false;

      const rg = await spawnCapture("rg", rgArgs, { signal, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      if (rg.notFound) {
        const grep = await spawnCapture("grep", grepArgs, { signal, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        notFound = grep.notFound;
        out = grep.stdout;
        timedOut = grep.timedOut;
        cancelled = grep.cancelled;
      } else {
        out = rg.stdout;
        timedOut = rg.timedOut;
        cancelled = rg.cancelled;
      }

      if (notFound) {
        return { ok: false, files: [], source: "native_fallback", complete: false, error: "neither rg nor grep is installed" };
      }
      if (cancelled) {
        return { ok: false, files: [], source: "native_fallback", complete: false, error: "native fallback cancelled" };
      }

      const lines = out.split("\n").filter(Boolean).slice(0, overscan * 3);
      const fileMap = new Map<string, { path: string; matches: any[] }>();

      for (const line of lines) {
        const parts = line.split(":");
        if (parts.length >= 3) {
          const filePath = parts[0];
          const lineNum = parseInt(parts[1], 10) || 1;
          const matchText = parts.slice(2).join(":");

          if (!fileMap.has(filePath)) {
            fileMap.set(filePath, { path: filePath, matches: [] });
          }
          fileMap.get(filePath)!.matches.push({ line: lineNum, text: matchText });
        }
      }

      const rawFiles = Array.from(fileMap.values()).slice(0, overscan);
      const charCount = UltraSearchClient.countGrepChars(rawFiles);
      const meta = this.buildMeta({
        complete: !timedOut,
        rawCount: rawFiles.length,
        filteredCount: 0,
        truncatedCount: Math.max(0, rawFiles.length - limit),
        truncated: timedOut || rawFiles.length >= overscan,
        charCount,
        source: "native_fallback",
        budgetMs,
      });

      return {
        ok: true,
        took_us: Math.round((performance.now() - start) * 1000),
        files: rawFiles,
        source: "native_fallback",
        complete: meta.complete,
        truncated: meta.truncated,
        meta,
      };
    } catch (err: any) {
      return {
        ok: false,
        files: [],
        source: "native_fallback",
        complete: false,
        error: `Fallback grep failed: ${err?.message ?? err}`,
      };
    } finally {
      end();
    }
  }
}
