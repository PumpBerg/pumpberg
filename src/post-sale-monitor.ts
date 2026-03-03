// ── Post-Sale Monitor ──
// Monitors tokens AFTER they've been sold to determine:
// 1. Was the exit too early? (missed opportunity — token pumped after we sold)
// 2. Was the exit well-timed? (token dumped further — stop-loss saved us)
// 3. What happened to the token over 10 minutes post-sale?
// This data feeds back into the trade journal and RAG for learning.

import { logger } from "./logger.js";

/** Result of monitoring a token after sale */
export interface PostSaleResult {
  mint: string;
  symbol: string;
  exitPrice: number;
  exitReason: string;
  exitTimestamp: number;
  pnlSol: number;

  // ── Post-sale data (filled after monitoring) ──
  /** Price 1 minute after sale */
  price1m?: number;
  /** Price 5 minutes after sale */
  price5m?: number;
  /** Price 10 minutes after sale */
  price10m?: number;
  /** Price 30 minutes after sale */
  price30m?: number;
  /** Price 1 hour after sale */
  price1h?: number;
  /** Highest price seen post-sale */
  postSalePeakPrice?: number;
  /** Lowest price seen post-sale */
  postSaleTroughPrice?: number;
  /** Market cap at 10 min */
  marketCap10m?: number;
  /** Market cap at 1 hour */
  marketCap1h?: number;
  /** Whether the token graduated (reached Raydium) */
  graduated?: boolean;
  /** % change from exit price to peak post-sale */
  missedUpsidePct?: number;
  /** % change from exit price to 10m price */
  priceChange10mPct?: number;
  /** % change from exit price to 1h price */
  priceChange1hPct?: number;
  /** Verdict: "good-exit" | "missed-opportunity" | "early-exit" | "token-dead" */
  verdict?: string;
  /** Human-readable analysis summary */
  analysis?: string;
  /** Whether monitoring completed successfully */
  completed: boolean;
}

/** Callback for when monitoring completes */
type MonitorCallback = (result: PostSaleResult) => void;

/** Internal tracking of a monitored token */
interface MonitoredToken {
  result: PostSaleResult;
  checkTimes: number[];  // timestamps for 1m, 5m, 10m checks
  checksCompleted: number;
  timers: ReturnType<typeof setTimeout>[];
}

/**
 * Post-Sale Monitor
 * Tracks tokens for up to 1 hour after sale to assess exit quality.
 * Primary verdicts at 10m, extended tracking at 30m and 1h.
 */
export class PostSaleMonitor {
  private monitored: Map<string, MonitoredToken> = new Map();
  private fetchTokenDetails: (mint: string) => Promise<Record<string, unknown> | null>;
  private onComplete: MonitorCallback;

  constructor(
    fetchTokenDetails: (mint: string) => Promise<Record<string, unknown> | null>,
    onComplete: MonitorCallback,
  ) {
    this.fetchTokenDetails = fetchTokenDetails;
    this.onComplete = onComplete;
  }

  /** Start monitoring a token after it's been sold */
  startMonitoring(params: {
    mint: string;
    symbol: string;
    exitPrice: number;
    exitReason: string;
    pnlSol: number;
  }): void {
    // Don't double-monitor
    if (this.monitored.has(params.mint)) return;

    const result: PostSaleResult = {
      mint: params.mint,
      symbol: params.symbol,
      exitPrice: params.exitPrice,
      exitReason: params.exitReason,
      exitTimestamp: Date.now(),
      pnlSol: params.pnlSol,
      completed: false,
    };

    const token: MonitoredToken = {
      result,
      checkTimes: [
        Date.now() + 60_000,    // 1 minute
        Date.now() + 300_000,   // 5 minutes
        Date.now() + 600_000,   // 10 minutes
        Date.now() + 1_800_000, // 30 minutes
        Date.now() + 3_600_000, // 1 hour
      ],
      checksCompleted: 0,
      timers: [],
    };

    // Schedule the five check-ins
    token.timers.push(setTimeout(() => this.checkToken(params.mint, "1m"), 60_000));
    token.timers.push(setTimeout(() => this.checkToken(params.mint, "5m"), 300_000));
    token.timers.push(setTimeout(() => this.checkToken(params.mint, "10m"), 600_000));
    token.timers.push(setTimeout(() => this.checkToken(params.mint, "30m"), 1_800_000));
    token.timers.push(setTimeout(() => this.checkToken(params.mint, "1h"), 3_600_000));

    this.monitored.set(params.mint, token);
    logger.info("MONITOR", `📡 Monitoring ${params.symbol} post-sale (checks at 1m, 5m, 10m, 30m, 1h)`);
  }

