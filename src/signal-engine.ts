// ── Signal engine with thinking/reasoning integration ──

import type { PumpTraderConfig } from "./config.js";
import type { TokenMetrics, TokenSignal, SignalFactors } from "./types.js";
import type { LLMAnalysis } from "./llm-analyzer.js";
import type { MarketRegime } from "./market-regime.js";
import { logger } from "./logger.js";
import { thinkingLog } from "./thinking.js";

/** Extended context passed to the signal engine for smarter decisions */
export interface SignalContext {
  /** Creator wallet reputation score (negative = known rugger) */
  creatorReputation: number;
  /** How many tokens this creator has launched */
  creatorLaunchCount: number;
  /** Whether creator is blacklisted */
  creatorBlacklisted: boolean;
  /** Current market regime */
  marketRegime: MarketRegime;
  /** Score adjustment from market regime */
  regimeScoreBoost: number;
  /** Size multiplier from market regime */
  regimeSizeMultiplier: number;
  /** LLM analysis (if available) */
  llmAnalysis?: LLMAnalysis;
  /** Narrative trend boost from market intelligence (0-15) */
  narrativeBoost?: number;
}

export class SignalEngine {
  constructor(private readonly config: PumpTraderConfig) {}

  /**
   * Enhanced scoring with creator reputation, market regime, and LLM analysis.
   * The heuristic score (0-100) is blended with LLM score when available.
   */
  score(metrics: TokenMetrics, context?: SignalContext): TokenSignal {
    const reasoning: string[] = [];
    const factors = this.computeFactors(metrics, reasoning);
    const totalScore = Math.round(
      factors.volumeScore + factors.buyPressureScore + factors.uniqueBuyersScore +
      factors.marketCapVelocityScore + factors.devBehaviorScore + factors.antiRugScore +
      factors.bondingCurveScore + factors.ageScore,
    );
    let score = Math.max(0, Math.min(100, totalScore));

    // ── Creator reputation adjustment ──
    if (context) {
      if (context.creatorBlacklisted) {
        reasoning.push(`🚫 Creator BLACKLISTED — auto-skip`);
        score = 0; // Force skip
      } else if (context.creatorReputation < -10) {
        const penalty = Math.min(20, Math.abs(context.creatorReputation));
        score -= penalty;
        reasoning.push(`⚠️ Creator reputation ${context.creatorReputation} → -${penalty} pts`);
      } else if (context.creatorReputation > 5) {
        const bonus = Math.min(5, Math.floor(context.creatorReputation / 3));
        score += bonus;
        reasoning.push(`✅ Creator reputation ${context.creatorReputation} → +${bonus} pts`);
      }

      if (context.creatorLaunchCount > 5) {
        reasoning.push(`⚠️ Serial launcher: ${context.creatorLaunchCount} tokens`);
        score -= 5;
      }

      // ── Market regime adjustment ──
      if (context.regimeScoreBoost !== 0) {
        reasoning.push(`📊 Market regime "${context.marketRegime}" → threshold adjust ${context.regimeScoreBoost > 0 ? "+" : ""}${context.regimeScoreBoost}`);
      }

      // ── LLM analysis blend ──
      if (context.llmAnalysis?.success) {
        const llm = context.llmAnalysis;
        // Blend: 75% heuristic + 25% LLM (reduced from 40% — heuristics more predictive)
        const llmWeight = 0.25 * llm.confidence;
        const heuristicWeight = 1.0 - llmWeight;
        const blendedScore = Math.round(score * heuristicWeight + llm.score * llmWeight);
        reasoning.push(`🧠 LLM score: ${llm.score}/100 (confidence: ${(llm.confidence * 100).toFixed(0)}%) → blended: ${score}→${blendedScore}`);
        reasoning.push(`   Narrative: ${llm.narrative} | ${llm.reasoning}`);
        if (llm.factors.length > 0) {
          reasoning.push(`   Factors: ${llm.factors.join(", ")}`);
        }
        score = blendedScore;
      }

      // ── Narrative trend boost from market intelligence ──
      if (context.narrativeBoost && context.narrativeBoost > 0) {
        score += context.narrativeBoost;
        reasoning.push(`🔥 Trending narrative boost → +${context.narrativeBoost} pts`);
      }
    }

    score = Math.max(0, Math.min(100, score));

    // Effective threshold (adjusted by market regime)
    const effectiveThreshold = this.config.minBuyScore + (context?.regimeScoreBoost ?? 0);

    // Scale position size between minPositionSizeSol and maxPositionSizeSol based on score strength
    const minSize = this.config.minPositionSizeSol ?? 0.01;
    const maxSize = this.config.maxPositionSizeSol ?? 0.5;
    let sizeMultiplier = score >= 85 ? 1.0 : score >= 75 ? 0.75 : score >= 65 ? 0.5 : 0.35;
    // Apply market regime sizing
    if (context?.regimeSizeMultiplier !== undefined) {
      sizeMultiplier *= context.regimeSizeMultiplier;
    }
    const suggestedSizeSol = Math.max(minSize, Math.min(maxSize, minSize + (maxSize - minSize) * sizeMultiplier));
    const action = score >= effectiveThreshold ? "buy" : "skip";

    // Record thinking
    if (action === "buy") {
      reasoning.push(`✅ DECISION: BUY — Score ${score}/100 exceeds threshold of ${effectiveThreshold}${context?.regimeScoreBoost ? ` (base ${this.config.minBuyScore} + regime ${context.regimeScoreBoost})` : ""}`);
      reasoning.push(`Position size: ${suggestedSizeSol.toFixed(4)} SOL (${(sizeMultiplier * 100).toFixed(0)}% of base)`);
    } else {
      reasoning.push(`❌ DECISION: SKIP — Score ${score}/100 below threshold of ${effectiveThreshold}`);
    }

    logger.signal(`${metrics.symbol || metrics.mint.slice(0, 8)}: score=${score} action=${action}`, {
      mint: metrics.mint, score, action, factors,
      ...(context ? { regime: context.marketRegime, llmScore: context.llmAnalysis?.score } : {}),
    });

    thinkingLog.add({
      mint: metrics.mint,
      symbol: metrics.symbol || metrics.mint.slice(0, 8),
      type: "evaluation",
      decision: action === "buy" ? `BUY (score: ${score})` : `SKIP (score: ${score})`,
      reasoning,
      factors: factors as unknown as Record<string, number>,
      data: {
        marketCapSol: metrics.marketCapSol,
        recentVolumeSol: metrics.recentVolumeSol,
        buyCount: metrics.buyCount,
        sellCount: metrics.sellCount,
        uniqueBuyers: metrics.uniqueBuyers.size,
        bondingCurveProgress: metrics.bondingCurveProgress,
        suggestedSizeSol,
        ...(context ? {
          creatorReputation: context.creatorReputation,
          marketRegime: context.marketRegime,
          llmScore: context.llmAnalysis?.score,
          llmNarrative: context.llmAnalysis?.narrative,
        } : {}),
      },
    });

    return { mint: metrics.mint, symbol: metrics.symbol, name: metrics.name, score, factors, action, suggestedSizeSol, timestamp: Date.now() };
  }

