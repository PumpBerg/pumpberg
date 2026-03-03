// ── Position manager: tracks open/closed positions, P&L, and persistence ──

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Position, ExitReason } from "./types.js";

/**
 * Tracks all open and recently closed positions.
 * Persists to a JSON file so positions survive restarts.
 */
export class PositionManager {
  private positions = new Map<string, Position>();
  private closedPositions: Position[] = [];
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, "positions.json");
    this.load();
  }

  // ────────────────────── Position lifecycle ──────────────────────

  /** Open a new position after a successful buy */
  openPosition(params: {
    mint: string;
    symbol: string;
    name: string;
    entrySol: number;
    tokenAmount: number;
    entryPrice: number;
    txSignature?: string;
    dryRun?: boolean;
  }): Position {
    const now = Date.now();
    const pos: Position = {
      id: randomUUID(),
      mint: params.mint,
      symbol: params.symbol,
      name: params.name,
      entrySol: params.entrySol,
      tokenAmount: params.tokenAmount,
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      peakPrice: params.entryPrice,
      unrealizedPnlSol: 0,
      unrealizedPnlPct: 0,
      status: "open",
      remainingRatio: 1.0,
      totalExitSol: 0,
      realizedPnlSol: 0,
      openedAt: now,
      entryTxSignature: params.txSignature,
      exitTxSignatures: [],
      trailingStopPrice: 0,
      dryRun: params.dryRun ?? false,
    };

    this.positions.set(params.mint, pos);
    this.persist();
    return pos;
  }

  /** Update the current price and P&L for a position */
  updatePrice(mint: string, currentPrice: number): Position | undefined {
    const pos = this.positions.get(mint);
    if (!pos || pos.status === "closed") return undefined;

    pos.currentPrice = currentPrice;

    // Update peak
    if (currentPrice > pos.peakPrice) {
      pos.peakPrice = currentPrice;
    }

    // Calculate unrealized P&L
    const currentValue = pos.tokenAmount * pos.remainingRatio * currentPrice;
    const costBasis = pos.entrySol * pos.remainingRatio;
    pos.unrealizedPnlSol = currentValue - costBasis;
    pos.unrealizedPnlPct = costBasis > 0 ? pos.unrealizedPnlSol / costBasis : 0;

    return pos;
  }

  /** Record a partial exit (sell some tokens) */
  recordPartialExit(
    mint: string,
    exitRatio: number,
    solReceived: number,
    reason: ExitReason,
    txSignature?: string,
  ): Position | undefined {
    const pos = this.positions.get(mint);
    if (!pos) return undefined;

    const exitedPortion = pos.remainingRatio * exitRatio;
    const costBasis = pos.entrySol * exitedPortion;

    pos.totalExitSol += solReceived;
    pos.realizedPnlSol += solReceived - costBasis;
    pos.remainingRatio -= exitedPortion;
    pos.status = pos.remainingRatio <= 0.01 ? "closed" : "partial-exit";
    if (txSignature) pos.exitTxSignatures.push(txSignature);

    if (pos.status === "closed") {
      pos.closedAt = Date.now();
      pos.exitReason = reason;
      pos.remainingRatio = 0;
      this.closedPositions.push({ ...pos });
      this.positions.delete(mint);
    }

    this.persist();
    return pos;
  }

  /** Record a full exit */
  recordFullExit(
    mint: string,
    solReceived: number,
    reason: ExitReason,
    txSignature?: string,
  ): Position | undefined {
    return this.recordPartialExit(mint, 1.0, solReceived, reason, txSignature);
  }

  /** Set trailing stop price for a position */
  setTrailingStop(mint: string, stopPrice: number): void {
    const pos = this.positions.get(mint);
    if (pos) {
      pos.trailingStopPrice = stopPrice;
    }
  }

  // ────────────────────── Queries ──────────────────────

  getOpenPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status !== "closed");
  }

  getPosition(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  hasPosition(mint: string): boolean {
    return this.positions.has(mint);
  }

  getOpenPositionCount(): number {
    return this.getOpenPositions().length;
  }

  getTotalExposureSol(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      if (pos.status !== "closed") {
        total += pos.entrySol * pos.remainingRatio;
      }
    }
    return total;
  }

  getClosedPositions(limit = 50, filterDryRun?: boolean): Position[] {
    const filtered = filterDryRun === undefined
      ? this.closedPositions
      : this.closedPositions.filter((p) => Boolean(p.dryRun) === filterDryRun);
    return filtered.slice(-limit);
  }

  /** Aggregate stats across closed positions, optionally filtered by mode and/or session start time */
  getStats(filterDryRun?: boolean, sinceTimestamp?: number): {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalRealizedPnl: number;
    bestTrade: number;
    worstTrade: number;
    avgHoldTimeSec: number;
  } {
    let closed = filterDryRun === undefined
      ? this.closedPositions
      : this.closedPositions.filter((p) => Boolean(p.dryRun) === filterDryRun);
    if (sinceTimestamp) {
      closed = closed.filter((p) => p.openedAt >= sinceTimestamp);
    }
    const wins = closed.filter((p) => p.realizedPnlSol > 0).length;
    const losses = closed.filter((p) => p.realizedPnlSol <= 0).length;
    const pnls = closed.map((p) => p.realizedPnlSol);
    const holdTimes = closed
      .filter((p) => p.closedAt)
      .map((p) => ((p.closedAt ?? p.openedAt) - p.openedAt) / 1_000);

    return {
      totalTrades: closed.length,
      wins,
      losses,
      winRate: closed.length > 0 ? wins / closed.length : 0,
      totalRealizedPnl: pnls.reduce((a, b) => a + b, 0),
      bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
      avgHoldTimeSec: holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0,
    };
  }

  // ────────────────────── Persistence ──────────────────────

  private persist(): void {
    try {
      const data = {
        open: [...this.positions.values()].map(serializePosition),
        closed: this.closedPositions.slice(-200).map(serializePosition), // keep last 200
      };
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[pump-trader] Failed to persist positions:", err);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, "utf-8");
      const data = JSON.parse(raw) as {
        open: SerializedPosition[];
        closed: SerializedPosition[];
      };

      for (const sp of data.open ?? []) {
        const pos = deserializePosition(sp);
        this.positions.set(pos.mint, pos);
      }
      const rawClosed = (data.closed ?? []).map(deserializePosition);

      // Sanitize: remove corrupted positions where realized P&L exceeds 100x entry
      // (caused by a legacy bug that returned token counts as SOL amounts)
      let needsPersist = false;
      const validClosed = rawClosed.filter((p) => {
        if (p.entrySol > 0 && Math.abs(p.realizedPnlSol) > p.entrySol * 100) {
          console.warn(
            `[pump-trader] Discarding corrupted position ${p.symbol} (${p.mint.slice(0, 8)}): ` +
            `realizedPnlSol=${p.realizedPnlSol.toFixed(2)} on entrySol=${p.entrySol}`,
          );
          needsPersist = true;
          return false;
        }
        return true;
      });
      if (validClosed.length < rawClosed.length) {
        console.warn(
          `[pump-trader] Removed ${rawClosed.length - validClosed.length} corrupted closed position(s)`,
        );
      }

      // Back-fill dryRun flag on legacy positions that lack it
      for (const p of [...this.positions.values(), ...validClosed]) {
        if (p.dryRun === undefined) {
          p.dryRun = (p.entryTxSignature ?? "").startsWith("dry-run-");
          needsPersist = true;
        }
      }

      this.closedPositions = validClosed;

      console.log(
        `[pump-trader] Loaded ${this.positions.size} open, ${this.closedPositions.length} closed positions`,
      );

      // Persist cleaned data back to disk
      if (needsPersist) {
        this.persist();
        console.log("[pump-trader] Persisted sanitized positions to disk");
      }
    } catch (err) {
      console.error("[pump-trader] Failed to load positions:", err);
    }
  }
}

// ── Serialization helpers (Set → array for JSON) ──

type SerializedPosition = Omit<Position, never>;

function serializePosition(pos: Position): SerializedPosition {
  return { ...pos };
}

function deserializePosition(sp: SerializedPosition): Position {
  return { ...sp };
}