  /** Check a token at a specific interval */
  private async checkToken(mint: string, interval: "1m" | "5m" | "10m" | "30m" | "1h"): Promise<void> {
    const token = this.monitored.get(mint);
    if (!token) return;

    try {
      const details = await this.fetchTokenDetails(mint);
      if (!details) {
        logger.warn("MONITOR", `Failed to fetch ${token.result.symbol} at ${interval}`);
        token.checksCompleted++;
        if (interval === "10m") this.finalizeMonitoring(mint, false);
        if (interval === "1h") this.finalizeMonitoring(mint, true);
        return;
      }

      // Extract price from token details
      const vSol = details.virtual_sol_reserves as number | undefined;
      const vTokens = details.virtual_token_reserves as number | undefined;
      const currentPrice = vSol && vTokens ? vSol / vTokens : 0;
      const marketCap = (details.market_cap as number) || (details.usd_market_cap as number) || 0;
      const graduated = !!(details.raydium_pool || details.complete);

      // Store price at each interval
      switch (interval) {
        case "1m":
          token.result.price1m = currentPrice;
          break;
        case "5m":
          token.result.price5m = currentPrice;
          break;
        case "10m":
          token.result.price10m = currentPrice;
          token.result.marketCap10m = marketCap;
          token.result.graduated = graduated;
          break;
        case "30m":
          token.result.price30m = currentPrice;
          token.result.graduated = token.result.graduated || graduated;
          break;
        case "1h":
          token.result.price1h = currentPrice;
          token.result.marketCap1h = marketCap;
          token.result.graduated = token.result.graduated || graduated;
          break;
      }

      // Track peak and trough
      if (currentPrice > 0) {
        if (!token.result.postSalePeakPrice || currentPrice > token.result.postSalePeakPrice) {
          token.result.postSalePeakPrice = currentPrice;
        }
        if (!token.result.postSaleTroughPrice || currentPrice < token.result.postSaleTroughPrice) {
          token.result.postSaleTroughPrice = currentPrice;
        }
      }

      logger.info("MONITOR", `📡 ${token.result.symbol} @ ${interval}: price=${currentPrice.toFixed(12)}, mcap=${marketCap.toFixed(0)}`);

      token.checksCompleted++;
      if (interval === "10m") {
        // Primary finalization at 10m — compute verdict + notify
        this.finalizeMonitoring(mint, false);
      } else if (interval === "1h") {
        // Extended finalization at 1h — update verdict if data changed significantly
        this.finalizeMonitoring(mint, true);
      }
    } catch (err) {
      logger.error("MONITOR", `Check failed for ${token.result.symbol} at ${interval}: ${err}`);
      token.checksCompleted++;
      if (interval === "10m") this.finalizeMonitoring(mint, false);
      if (interval === "1h") this.finalizeMonitoring(mint, true);
    }
  }

  /** Finalize monitoring — compute verdict and analysis */
  private finalizeMonitoring(mint: string, extended: boolean): void {
    const token = this.monitored.get(mint);
    if (!token) return;

    const r = token.result;
    const exitPrice = r.exitPrice;

    // Compute post-sale metrics
    if (exitPrice > 0) {
      if (r.postSalePeakPrice) {
        r.missedUpsidePct = (r.postSalePeakPrice - exitPrice) / exitPrice;
      }
      if (r.price10m) {
        r.priceChange10mPct = (r.price10m - exitPrice) / exitPrice;
      }
      if (r.price1h) {
        r.priceChange1hPct = (r.price1h - exitPrice) / exitPrice;
      }
    }

    // Determine verdict
    r.verdict = this.computeVerdict(r);
    r.analysis = this.buildAnalysis(r);
    r.completed = true;

    if (extended) {
      logger.info("MONITOR", `📊 ${r.symbol} EXTENDED POST-SALE (1h): verdict=${r.verdict}, ` +
        `1h_change=${r.priceChange1hPct ? (r.priceChange1hPct * 100).toFixed(1) + "%" : "n/a"}`);
    } else {
      logger.info("MONITOR", `📊 ${r.symbol} POST-SALE VERDICT: ${r.verdict}`);
      logger.info("MONITOR", `   ${r.analysis}`);
    }

    // Notify callback (both primary and extended)
    try {
      this.onComplete(r);
    } catch (err) {
      logger.error("MONITOR", `Callback error: ${err}`);
    }

    // Only cleanup on extended (1h) — keep monitoring until then
    if (extended) {
      token.timers.forEach((t) => clearTimeout(t));
      this.monitored.delete(mint);
    }
  }

