// ── Trade Journal: persistent log of every trade with full context ──
// This gives the autonomous agent memory to learn from past trades.

import fs from "node:fs";
import path from "node:path";

export interface TradeEntry {
  id: string;
  /** "buy" or "sell" */
  action: "buy" | "sell";
  mint: string;
  symbol: string;
  name: string;
  timestamp: number;

  // ── Entry context (buy) ──
  signalScore?: number;
  llmScore?: number;
  llmNarrative?: string;
  llmReasoning?: string;
  llmConfidence?: number;
  marketRegime?: string;
  creatorReputation?: number;
  creatorBlacklisted?: boolean;
  positionSizeSol?: number;
  entryPrice?: number;
  marketCapSol?: number;
  volumeSol?: number;
  buyCount?: number;
  sellCount?: number;
  uniqueBuyers?: number;
  bondingCurveProgress?: number;
  tokenAgeSec?: number;

  // ── Enrichment data (from scanner context) ──
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

  // ── Extended enrichment data (Phase 2) ──
  replyCount?: number;       // pump.fun reply thread activity
  hasTwitter?: boolean;      // Token has a linked Twitter/X account
  hasWebsite?: boolean;      // Token has a linked website
  hasTelegram?: boolean;     // Token has a linked Telegram
  tokenDescription?: string; // Truncated description (max 200 chars)
  narrativeBoost?: number;   // Market intel narrative boost score (0-15)
  devWalletHash?: string;    // SHA-256 prefix of dev wallet (privacy-safe, for creator correlation)
  hourOfDay?: number;        // 0-23, hour of entry (UTC)
  dayOfWeek?: number;        // 0-6, day of entry (0=Sunday)

  // ── Exit context (sell) ──
  exitReason?: string;
  exitPrice?: number;
  pnlSol?: number;
  pnlPct?: number;
  holdTimeSec?: number;
  peakPrice?: number;
  peakPnlPct?: number;

  // ── Transaction signatures (for on-chain verification) ──
  entryTxSignature?: string;
  exitTxSignatures?: string[];

  // ── Config at time of trade ──
  configSnapshot?: {
    minPositionSizeSol: number;
    maxPositionSizeSol: number;
    stopLossPct: number;
    takeProfitPct1: number;
    takeProfitPct2: number;
    maxConcurrentPositions: number;
    maxTotalExposureSol: number;
  };

  // ── Post-sale monitoring (filled after exit, updated at 10m and 1h) ──
  postSaleVerdict?: string;     // "good-exit" | "missed-opportunity" | "early-exit" | "token-dead" etc.
  postSaleAnalysis?: string;    // Human-readable analysis
  postSalePeakPct?: number;     // % price moved up post-sale (missed upside)
  postSaleChange10mPct?: number; // % price changed 10 min after sale
  postSaleChange1hPct?: number;  // % price changed 1 hour after sale
  postSaleGraduated?: boolean;  // Did token graduate after we sold?

  // ── Live eligibility tracking (dry-run only: would this trade have passed live filters?) ──
  liveEligible?: boolean;       // true = passed all live-mode quality gates
  liveFilterFailReasons?: string[]; // Which gates this trade failed, e.g. ["uniqueBuyers:4<5", "volume:0.3<0.5"]
}

export interface JournalAnalysis {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  avgHoldTimeSec: number;
  /** Win rate by exit reason */
  exitReasonStats: Record<string, { count: number; avgPnl: number; winRate: number }>;
  /** Win rate by market regime */
  regimeStats: Record<string, { count: number; avgPnl: number; winRate: number }>;
  /** Win rate by LLM narrative category */
  narrativeStats: Record<string, { count: number; avgPnl: number; winRate: number }>;
  /** Score distribution: how trades performed at different signal scores */
  scoreRangeStats: Record<string, { count: number; avgPnl: number; winRate: number }>;
  /** Recent trend: last N trades performance */
  recentTrend: { trades: number; winRate: number; avgPnl: number; direction: "improving" | "declining" | "stable" };
  /** Top patterns identified */
  patterns: string[];
}

