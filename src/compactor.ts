import { FSearchClient } from "./client.ts";
import { recordAudit } from "./telemetry.ts";

export interface CompactionStats {
  timestamp: number;
  entries: number;
  overlay: number;
  removed: number;
  segments: number;
  durationMs: number;
  automated: boolean;
}

const compactionHistory: CompactionStats[] = [];

export class LsmCompactor {
  private client: FSearchClient;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isCompacting = false;
  private overlayThreshold: number;
  private checkIntervalMs: number;

  constructor(client?: FSearchClient, options: { overlayThreshold?: number; checkIntervalMs?: number } = {}) {
    this.client = client || new FSearchClient();
    this.overlayThreshold = options.overlayThreshold ?? 5000;
    this.checkIntervalMs = options.checkIntervalMs ?? 30000;
  }

  /**
   * Manually trigger LSM segment compaction and name index consolidation.
   */
  public async compact(automated = false): Promise<{ ok: boolean; stats?: CompactionStats; message: string }> {
    if (this.isCompacting) {
      return { ok: false, message: "Compaction already in progress" };
    }

    this.isCompacting = true;
    const start = performance.now();

    try {
      const beforeStatus = await this.client.status().catch(() => null);
      // Trigger engine.save() background compaction
      const res = await this.client.request({ op: "save" });

      // Allow background compaction worker to consolidate
      await new Promise((r) => setTimeout(r, 600));

      const afterStatus = await this.client.status().catch(() => null);
      const durationMs = Math.round((performance.now() - start) * 100) / 100;

      const stats: CompactionStats = {
        timestamp: Date.now(),
        entries: afterStatus?.entries ?? beforeStatus?.entries ?? 0,
        overlay: afterStatus?.overlay ?? 0,
        removed: afterStatus?.removed ?? 0,
        segments: afterStatus?.content_segments ?? beforeStatus?.content_segments ?? 0,
        durationMs,
        automated,
      };

      compactionHistory.push(stats);
      if (compactionHistory.length > 50) compactionHistory.shift();

      recordAudit({
        ts: Date.now(),
        tool: "fsearch_compact" as any,
        query: `compact (automated=${automated})`,
        ms: durationMs,
        ok: true,
        hitCount: stats.entries,
        source: "index",
        tokenCount: 0,
      });

      return {
        ok: res.ok === true || res.scheduled === true,
        stats,
        message: `Compacted in ${durationMs}ms (Entries: ${stats.entries.toLocaleString()}, Overlay: ${stats.overlay})`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Compaction failed: ${err.message}`,
      };
    } finally {
      this.isCompacting = false;
    }
  }

  /**
   * Start the automated LSM compaction supervisor loop.
   */
  public startAutoCompaction(): void {
    if (this.intervalTimer) return;

    this.intervalTimer = setInterval(async () => {
      try {
        const st = await this.client.status();
        // If overlay modifications or deletions exceed thresholds, run auto compaction
        if (st.overlay > this.overlayThreshold || st.removed > 10000) {
          await this.compact(true);
        }
      } catch {
        // Ignore background heartbeat errors
      }
    }, this.checkIntervalMs);

    // Unref so process doesn't hang if idle
    if (this.intervalTimer.unref) {
      this.intervalTimer.unref();
    }
  }

  /**
   * Stop automated compaction supervisor.
   */
  public stopAutoCompaction(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Return recent compaction history.
   */
  public getHistory(): CompactionStats[] {
    return [...compactionHistory];
  }
}