  shouldExit(
    metrics: TokenMetrics, entryPrice: number, currentPrice: number, positionOpenedAt: number,
    entrySol?: number,
  ): { exit: boolean; reason: string; exitRatio: number } {
    const pnlPct = (currentPrice - entryPrice) / entryPrice;
    const now = Date.now();
    const ageSeconds = (now - positionOpenedAt) / 1_000;

    // ── Round-trip fee cost as a percentage of position ──
    // Includes: buy-side PumpPortal fee + sell-side PumpPortal fee + 2× priority fee
    const feePct = this.config.tradingFeePct * 2; // buy + sell PumpPortal fees
    const priorityFeesPct = entrySol && entrySol > 0
      ? (this.config.priorityFeeSol * 2) / entrySol
      : 0;
    const totalFeePct = feePct + priorityFeesPct;

    // Net P&L after fees — this is the REAL profit/loss
    const netPnlPct = pnlPct - totalFeePct;

    if (netPnlPct <= -this.config.stopLossPct) {
      return { exit: true, reason: "stop-loss", exitRatio: 1.0 };
    }
    if (netPnlPct >= this.config.takeProfitPct2) {
      return { exit: true, reason: "take-profit-2", exitRatio: 1.0 };
    }
    if (netPnlPct >= this.config.takeProfitPct1) {
      return { exit: true, reason: "take-profit-1", exitRatio: 0.3 };
    }
    // ── Early momentum fail: if token shows steep loss early, cut losses ──
    // Widened from -3% to -5% at 10-20s to give pump tokens room to swing.
    // Removed the 15-30s "no movement" exit — it killed tokens that needed a moment.
    // Added 30-60s combined price+volume check to catch truly dead tokens.
    if (ageSeconds >= 10 && ageSeconds <= 20 && netPnlPct <= -0.05) {
      return { exit: true, reason: "early-momentum-fail", exitRatio: 1.0 };
    }
    if (ageSeconds >= 30 && ageSeconds <= 60 && netPnlPct <= -0.03) {
      const recentActivity = metrics.recentTrades.filter((t) => t.timestamp >= Date.now() - 30_000);
      if (recentActivity.length < 2) {
        // Price down AND no activity — truly dead token
        return { exit: true, reason: "early-momentum-fail", exitRatio: 1.0 };
      }
    }

    if (ageSeconds > this.config.maxPositionAgeSec && netPnlPct < 0.05) {
      return { exit: true, reason: "age-timeout", exitRatio: 1.0 };
    }

    const recentTradesCutoff = now - 30_000;
    const veryRecentTrades = metrics.recentTrades.filter((t) => t.timestamp >= recentTradesCutoff);
    if (ageSeconds > 60 && veryRecentTrades.length < 2) {
      return { exit: true, reason: "volume-death", exitRatio: 1.0 };
    }

    const recentBuys = veryRecentTrades.filter((t) => t.txType === "buy").length;
    const recentSells = veryRecentTrades.filter((t) => t.txType === "sell").length;
    if (recentSells > 3 && recentSells > recentBuys * 3 && netPnlPct < 0.05) {
      return { exit: true, reason: "sell-pressure", exitRatio: 1.0 };
    }

    return { exit: false, reason: "", exitRatio: 0 };
  }

