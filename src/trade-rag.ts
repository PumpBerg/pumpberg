// ── Trade RAG: Retrieval-Augmented Generation for trade decisions ──
// Uses structured similarity matching against past trades to give the LLM
// concrete historical examples when evaluating new token candidates.
// No API keys, no vector DB — pure feature-based similarity on trade journal data.

import { logger } from "./logger.js";
import type { TradeEntry, TradeJournal } from "./trade-journal.js";
import { getExpertKnowledge, getExpertFraming } from "./pump-fun-knowledge.js";

// ── Configuration ──
const MAX_SIMILAR_TRADES = 5;         // Max similar trades to retrieve per candidate
const MIN_SIMILARITY_THRESHOLD = 0.3; // Minimum similarity to include (0-1)
const MIN_COMPLETED_TRADES = 3;       // Need at least this many trades for RAG to activate

// ── Feature weights for similarity calculation ──
// Higher weight = more important for matching "similar" trades
const FEATURE_WEIGHTS = {
  narrative: 0.15,          // Same LLM narrative category (animal, ai, political, etc.)
  marketCap: 0.12,          // Similar market cap at entry
  signalScore: 0.08,        // Similar heuristic score
  volume: 0.10,             // Similar volume at entry
  buyPressure: 0.10,        // Similar buy:sell ratio
  uniqueBuyers: 0.07,       // Similar unique buyer count
  bondingCurve: 0.05,       // Similar bonding curve position
  age: 0.04,                // Similar token age at buy
  marketRegime: 0.06,       // Same market regime
  creatorRep: 0.04,         // Similar creator reputation
  socialScore: 0.07,        // Similar social engagement
  isFirstMover: 0.04,       // Both first movers or not
  smartMoneyRank: 0.05,     // Similar smart money presence
  hourOfDay: 0.03,          // Similar time of day
};

// ── Temporal decay: recent trades weight more than old ones ──
const TEMPORAL_DECAY_HOURS = 48; // Half-life in hours

// ── Narrative group hierarchy for fuzzy narrative matching ──
const NARRATIVE_GROUPS: Record<string, string[]> = {
  "animal": ["dog", "cat", "frog", "pepe", "doge", "shib", "bonk", "inu", "bear", "bull", "fish", "bird", "monkey", "ape"],
  "ai": ["ai", "gpt", "bot", "neural", "agent", "llm", "machine", "deep", "openai", "claude"],
  "political": ["trump", "biden", "maga", "president", "election", "politic", "vote"],
  "celebrity": ["elon", "musk", "kanye", "drake", "celebrity", "famous"],
  "defi": ["defi", "swap", "yield", "stake", "farm", "liquidity", "lend"],
  "gaming": ["game", "play", "nft", "meta", "verse", "pixel", "quest"],
  "meme-culture": ["meme", "wojak", "chad", "based", "moon", "hodl", "wagmi", "ngmi", "cope", "seethe"],
};

// ── Types ──

export interface RAGContext {
  /** Whether RAG had enough data to produce results */
  active: boolean;
  /** Number of completed trades in the knowledge base */
  knowledgeBaseSize: number;
  /** Similar past trades retrieved for this candidate */
  similarTrades: SimilarTrade[];
  /** Aggregate stats from similar trades */
  aggregateStats: AggregateStats;
  /** Formatted text block for LLM injection */
  prompt: string;
}

interface SimilarTrade {
  /** The past trade entry */
  trade: TradeEntry;
  /** Similarity score (0-1) */
  similarity: number;
  /** Which features matched most */
  matchedFeatures: string[];
}

interface AggregateStats {
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPct: number;
  avgHoldTimeSec: number;
  mostCommonExitReason: string;
  /** Average peak (unrealized) P&L — shows how close to profit they got */
  avgPeakPnlPct: number;
  /** Post-sale analysis from similar trades */
  postSaleGoodExits: number;
  postSaleMissedOps: number;
  avgPostSaleMissedPct: number;
}

/** Features extracted from a trade or candidate for similarity matching */
interface TradeFeatures {
  narrative: string;
  narrativeGroup: string;  // Higher-level grouping ("animal", "ai", etc.)
  marketCapSol: number;
  signalScore: number;
  volumeSol: number;
  buyRatio: number;        // buys / (buys + sells)
  uniqueBuyers: number;
  bondingCurveProgress: number;
  ageSec: number;
  marketRegime: string;
  creatorReputation: number;
  socialScore: number;     // Social engagement score
  isFirstMover: boolean;   // First coin of its kind
  smartMoneyRank: number;  // 0 = no smart money, 1-5 = top wallet rank
  hourOfDay: number;       // 0-23, hour trade was entered
  tradeTimestamp: number;  // For temporal decay
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Trade RAG Engine ──
// ══════════════════════════════════════════════════════════════════════════════

export class TradeRAG {
  private journal: TradeJournal;
  private completedTrades: TradeEntry[] = [];
  private lastRefreshAt = 0;
  private refreshIntervalMs = 30_000; // Refresh trade cache every 30s

  constructor(journal: TradeJournal) {
    this.journal = journal;
    this.refresh();
    logger.system("Trade RAG: Structured similarity retrieval initialized");
  }

  /** Refresh the local cache of completed trades from the journal */
  private refresh(): void {
    this.completedTrades = this.journal.getCompletedTrades(500);
    this.lastRefreshAt = Date.now();
  }

  /** Ensure cache is fresh */
  private ensureFresh(): void {
    if (Date.now() - this.lastRefreshAt > this.refreshIntervalMs) {
      this.refresh();
    }
  }

