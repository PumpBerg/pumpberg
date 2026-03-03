// ── Pumpberg Points System: Proof of Data mining rewards ──
//
// Users earn points by contributing verified trade data.
// Points are quality-weighted — more signals = higher reward.
// Points accumulate locally and are tracked server-side for the leaderboard.
// Periodic airdrops of $PUMPBERG token are distributed based on points.

import type { TradeEntry } from "./trade-journal.js";
import type { RAGTradeRecord } from "./rag/types.js";
import fs from "node:fs";
import path from "node:path";

// ── Points calculation weights ──
const BASE_POINTS = 1.0;                   // Every verified trade gets 1 point
const SOCIAL_SIGNAL_BONUS = 0.5;           // Trade had social scanner data
const SMART_MONEY_BONUS = 0.5;             // Trade had smart money signal
const POST_SALE_BONUS = 1.0;               // Trade has post-sale monitoring data
const CREATOR_REP_BONUS = 0.25;            // Trade contributed creator reputation data
const WHALE_DATA_BONUS = 0.25;             // Trade had whale detection data
const LIVE_TRADE_BONUS = 0.5;              // Live trade (not dry-run) — higher quality
const MAX_POINTS_PER_TRADE = 4.0;          // Cap per trade

export interface PointsEntry {
  tradeId: string;
  mint: string;
  symbol: string;
  timestamp: number;
  basePoints: number;
  bonuses: string[];
  totalPoints: number;
  verified: boolean;         // On-chain verification passed
  entryTxSignature?: string;
  exitTxSignatures?: string[];
}

export interface PointsSummary {
  totalPoints: number;
  totalTrades: number;
  verifiedTrades: number;
  unverifiedTrades: number;
  averagePointsPerTrade: number;
  rank?: number;              // From leaderboard (filled by sync server)
  walletAddress?: string;
  entries: PointsEntry[];
}

const POINTS_FILE = "points.json";

export class PointsTracker {
  private entries: PointsEntry[] = [];
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, POINTS_FILE);
    this.load();
  }

  /** Calculate and record points for a completed trade */
  recordTrade(trade: TradeEntry | RAGTradeRecord, isDryRun: boolean = false): PointsEntry {
    const bonuses: string[] = [];
    let points = BASE_POINTS;

    // Social signal bonus
    const socialScore = "socialScore" in trade ? (trade.socialScore ?? 0) : 0;
    if (socialScore > 0) {
      points += SOCIAL_SIGNAL_BONUS;
      bonuses.push("social");
    }

    // Smart money bonus
    const smartMoneyRank = "smartMoneyRank" in trade ? (trade.smartMoneyRank ?? 0) : 0;
    if (smartMoneyRank > 0) {
      points += SMART_MONEY_BONUS;
      bonuses.push("smart-money");
    }

    // Post-sale monitoring bonus
    const postSaleVerdict = "postSaleVerdict" in trade ? (trade as TradeEntry).postSaleVerdict : undefined;
    if (postSaleVerdict) {
      points += POST_SALE_BONUS;
      bonuses.push("post-sale");
    }

    // Creator reputation bonus
    const creatorRep = "creatorReputation" in trade ? (trade.creatorReputation ?? 0) : 0;
    if (creatorRep !== 0) {
      points += CREATOR_REP_BONUS;
      bonuses.push("creator-rep");
    }

    // Whale data bonus
    const whaleCount = "whaleCount" in trade ? (trade.whaleCount ?? 0) : 0;
    if (whaleCount > 0) {
      points += WHALE_DATA_BONUS;
      bonuses.push("whale-data");
    }

    // Live trade bonus (not dry-run)
    if (!isDryRun) {
      points += LIVE_TRADE_BONUS;
      bonuses.push("live-trade");
    }

    // Cap points
    points = Math.min(points, MAX_POINTS_PER_TRADE);

    const entry: PointsEntry = {
      tradeId: "id" in trade ? trade.id : `${trade.mint}-${trade.timestamp}`,
      mint: trade.mint,
      symbol: trade.symbol,
      timestamp: Date.now(),
      basePoints: BASE_POINTS,
      bonuses,
      totalPoints: Math.round(points * 100) / 100,
      verified: false,
      entryTxSignature: "entryTxSignature" in trade ? trade.entryTxSignature : undefined,
      exitTxSignatures: "exitTxSignatures" in trade ? trade.exitTxSignatures : undefined,
    };

    this.entries.push(entry);
    this.persist();
    return entry;
  }

  /** Mark a trade as verified (tx confirmed on-chain) */
  markVerified(tradeId: string): void {
    const entry = this.entries.find(e => e.tradeId === tradeId);
    if (entry) {
      entry.verified = true;
      this.persist();
    }
  }

  /** Get the full points summary */
  getSummary(): PointsSummary {
    const totalPoints = this.entries.reduce((sum, e) => sum + e.totalPoints, 0);
    const verifiedTrades = this.entries.filter(e => e.verified).length;

    return {
      totalPoints: Math.round(totalPoints * 100) / 100,
      totalTrades: this.entries.length,
      verifiedTrades,
      unverifiedTrades: this.entries.length - verifiedTrades,
      averagePointsPerTrade: this.entries.length > 0
        ? Math.round((totalPoints / this.entries.length) * 100) / 100
        : 0,
      entries: this.entries.slice(-100), // Last 100 entries
    };
  }

  /** Get total points */
  getTotalPoints(): number {
    return Math.round(this.entries.reduce((sum, e) => sum + e.totalPoints, 0) * 100) / 100;
  }

  /** Get verified points only (for airdrop eligibility) */
  getVerifiedPoints(): number {
    return Math.round(
      this.entries
        .filter(e => e.verified)
        .reduce((sum, e) => sum + e.totalPoints, 0) * 100
    ) / 100;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, "utf-8");
        this.entries = JSON.parse(raw);
      }
    } catch (err) {
      console.error("[points] Failed to load points:", err);
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch (err) {
      console.error("[points] Failed to persist points:", err);
    }
  }
}
