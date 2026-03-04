// ── Data sync client ──
// Batches anonymized trade data and syncs to the central server.
// Handles offline resilience, retry with backoff, and pattern updates.

import fs from "node:fs";
import path from "node:path";
import type { RAGTradeRecord } from "../rag/types.ts";
import { anonymizeTrade, validatePayloadSafety } from "./anonymizer.ts";
import type {
  SyncTradePayload,
  SyncBatchRequest,
  SyncBatchResponse,
  SyncState,
  PatternUpdate,
} from "./types.ts";

const SYNC_STATE_FILE = "sync-state.json";
const SYNC_QUEUE_FILE = "sync-queue.json";
const SCHEMA_VERSION = 1;

// Sync config
const BATCH_SIZE = 10;                        // Max trades per sync batch
const SYNC_INTERVAL_MS = 5 * 60 * 1000;      // 5 minutes
const MIN_RETRY_DELAY_MS = 10 * 1000;         // 10 seconds
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;    // 30 minutes
const MAX_QUEUE_SIZE = 500;                    // Max pending trades before dropping oldest

export class SyncClient {
  private dataDir: string;
  private instanceId: string;
  private walletAddress: string | undefined;
  private serverUrl: string;
  private enabled: boolean;
  private state: SyncState;
  private queue: SyncTradePayload[];
  private syncTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    dataDir: string;
    instanceId: string;
    walletAddress?: string;
    serverUrl?: string;
    enabled?: boolean;
  }) {
    this.dataDir = opts.dataDir;
    this.instanceId = opts.instanceId;
    this.walletAddress = opts.walletAddress;
    this.serverUrl = opts.serverUrl || "";
    this.enabled = this.serverUrl ? (opts.enabled ?? false) : false;

    this.state = this.loadState();
    this.queue = this.loadQueue();
  }

  // ── Public API ──

  /** Start the background sync loop */
  start(): void {
    if (!this.enabled) {
      console.log("[sync] Data sharing disabled — not starting sync");
      return;
    }

    console.log(`[sync] Started — ${this.queue.length} pending, ${this.state.totalSynced} lifetime synced`);

    // Sync immediately if there are pending trades
    if (this.queue.length > 0) {
      this.scheduleSync(1000);
    }

    // Regular sync interval
    this.syncTimer = setInterval(() => {
      if (this.queue.length > 0) {
        this.flush().catch(console.error);
      }
    }, SYNC_INTERVAL_MS);
  }

  /** Stop the sync loop */
  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.syncTimer = null;
    this.retryTimer = null;
    this.persistQueue();
    this.persistState();
  }

  /** Queue a completed trade for sync */
  enqueue(record: RAGTradeRecord): void {
    if (!this.enabled) return;

    try {
      const payload = anonymizeTrade(record, this.instanceId, this.walletAddress);

      // Safety check — never sync if sensitive data leaked through
      if (!validatePayloadSafety(payload)) {
        console.error("[sync] SAFETY CHECK FAILED — payload contains sensitive data, not syncing");
        return;
      }

      this.queue.push(payload);

      // Trim queue if too large (drop oldest)
      if (this.queue.length > MAX_QUEUE_SIZE) {
        this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
      }

      this.state.pendingCount = this.queue.length;
      this.persistQueue();

      // Trigger sync if we have a batch ready
      if (this.queue.length >= BATCH_SIZE) {
        this.scheduleSync(1000);
      }
    } catch (err) {
      console.error("[sync] Failed to enqueue trade:", err);
    }
  }

  /** Force an immediate sync attempt */
  async flush(): Promise<SyncBatchResponse | null> {
    if (this.queue.length === 0) return null;

    const batch = this.queue.slice(0, BATCH_SIZE);

    const request: SyncBatchRequest = {
      instanceId: this.instanceId,
      schemaVersion: SCHEMA_VERSION,
      trades: batch,
    };

    try {
      const response = await this.sendBatch(request);

      if (response.ok) {
        // Remove synced trades from queue
        this.queue = this.queue.slice(batch.length);
        this.state.totalSynced += response.accepted;
        this.state.lastSyncedAt = Date.now();
        this.state.pendingCount = this.queue.length;
        this.state.consecutiveFailures = 0;

        if (batch.length > 0) {
          this.state.lastSyncedId = batch[batch.length - 1].mint;
        }

        // Check if server has newer patterns
        if (response.patternVersion && response.patternVersion > this.state.patternVersion) {
          this.pullPatterns().catch(console.error);
        }

        this.persistState();
        this.persistQueue();

        console.log(`[sync] ✅ Synced ${response.accepted} trades (${this.queue.length} pending, ${this.state.totalSynced} total)`);

        // If more trades pending, schedule another batch
        if (this.queue.length > 0) {
          this.scheduleSync(2000);
        }

        return response;
      } else {
        throw new Error(response.errors?.join(", ") || "Sync rejected");
      }
    } catch (err) {
      this.state.consecutiveFailures++;
      this.persistState();

      const delay = Math.min(
        MIN_RETRY_DELAY_MS * Math.pow(2, this.state.consecutiveFailures - 1),
        MAX_RETRY_DELAY_MS,
      );

      console.warn(`[sync] ❌ Failed (attempt ${this.state.consecutiveFailures}), retrying in ${Math.round(delay / 1000)}s: ${err}`);
      this.scheduleSync(delay);

      return null;
    }
  }

  /** Get sync statistics */
  getStats(): SyncState & { queueSize: number; enabled: boolean } {
    return {
      ...this.state,
      queueSize: this.queue.length,
      enabled: this.enabled,
    };
  }

  /** Enable/disable data sharing */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.syncTimer) {
      this.start();
    } else if (!enabled) {
      this.stop();
    }
  }

  // ── Private methods ──

  private scheduleSync(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.flush().catch(console.error);
    }, delayMs);
  }

  private async sendBatch(request: SyncBatchRequest): Promise<SyncBatchResponse> {
    const res = await fetch(`${this.serverUrl}/api/v1/trades/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Instance-Id": this.instanceId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    return (await res.json()) as SyncBatchResponse;
  }

  /** Pull updated patterns from central server */
  private async pullPatterns(): Promise<void> {
    try {
      const res = await fetch(`${this.serverUrl}/api/v1/patterns`, {
        headers: { "X-Instance-Id": this.instanceId },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return;

      const update = (await res.json()) as PatternUpdate;
      this.state.patternVersion = update.version;
      this.persistState();

      // Save patterns locally for the RAG system to use
      const patternsFile = path.join(this.dataDir, "global-patterns.json");
      fs.writeFileSync(patternsFile, JSON.stringify(update, null, 2), "utf-8");

      console.log(`[sync] 📥 Updated to pattern version ${update.version} (${update.patterns.length} patterns)`);
    } catch (err) {
      console.warn("[sync] Failed to pull patterns:", err);
    }
  }

  // ── Persistence ──

  private loadState(): SyncState {
    try {
      const filePath = path.join(this.dataDir, SYNC_STATE_FILE);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SyncState;
      }
    } catch {}

    return {
      lastSyncedId: "",
      lastSyncedAt: 0,
      pendingCount: 0,
      totalSynced: 0,
      patternVersion: 0,
      consecutiveFailures: 0,
    };
  }

  private persistState(): void {
    try {
      fs.writeFileSync(
        path.join(this.dataDir, SYNC_STATE_FILE),
        JSON.stringify(this.state, null, 2),
        "utf-8",
      );
    } catch {}
  }

  private loadQueue(): SyncTradePayload[] {
    try {
      const filePath = path.join(this.dataDir, SYNC_QUEUE_FILE);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SyncTradePayload[];
      }
    } catch {}
    return [];
  }

  private persistQueue(): void {
    try {
      fs.writeFileSync(
        path.join(this.dataDir, SYNC_QUEUE_FILE),
        JSON.stringify(this.queue),
        "utf-8",
      );
    } catch {}
  }
}
