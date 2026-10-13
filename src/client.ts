import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { FSearchSearchResponse, FSearchGrepResponse, FSearchStatusResponse } from "./types.js";

export interface FSearchClientOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export class FSearchClient {
  private socketPath: string;
  private timeoutMs: number;
  private socket: net.Socket | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(options: FSearchClientOptions = {}) {
    const home = os.homedir();
    this.socketPath = options.socketPath ?? path.join(home, "Library/Application Support/FSearch/fsearch.sock");
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  private async ensureConnection(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }

    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: this.socketPath });

      sock.on("connect", () => {
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

      sock.on("error", (err) => {
        this.cleanup();
        reject(err);
      });

      sock.on("close", () => {
        this.cleanup();
      });
    });
  }

  private cleanup(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error("FSearch daemon connection closed"));
    }
    this.pending.clear();
  }

  public async request<T = any>(payload: Record<string, any>): Promise<T> {
    const sock = await this.ensureConnection();
    const id = this.nextId++;
    const message = { ...payload, id };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FSearch request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      sock.write(JSON.stringify(message) + "\n");
    });
  }

  public async ping(): Promise<boolean> {
    const res = await this.request({ op: "ping" });
    return res.ok === true;
  }

  public async status(): Promise<FSearchStatusResponse> {
    return await this.request({ op: "status" });
  }

  public async search(query: string, options: {
    in?: string;
    limit?: number;
    git?: boolean;
    boost?: boolean;
    near?: string;
  } = {}): Promise<FSearchSearchResponse> {
    const payload: Record<string, any> = { q: query, limit: options.limit ?? 50 };
    if (options.in) payload.in = options.in;
    if (options.git !== undefined) payload.git = options.git;
    if (options.boost !== undefined) payload.boost = options.boost;
    if (options.near) payload.near = options.near;
    return await this.request(payload);
  }

  public async grep(pattern: string, options: {
    in?: string;
    mode?: "literal" | "regex" | "symbol";
    limit?: number;
    budget_ms?: number;
    context?: number;
    git?: boolean;
  } = {}): Promise<FSearchGrepResponse> {
    const payload: Record<string, any> = {
      op: "grep",
      pattern,
      mode: options.mode ?? "literal",
      limit: options.limit ?? 50,
      budget_ms: options.budget_ms ?? 2000,
    };
    if (options.in) payload.in = options.in;
    if (options.context !== undefined) payload.context = options.context;
    if (options.git !== undefined) payload.git = options.git;
    return await this.request(payload);
  }

  public async open(paths: string | string[]): Promise<boolean> {
    const payload: Record<string, any> = { op: "open" };
    if (Array.isArray(paths)) {
      payload.paths = paths;
    } else {
      payload.path = paths;
    }
    const res = await this.request(payload);
    return res.ok === true;
  }

  public async recent(scope?: string, limit = 20): Promise<FSearchSearchResponse> {
    const payload: Record<string, any> = { op: "recent", limit };
    if (scope) payload.in = scope;
    return await this.request(payload);
  }

  public close(): void {
    this.cleanup();
  }
}
