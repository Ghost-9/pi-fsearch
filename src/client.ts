import * as child_process from "node:child_process";

export function resolveDefaultSocketPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\fsearch";
  }
  if (process.platform === "linux") {
    if (process.env.XDG_RUNTIME_DIR) {
      return path.join(process.env.XDG_RUNTIME_DIR, "fsearch.sock");
    }
    return path.join(home, ".local/share/fsearch/fsearch.sock");
  }
  return path.join(home, "Library/Application Support/FSearch/fsearch.sock");
}
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { execFileSync } from "node:child_process";
import type {
  FSearchSearchResponse,
  FSearchGrepResponse,
  FSearchMultiGrepResponse,
  FSearchStatusResponse,
  FSearchHit,
  SearchOptions,
  GrepOptions,
} from "./types.ts";
import { recordAudit } from "./telemetry.ts";

export interface FSearchClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxReconnectRetries?: number;
  enableFallback?: boolean;
}

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


export class FSearchClient {
  private socketPath: string;
  private timeoutMs: number;
  private maxReconnectRetries: number;
  private enableFallback: boolean;
  private socket: net.Socket | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private isConnecting = false;
  private pending = new Map<number | string, {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(options: FSearchClientOptions = {}) {
    this.socketPath = options.socketPath ?? resolveDefaultSocketPath();
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxReconnectRetries = options.maxReconnectRetries ?? 3;
    this.enableFallback = options.enableFallback ?? true;
  }

  
  private trySpawnDaemon(): void {
    try {
      const candidates = [
        path.join(os.homedir(), "Applications/UltraSearch.app/Contents/MacOS/UltraSearch"),
        path.join(os.homedir(), ".local/bin/ultrasearch-daemon"),
        path.join(os.homedir(), ".local/bin/fsearch"),
        "/usr/local/bin/ultrasearch-daemon",
        "/usr/local/bin/fsearch",
        "/opt/homebrew/bin/fsearch",
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

  private async ensureConnection(retryCount = 0): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      return this.socket;
    }

    if (this.isConnecting) {
      await new Promise((r) => setTimeout(r, 50));
      if (this.socket && !this.socket.destroyed) return this.socket;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: this.socketPath });

      sock.on("connect", () => {
        this.isConnecting = false;
        this.socket = sock;
        this.rl = readline.createInterface({ input: sock, crlfDelay: Infinity });

        this.rl.on("line", (line) => {
          if (!line.trim()) return;
          try {
            const data = JSON.parse(line);
            const id = data.id;
            if (id !== undefined && this.pending.has(id)) {
              const req = this.pending.get(id)!;
              clearTimeout(req.timer);
              this.pending.delete(id);
              req.resolve(data);
            }
          } catch {
            // Drop unparseable lines gracefully
          }
        });

        resolve(sock);
      });

      sock.on("error", async (err) => {
        this.cleanup();
        this.isConnecting = false;
        if (retryCount === 0) { this.trySpawnDaemon(); }
        if (retryCount < this.maxReconnectRetries) {
          const backoffMs = Math.min(100 * Math.pow(2, retryCount), 500);
          await new Promise((r) => setTimeout(r, backoffMs));
          try {
            const retried = await this.ensureConnection(retryCount + 1);
            return resolve(retried);
          } catch (retryErr) {
            return reject(retryErr);
          }
        }
        reject(err);
      });

      sock.on("close", () => {
        this.cleanup();
      });
    });
  }

  private cleanup(): void {
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error("FSearch daemon connection closed"));
    }
    this.pending.clear();
  }

  public close(): void {
    this.cleanup();
  }

  public async request<T = any>(payload: Record<string, any>): Promise<T> {
    try {
      const sock = await this.ensureConnection();
      const id = this.nextId++;
      const message = { ...payload, id };

      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`FSearch request timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);

        this.pending.set(id, { resolve, reject, timer });
        sock.write(JSON.stringify(message) + "\n");
      });
    } catch (err: any) {
      this.cleanup();
      throw err;
    }
  }

  public async ping(): Promise<boolean> {
    try {
      const res = await this.request({ op: "ping" });
      return res.ok === true;
    } catch {
      return false;
    }
  }

  public async status(): Promise<FSearchStatusResponse> {
    return await this.request({ op: "status" });
  }

  /**
   * Fast file search with STRICT ZERO TYPO TOLERANCE, globs, proximity ranking, and fail-open native fallback.
   */
  public async search(query: string, options: SearchOptions = {}): Promise<FSearchSearchResponse> {
    const start = performance.now();
    try {
      const finalQuery = options.fuzzy ? query : enforceExactQuery(query);
      const exactWords = options.fuzzy ? [] : extractExactWords(query);

      const payload: Record<string, any> = {
        op: "search",
        q: finalQuery,
        query: finalQuery,
        path: options.in,
        in: options.in,
        limit: options.limit ?? 30,
        git: options.git ?? true,
        boost: options.boost ?? true,
      };

      if (options.near) {
        payload.near = options.near;
      }

      const res: FSearchSearchResponse = await this.request(payload);

      // Strict Zero Typo Tolerance post-filter: remove low-scoring partial matches that do not contain exact query words
      if (res.ok && res.hits && !options.fuzzy && exactWords.length > 0) {
        res.hits = res.hits.filter((h) => {
          const pathLower = h.path.toLowerCase();
          return exactWords.every((word) => pathLower.includes(word));
        });
      }

      // Apply Proximity re-ranking if near option or near: filter requested
      if (res.ok && res.hits && options.near) {
        res.hits = this.applyProximityRanking(res.hits, options.near);
      }

      if (
        res.ok &&
        (!res.hits || res.hits.length === 0) &&
        options.in &&
        this.isConsentGatedPath(options.in) &&
        this.enableFallback
      ) {
        const fallbackRes = this.nativeFallbackSearch(query, options);
        if (fallbackRes.ok && fallbackRes.hits && fallbackRes.hits.length > 0) {
          const elapsed = Math.round((performance.now() - start) * 100) / 100;
          if (!options.skipAudit) {
            recordAudit({
              ts: Date.now(),
              tool: "fsearch_query",
              query,
              scope: options.in,
              ms: elapsed,
              ok: true,
              hitCount: fallbackRes.hits.length,
              source: "native_fallback",
            });
          }
          return fallbackRes;
        }
      }

      const elapsed = Math.round((performance.now() - start) * 100) / 100;
      if (!options.skipAudit) {
        recordAudit({
          ts: Date.now(),
          tool: "fsearch_query",
          query,
          scope: options.in,
          ms: elapsed,
          ok: res.ok,
          hitCount: res.hits?.length ?? 0,
          source: res.source ?? "index",
        });
      }

      return res;
    } catch (err) {
      if (this.enableFallback) {
        const fallbackRes = await this.nativeFallbackSearch(query, options);
        const elapsed = Math.round((performance.now() - start) * 100) / 100;
        if (!options.skipAudit) {
          recordAudit({
            ts: Date.now(),
            tool: "fsearch_query",
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

  /**
   * Fast indexed trigram content search with fail-open fallback.
   */
  public async grep(pattern: string, options: GrepOptions = {}): Promise<FSearchGrepResponse> {
    const start = performance.now();
    try {
      const payload: Record<string, any> = {
        op: "grep",
        pattern,
        in: options.in,
        mode: options.mode ?? "literal",
        limit: options.limit ?? 30,
        budget_ms: options.budget_ms ?? 2500,
        context: options.context ?? 1,
      };

      const res: FSearchGrepResponse = await this.request(payload);

      if (
        res.ok &&
        (!res.files || res.files.length === 0) &&
        options.in &&
        this.isConsentGatedPath(options.in) &&
        this.enableFallback
      ) {
        const fallbackRes = this.nativeFallbackGrep(pattern, options);
        if (fallbackRes.ok && fallbackRes.files && fallbackRes.files.length > 0) {
          const elapsed = Math.round((performance.now() - start) * 100) / 100;
          const totalMatches = fallbackRes.files.reduce((acc, f) => acc + f.matches.length, 0);
          if (!options.skipAudit) {
            recordAudit({
              ts: Date.now(),
              tool: "fsearch_grep",
              pattern,
              scope: options.in,
              ms: elapsed,
              ok: true,
              hitCount: totalMatches,
              source: "native_fallback",
            });
          }
          return fallbackRes;
        }
      }

      const elapsed = Math.round((performance.now() - start) * 100) / 100;

      if (!options.skipAudit) {
        const totalMatches = res.files?.reduce((acc, f) => acc + f.matches.length, 0) ?? 0;
        recordAudit({
          ts: Date.now(),
          tool: "fsearch_grep",
          pattern,
          scope: options.in,
          ms: elapsed,
          ok: res.ok,
          hitCount: totalMatches,
          source: res.source ?? "index",
        });
      }

      return res;
    } catch (err) {
      if (this.enableFallback) {
        const fallbackRes = await this.nativeFallbackGrep(pattern, options);
        const elapsed = Math.round((performance.now() - start) * 100) / 100;
        if (!options.skipAudit) {
          recordAudit({
            ts: Date.now(),
            tool: "fsearch_grep",
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
   * Multi-pattern OR content search (fsearch_multi_grep)
   */
  public async multiGrep(patterns: string[], options: GrepOptions = {}): Promise<FSearchMultiGrepResponse> {
    const start = performance.now();
    try {
      const res: FSearchMultiGrepResponse = await this.request({
        op: "multi_grep",
        patterns,
        in: options.in,
        mode: options.mode ?? "literal",
        limit: options.limit ?? 30,
        budget_ms: options.budget_ms ?? 3000,
      });

      if (res.ok) {
        const elapsed = Math.round((performance.now() - start) * 100) / 100;
        if (!options.skipAudit) {
          const totalMatches = res.files?.reduce((acc, f) => acc + f.matches.length, 0) ?? 0;
          recordAudit({
            ts: Date.now(),
            tool: "fsearch_multi_grep",
            pattern: patterns.join(" | "),
            scope: options.in,
            ms: elapsed,
            ok: true,
            hitCount: totalMatches,
            source: "index",
          });
        }
        return res;
      }
    } catch {
      // Fallback: run individual greps concurrently and merge unique files
    }

    try {
      const results = await Promise.all(
        patterns.map((p) => this.grep(p, { ...options, skipAudit: true, limit: Math.max(10, Math.floor((options.limit ?? 30) / patterns.length)) }))
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

      const elapsed = Math.round((performance.now() - start) * 100) / 100;
      const mergedFiles = Array.from(fileMap.values());
      const totalMatches = mergedFiles.reduce((acc, f) => acc + f.matches.length, 0);

      if (!options.skipAudit) {
        recordAudit({
          ts: Date.now(),
          tool: "fsearch_multi_grep",
          pattern: patterns.join(" | "),
          scope: options.in,
          ms: elapsed,
          ok: true,
          hitCount: totalMatches,
          source: "index",
        });
      }

      return {
        ok: true,
        took_us: Math.round(elapsed * 1000),
        patterns,
        files: mergedFiles,
        source: "index",
      };
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

  public async recent(scopeDir: string, limit = 15): Promise<FSearchSearchResponse> {
    const start = performance.now();
    try {
      const res: FSearchSearchResponse = await this.request({ op: "recent", in: scopeDir, limit });
      const elapsed = Math.round((performance.now() - start) * 100) / 100;
      recordAudit({
        ts: Date.now(),
        tool: "fsearch_recent",
        query: `recent:${limit}`,
        scope: scopeDir,
        ms: elapsed,
        ok: res.ok,
        hitCount: res.hits?.length ?? 0,
        source: "index",
      });
      return res;
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
    const abs = path.resolve(p);
    const home = os.homedir();
    return (
      abs.startsWith(path.join(home, "Downloads")) ||
      abs.startsWith(path.join(home, "Documents")) ||
      abs.startsWith(path.join(home, "Desktop"))
    );
  }

  public applyProximityRanking(hits: FSearchHit[], nearPath: string): FSearchHit[] {
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

  private nativeFallbackSearch(query: string, options: SearchOptions): FSearchSearchResponse {
    const start = Date.now();
    const scope = options.in ? path.resolve(options.in) : process.cwd();
    const limit = options.limit ?? 30;
    const cleanQ = query.trim().replace(/^['"]/, "").replace(/['"]$/, "");

    try {
      const args = [
        scope,
        "-maxdepth", "6",
        "-not", "-path", "*/.*",
        "-not", "-path", "*/node_modules/*",
        "-not", "-path", "*/target/*",
        "-not", "-path", "*/dist/*",
        "-not", "-path", "*/build/*",
      ];
      if (cleanQ) {
        args.push("-iname", `*${cleanQ}*`);
      }
      args.push("-print");

      const out = execFileSync(
        "find",
        args,
        { encoding: "utf-8", timeout: 4000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
      );

      const lines = out.split("\n").filter(Boolean).slice(0, limit);
      const hits: FSearchHit[] = lines.map((p) => ({
        kind: "file",
        mtime: Math.floor(Date.now() / 1000),
        path: p,
        score: p.toLowerCase().endsWith(cleanQ.toLowerCase()) ? 100 : 50,
        size: 0,
      }));

      return {
        ok: true,
        took_us: (Date.now() - start) * 1000,
        hits,
        source: "native_fallback",
      };
    } catch (err: any) {
      return {
        ok: false,
        hits: [],
        source: "native_fallback",
        error: `Fallback find failed: ${err.message}`,
      };
    }
  }

  private nativeFallbackGrep(pattern: string, options: GrepOptions): FSearchGrepResponse {
    const start = Date.now();
    const scope = options.in ? path.resolve(options.in) : process.cwd();
    const limit = options.limit ?? 30;

    try {
      const out = execFileSync(
        "grep",
        [
          "-rn",
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          "--exclude-dir=target",
          "--exclude-dir=dist",
          "--exclude-dir=build",
          pattern,
          scope,
        ],
        { encoding: "utf-8", timeout: 4000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
      );

      const lines = out.split("\n").filter(Boolean).slice(0, limit * 3);
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

      return {
        ok: true,
        took_us: (Date.now() - start) * 1000,
        files: Array.from(fileMap.values()).slice(0, limit),
        source: "native_fallback",
      };
    } catch (err: any) {
      return {
        ok: false,
        files: [],
        source: "native_fallback",
        error: `Fallback grep failed: ${err.message}`,
      };
    }
  }
}