  private computeFactors(metrics: TokenMetrics, reasoning: string[]): SignalFactors {
    const volumeScore = this.scoreVolume(metrics, reasoning);
    const buyPressureScore = this.scoreBuyPressure(metrics, reasoning);
    const uniqueBuyersScore = this.scoreUniqueBuyers(metrics, reasoning);
    const marketCapVelocityScore = this.scoreMarketCapVelocity(metrics, reasoning);
    const devBehaviorScore = this.scoreDevBehavior(metrics, reasoning);
    const antiRugScore = this.scoreAntiRug(metrics, reasoning);
    const bondingCurveScore = this.scoreBondingCurve(metrics, reasoning);
    const ageScore = this.scoreAge(metrics, reasoning);
    return { volumeScore, buyPressureScore, uniqueBuyersScore, marketCapVelocityScore, devBehaviorScore, antiRugScore, bondingCurveScore, ageScore };
  }

  private scoreVolume(m: TokenMetrics, r: string[]): number {
    const v = m.recentVolumeSol;
    let score: number;
    // Raised thresholds: require stronger volume conviction (winners avg 24 SOL)
    if (v >= 20) score = 15;
    else if (v >= 10) score = 12;
    else if (v >= 5) score = 8;
    else if (v >= 3) score = 4;
    else score = 0;
    r.push(`Volume: ${v.toFixed(2)} SOL/60s → ${score}/15 pts`);
    return score;
  }

  private scoreBuyPressure(m: TokenMetrics, r: string[]): number {
    const total = m.buyCount + m.sellCount;
    if (total < 3) { r.push(`Buy pressure: ${m.buyCount}B/${m.sellCount}S (too few trades) → 5/15 pts`); return 5; }
    const ratio = m.buyCount / Math.max(1, m.sellCount);
    let score: number;
    if (ratio >= 5) score = 15;
    else if (ratio >= 3) score = 12;
    else if (ratio >= 2) score = 9;
    else if (ratio >= 1.2) score = 5;
    else if (ratio >= 0.8) score = 2;
    else score = 0;
    r.push(`Buy pressure: ${m.buyCount}B/${m.sellCount}S (ratio ${ratio.toFixed(1)}) → ${score}/15 pts`);
    return score;
  }

  private scoreUniqueBuyers(m: TokenMetrics, r: string[]): number {
    const count = m.uniqueBuyers.size;
    let score: number;
    // Raised thresholds: winners avg 27 buyers, losers avg 18
    if (count >= 50) score = 15;
    else if (count >= 35) score = 13;
    else if (count >= 25) score = 10;
    else if (count >= 20) score = 7;
    else if (count >= 15) score = 4;
    else score = 0;
    r.push(`Unique buyers: ${count} wallets → ${score}/15 pts`);
    return score;
  }

  private scoreMarketCapVelocity(m: TokenMetrics, r: string[]): number {
    if (m.priceHistory.length < 2) { r.push(`MC velocity: insufficient data → 5/15 pts`); return 5; }
    const now = Date.now();
    const recentPrices = m.priceHistory.filter(([ts]) => ts >= now - 30_000);
    if (recentPrices.length < 2) { r.push(`MC velocity: no recent price data → 3/15 pts`); return 3; }
    const firstPrice = recentPrices[0]![1];
    const lastPrice = recentPrices[recentPrices.length - 1]![1];
    if (firstPrice <= 0) return 0;
    const growthPct = (lastPrice - firstPrice) / firstPrice;
    let score: number;
    if (growthPct >= 0.5) score = 15;
    else if (growthPct >= 0.25) score = 12;
    else if (growthPct >= 0.1) score = 9;
    else if (growthPct >= 0.03) score = 6;
    else if (growthPct >= 0) score = 3;
    else score = 0;
    r.push(`MC velocity: ${(growthPct * 100).toFixed(1)}% in 30s → ${score}/15 pts`);
    return score;
  }