export class TradeJournal {
  private entries: TradeEntry[] = [];
  private persistPath: string;
  private maxEntries = 10000;

  constructor(dataDir: string) {
    this.persistPath = path.join(dataDir, "trade-journal.json");
    this.load();
  }

  /** Log a buy (entry) */
  logEntry(params: {
    mint: string;
    symbol: string;
    name: string;
    signalScore: number;
    llmScore?: number;
    llmNarrative?: string;
    llmReasoning?: string;
    llmConfidence?: number;
    marketRegime: string;
    creatorReputation: number;
    creatorBlacklisted: boolean;
    positionSizeSol: number;
    entryPrice: number;
    marketCapSol: number;
    volumeSol: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    bondingCurveProgress: number;
    tokenAgeSec?: number;
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
    replyCount?: number;
    hasTwitter?: boolean;
    hasWebsite?: boolean;
    hasTelegram?: boolean;
    tokenDescription?: string;
    narrativeBoost?: number;
    devWalletHash?: string;
    liveEligible?: boolean;
    liveFilterFailReasons?: string[];
    configSnapshot: TradeEntry["configSnapshot"];
  }): TradeEntry {
    const now = new Date();
    const entry: TradeEntry = {
      id: `${Date.now()}-${params.mint.slice(0, 8)}`,
      action: "buy",
      mint: params.mint,
      symbol: params.symbol,
      name: params.name,
      timestamp: Date.now(),
      signalScore: params.signalScore,
      llmScore: params.llmScore,
      llmNarrative: params.llmNarrative,
      llmReasoning: params.llmReasoning,
      llmConfidence: params.llmConfidence,
      marketRegime: params.marketRegime,
      creatorReputation: params.creatorReputation,
      creatorBlacklisted: params.creatorBlacklisted,
      positionSizeSol: params.positionSizeSol,
      entryPrice: params.entryPrice,
      marketCapSol: params.marketCapSol,
      volumeSol: params.volumeSol,
      buyCount: params.buyCount,
      sellCount: params.sellCount,
      uniqueBuyers: params.uniqueBuyers,
      bondingCurveProgress: params.bondingCurveProgress,
      tokenAgeSec: params.tokenAgeSec,
      spamLaunchCount: params.spamLaunchCount,
      socialScore: params.socialScore,
      socialFirstMover: params.socialFirstMover,
      socialCompetingCoins: params.socialCompetingCoins,
      socialXTweets: params.socialXTweets,
      socialViralMeme: params.socialViralMeme,
      smartMoneyRank: params.smartMoneyRank,
      smartMoneyWinRate: params.smartMoneyWinRate,
      whaleCount: params.whaleCount,
      whaleVolumeSol: params.whaleVolumeSol,
      replyCount: params.replyCount,
      hasTwitter: params.hasTwitter,
      hasWebsite: params.hasWebsite,
      hasTelegram: params.hasTelegram,
      tokenDescription: params.tokenDescription?.slice(0, 200),
      narrativeBoost: params.narrativeBoost,
      devWalletHash: params.devWalletHash,
      hourOfDay: now.getUTCHours(),
      dayOfWeek: now.getUTCDay(),
      liveEligible: params.liveEligible,
      liveFilterFailReasons: params.liveFilterFailReasons,
      configSnapshot: params.configSnapshot,
    };

    this.entries.push(entry);
    this.trimAndPersist();
    return entry;
  }

