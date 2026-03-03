// ── Smart Money Tracker: identifies and follows top profitable traders ──
// Passively observes all trade events to build wallet performance profiles.
// Identifies the top 5 most consistent & profitable traders over a 7-day window.
// When a top wallet buys a new token, fires a signal for the agent to consider.
// Excludes "lucky whales" — wallets with few large trades are filtered out.

import { logger } from "./logger.js";

// ── Configuration ──
const WALLET_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
const TOP_WALLET_COUNT = 5;
const MIN_COMPLETED_TRADES = 10; // Must have 10+ round-trips to qualify
const MIN_TOTAL_TRADES = 15; // Must have 15+ total trades
const MIN_WIN_RATE = 0.4; // Must have >40% win rate
const MAX_SINGLE_TRADE_PNL_PCT = 0.40; // No single trade can be >40% of total PnL
const RANK_REFRESH_INTERVAL_MS = 5 * 60 * 1_000; // Re-rank every 5 minutes
const SIGNAL_MAX_AGE_MS = 120_000; // Signals older than 2 minutes are stale
const MAX_SIGNALS_KEPT = 50;
const PRUNE_INTERVAL_MS = 30 * 60 * 1_000; // Prune inactive wallets every 30 min

// ── Types ──

/** Per-token position tracking for a single wallet */
interface WalletTokenPosition {
  totalBuySol: number;
  totalBuyTokens: number;
  avgEntryPrice: number;
  totalSellSol: number;
  totalSellTokens: number;
  firstBuyAt: number;
  lastTradeAt: number;
}

/** Aggregated stats for a single wallet */
interface WalletProfile {
  wallet: string;
  tokenPositions: Map<string, WalletTokenPosition>;
  totalTrades: number;
  completedRoundTrips: number; // number of sell events with prior buys (win/loss counted)
  wins: number;
  losses: number;
  totalPnlSol: number;
  largestSinglePnlSol: number; // abs value of biggest single-trade PnL
  tradeTimestamps: number[];
  lastActiveAt: number;
}

/** Signal fired when a top wallet buys a new token */
export interface SmartMoneySignal {
  wallet: string;
  mint: string;
  symbol: string;
  solAmount: number;
  walletWinRate: number;
  walletTotalTrades: number;
  walletCompletedRoundTrips: number;
  walletPnlSol: number;
  walletConsistencyScore: number;
  walletRank: number; // 1-based
  timestamp: number;
  type: "buy" | "sell";
}

/** Dashboard/agent stats */
export interface SmartMoneyStats {
  totalWalletsTracked: number;
  qualifiedWallets: number;
  topWallets: Array<{
    wallet: string; // truncated for display
    walletFull: string;
    winRate: number;
    totalTrades: number;
    completedRoundTrips: number;
    totalPnlSol: number;
    consistencyScore: number;
    lastActive: string;
  }>;
  recentSignals: SmartMoneySignal[];
}

// ── Main Class ──

export class SmartMoneyTracker {
  private wallets = new Map<string, WalletProfile>();
  private topWallets: string[] = [];
  private topWalletScores = new Map<string, number>();
  private recentSignals: SmartMoneySignal[] = [];
  private rankTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private excludedWallets = new Set<string>();

  /** Callback when a top wallet buys a new token */
  onSmartMoneyBuy?: (signal: SmartMoneySignal) => void;
  /** Callback when a top wallet sells a token we might be holding */
  onSmartMoneySell?: (signal: SmartMoneySignal) => void;

  constructor(ownWalletPubkey: string) {
    // Never track our own wallet
    this.excludedWallets.add(ownWalletPubkey);
  }

  start(): void {
    // Re-rank wallets periodically
    this.rankTimer = setInterval(() => this.rerank(), RANK_REFRESH_INTERVAL_MS);
    // Prune inactive wallets periodically
    this.pruneTimer = setInterval(() => this.pruneOldWallets(), PRUNE_INTERVAL_MS);
    logger.system("🧠 Smart Money Tracker started — building wallet profiles from live trade data");
  }