  /** Determine the verdict for a post-sale monitoring result */
  private computeVerdict(r: PostSaleResult): string {
    const missedUpside = r.missedUpsidePct ?? 0;
    const change10m = r.priceChange10mPct ?? 0;

    // Token graduated after we sold — big missed opportunity
    if (r.graduated) return "missed-graduation";

    // Price went up 50%+ after we sold — significant missed opportunity
    if (missedUpside > 0.5) return "missed-opportunity";

    // Price went up 20-50% — mild early exit
    if (missedUpside > 0.2) return "early-exit";

    // Price dropped further after we sold — good exit
    if (change10m < -0.2) return "good-exit";

    // Token is basically dead (price near zero or no data)
    if (!r.price10m || r.price10m === 0) return "token-dead";

    // Price stayed roughly flat or went down — exit was fine
    if (change10m < 0.1) return "good-exit";

    // Small upside missed — exit was acceptable
    return "acceptable-exit";
  }

  /** Build a human-readable analysis summary */
  private buildAnalysis(r: PostSaleResult): string {
    const parts: string[] = [];
    const symbol = r.symbol;

    parts.push(`Exit: ${r.exitReason} at P&L ${r.pnlSol >= 0 ? "+" : ""}${r.pnlSol.toFixed(4)} SOL.`);

    if (r.price1m && r.exitPrice > 0) {
      const change1m = ((r.price1m - r.exitPrice) / r.exitPrice * 100).toFixed(1);
      parts.push(`1m: ${Number(change1m) >= 0 ? "+" : ""}${change1m}%`);
    }
    if (r.price5m && r.exitPrice > 0) {
      const change5m = ((r.price5m - r.exitPrice) / r.exitPrice * 100).toFixed(1);
      parts.push(`5m: ${Number(change5m) >= 0 ? "+" : ""}${change5m}%`);
    }
    if (r.price10m && r.exitPrice > 0) {
      const change10m = ((r.price10m - r.exitPrice) / r.exitPrice * 100).toFixed(1);
      parts.push(`10m: ${Number(change10m) >= 0 ? "+" : ""}${change10m}%`);
    }
    if (r.price30m && r.exitPrice > 0) {
      const change30m = ((r.price30m - r.exitPrice) / r.exitPrice * 100).toFixed(1);
      parts.push(`30m: ${Number(change30m) >= 0 ? "+" : ""}${change30m}%`);
    }
    if (r.price1h && r.exitPrice > 0) {
      const change1h = ((r.price1h - r.exitPrice) / r.exitPrice * 100).toFixed(1);
      parts.push(`1h: ${Number(change1h) >= 0 ? "+" : ""}${change1h}%`);
    }

    if (r.missedUpsidePct !== undefined) {
      const missed = (r.missedUpsidePct * 100).toFixed(1);
      parts.push(`Peak missed: +${missed}%`);
    }

    if (r.graduated) {
      parts.push(`🎓 TOKEN GRADUATED — major missed opportunity!`);
    }

    switch (r.verdict) {
      case "missed-graduation":
        parts.push(`LESSON: This token hit Raydium. Consider holding longer when fundamentals are strong.`);
        break;
      case "missed-opportunity":
        parts.push(`LESSON: Significant upside missed. Consider wider trailing stops or higher take-profit targets.`);
        break;
      case "early-exit":
        parts.push(`LESSON: Mild upside missed. Exit timing was slightly early but within acceptable range.`);
        break;
      case "good-exit":
        parts.push(`LESSON: Token dumped after exit. The ${r.exitReason} saved us from further losses. Good risk management.`);
        break;
      case "token-dead":
        parts.push(`LESSON: Token is essentially dead. Exit was correct regardless of timing.`);
        break;
      case "acceptable-exit":
        parts.push(`LESSON: Exit timing was fine. Marginal upside not worth the risk of holding.`);
        break;
    }

    return parts.join(" ");
  }

  /** Stop all monitoring (on shutdown) */
  stopAll(): void {
    for (const [mint, token] of this.monitored) {
      token.timers.forEach((t) => clearTimeout(t));
    }
    this.monitored.clear();
    logger.info("MONITOR", "All post-sale monitors stopped");
  }

  /** Get count of actively monitored tokens */
  get activeCount(): number {
    return this.monitored.size;
  }
}