  /** Log a sell (exit) — finds the matching buy entry and creates a paired exit entry */
  logExit(params: {
    mint: string;
    symbol: string;
    exitReason: string;
    exitPrice: number;
    pnlSol: number;
    pnlPct: number;
    holdTimeSec: number;
    peakPrice: number;
    peakPnlPct: number;
    configSnapshot: TradeEntry["configSnapshot"];
  }): TradeEntry {
    const entry: TradeEntry = {
      id: `${Date.now()}-${params.mint.slice(0, 8)}-exit`,
      action: "sell",
      mint: params.mint,
      symbol: params.symbol,
      name: "",
      timestamp: Date.now(),
      exitReason: params.exitReason,
      exitPrice: params.exitPrice,
      pnlSol: params.pnlSol,
      pnlPct: params.pnlPct,
      holdTimeSec: params.holdTimeSec,
      peakPrice: params.peakPrice,
      peakPnlPct: params.peakPnlPct,
      configSnapshot: params.configSnapshot,
    };

    // Copy entry context from matching buy entry
    const buyEntry = [...this.entries].reverse().find(
      (e) => e.mint === params.mint && e.action === "buy"
    );
    if (buyEntry) {
      entry.name = buyEntry.name;
      entry.signalScore = buyEntry.signalScore;
      entry.llmScore = buyEntry.llmScore;
      entry.llmNarrative = buyEntry.llmNarrative;
      entry.llmReasoning = buyEntry.llmReasoning;
      entry.llmConfidence = buyEntry.llmConfidence;
      entry.marketRegime = buyEntry.marketRegime;
      entry.creatorReputation = buyEntry.creatorReputation;
      entry.creatorBlacklisted = buyEntry.creatorBlacklisted;
      entry.positionSizeSol = buyEntry.positionSizeSol;
      entry.entryPrice = buyEntry.entryPrice;
      entry.marketCapSol = buyEntry.marketCapSol;
      entry.volumeSol = buyEntry.volumeSol;
      entry.buyCount = buyEntry.buyCount;
      entry.sellCount = buyEntry.sellCount;
      entry.uniqueBuyers = buyEntry.uniqueBuyers;
      entry.bondingCurveProgress = buyEntry.bondingCurveProgress;
      entry.tokenAgeSec = buyEntry.tokenAgeSec;
      entry.spamLaunchCount = buyEntry.spamLaunchCount;
      entry.socialScore = buyEntry.socialScore;
      entry.socialFirstMover = buyEntry.socialFirstMover;
      entry.socialCompetingCoins = buyEntry.socialCompetingCoins;
      entry.socialXTweets = buyEntry.socialXTweets;
      entry.socialViralMeme = buyEntry.socialViralMeme;
      entry.smartMoneyRank = buyEntry.smartMoneyRank;
      entry.smartMoneyWinRate = buyEntry.smartMoneyWinRate;
      entry.whaleCount = buyEntry.whaleCount;
      entry.whaleVolumeSol = buyEntry.whaleVolumeSol;
      // Extended enrichment fields
      entry.replyCount = buyEntry.replyCount;
      entry.hasTwitter = buyEntry.hasTwitter;
      entry.hasWebsite = buyEntry.hasWebsite;
      entry.hasTelegram = buyEntry.hasTelegram;
      entry.tokenDescription = buyEntry.tokenDescription;
      entry.narrativeBoost = buyEntry.narrativeBoost;
      entry.devWalletHash = buyEntry.devWalletHash;
      entry.hourOfDay = buyEntry.hourOfDay;
      entry.dayOfWeek = buyEntry.dayOfWeek;
      entry.liveEligible = buyEntry.liveEligible;
      entry.liveFilterFailReasons = buyEntry.liveFilterFailReasons;
    }

    this.entries.push(entry);
    this.trimAndPersist();
    return entry;
  }

  /** Get all completed trades (exits only, with full context) */
  getCompletedTrades(limit = 100): TradeEntry[] {
    return this.entries
      .filter((e) => e.action === "sell")
      .slice(-limit);
  }

  /** Get the last buy entry for a mint (for missed-winner tracking in scanner) */
  getLastBuyEntry(mint: string): TradeEntry | undefined {
    return [...this.entries].reverse().find(e => e.mint === mint && e.action === "buy");
  }

  /** Get recent N entries (both buys and sells) */
  getRecent(limit = 50): TradeEntry[] {
    return this.entries.slice(-limit);
  }

