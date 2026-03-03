// ── RAG Query Engine: real-time trade veto + similar trade retrieval ──
// Uses numeric feature similarity (not SBERT embeddings) for risk scoring.
// Called before every buy decision to check against historical losers.

import { logger } from "../logger.js";
import { RAGDatabase, type CandidateFeatures } from "./database.js";
import { EmbeddingService, buildFeatureText } from "./embeddings.js";
import type { RAGMatch, LossPattern } from "./types.js";

/** Minimum numeric feature similarity to consider a match */
const MIN_SIMILARITY = 0.30;
/** Risk score above this = veto the trade.
 *  Risk = similarity-weighted loss fraction among K nearest neighbors.
 *  Base rate is ~85% losses — with such a high base rate, the veto threshold
 *  must be well above the base rate to avoid blocking everything.
 *  0.90 = only block tokens matching patterns that are WORSE than average.
 *  This blocks ~10% of candidates (the truly toxic patterns). */
const VETO_THRESHOLD = 0.90;
/** Number of nearest neighbors to retrieve (outcome-agnostic k-NN) */
const TOP_K = 30;

export interface RAGVetoResult {
  /** Whether the trade should be blocked */
  vetoed: boolean;
  /** Why it was vetoed (or approved) */
  reason: string;
  /** Aggregate risk score (0-1) */
  riskScore: number;
  /** Similar losing trades found */
  similarLosses: RAGMatch[];
  /** Similar winning trades found */
  similarWins: RAGMatch[];
  /** Loss patterns that match this candidate */
  matchedPatterns: LossPattern[];
  /** Formatted context for LLM prompt injection */
  promptContext: string;
}

export class RAGQueryEngine {
  constructor(
    private db: RAGDatabase,
    private embedder: EmbeddingService,
  ) {}