  /**
   * Retrieve similar past trades for a token candidate.
   * This is the main RAG entry point — call for each candidate before LLM review.
   */
  retrieve(candidate: {
    name: string;
    symbol: string;
    marketCapSol: number;
    recentVolumeSol: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    bondingCurveProgress: number;
    ageSec: number;
    marketRegime: string;
    creatorReputation: number;
    llmNarrative?: string;
    signalScore: number;
    socialScore?: number;
    isFirstMover?: boolean;
    smartMoneyRank?: number;
  }): RAGContext {
    this.ensureFresh();

    const kbSize = this.completedTrades.length;

    if (kbSize < MIN_COMPLETED_TRADES) {
      return {
        active: false,
        knowledgeBaseSize: kbSize,
        similarTrades: [],
        aggregateStats: this.emptyStats(),
        prompt: "",
      };
    }

    const narrative = candidate.llmNarrative ?? "unknown";
    // Extract features from the candidate
    const candidateFeatures: TradeFeatures = {
      narrative,
      narrativeGroup: this.getNarrativeGroup(narrative),
      marketCapSol: candidate.marketCapSol,
      signalScore: candidate.signalScore,
      volumeSol: candidate.recentVolumeSol,
      buyRatio: candidate.buyCount / Math.max(1, candidate.buyCount + candidate.sellCount),
      uniqueBuyers: candidate.uniqueBuyers,
      bondingCurveProgress: candidate.bondingCurveProgress,
      ageSec: candidate.ageSec,
      marketRegime: candidate.marketRegime,
      creatorReputation: candidate.creatorReputation,
      socialScore: candidate.socialScore ?? 0,
      isFirstMover: candidate.isFirstMover ?? false,
      smartMoneyRank: candidate.smartMoneyRank ?? 0,
      hourOfDay: new Date().getHours(),
      tradeTimestamp: Date.now(),
    };

    // Score all completed trades by similarity to this candidate
    const scored: SimilarTrade[] = [];
    for (const trade of this.completedTrades) {
      const tradeFeatures = this.extractFeatures(trade);
      const { similarity, matchedFeatures } = this.computeSimilarity(candidateFeatures, tradeFeatures);

      if (similarity >= MIN_SIMILARITY_THRESHOLD) {
        scored.push({ trade, similarity, matchedFeatures });
      }
    }

    // Sort by similarity (highest first) and take top N
    scored.sort((a, b) => b.similarity - a.similarity);
    const topMatches = scored.slice(0, MAX_SIMILAR_TRADES);

    // Compute aggregate stats
    const aggStats = this.computeAggregateStats(topMatches);

    // Build prompt text
    const prompt = this.buildPromptBlock(candidate.symbol, topMatches, aggStats, kbSize);

    return {
      active: true,
      knowledgeBaseSize: kbSize,
      similarTrades: topMatches,
      aggregateStats: aggStats,
      prompt,
    };
  }