  /** Update a completed trade with post-sale monitoring data */
  updatePostSaleData(mint: string, data: {
    verdict: string;
    analysis: string;
    missedUpsidePct?: number;
    priceChange10mPct?: number;
    priceChange1hPct?: number;
    graduated?: boolean;
  }): void {
    // Find the most recent sell entry for this mint
    const entry = [...this.entries].reverse().find(
      (e) => e.mint === mint && e.action === "sell"
    );
    if (!entry) return;
    entry.postSaleVerdict = data.verdict;
    entry.postSaleAnalysis = data.analysis;
    entry.postSalePeakPct = data.missedUpsidePct;
    entry.postSaleChange10mPct = data.priceChange10mPct;
    entry.postSaleChange1hPct = data.priceChange1hPct;
    entry.postSaleGraduated = data.graduated;
    this.persist();
  }

  /** Deep analysis of trade history for the autonomous agent */
  analyze(): JournalAnalysis {
    const exits = this.entries.filter((e) => e.action === "sell");
    const wins = exits.filter((e) => (e.pnlSol ?? 0) > 0);
    const losses = exits.filter((e) => (e.pnlSol ?? 0) <= 0);

    const totalPnl = exits.reduce((sum, e) => sum + (e.pnlSol ?? 0), 0);
    const avgPnl = exits.length > 0 ? totalPnl / exits.length : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / losses.length : 0;
    const avgHold = exits.length > 0
      ? exits.reduce((s, e) => s + (e.holdTimeSec ?? 0), 0) / exits.length
      : 0;

    // Exit reason stats
    const exitReasonStats: JournalAnalysis["exitReasonStats"] = {};
    for (const e of exits) {
      const reason = e.exitReason ?? "unknown";
      if (!exitReasonStats[reason]) exitReasonStats[reason] = { count: 0, avgPnl: 0, winRate: 0 };
      exitReasonStats[reason].count++;
    }
    for (const reason of Object.keys(exitReasonStats)) {
      const group = exits.filter((e) => (e.exitReason ?? "unknown") === reason);
      const groupWins = group.filter((e) => (e.pnlSol ?? 0) > 0).length;
      exitReasonStats[reason].avgPnl = group.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / group.length;
      exitReasonStats[reason].winRate = group.length > 0 ? groupWins / group.length : 0;
    }

    // Regime stats
    const regimeStats: JournalAnalysis["regimeStats"] = {};
    for (const e of exits) {
      const regime = e.marketRegime ?? "unknown";
      if (!regimeStats[regime]) regimeStats[regime] = { count: 0, avgPnl: 0, winRate: 0 };
      regimeStats[regime].count++;
    }
    for (const regime of Object.keys(regimeStats)) {
      const group = exits.filter((e) => (e.marketRegime ?? "unknown") === regime);
      const groupWins = group.filter((e) => (e.pnlSol ?? 0) > 0).length;
      regimeStats[regime].avgPnl = group.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / group.length;
      regimeStats[regime].winRate = group.length > 0 ? groupWins / group.length : 0;
    }

    // Narrative stats
    const narrativeStats: JournalAnalysis["narrativeStats"] = {};
    for (const e of exits) {
      const narrative = e.llmNarrative ?? "none";
      if (!narrativeStats[narrative]) narrativeStats[narrative] = { count: 0, avgPnl: 0, winRate: 0 };
      narrativeStats[narrative].count++;
    }
    for (const narrative of Object.keys(narrativeStats)) {
      const group = exits.filter((e) => (e.llmNarrative ?? "none") === narrative);
      const groupWins = group.filter((e) => (e.pnlSol ?? 0) > 0).length;
      narrativeStats[narrative].avgPnl = group.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / group.length;
      narrativeStats[narrative].winRate = group.length > 0 ? groupWins / group.length : 0;
    }

    // Score range stats
    const scoreRangeStats: JournalAnalysis["scoreRangeStats"] = {};
    const ranges = ["0-30", "31-50", "51-65", "66-75", "76-85", "86-100"];
    for (const range of ranges) {
      scoreRangeStats[range] = { count: 0, avgPnl: 0, winRate: 0 };
    }
    for (const e of exits) {
      const score = e.signalScore ?? 0;
      let range: string;
      if (score <= 30) range = "0-30";
      else if (score <= 50) range = "31-50";
      else if (score <= 65) range = "51-65";
      else if (score <= 75) range = "66-75";
      else if (score <= 85) range = "76-85";
      else range = "86-100";
      scoreRangeStats[range].count++;
    }
    for (const range of ranges) {
      const [lo, hi] = range.split("-").map(Number);
      const group = exits.filter((e) => {
        const s = e.signalScore ?? 0;
        return s >= lo! && s <= hi!;
      });
      if (group.length > 0) {
        const groupWins = group.filter((e) => (e.pnlSol ?? 0) > 0).length;
        scoreRangeStats[range].avgPnl = group.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / group.length;
        scoreRangeStats[range].winRate = groupWins / group.length;
      }
    }

    // Recent trend (last 10 vs previous 10)
    const last10 = exits.slice(-10);
    const prev10 = exits.slice(-20, -10);
    const last10WinRate = last10.length > 0 ? last10.filter((e) => (e.pnlSol ?? 0) > 0).length / last10.length : 0;
    const prev10WinRate = prev10.length > 0 ? prev10.filter((e) => (e.pnlSol ?? 0) > 0).length / prev10.length : 0;
    const last10AvgPnl = last10.length > 0 ? last10.reduce((s, e) => s + (e.pnlSol ?? 0), 0) / last10.length : 0;
    let direction: "improving" | "declining" | "stable" = "stable";
    if (last10.length >= 5 && prev10.length >= 5) {
      if (last10WinRate > prev10WinRate + 0.1) direction = "improving";
      else if (last10WinRate < prev10WinRate - 0.1) direction = "declining";
    }

    // Identify patterns
    const patterns: string[] = [];

    // Pattern: Stop losses dominate
    if (exitReasonStats["stop-loss"]?.count > exits.length * 0.6) {
      patterns.push(`Stop losses account for ${((exitReasonStats["stop-loss"].count / exits.length) * 100).toFixed(0)}% of exits — consider widening stop loss or tightening entry criteria`);
    }

    // Pattern: Max-age exits are profitable
    if (exitReasonStats["max-age"]?.winRate && exitReasonStats["max-age"].winRate > 0.5) {
      patterns.push(`Max-age exits have ${(exitReasonStats["max-age"].winRate * 100).toFixed(0)}% win rate — positions may benefit from longer hold times`);
    }

    // Pattern: High-score trades perform better
    if (scoreRangeStats["86-100"].count >= 3 && scoreRangeStats["86-100"].winRate > scoreRangeStats["51-65"].winRate + 0.15) {
      patterns.push(`High-score trades (86-100) significantly outperform low-score trades — consider raising minBuyScore`);
    }

    // Pattern: Certain narratives are more profitable
    const bestNarrative = Object.entries(narrativeStats)
      .filter(([, s]) => s.count >= 3)
      .sort((a, b) => b[1].winRate - a[1].winRate)[0];
    if (bestNarrative && bestNarrative[1].winRate > 0.5) {
      patterns.push(`"${bestNarrative[0]}" narrative tokens have ${(bestNarrative[1].winRate * 100).toFixed(0)}% win rate (${bestNarrative[1].count} trades)`);
    }

    // Pattern: Consecutive losses
    let maxConsecLosses = 0;
    let currentStreak = 0;
    for (const e of exits) {
      if ((e.pnlSol ?? 0) <= 0) { currentStreak++; maxConsecLosses = Math.max(maxConsecLosses, currentStreak); }
      else currentStreak = 0;
    }
    if (maxConsecLosses >= 5) {
      patterns.push(`Max consecutive losses: ${maxConsecLosses} — risk management may need tightening`);
    }

    // Pattern: Take profit too early
    const tp1Exits = exits.filter((e) => e.exitReason === "take-profit-1");
    const tp2Exits = exits.filter((e) => e.exitReason === "take-profit-2");
    if (tp1Exits.length > 0 && tp2Exits.length === 0 && exits.length >= 5) {
      const avgPeakPnl = tp1Exits.reduce((s, e) => s + (e.peakPnlPct ?? 0), 0) / tp1Exits.length;
      if (avgPeakPnl > 0.3) {
        patterns.push(`Tokens hitting TP1 often continued to ${(avgPeakPnl * 100).toFixed(0)}% peak — consider raising TP1 threshold`);
      }
    }

    // Pattern: Post-sale monitoring shows missed opportunities
    const postSaleTracked = exits.filter((e) => e.postSaleVerdict);
    if (postSaleTracked.length >= 3) {
      const missedOps = postSaleTracked.filter((e) => e.postSaleVerdict === "missed-opportunity" || e.postSaleVerdict === "missed-graduation");
      const goodExits = postSaleTracked.filter((e) => e.postSaleVerdict === "good-exit" || e.postSaleVerdict === "token-dead");
      if (missedOps.length > postSaleTracked.length * 0.4) {
        patterns.push(`${((missedOps.length / postSaleTracked.length) * 100).toFixed(0)}% of exits were missed opportunities — consider wider trailing stops and higher take-profit targets`);
      }
      if (goodExits.length > postSaleTracked.length * 0.6) {
        patterns.push(`${((goodExits.length / postSaleTracked.length) * 100).toFixed(0)}% of exits were confirmed good — exit strategy is working well`);
      }
      const graduated = postSaleTracked.filter((e) => e.postSaleGraduated);
      if (graduated.length > 0) {
        patterns.push(`${graduated.length} token(s) GRADUATED after we sold — these are major missed opportunities. Hold longer when fundamentals are strong.`);
      }
    }

    return {
      totalTrades: exits.length,
      wins: wins.length,
      losses: losses.length,
      winRate: exits.length > 0 ? wins.length / exits.length : 0,
      totalPnl,
      avgPnl,
      avgWin,
      avgLoss,
      avgHoldTimeSec: avgHold,
      exitReasonStats,
      regimeStats,
      narrativeStats,
      scoreRangeStats,
      recentTrend: { trades: last10.length, winRate: last10WinRate, avgPnl: last10AvgPnl, direction },
      patterns,
    };
  }