  stop(): void {
    if (this.rankTimer) { clearInterval(this.rankTimer); this.rankTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
  }

  /** Exclude a wallet from tracking (e.g. known bots) */
  excludeWallet(wallet: string): void {
    this.excludedWallets.add(wallet);
    this.wallets.delete(wallet);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Trade Processing ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Process a trade event to update wallet profiles.
   * Called for EVERY trade flowing through PumpApi.
   */
  recordTrade(
    traderWallet: string,
    mint: string,
    symbol: string,
    txType: "buy" | "sell",
    solAmount: number,
    tokenAmount: number,
  ): void {
    if (this.excludedWallets.has(traderWallet)) return;
    if (solAmount <= 0 || tokenAmount <= 0) return;

    const now = Date.now();

    // Get or create wallet profile
    let profile = this.wallets.get(traderWallet);
    if (!profile) {
      profile = {
        wallet: traderWallet,
        tokenPositions: new Map(),
        totalTrades: 0,
        completedRoundTrips: 0,
        wins: 0,
        losses: 0,
        totalPnlSol: 0,
        largestSinglePnlSol: 0,
        tradeTimestamps: [],
        lastActiveAt: now,
      };
      this.wallets.set(traderWallet, profile);
    }

    profile.totalTrades++;
    profile.lastActiveAt = now;
    profile.tradeTimestamps.push(now);

    // Get or create per-token position
    let pos = profile.tokenPositions.get(mint);
    if (!pos) {
      pos = {
        totalBuySol: 0, totalBuyTokens: 0, avgEntryPrice: 0,
        totalSellSol: 0, totalSellTokens: 0,
        firstBuyAt: now, lastTradeAt: now,
      };
      profile.tokenPositions.set(mint, pos);
    }
    pos.lastTradeAt = now;

    if (txType === "buy") {
      const isFirstBuyOnToken = pos.totalBuyTokens === 0;

      // Update position
      pos.totalBuySol += solAmount;
      pos.totalBuyTokens += tokenAmount;
      pos.avgEntryPrice = pos.totalBuySol / pos.totalBuyTokens;

      if (isFirstBuyOnToken) {
        pos.firstBuyAt = now;
      }

      // ── Smart money signal: top wallet's first buy on a new token ──
      if (isFirstBuyOnToken && this.topWallets.includes(traderWallet)) {
        const rank = this.topWallets.indexOf(traderWallet) + 1;
        const winRate = profile.completedRoundTrips > 0
          ? profile.wins / profile.completedRoundTrips
          : 0;

        const signal: SmartMoneySignal = {
          wallet: traderWallet,
          mint,
          symbol: symbol || mint.slice(0, 8),
          solAmount,
          walletWinRate: winRate,
          walletTotalTrades: profile.totalTrades,
          walletCompletedRoundTrips: profile.completedRoundTrips,
          walletPnlSol: profile.totalPnlSol,
          walletConsistencyScore: this.topWalletScores.get(traderWallet) ?? 0,
          walletRank: rank,
          timestamp: now,
          type: "buy",
        };

        this.recentSignals.push(signal);
        if (this.recentSignals.length > MAX_SIGNALS_KEPT) {
          this.recentSignals = this.recentSignals.slice(-MAX_SIGNALS_KEPT);
        }

        logger.info("SMART_MONEY",
          `🐋 Top #${rank} wallet BOUGHT ${symbol || mint.slice(0, 8)}! ` +
          `WR: ${(winRate * 100).toFixed(0)}%, ${profile.completedRoundTrips} trades, ` +
          `P&L: ${profile.totalPnlSol >= 0 ? "+" : ""}${profile.totalPnlSol.toFixed(3)} SOL`,
          { wallet: traderWallet.slice(0, 12), mint, symbol, solAmount, rank });

        // Fire callback for scanner integration
        if (this.onSmartMoneyBuy) {
          try { this.onSmartMoneyBuy(signal); } catch (err) {
            logger.error("SMART_MONEY", `Signal callback error: ${err}`);
          }
        }
      }
    } else {
      // ── SELL: compute realized PnL ──
      pos.totalSellSol += solAmount;
      pos.totalSellTokens += tokenAmount;

      // ── Smart money SELL signal: top wallet dumping a token ──
      if (this.topWallets.includes(traderWallet)) {
        const rank = this.topWallets.indexOf(traderWallet) + 1;
        const winRate = profile.completedRoundTrips > 0
          ? profile.wins / profile.completedRoundTrips
          : 0;

        const sellSignal: SmartMoneySignal = {
          wallet: traderWallet,
          mint,
          symbol: symbol || mint.slice(0, 8),
          solAmount,
          walletWinRate: winRate,
          walletTotalTrades: profile.totalTrades,
          walletCompletedRoundTrips: profile.completedRoundTrips,
          walletPnlSol: profile.totalPnlSol,
          walletConsistencyScore: this.topWalletScores.get(traderWallet) ?? 0,
          walletRank: rank,
          timestamp: now,
          type: "sell",
        };

        this.recentSignals.push(sellSignal);
        if (this.recentSignals.length > MAX_SIGNALS_KEPT) {
          this.recentSignals = this.recentSignals.slice(-MAX_SIGNALS_KEPT);
        }

        logger.info("SMART_MONEY",
          `🐋🔴 Top #${rank} wallet SOLD ${symbol || mint.slice(0, 8)}! ` +
          `${solAmount.toFixed(3)} SOL — EXIT SIGNAL`,
          { wallet: traderWallet.slice(0, 12), mint, symbol, solAmount, rank });

        if (this.onSmartMoneySell) {
          try { this.onSmartMoneySell(sellSignal); } catch (err) {
            logger.error("SMART_MONEY", `Sell signal callback error: ${err}`);
          }
        }
      }

      // Only count as round-trip if we had prior buys
      if (pos.avgEntryPrice > 0 && pos.totalBuyTokens > 0) {
        const sellPrice = solAmount / tokenAmount;
        const costBasis = tokenAmount * pos.avgEntryPrice;
        const pnlSol = solAmount - costBasis;

        profile.completedRoundTrips++;
        profile.totalPnlSol += pnlSol;

        if (Math.abs(pnlSol) > Math.abs(profile.largestSinglePnlSol)) {
          profile.largestSinglePnlSol = pnlSol;
        }

        if (pnlSol > 0) {
          profile.wins++;
        } else {
          profile.losses++;
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Ranking ──
  // ══════════════════════════════════════════════════════════════════════════

  /** Re-rank wallets by consistency score. Called every 5 minutes. */
  private rerank(): void {
    const scored: Array<{ wallet: string; score: number; profile: WalletProfile }> = [];

    for (const [wallet, profile] of this.wallets) {
      // ── Filter: minimum trade history ──
      if (profile.completedRoundTrips < MIN_COMPLETED_TRADES) continue;
      if (profile.totalTrades < MIN_TOTAL_TRADES) continue;

      const winRate = profile.wins / Math.max(1, profile.completedRoundTrips);

      // ── Filter: must be profitable & above min win rate ──
      if (profile.totalPnlSol <= 0) continue;
      if (winRate < MIN_WIN_RATE) continue;

      // ── Filter: exclude "one lucky trade" wallets ──
      // If their largest single trade is > 40% of total PnL, they're just lucky
      if (profile.largestSinglePnlSol > 0 && profile.totalPnlSol > 0) {
        const singleTradeConcentration = profile.largestSinglePnlSol / profile.totalPnlSol;
        if (singleTradeConcentration > MAX_SINGLE_TRADE_PNL_PCT) continue;
      }

      // ── Consistency Score ──
      // Rewards: high win rate, many trades (log scale), profitable trades
      // Formula: winRate * log2(roundTrips + 1) * (1 + clamp(avgPnlPerTrade, 0, 5))
      const avgPnlPerTrade = profile.totalPnlSol / profile.completedRoundTrips;
      const score = winRate
        * Math.log2(profile.completedRoundTrips + 1)
        * (1 + Math.min(Math.max(avgPnlPerTrade, 0), 5));

      scored.push({ wallet, score, profile });
    }

    scored.sort((a, b) => b.score - a.score);
    const newTop = scored.slice(0, TOP_WALLET_COUNT).map((s) => s.wallet);

    // Detect changes
    const added = newTop.filter((w) => !this.topWallets.includes(w));
    const removed = this.topWallets.filter((w) => !newTop.includes(w));

    // Update scores map
    this.topWalletScores.clear();
    for (const s of scored.slice(0, TOP_WALLET_COUNT)) {
      this.topWalletScores.set(s.wallet, s.score);
    }

    if (added.length > 0 || removed.length > 0 || this.topWallets.length !== newTop.length) {
      this.topWallets = newTop;

      if (newTop.length > 0) {
        logger.info("SMART_MONEY", `🧠 Top ${newTop.length} wallets updated (${this.wallets.size} total tracked)`, {
          added: added.length, removed: removed.length,
        });
        for (let i = 0; i < scored.length && i < TOP_WALLET_COUNT; i++) {
          const s = scored[i]!;
          const wr = (s.profile.wins / Math.max(1, s.profile.completedRoundTrips) * 100).toFixed(0);
          logger.info("SMART_MONEY",
            `  #${i + 1}: ${s.wallet.slice(0, 12)}... | WR: ${wr}% | ` +
            `Trades: ${s.profile.completedRoundTrips} | ` +
            `P&L: ${s.profile.totalPnlSol >= 0 ? "+" : ""}${s.profile.totalPnlSol.toFixed(3)} SOL | ` +
            `Score: ${s.score.toFixed(2)}`);
        }
      }
    } else {
      this.topWallets = newTop;
    }
  }

  /** Prune wallets inactive for >7 days to limit memory usage */
  private pruneOldWallets(): void {
    const cutoff = Date.now() - WALLET_RETENTION_MS;
    let pruned = 0;
    for (const [wallet, profile] of this.wallets) {
      if (profile.lastActiveAt < cutoff) {
        this.wallets.delete(wallet);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.debug("SMART_MONEY", `Pruned ${pruned} inactive wallets, ${this.wallets.size} remaining`);
    }

    // Also prune old trade timestamps to save memory
    const tsCutoff = Date.now() - WALLET_RETENTION_MS;
    for (const [, profile] of this.wallets) {
      profile.tradeTimestamps = profile.tradeTimestamps.filter((t) => t > tsCutoff);
      // Prune token positions with no recent activity
      for (const [mint, pos] of profile.tokenPositions) {
        if (pos.lastTradeAt < tsCutoff) {
          profile.tokenPositions.delete(mint);
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Public Accessors ──
  // ══════════════════════════════════════════════════════════════════════════

  /** Get current top wallet addresses (for WS subscription) */
  getTopWallets(): string[] {
    return [...this.topWallets];
  }

  /** Check if a wallet is in the top list */
  isTopWallet(wallet: string): boolean {
    return this.topWallets.includes(wallet);
  }

  /** Get recent smart money buy signals */
  getRecentSignals(maxAgeMs = SIGNAL_MAX_AGE_MS): SmartMoneySignal[] {
    const cutoff = Date.now() - maxAgeMs;
    return this.recentSignals.filter((s) => s.timestamp > cutoff);
  }

  /** Get stats for dashboard and agent prompts */
  getStats(): SmartMoneyStats {
    const scored: Array<{ wallet: string; score: number; profile: WalletProfile }> = [];
    for (const [wallet, p] of this.wallets) {
      if (p.completedRoundTrips < MIN_COMPLETED_TRADES) continue;
      if (p.totalPnlSol <= 0) continue;
      const winRate = p.wins / Math.max(1, p.completedRoundTrips);
      if (winRate < MIN_WIN_RATE) continue;
      const avgPnl = p.totalPnlSol / p.completedRoundTrips;
      const score = winRate * Math.log2(p.completedRoundTrips + 1) * (1 + Math.min(Math.max(avgPnl, 0), 5));
      scored.push({ wallet, score, profile: p });
    }
    scored.sort((a, b) => b.score - a.score);

    return {
      totalWalletsTracked: this.wallets.size,
      qualifiedWallets: scored.length,
      topWallets: scored.slice(0, TOP_WALLET_COUNT).map((s) => ({
        wallet: s.wallet.slice(0, 12) + "...",
        walletFull: s.wallet,
        winRate: s.profile.wins / Math.max(1, s.profile.completedRoundTrips),
        totalTrades: s.profile.totalTrades,
        completedRoundTrips: s.profile.completedRoundTrips,
        totalPnlSol: s.profile.totalPnlSol,
        consistencyScore: s.score,
        lastActive: `${Math.round((Date.now() - s.profile.lastActiveAt) / 1000)}s ago`,
      })),
      recentSignals: this.recentSignals.slice(-10),
    };
  }

  /** Get a text briefing for agent prompts */
  getBriefing(): string {
    const stats = this.getStats();

    if (stats.topWallets.length === 0) {
      return `═══ SMART MONEY TRACKER ═══\nTracking ${stats.totalWalletsTracked} wallets — no qualified top traders yet (need ${MIN_COMPLETED_TRADES}+ completed round-trip trades with >40% WR).\n`;
    }

    let briefing = `═══ SMART MONEY TRACKER ═══\nTracking ${stats.totalWalletsTracked} wallets | ${stats.qualifiedWallets} qualified as consistently profitable.\n\nTOP ${stats.topWallets.length} MOST CONSISTENT PROFITABLE TRADERS (7-day):\n`;

    for (const [i, w] of stats.topWallets.entries()) {
      briefing += `  #${i + 1}: ${w.wallet} | WR: ${(w.winRate * 100).toFixed(0)}% | ` +
        `Round-trips: ${w.completedRoundTrips} | ` +
        `P&L: ${w.totalPnlSol >= 0 ? "+" : ""}${w.totalPnlSol.toFixed(3)} SOL | ` +
        `Score: ${w.consistencyScore.toFixed(2)} | ` +
        `Active: ${w.lastActive}\n`;
    }

    const signals = this.getRecentSignals();
    const buySignals = signals.filter((s) => s.type === "buy");
    const sellSignals = signals.filter((s) => s.type === "sell");

    if (buySignals.length > 0) {
      briefing += `\n🐋 RECENT SMART MONEY BUYS (last 2 min):\n`;
      for (const s of buySignals) {
        const ago = Math.round((Date.now() - s.timestamp) / 1000);
        briefing += `  Top #${s.walletRank} (WR: ${(s.walletWinRate * 100).toFixed(0)}%, ` +
          `${s.walletCompletedRoundTrips} trades) bought ${s.symbol} ` +
          `(${s.solAmount.toFixed(3)} SOL) ${ago}s ago\n` +
          `    Mint: ${s.mint}\n`;
      }
      briefing += `\n⚡ Smart money buys are HIGH-PRIORITY signals — these wallets have proven track records.\n`;
    }

    if (sellSignals.length > 0) {
      briefing += `\n🐋🔴 RECENT SMART MONEY SELLS (last 2 min):\n`;
      for (const s of sellSignals) {
        const ago = Math.round((Date.now() - s.timestamp) / 1000);
        briefing += `  Top #${s.walletRank} (WR: ${(s.walletWinRate * 100).toFixed(0)}%, ` +
          `${s.walletCompletedRoundTrips} trades) sold ${s.symbol} ` +
          `(${s.solAmount.toFixed(3)} SOL) ${ago}s ago\n` +
          `    Mint: ${s.mint}\n`;
      }
      briefing += `\n⚠️ Smart money sells are EXIT signals — if holding the same token, consider selling.\n`;
    }

    return briefing;
  }

  /** Compact briefing for token review prompts (~100 tokens vs ~377) */
  getCompactBriefing(): string {
    const stats = this.getStats();
    if (stats.topWallets.length === 0) {
      return `SMART MONEY: Tracking ${stats.totalWalletsTracked} wallets, no qualified traders yet.`;
    }

    const lines: string[] = [];
    lines.push(`SMART MONEY: ${stats.qualifiedWallets} qualified of ${stats.totalWalletsTracked} tracked`);

    // Recent signals only (most actionable)
    const signals = this.getRecentSignals();
    const buys = signals.filter(s => s.type === "buy");
    const sells = signals.filter(s => s.type === "sell");

    if (buys.length > 0) {
      for (const s of buys.slice(0, 3)) {
        const ago = Math.round((Date.now() - s.timestamp) / 1000);
        lines.push(`  🐋 #${s.walletRank} (${(s.walletWinRate * 100).toFixed(0)}%WR) bought ${s.symbol} ${ago}s ago`);
      }
    }
    if (sells.length > 0) {
      for (const s of sells.slice(0, 3)) {
        const ago = Math.round((Date.now() - s.timestamp) / 1000);
        lines.push(`  🐋🔴 #${s.walletRank} sold ${s.symbol} ${ago}s ago`);
      }
    }

    return lines.join("\n");
  }
}