  /**
   * Check a candidate token against historical trade data.
   * Returns a veto decision, risk score, and context for the LLM prompt.
   * This is the main entry point — called before every buy decision.
   *
   * Uses numeric feature similarity (14 weighted dimensions) for risk scoring,
   * NOT SBERT embedding cosine similarity.
   */
  async evaluate(candidate: {
    symbol: string;
    name: string;
    llmNarrative: string;
    marketCapSol: number;
    volumeSol: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    bondingCurveProgress: number;
    tokenAgeSec: number;
    signalScore: number;
    marketRegime: string;
    creatorReputation: number;
    // Enrichment signals (optional — zero-cost, already computed)
    spamLaunchCount?: number;
    socialScore?: number;
    socialFirstMover?: boolean;
    socialCompetingCoins?: number;
    socialXTweets?: number;
    socialViralMeme?: boolean;
    smartMoneyRank?: number;
    smartMoneyWinRate?: number;
    whaleCount?: number;
    whaleVolumeSol?: number;
  }): Promise<RAGVetoResult> {
    const stats = this.db.getStats();

    // Not enough data yet — approve everything while collecting
    if (stats.totalRecords < 5) {
      return {
        vetoed: false,
        reason: `RAG inactive (${stats.totalRecords}/5 min records)`,
        riskScore: 0,
        similarLosses: [],
        similarWins: [],
        matchedPatterns: [],
        promptContext: "",
      };
    }

    // Build candidate features for numeric similarity matching
    const candidateFeatures: CandidateFeatures = {
      llmNarrative: candidate.llmNarrative,
      marketCapSol: candidate.marketCapSol,
      volumeSol: candidate.volumeSol,
      buyCount: candidate.buyCount,
      sellCount: candidate.sellCount,
      uniqueBuyers: candidate.uniqueBuyers,
      bondingCurveProgress: candidate.bondingCurveProgress,
      tokenAgeSec: candidate.tokenAgeSec,
      signalScore: candidate.signalScore,
      marketRegime: candidate.marketRegime,
      creatorReputation: candidate.creatorReputation,
      socialScore: candidate.socialScore ?? 0,
      socialFirstMover: candidate.socialFirstMover ?? false,
      smartMoneyRank: candidate.smartMoneyRank ?? 0,
      whaleCount: candidate.whaleCount ?? 0,
      whaleVolumeSol: candidate.whaleVolumeSol ?? 0,
      spamLaunchCount: candidate.spamLaunchCount ?? 0,
    };

    // Find K nearest neighbors regardless of outcome (outcome-agnostic k-NN)
    // This avoids pool-size bias from searching losses/wins separately.
    const allNeighbors = this.db.findSimilarByFeatures(candidateFeatures, TOP_K, MIN_SIMILARITY);
    const similarLosses = allNeighbors.filter(m => m.record.outcome === "loss");
    const similarWins = allNeighbors.filter(m => m.record.outcome === "win");

    // Check against loss patterns
    const lossPatterns = this.db.getLossPatterns();
    const matchedPatterns = this.matchPatterns(candidate, lossPatterns);

    // Calculate risk score: loss fraction among K nearest neighbors
    const riskScore = this.calculateRiskScore(allNeighbors, matchedPatterns, stats);

    // Determine if we should veto
    const vetoed = riskScore >= VETO_THRESHOLD;
    const reason = vetoed
      ? this.buildVetoReason(similarLosses, matchedPatterns, riskScore)
      : `RAG approved (risk: ${(riskScore * 100).toFixed(0)}%)`;

    // Build prompt context for the LLM (appended to agent prompt)
    const promptContext = this.buildPromptContext(
      candidate.symbol,
      similarLosses,
      similarWins,
      matchedPatterns,
      riskScore,
      stats.totalRecords,
    );

    if (vetoed) {
      logger.warn("RAG-QUERY", `⛔ VETO: ${candidate.symbol} — ${reason}`);
    } else if (riskScore > 0.88) {
      logger.info("RAG-QUERY", `⚠️ CAUTION: ${candidate.symbol} — risk ${(riskScore * 100).toFixed(0)}%`);
    }

    return {
      vetoed,
      reason,
      riskScore,
      similarLosses,
      similarWins,
      matchedPatterns,
      promptContext,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Risk Score Calculation (k-NN loss fraction) ──
  // ══════════════════════════════════════════════════════════════════════════

  private calculateRiskScore(
    neighbors: RAGMatch[],
    patterns: LossPattern[],
    _stats: { totalWins: number; totalLosses: number },
  ): number {
    if (neighbors.length === 0 && patterns.length === 0) return 0;

    // ── Core metric: similarity-weighted loss fraction among K nearest neighbors ──
    // This directly estimates P(loss | similar features) without pool-size bias.
    // Higher fraction = more of the similar trades were losses = higher risk.
    let lossWeight = 0;
    let totalWeight = 0;
    for (const n of neighbors) {
      totalWeight += n.similarity;
      if (n.record.outcome === "loss") lossWeight += n.similarity;
    }
    const lossFraction = totalWeight > 0 ? lossWeight / totalWeight : 0.5;

    // Small pattern penalty (additive)
    const patternPenalty = Math.min(0.05, patterns.length * 0.02);

    return Math.min(1, Math.max(0, lossFraction + patternPenalty));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Pattern Matching (fixed) ──
  // ══════════════════════════════════════════════════════════════════════════

  private matchPatterns(
    candidate: {
      uniqueBuyers: number;
      volumeSol: number;
      marketCapSol: number;
      creatorReputation: number;
      sellCount: number;
      buyCount: number;
      bondingCurveProgress: number;
      whaleCount?: number;
      spamLaunchCount?: number;
    },
    patterns: LossPattern[],
  ): LossPattern[] {
    const matched: LossPattern[] = [];

    for (const pattern of patterns) {
      let matchCount = 0;
      let checkedSignals = 0;

      for (const signal of pattern.signals) {
        let canCheck = true;

        if (signal === "low_volume_at_exit" && candidate.volumeSol < 0.5) matchCount++;
        else if (signal === "few_buyers" && candidate.uniqueBuyers < 3) matchCount++;
        else if (signal === "instant_dump" && candidate.creatorReputation < -1) matchCount++;
        else if (signal === "bad_creator" && candidate.creatorReputation < 0) matchCount++;
        else if (signal === "heavy_sell_pressure" && candidate.sellCount > candidate.buyCount * 1.5) matchCount++;
        else if (signal === "peaked_then_crashed") {
          // Fixed: was unconditional matchCount++. Now uses bonding curve as proxy.
          if (candidate.bondingCurveProgress > 0.70) matchCount++;
        }
        else if (signal === "sell_pressure_triggered" && candidate.sellCount > candidate.buyCount) matchCount++;
        else if (signal === "high_mcap_low_volume" && candidate.marketCapSol > 30 && candidate.volumeSol < 1) matchCount++;
        else if (signal === "too_many_whales" && (candidate.whaleCount ?? 0) >= 3) matchCount++;
        else if (signal === "spam_creator" && (candidate.spamLaunchCount ?? 0) >= 3) matchCount++;
        else if (signal === "general_stop_loss") canCheck = false;
        else if (signal === "unclassified") canCheck = false;
        else canCheck = false;

        if (canCheck) checkedSignals++;
      }

      // If >50% of checkable signals match, consider this pattern a match
      if (checkedSignals > 0 && matchCount / checkedSignals >= 0.5) {
        matched.push(pattern);
      }
    }

    return matched;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Prompt Building ──
  // ══════════════════════════════════════════════════════════════════════════

  private buildVetoReason(losses: RAGMatch[], patterns: LossPattern[], riskScore: number): string {
    const parts: string[] = [`Risk ${(riskScore * 100).toFixed(0)}%`];

    if (losses.length > 0) {
      const topLoss = losses[0];
      parts.push(
        `matches ${losses.length} losing trades (top: ${topLoss.record.symbol} ${(topLoss.similarity * 100).toFixed(0)}% similar, ${topLoss.record.lossCategory ?? "uncategorized"})`,
      );
    }

    if (patterns.length > 0) {
      parts.push(`matches patterns: ${patterns.map((p) => p.category).join(", ")}`);
    }

    return parts.join(" — ");
  }

  buildPromptContext(
    symbol: string,
    losses: RAGMatch[],
    wins: RAGMatch[],
    patterns: LossPattern[],
    riskScore: number,
    dbSize: number,
  ): string {
    if (losses.length === 0 && wins.length === 0) return "";

    const lines: string[] = [];
    lines.push(`\n═══ RAG ANALYSIS for ${symbol} (${dbSize} trades in DB) ═══`);
    lines.push(`Risk Score: ${(riskScore * 100).toFixed(0)}% ${riskScore >= VETO_THRESHOLD ? "⛔ HIGH RISK" : riskScore > 0.70 ? "⚠️ MODERATE" : "✅ LOW"}`);

    if (losses.length > 0) {
      lines.push(`\nSimilar LOSING trades (${losses.length}):`);
      for (const m of losses.slice(0, 3)) {
        const r = m.record;
        lines.push(
          `  ❌ ${r.symbol}: ${(r.pnlPct * 100).toFixed(1)}% P&L, ${r.exitReason}, ${r.lossCategory ?? "uncategorized"} (${(m.similarity * 100).toFixed(0)}% match)`,
        );
      }
    }

    if (wins.length > 0) {
      lines.push(`\nSimilar WINNING trades (${wins.length}):`);
      for (const m of wins.slice(0, 3)) {
        const r = m.record;
        lines.push(
          `  ✅ ${r.symbol}: +${(r.pnlPct * 100).toFixed(1)}% P&L, ${r.exitReason} (${(m.similarity * 100).toFixed(0)}% match)`,
        );
      }
    }

    if (patterns.length > 0) {
      lines.push(`\n⚠️ Matched loss patterns:`);
      for (const p of patterns) {
        lines.push(`  • ${p.category} (${(p.frequency * 100).toFixed(0)}% of losses): ${p.description}`);
        for (const rule of p.avoidanceRules.slice(0, 2)) {
          lines.push(`    → ${rule}`);
        }
      }
    }

    if (riskScore >= VETO_THRESHOLD) {
      lines.push(`\n⛔ RAG RECOMMENDATION: SKIP this token — neighborhood loss rate ${(riskScore * 100).toFixed(0)}% exceeds threshold.`);
    } else if (riskScore > 0.88) {
      lines.push(`\n⚠️ RAG RECOMMENDATION: CAUTION — ${(riskScore * 100).toFixed(0)}% of similar trades lost. Proceed with extra care.`);
    } else {
      lines.push(`\n✅ RAG: Neighborhood loss rate ${(riskScore * 100).toFixed(0)}% — within normal range.`);
    }

    return lines.join("\n");
  }

  /** Get human-readable stats about the RAG database */
  getStatusSummary(): string {
    const stats = this.db.getStats();
    const patterns = this.db.getLossPatterns();

    const lines = [
      `RAG DB: ${stats.totalRecords} trades (${stats.totalWins}W/${stats.totalLosses}L)`,
      `Embeddings: ${stats.withEmbeddings}/${stats.totalRecords}`,
      `Categorized: ${stats.withLossCategory} losses`,
      `Patterns: ${patterns.map((p) => `${p.category}(${p.tradeCount})`).join(", ") || "none"}`,
    ];

    return lines.join(" | ");
  }
}
