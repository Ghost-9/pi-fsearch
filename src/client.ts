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
import { isPathSafe } from "./sanitize.ts";

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
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((tok) => !tok.includes(":") && !tok.startsWith("!") && !tok.includes("*") && !tok.includes("?"))
    .map((tok) => tok.replace(/^['^]/, "").replace(/\$$/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Transforms plain words in query into exact match mode (prefixing `'`),
 * ensuring ZERO typo tolerance and strict deterministic token matching.
 */
export function enforceExactQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const transformed = tokens.map((tok) => {
    if (
      tok.includes(":") ||
      tok.startsWith("'") ||
      tok.startsWith("!") ||
      tok.startsWith("^") ||
      tok.endsWith("$") ||
      tok.includes("*") ||
      tok.includes("?")
    ) {
      return tok;
    }
    return `'${tok}`;
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
    const home = os.homedir();
    this.socketPath = options.socketPath ?? path.join(home, "Library/Application Support/FSearch/fsearch.sock");
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxReconnectRetries = options.maxReconnectRetries ?? 3;
    this.enableFallback = options.enableFallback ?? true;
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

      return res;
    } catch (err) {
      if (this.enableFallback) {
        return this.nativeFallbackSearch(query, options);
      }
      throw err;
    }
  }

  /**
   * Fast indexed trigram content search with fail-open fallback.
   */
  public async grep(pattern: string, options: GrepOptions = {}): Promise<FSearchGrepResponse> {
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

      return await this.request(payload);
    } catch (err) {
      if (this.enableFallback) {
        return this.nativeFallbackGrep(pattern, options);
      }
      throw err;
    }
  }

  /**
   * Multi-pattern OR content search (fsearch_multi_grep)
   */
  public async multiGrep(patterns: string[], options: GrepOptions = {}): Promise<FSearchMultiGrepResponse> {
    const start = Date.now();
    try {
      const res: FSearchMultiGrepResponse = await this.request({
        op: "multi_grep",
        patterns,
        in: options.in,
        mode: options.mode ?? "literal",
        limit: options.limit ?? 30,
        budget_ms: options.budget_ms ?? 3000,
      });
      if (res.ok) return res;
    } catch {
      // Fallback: run individual greps concurrently and merge unique files
    }

    try {
      const results = await Promise.all(
        patterns.map((p) => this.grep(p, { ...options, limit: Math.max(10, Math.floor((options.limit ?? 30) / patterns.length)) }))
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

      return {
        ok: true,
        took_us: (Date.now() - start) * 1000,
        patterns,
        files: Array.from(fileMap.values()),
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
    try {
      return await this.request({ op: "recent", in: scopeDir, limit });
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

  /**
   * Graceful fail-open fallback: performs deterministic file search using ripgrep or fs walk.
   * Strict exact matching (zero typo tolerance).
   */
  private nativeFallbackSearch(query: string, options: SearchOptions): FSearchSearchResponse {
    const start = Date.now();
    const searchRoot = options.in ?? process.cwd();
    const hits: FSearchHit[] = [];

    try {
      let fileList: string[] = [];
      try {
        const out = execFileSync("git", ["ls-files"], { cwd: searchRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        fileList = out.split("\n").filter(Boolean).map((f) => path.join(searchRoot, f));
      } catch {
        fileList = this.walkDir(searchRoot, 3);
      }

      const qLower = query.toLowerCase().replace(/['*]/g, "").trim();

      for (const f of fileList) {
        if (!isPathSafe(f, options.in)) continue;
        const base = path.basename(f).toLowerCase();
        let matched = false;
        let score = 50;

        // Deterministic exact matching only
        if (!qLower || base === qLower || base.includes(qLower)) {
          matched = true;
          if (base === qLower) score = 300;
          else if (base.startsWith(qLower)) score = 200;
        }

        if (matched) {
          hits.push({
            kind: "file",
            path: f,
            score,
            mtime: Date.now(),
            size: 0,
          });
        }
        if (hits.length >= (options.limit ?? 30)) break;
      }

      return {
        ok: true,
        took_us: (Date.now() - start) * 1000,
        hits,
        source: "native_fallback",
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `Native search fallback failed: ${err?.message ?? err}`,
        source: "native_fallback",
      };
    }
  }

  /**
   * Graceful fail-open fallback: executes system `rg` (ripgrep) when daemon is unavailable.
   */
  private nativeFallbackGrep(pattern: string, options: GrepOptions): FSearchGrepResponse {
    const start = Date.now();
    const searchRoot = options.in ?? process.cwd();

    try {
      const args = ["-n", "--no-heading", "--max-count", "10", pattern];
      if (options.limit) {
        args.push("--max-filesize", "2M");
      }
      args.push(searchRoot);

      const stdout = execFileSync("rg", args, {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });

      const fileMap = new Map<string, { path: string; matches: any[] }>();
      const lines = stdout.split("\n").filter(Boolean);

      for (const line of lines) {
        const match = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!match) continue;
        const [, filePath, lineStr, text] = match;
        if (!isPathSafe(filePath, options.in)) continue;

        if (!fileMap.has(filePath)) {
          fileMap.set(filePath, { path: filePath, matches: [] });
        }
        fileMap.get(filePath)!.matches.push({
          line: parseInt(lineStr, 10),
          text: text.slice(0, 300),
        });

        if (fileMap.size >= (options.limit ?? 30)) break;
      }

      return {
        ok: true,
        took_us: (Date.now() - start) * 1000,
        source: "native_fallback",
        files: Array.from(fileMap.values()),
      };
    } catch {
      return {
        ok: true,
        took_us: (Date.now() - start) * 1000,
        source: "native_fallback",
        files: [],
      };
    }
  }

  private walkDir(dir: string, depthRemaining: number): string[] {
    if (depthRemaining <= 0) return [];
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "target") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          results.push(...this.walkDir(full, depthRemaining - 1));
        } else if (e.isFile()) {
          results.push(full);
        }
        if (results.length > 500) break;
      }
    } catch {}
    return results;
  }
}
