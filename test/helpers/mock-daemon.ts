import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export interface MockRequest {
  payload: any;
  lane: number;
  at: number;
}

export interface MockDaemonOptions {
  /** Reply builder. Receives the parsed request and a lane/hit context. */
  reply?: (req: any, ctx: { lane: number; hit: number }) => any | Promise<any>;
  /** Delay applied per request (ms), constant or computed. */
  delayMs?: number | ((req: any, ctx: { lane: number; hit: number }) => number);
}

/**
 * Hermetic line-delimited JSON daemon over a temporary UNIX socket.
 * One connection = one lane; requests on a lane are processed in order.
 */
export class MockDaemon {
  readonly socketPath: string;
  readonly requests: MockRequest[] = [];
  readonly lanesSeen = new Set<number>();
  maxConcurrent = 0;
  openConnections = 0;

  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private laneSeq = 0;
  private inFlight = 0;
  private accepting = true;

  private options: MockDaemonOptions;

  constructor(options: MockDaemonOptions = {}) {
    this.options = options;
    this.socketPath = path.join(os.tmpdir(), `ults-mock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  }

  async listen(): Promise<void> {
    this.server = net.createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  /** Stop accepting new connections; existing lanes stay alive. */
  stopAccepting(): void {
    this.accepting = false;
    this.server?.close();
  }

  private handleConnection(sock: net.Socket): void {
    if (!this.accepting) {
      sock.destroy();
      return;
    }
    const lane = ++this.laneSeq;
    this.lanesSeen.add(lane);
    this.openConnections++;
    this.sockets.add(sock);
    sock.on("close", () => {
      this.openConnections--;
      this.sockets.delete(sock);
    });

    let buffer = "";
    let queue = Promise.resolve();
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let req: any;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        queue = queue.then(() => this.respond(sock, lane, req));
      }
    });
  }

  private async respond(sock: net.Socket, lane: number, req: any): Promise<void> {
    const hit = this.requests.length + 1;
    const ctx = { lane, hit };
    this.requests.push({ payload: req, lane, at: Date.now() });
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);

    try {
      const delay = typeof this.options.delayMs === "function" ? this.options.delayMs(req, ctx) : this.options.delayMs ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const reply = this.options.reply ? await this.options.reply(req, ctx) : this.defaultReply(req);
      if (!sock.destroyed) sock.write(JSON.stringify({ ...reply, id: req.id }) + "\n");
    } catch {
      if (!sock.destroyed) sock.write(JSON.stringify({ ok: false, id: req.id, error: "mock reply failed" }) + "\n");
    } finally {
      this.inFlight--;
    }
  }

  private defaultReply(req: any): any {
    if (req.op === "search" || req.op === "recent") return { ok: true, hits: [] };
    if (req.op === "grep" || req.op === "multi_grep") return { ok: true, files: [] };
    return { ok: true };
  }

  countOps(op: string): number {
    return this.requests.filter((r) => r.payload.op === op).length;
  }

  ops(): any[] {
    return this.requests.map((r) => r.payload);
  }

  lastOp(op: string): any {
    return [...this.requests].reverse().find((r) => r.payload.op === op)?.payload ?? null;
  }

  async close(): Promise<void> {
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {}
  }
}