  /** Get a natural language summary of the last N trades for the agent */
  getTradeContext(limit = 20): string {
    const recent = this.getCompletedTrades(limit);
    if (recent.length === 0) return "No completed trades yet.";

    const lines: string[] = [];
    for (const t of recent) {
      const pnlEmoji = (t.pnlSol ?? 0) >= 0 ? "✅" : "❌";
      const pnlStr = `${(t.pnlSol ?? 0) >= 0 ? "+" : ""}${(t.pnlSol ?? 0).toFixed(4)} SOL (${((t.pnlPct ?? 0) * 100).toFixed(1)}%)`;
      const scoreStr = t.signalScore !== undefined ? `score=${t.signalScore}` : "";
      const llmStr = t.llmScore !== undefined ? `llm=${t.llmScore}` : "";
      const holdStr = t.holdTimeSec !== undefined ? `hold=${t.holdTimeSec}s` : "";
      const exitStr = t.exitReason ?? "?";
      const narrativeStr = t.llmNarrative ?? "";
      const peakStr = t.peakPnlPct !== undefined ? `peak=${(t.peakPnlPct * 100).toFixed(1)}%` : "";
      const postSaleStr = t.postSaleVerdict ? `[POST-SALE: ${t.postSaleVerdict}${t.postSalePeakPct ? ` missed+${(t.postSalePeakPct * 100).toFixed(0)}%` : ""}${t.postSaleGraduated ? " GRADUATED!" : ""}]` : "";

      lines.push(
        `${pnlEmoji} ${t.symbol}: ${pnlStr} | ${exitStr} | ${scoreStr} ${llmStr} ${holdStr} ${peakStr} ${narrativeStr ? `[${narrativeStr}]` : ""} ${postSaleStr}`.trim()
      );
    }

    return lines.join("\n");
  }

  private trimAndPersist(): void {
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.persist();
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch (err) {
      console.error("[trade-journal] Persist error:", err);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, "utf-8");
      this.entries = JSON.parse(raw) as TradeEntry[];
      console.log(`[trade-journal] Loaded ${this.entries.length} journal entries`);
    } catch (err) {
      console.error("[trade-journal] Load error:", err);
    }
  }
}