  private scoreDevBehavior(m: TokenMetrics, r: string[]): number {
    if (m.devHasSold) { r.push(`Dev behavior: ⚠️ DEV HAS SOLD → 0/12 pts`); return 0; }
    // Dev holding is the default for new tokens — not a strong signal by itself
    // Only give full points if we see dev buying MORE (not implemented yet)
    r.push(`Dev behavior: holding (default) → 6/12 pts`);
    return 6;
  }

  private scoreAntiRug(m: TokenMetrics, r: string[]): number {
    // Start at 7 (neutral) — most young tokens look clean by default
    // Only reach 13/13 with positive evidence (diverse buyers, no whale concentration)
    let score = 7;
    const reasons: string[] = [];
    const now = Date.now();

    const recentBuyTrades = m.recentTrades.filter((t) => t.timestamp >= now - 120_000 && t.txType === "buy");
    let hasWhaleConcentration = false;
    if (recentBuyTrades.length > 3) {
      const volumeByTrader = new Map<string, number>();
      let totalBuyVol = 0;
      for (const t of recentBuyTrades) {
        volumeByTrader.set(t.trader, (volumeByTrader.get(t.trader) ?? 0) + t.solAmount);
        totalBuyVol += t.solAmount;
      }
      for (const [wallet, vol] of volumeByTrader) {
        if (totalBuyVol > 0 && vol / totalBuyVol > 0.5) {
          score -= 10;
          hasWhaleConcentration = true;
          reasons.push(`single wallet ${wallet.slice(0, 8)}... controls ${((vol / totalBuyVol) * 100).toFixed(0)}% of buy volume`);
          break;
        }
      }
      // Positive evidence: diverse buyer distribution → bonus points (up to +6 to reach 13)
      if (!hasWhaleConcentration && volumeByTrader.size >= 10) {
        score += 4;
        reasons.push(`diverse buyers (${volumeByTrader.size} unique wallets)`);
      } else if (!hasWhaleConcentration && volumeByTrader.size >= 5) {
        score += 2;
        reasons.push(`moderate buyer diversity (${volumeByTrader.size} wallets)`);
      }
    }

    if (m.devHasSold) { score -= 5; reasons.push("dev sold"); }

    const rSells = m.recentTrades.filter((t) => t.timestamp >= now - 30_000 && t.txType === "sell").length;
    const rBuys = m.recentTrades.filter((t) => t.timestamp >= now - 30_000 && t.txType === "buy").length;
    if (rSells > 5 && rBuys < 2) { score -= 5; reasons.push(`heavy sell pressure (${rSells}S/${rBuys}B in 30s)`); }
    // Positive evidence: strong recent buy activity with no sells
    if (rBuys >= 5 && rSells <= 1) { score += 2; reasons.push(`strong buy momentum (${rBuys}B/${rSells}S in 30s)`); }

    score = Math.max(0, Math.min(13, score));
    r.push(`Anti-rug: ${reasons.length === 0 ? "neutral" : reasons.join(", ")} → ${score}/13 pts`);
    return score;
  }

  private scoreBondingCurve(m: TokenMetrics, r: string[]): number {
    const p = m.bondingCurveProgress;
    let score: number;
    if (p >= 0.8) score = 10;
    else if (p >= 0.6) score = 8;
    else if (p >= 0.4) score = 6;
    else if (p >= 0.2) score = 4;
    else score = 2;
    r.push(`Bonding curve: ${(p * 100).toFixed(0)}% → ${score}/10 pts`);
    return score;
  }

  private scoreAge(m: TokenMetrics, r: string[]): number {
    const ageSec = (Date.now() - m.createdAt) / 1_000;
    let score: number;
    // Heavily reward fresh launches — sniping is about speed
    if (ageSec < this.config.minTokenAgeSec) score = 0; // too fresh, no data yet
    else if (ageSec <= 15) score = 8;  // ultra fresh — best snipe window
    else if (ageSec <= 30) score = 7;  // excellent timing
    else if (ageSec <= 60) score = 5;  // good timing
    else if (ageSec <= 90) score = 3;  // acceptable
    else if (ageSec <= 120) score = 1; // getting stale
    else score = 0;                     // too old for sniping
    r.push(`Token age: ${ageSec.toFixed(0)}s → ${score}/8 pts${ageSec <= 30 ? " 🎯 FRESH LAUNCH" : ""}`);
    return score;
  }
}