  /**
   * Build a compact RAG context for the per-token LLM analyzer.
   * Returns a short text block with key stats only (to stay within token budget).
   */
  retrieveCompact(candidate: {
    marketCapSol: number;
    recentVolumeSol: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    bondingCurveProgress: number;
    ageSec: number;
    marketRegime: string;
    creatorReputation: number;
    llmNarrative?: string;
    signalScore: number;
    socialScore?: number;
    isFirstMover?: boolean;
    smartMoneyRank?: number;
  }): string {
    this.ensureFresh();

    if (this.completedTrades.length < MIN_COMPLETED_TRADES) return "";

    const narrative = candidate.llmNarrative ?? "unknown";
    const candidateFeatures: TradeFeatures = {
      narrative,
      narrativeGroup: this.getNarrativeGroup(narrative),
      marketCapSol: candidate.marketCapSol,
      signalScore: candidate.signalScore,
      volumeSol: candidate.recentVolumeSol,
      buyRatio: candidate.buyCount / Math.max(1, candidate.buyCount + candidate.sellCount),
      uniqueBuyers: candidate.uniqueBuyers,
      bondingCurveProgress: candidate.bondingCurveProgress,
      ageSec: candidate.ageSec,
      marketRegime: candidate.marketRegime,
      creatorReputation: candidate.creatorReputation,
      socialScore: candidate.socialScore ?? 0,
      isFirstMover: candidate.isFirstMover ?? false,
      smartMoneyRank: candidate.smartMoneyRank ?? 0,
      hourOfDay: new Date().getHours(),
      tradeTimestamp: Date.now(),
    };

    const scored: { trade: TradeEntry; similarity: number }[] = [];
    for (const trade of this.completedTrades) {
      const tradeFeatures = this.extractFeatures(trade);
      const { similarity } = this.computeSimilarity(candidateFeatures, tradeFeatures);
      if (similarity >= MIN_SIMILARITY_THRESHOLD) {
        scored.push({ trade, similarity });
      }
    }

    if (scored.length === 0) return "";

    scored.sort((a, b) => b.similarity - a.similarity);
    const top = scored.slice(0, 3);

    const wins = top.filter(s => (s.trade.pnlSol ?? 0) > 0).length;
    const losses = top.length - wins;
    const avgPnl = top.reduce((sum, s) => sum + (s.trade.pnlPct ?? 0), 0) / top.length;
    const exits = top.map(s => s.trade.exitReason).filter(Boolean);
    const topExit = this.getMostCommon(exits as string[]);

    return `\nHISTORICAL PATTERN: ${top.length} similar past trades found — ${wins}W/${losses}L, avg P&L: ${(avgPnl * 100).toFixed(1)}%, most common exit: ${topExit}. ${losses > wins ? "Past similar tokens lost — look for what makes THIS one DIFFERENT (better metrics, social buzz, smart money)." : wins > losses ? "✅ Similar tokens have been WINNING trades." : "Mixed results."}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Feature Extraction ──
  // ══════════════════════════════════════════════════════════════════════════

  private extractFeatures(trade: TradeEntry): TradeFeatures {
    const narrative = trade.llmNarrative ?? "unknown";
    return {
      narrative,
      narrativeGroup: this.getNarrativeGroup(narrative),
      marketCapSol: trade.marketCapSol ?? 0,
      signalScore: trade.signalScore ?? 0,
      volumeSol: trade.volumeSol ?? 0,
      buyRatio: (trade.buyCount ?? 0) / Math.max(1, (trade.buyCount ?? 0) + (trade.sellCount ?? 0)),
      uniqueBuyers: trade.uniqueBuyers ?? 0,
      bondingCurveProgress: trade.bondingCurveProgress ?? 0,
      ageSec: trade.tokenAgeSec ?? 30,
      marketRegime: trade.marketRegime ?? "normal",
      creatorReputation: trade.creatorReputation ?? 0,
      socialScore: trade.socialScore ?? 0,
      isFirstMover: trade.socialFirstMover ?? false,
      smartMoneyRank: trade.smartMoneyRank ?? 0,
      hourOfDay: trade.hourOfDay ?? new Date(trade.timestamp).getHours(),
      tradeTimestamp: trade.timestamp,
    };
  }

  /** Map a narrative label to its higher-level group for fuzzy matching */
  private getNarrativeGroup(narrative: string): string {
    const lower = narrative.toLowerCase();
    for (const [group, keywords] of Object.entries(NARRATIVE_GROUPS)) {
      if (keywords.some(k => lower.includes(k))) return group;
    }
    return "other";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Similarity Computation ──
  // ══════════════════════════════════════════════════════════════════════════

  private computeSimilarity(
    a: TradeFeatures,
    b: TradeFeatures,
  ): { similarity: number; matchedFeatures: string[] } {
    let totalScore = 0;
    const matchedFeatures: string[] = [];

    // 1. Narrative (hierarchical: exact match > same group > no match)
    let narrativeSim = 0;
    if (a.narrative.toLowerCase() === b.narrative.toLowerCase()) {
      narrativeSim = 1.0;
    } else if (a.narrativeGroup === b.narrativeGroup && a.narrativeGroup !== "other") {
      narrativeSim = 0.6; // Same group but different specific narrative
    }
    totalScore += narrativeSim * FEATURE_WEIGHTS.narrative;
    if (narrativeSim > 0.5) matchedFeatures.push("narrative");

    // 2. Market Cap (log-scale similarity — order of magnitude matters)
    const mcapSim = this.logSimilarity(a.marketCapSol, b.marketCapSol);
    totalScore += mcapSim * FEATURE_WEIGHTS.marketCap;
    if (mcapSim > 0.5) matchedFeatures.push("mcap");

    // 3. Signal Score (linear similarity)
    const scoreSim = 1 - Math.abs(a.signalScore - b.signalScore) / 100;
    totalScore += scoreSim * FEATURE_WEIGHTS.signalScore;
    if (scoreSim > 0.7) matchedFeatures.push("score");

    // 4. Volume (log-scale)
    const volSim = this.logSimilarity(a.volumeSol, b.volumeSol);
    totalScore += volSim * FEATURE_WEIGHTS.volume;
    if (volSim > 0.5) matchedFeatures.push("volume");

    // 5. Buy Pressure (linear similarity of ratio)
    const buySim = 1 - Math.abs(a.buyRatio - b.buyRatio);
    totalScore += buySim * FEATURE_WEIGHTS.buyPressure;
    if (buySim > 0.7) matchedFeatures.push("buyPressure");

    // 6. Unique Buyers (log-scale)
    const buyerSim = this.logSimilarity(Math.max(1, a.uniqueBuyers), Math.max(1, b.uniqueBuyers));
    totalScore += buyerSim * FEATURE_WEIGHTS.uniqueBuyers;
    if (buyerSim > 0.5) matchedFeatures.push("buyers");

    // 7. Bonding Curve (linear similarity)
    const bcSim = 1 - Math.abs(a.bondingCurveProgress - b.bondingCurveProgress);
    totalScore += bcSim * FEATURE_WEIGHTS.bondingCurve;
    if (bcSim > 0.7) matchedFeatures.push("bonding");

    // 8. Age (linear similarity, capped)
    const ageDiff = Math.abs(a.ageSec - b.ageSec);
    const ageSim = Math.max(0, 1 - ageDiff / 120); // Max 2 min difference
    totalScore += ageSim * FEATURE_WEIGHTS.age;

    // 9. Market Regime (categorical)
    const regimeSim = a.marketRegime === b.marketRegime ? 1.0 : 0.3;
    totalScore += regimeSim * FEATURE_WEIGHTS.marketRegime;
    if (regimeSim > 0.5) matchedFeatures.push("regime");

    // 10. Creator Rep (sign match + magnitude)
    const repSim = this.signedSimilarity(a.creatorReputation, b.creatorReputation);
    totalScore += repSim * FEATURE_WEIGHTS.creatorRep;

    // 11. Social Score (log-scale — social engagement level)
    const socialSim = this.logSimilarity(Math.max(1, a.socialScore), Math.max(1, b.socialScore));
    totalScore += socialSim * FEATURE_WEIGHTS.socialScore;
    if (socialSim > 0.5) matchedFeatures.push("social");

    // 12. First Mover (categorical — both first movers or both not)
    const fmSim = a.isFirstMover === b.isFirstMover ? 1.0 : 0.2;
    totalScore += fmSim * FEATURE_WEIGHTS.isFirstMover;
    if (a.isFirstMover && b.isFirstMover) matchedFeatures.push("firstMover");

    // 13. Smart Money Rank (presence + proximity)
    let smSim = 0;
    if (a.smartMoneyRank === 0 && b.smartMoneyRank === 0) {
      smSim = 1.0; // Both have no smart money — similar
    } else if (a.smartMoneyRank > 0 && b.smartMoneyRank > 0) {
      smSim = 1 - Math.abs(a.smartMoneyRank - b.smartMoneyRank) / 5;
    } else {
      smSim = 0.1; // One has smart money, other doesn't
    }
    totalScore += smSim * FEATURE_WEIGHTS.smartMoneyRank;
    if (smSim > 0.5 && a.smartMoneyRank > 0) matchedFeatures.push("smartMoney");

    // 14. Hour of Day (circular similarity — 23:00 is close to 01:00)
    const hourDiff = Math.min(Math.abs(a.hourOfDay - b.hourOfDay), 24 - Math.abs(a.hourOfDay - b.hourOfDay));
    const hourSim = Math.max(0, 1 - hourDiff / 6); // Within 6 hours = partial match
    totalScore += hourSim * FEATURE_WEIGHTS.hourOfDay;
    if (hourSim > 0.7) matchedFeatures.push("timeOfDay");

    // ── Temporal decay: recent trades are more relevant ──
    // Apply exponential decay based on age of the historical trade (b)
    const ageHours = (Date.now() - b.tradeTimestamp) / (1000 * 60 * 60);
    const decayFactor = Math.exp(-ageHours / TEMPORAL_DECAY_HOURS);
    // Blend: 70% raw similarity + 30% time-weighted (so old trades still appear but ranked lower)
    const decayedScore = totalScore * (0.7 + 0.3 * decayFactor);

    return { similarity: decayedScore, matchedFeatures };
  }

  /** Log-scale similarity — treats order-of-magnitude differences as important */
  private logSimilarity(a: number, b: number): number {
    if (a <= 0 && b <= 0) return 1.0;
    if (a <= 0 || b <= 0) return 0.0;
    const logA = Math.log10(a + 1);
    const logB = Math.log10(b + 1);
    const maxLog = Math.max(logA, logB, 1);
    return 1 - Math.abs(logA - logB) / maxLog;
  }

  /** Similarity for signed values — same sign is important */
  private signedSimilarity(a: number, b: number): number {
    if (Math.sign(a) !== Math.sign(b)) return 0.2;
    const maxAbs = Math.max(Math.abs(a), Math.abs(b), 1);
    return 1 - Math.abs(a - b) / maxAbs;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Aggregate Analysis ──
  // ══════════════════════════════════════════════════════════════════════════

  private computeAggregateStats(matches: SimilarTrade[]): AggregateStats {
    if (matches.length === 0) return this.emptyStats();

    const trades = matches.map(m => m.trade);
    const wins = trades.filter(t => (t.pnlSol ?? 0) > 0).length;
    const losses = trades.length - wins;

    const avgPnlPct = trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length;
    const avgHoldTimeSec = trades.reduce((s, t) => s + (t.holdTimeSec ?? 0), 0) / trades.length;
    const avgPeakPnlPct = trades.reduce((s, t) => s + (t.peakPnlPct ?? 0), 0) / trades.length;

    const exitReasons = trades.map(t => t.exitReason).filter(Boolean) as string[];
    const mostCommonExitReason = this.getMostCommon(exitReasons);

    // Post-sale analysis from similar trades
    const withPostSale = trades.filter(t => t.postSaleVerdict);
    const postSaleGoodExits = withPostSale.filter(t => t.postSaleVerdict === "good-exit" || t.postSaleVerdict === "token-dead").length;
    const postSaleMissedOps = withPostSale.filter(t => t.postSaleVerdict === "missed-opportunity" || t.postSaleVerdict === "missed-graduation" || t.postSaleVerdict === "early-exit").length;
    const missedPcts = withPostSale.filter(t => t.postSalePeakPct != null).map(t => t.postSalePeakPct!);
    const avgPostSaleMissedPct = missedPcts.length > 0 ? missedPcts.reduce((s, v) => s + v, 0) / missedPcts.length : 0;

    return {
      totalMatches: matches.length,
      wins,
      losses,
      winRate: wins / matches.length,
      avgPnlPct,
      avgHoldTimeSec,
      mostCommonExitReason,
      avgPeakPnlPct,
      postSaleGoodExits,
      postSaleMissedOps,
      avgPostSaleMissedPct,
    };
  }

  private getMostCommon(arr: string[]): string {
    if (arr.length === 0) return "unknown";
    const counts = new Map<string, number>();
    for (const item of arr) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    let maxCount = 0;
    let maxItem = "unknown";
    for (const [item, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        maxItem = item;
      }
    }
    return maxItem;
  }

  private emptyStats(): AggregateStats {
    return {
      totalMatches: 0, wins: 0, losses: 0, winRate: 0,
      avgPnlPct: 0, avgHoldTimeSec: 0, mostCommonExitReason: "none", avgPeakPnlPct: 0,
      postSaleGoodExits: 0, postSaleMissedOps: 0, avgPostSaleMissedPct: 0,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Prompt Building ──
  // ══════════════════════════════════════════════════════════════════════════

  private buildPromptBlock(
    symbol: string,
    matches: SimilarTrade[],
    stats: AggregateStats,
    kbSize: number,
  ): string {
    if (matches.length === 0) return "";

    const lines: string[] = [];
    lines.push(`\n═══ HISTORICAL PATTERN MATCH (RAG) for ${symbol} ═══`);
    lines.push(`Knowledge base: ${kbSize} completed trades. Found ${matches.length} similar past trades:`);
    lines.push("");

    // Summary stats
    const verdict = stats.losses > stats.wins
      ? `⚠️ WARNING: Similar tokens have been LOSING trades (${stats.wins}W/${stats.losses}L)`
      : stats.wins > stats.losses
        ? `✅ POSITIVE: Similar tokens have been WINNING trades (${stats.wins}W/${stats.losses}L)`
        : `⚖️ MIXED: Similar tokens have mixed outcomes (${stats.wins}W/${stats.losses}L)`;

    lines.push(verdict);
    lines.push(`Win Rate: ${(stats.winRate * 100).toFixed(0)}% | Avg P&L: ${(stats.avgPnlPct * 100).toFixed(1)}% | Avg Hold: ${stats.avgHoldTimeSec.toFixed(0)}s | Main Exit: ${stats.mostCommonExitReason}`);
    lines.push(`Avg Peak P&L: ${(stats.avgPeakPnlPct * 100).toFixed(1)}% (how close they got to profit before exit)`);
    if (stats.postSaleGoodExits + stats.postSaleMissedOps > 0) {
      lines.push(`Post-Sale: ${stats.postSaleGoodExits} good exits, ${stats.postSaleMissedOps} missed opportunities (avg missed: +${(stats.avgPostSaleMissedPct * 100).toFixed(0)}%)`);
    }
    lines.push("");

    // Individual trade details
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const t = m.trade;
      const pnlStr = t.pnlPct !== undefined ? `${(t.pnlPct * 100).toFixed(1)}%` : "?";
      const peakStr = t.peakPnlPct !== undefined ? `${(t.peakPnlPct * 100).toFixed(1)}%` : "?";
      const result = (t.pnlSol ?? 0) > 0 ? "✅ WIN" : "❌ LOSS";
      const socialStr = t.socialScore ? ` social=${t.socialScore}` : "";
      const smStr = t.smartMoneyRank ? ` sm_rank=#${t.smartMoneyRank}` : "";
      const fmStr = t.socialFirstMover ? " 🥇FM" : "";
      const postStr = t.postSaleVerdict ? ` [post: ${t.postSaleVerdict}${t.postSaleGraduated ? " 🎓GRAD" : ""}]` : "";
      lines.push(
        `  ${i + 1}. ${t.symbol} (${t.name}) — ${result} ${pnlStr} P&L | ` +
        `Peak: ${peakStr} | Hold: ${t.holdTimeSec?.toFixed(0) ?? "?"}s | ` +
        `Exit: ${t.exitReason ?? "?"}${postStr} | Sim: ${(m.similarity * 100).toFixed(0)}%`,
      );
      lines.push(
        `     Entry: mcap=${(t.marketCapSol ?? 0).toFixed(1)} SOL, vol=${(t.volumeSol ?? 0).toFixed(1)} SOL, ` +
        `buys=${t.buyCount ?? 0}, sellers=${t.sellCount ?? 0}, buyers=${t.uniqueBuyers ?? 0}, ` +
        `bonding=${((t.bondingCurveProgress ?? 0) * 100).toFixed(0)}%, narrative=${t.llmNarrative ?? "?"}${socialStr}${smStr}${fmStr}`,
      );
      lines.push(`     Matched on: ${m.matchedFeatures.join(", ")}`);
    }

    lines.push("");
    // Frame losses as data, not doom
    if (stats.wins === 0 && stats.losses > 0) {
      lines.push("📊 LEARNING FROM LOSSES: These similar trades lost, but that tells you WHAT TO AVOID, not to avoid everything.");
      lines.push("Look for what's DIFFERENT about this candidate vs the losers — better buy pressure? More unique buyers? Stronger narrative?");
      lines.push("If this token has traits the losers DIDN'T have (e.g. social buzz, smart money, first mover), it's worth a shot.");
    } else {
      lines.push("USE THIS DATA: Learn from past patterns. If similar tokens won, identify what made them winners.");
      lines.push("If they lost, look for what's different about this candidate.");
    }

    return lines.join("\n");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Global Knowledge Summary ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Build a global "lessons learned" section from ALL past trades.
   * This gives the agent persistent memory of macro patterns.
   */
  getGlobalLessons(): string {
    this.ensureFresh();
    const trades = this.completedTrades;
    if (trades.length < MIN_COMPLETED_TRADES) return "";

    const wins = trades.filter(t => (t.pnlSol ?? 0) > 0);
    const losses = trades.filter(t => (t.pnlSol ?? 0) <= 0);
    const winRate = wins.length / trades.length;

    const lines: string[] = [];
    lines.push(`\n═══ LESSONS FROM ${trades.length} PAST TRADES (RAG Memory) ═══`);
    lines.push(`Overall: ${wins.length}W/${losses.length}L (${(winRate * 100).toFixed(0)}% WR)`);

    // Exit reason breakdown
    const exitReasons = new Map<string, { count: number; wins: number; avgPnl: number }>();
    for (const t of trades) {
      const reason = t.exitReason ?? "unknown";
      const entry = exitReasons.get(reason) ?? { count: 0, wins: 0, avgPnl: 0 };
      entry.count++;
      if ((t.pnlSol ?? 0) > 0) entry.wins++;
      entry.avgPnl += t.pnlPct ?? 0;
      exitReasons.set(reason, entry);
    }
    lines.push("\nExit reasons:");
    for (const [reason, data] of exitReasons) {
      lines.push(`  ${reason}: ${data.count}x, ${data.wins}W/${data.count - data.wins}L, avg P&L: ${((data.avgPnl / data.count) * 100).toFixed(1)}%`);
    }

    // Narrative breakdown
    const narratives = new Map<string, { count: number; wins: number; avgPnl: number }>();
    for (const t of trades) {
      const narr = t.llmNarrative ?? "unknown";
      const entry = narratives.get(narr) ?? { count: 0, wins: 0, avgPnl: 0 };
      entry.count++;
      if ((t.pnlSol ?? 0) > 0) entry.wins++;
      entry.avgPnl += t.pnlPct ?? 0;
      narratives.set(narr, entry);
    }
    lines.push("\nNarrative performance:");
    for (const [narr, data] of [...narratives.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const avgPnl = ((data.avgPnl / data.count) * 100).toFixed(1);
      lines.push(`  ${narr}: ${data.count}x, ${data.wins}W/${data.count - data.wins}L, avg P&L: ${avgPnl}%`);
    }

    // Score range breakdown
    const scoreRanges = [
      { label: "0-30", min: 0, max: 30 },
      { label: "31-50", min: 31, max: 50 },
      { label: "51-70", min: 51, max: 70 },
      { label: "71-85", min: 71, max: 85 },
      { label: "86-100", min: 86, max: 100 },
    ];
    lines.push("\nSignal score performance:");
    for (const range of scoreRanges) {
      const inRange = trades.filter(t => (t.signalScore ?? 0) >= range.min && (t.signalScore ?? 0) <= range.max);
      if (inRange.length === 0) continue;
      const rWins = inRange.filter(t => (t.pnlSol ?? 0) > 0).length;
      const rAvgPnl = inRange.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / inRange.length;
      lines.push(`  Score ${range.label}: ${inRange.length}x, ${rWins}W/${inRange.length - rWins}L, avg P&L: ${(rAvgPnl * 100).toFixed(1)}%`);
    }

    // Market cap range breakdown
    const mcapRanges = [
      { label: "<5 SOL", min: 0, max: 5 },
      { label: "5-20 SOL", min: 5, max: 20 },
      { label: "20-50 SOL", min: 20, max: 50 },
      { label: "50-100 SOL", min: 50, max: 100 },
      { label: ">100 SOL", min: 100, max: Infinity },
    ];
    lines.push("\nMarket cap at entry:");
    for (const range of mcapRanges) {
      const inRange = trades.filter(t => (t.marketCapSol ?? 0) >= range.min && (t.marketCapSol ?? 0) < range.max);
      if (inRange.length === 0) continue;
      const rWins = inRange.filter(t => (t.pnlSol ?? 0) > 0).length;
      const rAvgPnl = inRange.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / inRange.length;
      lines.push(`  ${range.label}: ${inRange.length}x, ${rWins}W/${inRange.length - rWins}L, avg P&L: ${(rAvgPnl * 100).toFixed(1)}%`);
    }

    // Peak P&L analysis — did we enter good positions but exit too early/late?
    const avgPeakPnl = trades.reduce((s, t) => s + (t.peakPnlPct ?? 0), 0) / trades.length;
    const avgActualPnl = trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length;
    const missedProfit = avgPeakPnl - avgActualPnl;
    lines.push(`\nTiming analysis:`);
    lines.push(`  Avg peak P&L: ${(avgPeakPnl * 100).toFixed(1)}% | Avg actual P&L: ${(avgActualPnl * 100).toFixed(1)}% | Missed profit: ${(missedProfit * 100).toFixed(1)}%`);
    if (missedProfit > 0.05) {
      lines.push(`  ⚠️ We're missing ${(missedProfit * 100).toFixed(1)}% profit on average — positions reach peak then reverse before exit.`);
    }

    // Social signal analysis
    const withSocial = trades.filter(t => t.socialScore != null && t.socialScore > 0);
    const withoutSocial = trades.filter(t => !t.socialScore || t.socialScore === 0);
    if (withSocial.length >= 3 && withoutSocial.length >= 3) {
      const socialWR = withSocial.filter(t => (t.pnlSol ?? 0) > 0).length / withSocial.length;
      const noSocialWR = withoutSocial.filter(t => (t.pnlSol ?? 0) > 0).length / withoutSocial.length;
      lines.push(`\nSocial signal impact:`);
      lines.push(`  With social buzz (${withSocial.length} trades): ${(socialWR * 100).toFixed(0)}% WR`);
      lines.push(`  Without social (${withoutSocial.length} trades): ${(noSocialWR * 100).toFixed(0)}% WR`);
      if (socialWR > noSocialWR + 0.1) {
        lines.push(`  ✅ Social buzz correlates with better outcomes — prioritize tokens with social engagement`);
      }
    }

    // First mover analysis
    const firstMovers = trades.filter(t => t.socialFirstMover === true);
    const notFirstMovers = trades.filter(t => t.socialFirstMover === false);
    if (firstMovers.length >= 3 && notFirstMovers.length >= 3) {
      const fmWR = firstMovers.filter(t => (t.pnlSol ?? 0) > 0).length / firstMovers.length;
      const nfmWR = notFirstMovers.filter(t => (t.pnlSol ?? 0) > 0).length / notFirstMovers.length;
      lines.push(`  First movers: ${(fmWR * 100).toFixed(0)}% WR (${firstMovers.length} trades) vs copycat: ${(nfmWR * 100).toFixed(0)}% WR (${notFirstMovers.length} trades)`);
    }

    // Smart money analysis
    const withSM = trades.filter(t => t.smartMoneyRank != null && t.smartMoneyRank > 0);
    if (withSM.length >= 3) {
      const smWR = withSM.filter(t => (t.pnlSol ?? 0) > 0).length / withSM.length;
      const smAvgPnl = withSM.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / withSM.length;
      lines.push(`\nSmart money impact:`);
      lines.push(`  Trades with smart money backing (${withSM.length}): ${(smWR * 100).toFixed(0)}% WR, avg P&L: ${(smAvgPnl * 100).toFixed(1)}%`);
    }

    // Token metadata correlation (Twitter, website, Telegram)
    const withTwitter = trades.filter(t => t.hasTwitter === true);
    const withWebsite = trades.filter(t => t.hasWebsite === true);
    if (withTwitter.length >= 5) {
      const twWR = withTwitter.filter(t => (t.pnlSol ?? 0) > 0).length / withTwitter.length;
      lines.push(`\nToken metadata:`);
      lines.push(`  With Twitter (${withTwitter.length} trades): ${(twWR * 100).toFixed(0)}% WR`);
    }
    if (withWebsite.length >= 5) {
      const webWR = withWebsite.filter(t => (t.pnlSol ?? 0) > 0).length / withWebsite.length;
      if (!lines[lines.length - 1]?.startsWith("  With Twitter")) lines.push(`\nToken metadata:`);
      lines.push(`  With Website (${withWebsite.length} trades): ${(webWR * 100).toFixed(0)}% WR`);
    }

    // Hour of day analysis (find best/worst trading hours)
    const hourBuckets = new Map<number, { count: number; wins: number }>();
    for (const t of trades) {
      const h = t.hourOfDay ?? new Date(t.timestamp).getHours();
      const entry = hourBuckets.get(h) ?? { count: 0, wins: 0 };
      entry.count++;
      if ((t.pnlSol ?? 0) > 0) entry.wins++;
      hourBuckets.set(h, entry);
    }
    const sortedHours = [...hourBuckets.entries()]
      .filter(([, d]) => d.count >= 5)
      .sort((a, b) => (b[1].wins / b[1].count) - (a[1].wins / a[1].count));
    if (sortedHours.length >= 2) {
      const best = sortedHours[0]!;
      const worst = sortedHours[sortedHours.length - 1]!;
      lines.push(`\nTime-of-day analysis:`);
      lines.push(`  Best hour: ${best[0]}:00 UTC — ${(best[1].wins / best[1].count * 100).toFixed(0)}% WR (${best[1].count} trades)`);
      lines.push(`  Worst hour: ${worst[0]}:00 UTC — ${(worst[1].wins / worst[1].count * 100).toFixed(0)}% WR (${worst[1].count} trades)`);
    }

    // Post-sale verdict analysis
    const postSaleTracked = trades.filter(t => t.postSaleVerdict);
    if (postSaleTracked.length >= 5) {
      const goodExits = postSaleTracked.filter(t => t.postSaleVerdict === "good-exit" || t.postSaleVerdict === "token-dead").length;
      const missedOps = postSaleTracked.filter(t => t.postSaleVerdict === "missed-opportunity" || t.postSaleVerdict === "missed-graduation").length;
      const earlyExits = postSaleTracked.filter(t => t.postSaleVerdict === "early-exit").length;
      lines.push(`\nPost-sale analysis (${postSaleTracked.length} tracked):`);
      lines.push(`  Good exits: ${goodExits} | Missed opportunities: ${missedOps} | Early exits: ${earlyExits}`);
      const avgMissed = postSaleTracked.filter(t => t.postSalePeakPct != null).reduce((s, t) => s + (t.postSalePeakPct ?? 0), 0);
      const missedCount = postSaleTracked.filter(t => t.postSalePeakPct != null).length;
      if (missedCount > 0) {
        lines.push(`  Avg missed upside: +${((avgMissed / missedCount) * 100).toFixed(1)}%`);
      }
      // Extended post-sale (1h data)
      const with1h = postSaleTracked.filter(t => t.postSaleChange1hPct != null);
      if (with1h.length >= 3) {
        const avg1hChange = with1h.reduce((s, t) => s + (t.postSaleChange1hPct ?? 0), 0) / with1h.length;
        lines.push(`  Avg 1h post-sale change: ${(avg1hChange * 100).toFixed(1)}%`);
      }
    }

    // Creator correlation (dev wallet hash patterns)
    const devWalletTrades = new Map<string, { count: number; wins: number }>();
    for (const t of trades) {
      if (!t.devWalletHash) continue;
      const entry = devWalletTrades.get(t.devWalletHash) ?? { count: 0, wins: 0 };
      entry.count++;
      if ((t.pnlSol ?? 0) > 0) entry.wins++;
      devWalletTrades.set(t.devWalletHash, entry);
    }
    const repeatCreators = [...devWalletTrades.entries()].filter(([, d]) => d.count >= 2).sort((a, b) => b[1].count - a[1].count);
    if (repeatCreators.length > 0) {
      lines.push(`\nCreator patterns:`);
      lines.push(`  ${repeatCreators.length} repeat creators found (multiple tokens traded from same dev)`);
      for (const [hash, data] of repeatCreators.slice(0, 3)) {
        const wr = (data.wins / data.count * 100).toFixed(0);
        lines.push(`  Creator ${hash.slice(0, 8)}…: ${data.count} trades, ${wr}% WR`);
      }
    }

    // Key lessons — balanced with expert knowledge
    lines.push("\n📚 KEY LESSONS:");
    if (winRate === 0 && trades.length >= 5) {
      lines.push("  🟡 0% win rate across " + trades.length + " trades. Past trades have ALL lost, but this is LEARNING DATA, not a reason to stop trading.");
      lines.push("  💡 Focus on what made these trades LOSE — then look for tokens with OPPOSITE characteristics.");
      lines.push("  💡 You MUST keep trading (with tiny positions) to generate data and find winning patterns.");
      lines.push("  💡 60% of ALL memecoin traders lose money — your results aren't unusual for early learning phase.");
    } else if (winRate < 0.3 && trades.length >= 5) {
      lines.push("  🟡 Low win rate (" + (winRate * 100).toFixed(0) + "%). Focus on the DIFFERENCE between wins and losses.");
      lines.push("  💡 What did winning trades have that losers didn't? More buyers? Better narrative? Fresher?");
    } else if (winRate >= 0.3) {
      lines.push("  ✅ Win rate is " + (winRate * 100).toFixed(0) + "%. Keep doing what works.");
    }

    // Inject expert framing to prevent paralysis
    const expertContext = getExpertFraming(winRate, trades.length);
    if (expertContext) lines.push(expertContext);

    // Find which factors correlate with best/worst outcomes
    const bestTrades = [...trades].sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0)).slice(0, 3);
    const worstTrades = [...trades].sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0)).slice(0, 3);

    if (bestTrades.length > 0) {
      const avgBestMcap = bestTrades.reduce((s, t) => s + (t.marketCapSol ?? 0), 0) / bestTrades.length;
      const avgBestVol = bestTrades.reduce((s, t) => s + (t.volumeSol ?? 0), 0) / bestTrades.length;
      const avgBestBuyers = bestTrades.reduce((s, t) => s + (t.uniqueBuyers ?? 0), 0) / bestTrades.length;
      lines.push(`  Best trades avg: mcap=${avgBestMcap.toFixed(1)} SOL, vol=${avgBestVol.toFixed(1)} SOL, buyers=${avgBestBuyers.toFixed(0)}`);
    }
    if (worstTrades.length > 0) {
      const avgWorstMcap = worstTrades.reduce((s, t) => s + (t.marketCapSol ?? 0), 0) / worstTrades.length;
      const avgWorstVol = worstTrades.reduce((s, t) => s + (t.volumeSol ?? 0), 0) / worstTrades.length;
      const avgWorstBuyers = worstTrades.reduce((s, t) => s + (t.uniqueBuyers ?? 0), 0) / worstTrades.length;
      lines.push(`  Worst trades avg: mcap=${avgWorstMcap.toFixed(1)} SOL, vol=${avgWorstVol.toFixed(1)} SOL, buyers=${avgWorstBuyers.toFixed(0)}`);
    }

    return lines.join("\n");
  }

  /** Compact lessons for token review prompts (~200 tokens vs ~1086) */
  getCompactLessons(): string {
    this.ensureFresh();
    const trades = this.completedTrades;
    if (trades.length < MIN_COMPLETED_TRADES) return "";

    const wins = trades.filter(t => (t.pnlSol ?? 0) > 0);
    const losses = trades.filter(t => (t.pnlSol ?? 0) <= 0);
    const winRate = wins.length / trades.length;

    const lines: string[] = [];
    lines.push(`RAG MEMORY (${trades.length} trades): ${wins.length}W/${losses.length}L (${(winRate * 100).toFixed(0)}% WR)`);

    // Top 3 exit reasons by count
    const exitReasons = new Map<string, { count: number; wins: number }>();
    for (const t of trades) {
      const reason = t.exitReason ?? "unknown";
      const entry = exitReasons.get(reason) ?? { count: 0, wins: 0 };
      entry.count++;
      if ((t.pnlSol ?? 0) > 0) entry.wins++;
      exitReasons.set(reason, entry);
    }
    const topExits = [...exitReasons.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    lines.push(`  Top exits: ${topExits.map(([r, d]) => `${r} ${d.count}x (${d.wins}W)`).join(", ")}`);

    // Top 3 narratives by count
    const narratives = new Map<string, { count: number; wins: number }>();
    for (const t of trades) {
      const narr = t.llmNarrative ?? "unknown";
      const entry = narratives.get(narr) ?? { count: 0, wins: 0 };
      entry.count++;
      if ((t.pnlSol ?? 0) > 0) entry.wins++;
      narratives.set(narr, entry);
    }
    const topNarr = [...narratives.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    lines.push(`  Top narratives: ${topNarr.map(([n, d]) => `${n} ${d.count}x (${d.wins}W)`).join(", ")}`);

    // Timing summary — one line
    const avgPeakPnl = trades.reduce((s, t) => s + (t.peakPnlPct ?? 0), 0) / trades.length;
    const avgActualPnl = trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length;
    lines.push(`  Avg peak: ${(avgPeakPnl * 100).toFixed(1)}% | Actual: ${(avgActualPnl * 100).toFixed(1)}% | Missed: ${((avgPeakPnl - avgActualPnl) * 100).toFixed(1)}%`);

    return lines.join("\n");
  }

  /** Get stats for status endpoint */
  getStats() {
    return {
      knowledgeBaseSize: this.completedTrades.length,
      active: this.completedTrades.length >= MIN_COMPLETED_TRADES,
    };
  }
}
