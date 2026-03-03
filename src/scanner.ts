// ── Scanner: main orchestrator ──

import crypto from "node:crypto";
import type { PumpTraderConfig } from "./config.js";
import { PumpApi } from "./pump-api.js";
import { PositionManager } from "./position-manager.js";
import { RiskManager } from "./risk-manager.js";
import { SignalEngine } from "./signal-engine.js";
import { SolanaClient } from "./solana.js";
import { Trader } from "./trader.js";
import { CreatorBlacklist } from "./creator-blacklist.js";
import { MarketRegimeDetector } from "./market-regime.js";
import { LLMAnalyzer } from "./llm-analyzer.js";
import { TradeJournal } from "./trade-journal.js";
import { MarketIntel } from "./market-intel.js";
import { SmartMoneyTracker, type SmartMoneySignal } from "./smart-money.js";
import { SocialScanner, type SocialSignal } from "./social-scanner.js";
import { PostSaleMonitor, type PostSaleResult } from "./post-sale-monitor.js";
import type { GraduateAnalyzer } from "./graduate-analyzer.js";
import { logger } from "./logger.js";
import { thinkingLog } from "./thinking.js";
import type { ExitReason, PumpTokenCreateEvent, TokenMetrics, TokenSignal } from "./types.js";

/** Extract whale concentration data from token metrics (same logic as antiRug scorer) */
function extractWhaleData(metrics: TokenMetrics): { whaleCount: number; whaleVolumeSol: number } {
  const now = Date.now();
  const recentBuyTrades = metrics.recentTrades.filter(t => t.timestamp >= now - 120_000 && t.txType === "buy");
  if (recentBuyTrades.length <= 3) return { whaleCount: 0, whaleVolumeSol: 0 };
  const volumeByTrader = new Map<string, number>();
  let totalBuyVol = 0;
  for (const t of recentBuyTrades) {
    volumeByTrader.set(t.trader, (volumeByTrader.get(t.trader) ?? 0) + t.solAmount);
    totalBuyVol += t.solAmount;
  }
  let whaleCount = 0;
  let whaleVolumeSol = 0;
  for (const [, vol] of volumeByTrader) {
    if (totalBuyVol > 0 && vol / totalBuyVol > 0.25) { // 25%+ of volume = whale
      whaleCount++;
      whaleVolumeSol += vol;
    }
  }
  return { whaleCount, whaleVolumeSol };
}

/** Live-mode quality gate: evaluates whether a candidate would pass live trading filters.
 *  Used in dry-run to tag trades (liveEligible) and in live mode as a hard block before delayed buy. */
interface LiveFilterResult {
  eligible: boolean;
  failReasons: string[];
}

function evaluateLiveFilterGate(
  candidate: CandidateToken,
  metrics: TokenMetrics | undefined,
  config: PumpTraderConfig,
): LiveFilterResult {
  const failReasons: string[] = [];

  const buyers = candidate.uniqueBuyers ?? metrics?.uniqueBuyers.size ?? 0;
  if (buyers < 10) failReasons.push(`uniqueBuyers=${buyers}<10`);

  const vol = candidate.recentVolumeSol ?? metrics?.recentVolumeSol ?? 0;
  if (vol < 2.0) failReasons.push(`volume=${vol.toFixed(2)}<2.0`);

  const buys = candidate.buyCount ?? metrics?.buyCount ?? 0;
  if (buys < 8) failReasons.push(`buyCount=${buys}<8`);

  const bc = candidate.bondingCurveProgress ?? metrics?.bondingCurveProgress ?? 0;
  if (bc < 0.10) failReasons.push(`bondingCurve=${(bc * 100).toFixed(0)}%<10%`);

  if (candidate.score < config.minBuyScore) failReasons.push(`score=${candidate.score}<${config.minBuyScore}`);

  // Social/smart-money: NOT a hard block — most pump.fun tokens lack both.
  // When present, they already boost candidate.score via the social scanner,
  // so their benefit is captured without a gate.

  return { eligible: failReasons.length === 0, failReasons };
}

/** A token candidate awaiting agent review (agent decides whether to buy) */
export interface CandidateToken {
  mint: string;
  symbol: string;
  name: string;
  score: number;
  suggestedSizeSol: number;
  llmAnalysis?: {
    score: number;
    narrative: string;
    reasoning: string;
    confidence: number;
    factors: string[];
  };
  marketCapSol: number;
  recentVolumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  ageSec: number;
  creatorReputation: number;
  marketRegime: string;
  discoveredAt: number;
  /** Spam launch count: how many tokens with same symbol launched within 30s (3+ = coordinated hype) */
  spamLaunchCount?: number;
  /** Smart money signal if a top wallet triggered this candidate */
  smartMoneySignal?: {
    walletRank: number;
    walletWinRate: number;
    walletPnlSol: number;
    walletTrades: number;
    buySolAmount: number;
  };
  /** Social signal: X engagement + first-mover detection */
  socialSignal?: SocialSignal;
  // ── Extended enrichment (Phase 2) ──
  replyCount?: number;
  hasTwitter?: boolean;
  hasWebsite?: boolean;
  hasTelegram?: boolean;
  tokenDescription?: string;
  narrativeBoost?: number;
  devWalletHash?: string;
  /** Would this trade have passed live-mode quality gates? (set in both dry & live) */
  liveEligible?: boolean;
  /** Which live gates this trade failed, e.g. ["uniqueBuyers=3<5", "no-social-no-smartmoney"] */
  liveFilterFailReasons?: string[];
}

export class Scanner {
  readonly pumpApi: PumpApi;
  readonly solana: SolanaClient;
  readonly trader: Trader;
  readonly positions: PositionManager;
  readonly riskManager: RiskManager;
  readonly signalEngine: SignalEngine;
  readonly creatorBlacklist: CreatorBlacklist;
  readonly marketRegime: MarketRegimeDetector;
  readonly llmAnalyzer: LLMAnalyzer;
  readonly tradeJournal: TradeJournal;
  readonly marketIntel: MarketIntel;
  readonly smartMoney: SmartMoneyTracker;
  readonly socialScanner: SocialScanner;
  readonly postSaleMonitor: PostSaleMonitor;
  /** Graduate analyzer — injected by server, tracks bonding curve graduates */
  graduateAnalyzer?: GraduateAnalyzer;

  private running = false;
  private positionCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private smartMoneySubInterval: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | undefined;
  private evaluating = new Set<string>();
  private skippedMints = new Set<string>();
  private lastSignals = new Map<string, TokenSignal>();
  private sellAttempts = new Map<string, number>();
  /** Track recent winning token names for LLM narrative context */
  private recentWinners: string[] = [];
  /** Guard: mints currently being exited — prevents double-sell race condition */
  private exiting = new Set<string>();
  /** Map from mint → dev wallet for tracking dev sells */
  private mintToDevWallet = new Map<string, string>();
  /** Trading mode: agent=full AI control, uav=AI observes + score auto-buy, none=no AI */
  tradingMode: "agent" | "uav" | "none" = "agent";
  /** Consecutive loss counter for auto-pause */
  private consecutiveLosses = 0;
  /** Auto-paused flag (paused due to consecutive losses) */
  autoPaused = false;
  private static readonly AUTO_PAUSE_THRESHOLD = 8;
  /** Candidate tokens awaiting agent review */
  private candidateTokens = new Map<string, CandidateToken>();
  /** Spam launch tracker: normalized symbol → { mints, firstMint, firstSeenAt } */
  private spamLaunches = new Map<string, { mints: string[]; firstMint: string; firstSeenAt: number }>();
  /** Mints that got a spam-launch boost (skip the "too thin" pre-filter) */
  private spamBoostMints = new Set<string>();
  onTradeNotification?: (message: string) => void;
  /** Called after every completed trade (for autonomous agent) */
  onTradeCompleted?: (symbol: string, pnlSol: number, exitReason: string) => void;
  /** Reference to the chat agent for persistent strategy memory */
  chatAgent?: { strategy: import("./agent-strategy.js").AgentStrategy };

  constructor(
    readonly config: PumpTraderConfig,
    dataDir: string,
  ) {
    this.pumpApi = new PumpApi(config.metricsRetentionMs);
    this.solana = new SolanaClient(config.privateKey, config.rpcUrl);
    this.trader = new Trader(this.solana, config);
    this.positions = new PositionManager(dataDir);
    this.riskManager = new RiskManager(config, this.positions, this.solana);
    this.signalEngine = new SignalEngine(config);
    this.creatorBlacklist = new CreatorBlacklist(dataDir);
    this.marketRegime = new MarketRegimeDetector(50, 600_000);
    this.llmAnalyzer = new LLMAnalyzer();
    this.tradeJournal = new TradeJournal(dataDir);
    this.marketIntel = new MarketIntel();
    this.smartMoney = new SmartMoneyTracker(this.solana.publicKey.toBase58());
    this.socialScanner = new SocialScanner();

    // Post-sale monitor: tracks tokens for 10 min after exit to assess exit quality
    this.postSaleMonitor = new PostSaleMonitor(
      (mint) => this.pumpApi.fetchTokenDetails(mint),
      (result) => this.onPostSaleComplete(result),
    );

    // Wire smart money signals: when a top wallet buys a new token, queue it as candidate
    this.smartMoney.onSmartMoneyBuy = (signal: SmartMoneySignal) => {
      this.handleSmartMoneyBuy(signal);
    };

    // Wire smart money SELL signals: when a top wallet sells a token we hold, exit immediately
    this.smartMoney.onSmartMoneySell = (signal: SmartMoneySignal) => {
      this.handleSmartMoneySell(signal);
    };
  }

  async start(): Promise<void> {
    if (this.running) { logger.warn("SCANNER", "Scanner already running"); return; }

    // ── Dry-run overrides: maximize data collection with virtual limits ──
    if (this.config.dryRun) {
      this.config.maxConcurrentPositions = 50;
      this.config.maxTotalExposureSol = 10.0;
      logger.system("🧪 Dry-run overrides applied: 50 max positions, 10 SOL max exposure");
    }

    logger.system("=== PUMPBERG STARTING ===");
    logger.system(`Configuration:`, {
      minPositionSizeSol: this.config.minPositionSizeSol,
      maxPositionSizeSol: this.config.maxPositionSizeSol,
      maxConcurrentPositions: this.config.maxConcurrentPositions,
      maxTotalExposureSol: this.config.maxTotalExposureSol,
      stopLossPct: this.config.stopLossPct,
      takeProfitPct1: this.config.takeProfitPct1,
      takeProfitPct2: this.config.takeProfitPct2,
      dryRun: this.config.dryRun,
    });

    const wallet = await this.solana.getWalletInfo();
    logger.system(`Wallet: ${wallet.publicKey}`, { publicKey: wallet.publicKey });
    logger.system(`SOL balance: ${wallet.solBalance.toFixed(4)} SOL`, { balance: wallet.solBalance });

    if (wallet.solBalance < this.config.reserveSol + 0.01) {
      logger.error("SCANNER", `Insufficient SOL: ${wallet.solBalance.toFixed(4)} < ${(this.config.reserveSol + 0.01).toFixed(4)}`);
      throw new Error(`Insufficient SOL balance (${wallet.solBalance.toFixed(4)} SOL).`);
    }

    this.running = true;
    this.startedAt = Date.now();

    // Remove any leftover listeners from previous start/stop cycles to prevent duplicates
    this.pumpApi.removeAllListeners();

    this.pumpApi.on("tokenCreated", (event) => {
      // Guard against malformed events
      if (!event.mint) return;
      // Track dev wallet for creator intelligence
      if (event.traderPublicKey) {
        this.mintToDevWallet.set(event.mint, event.traderPublicKey);
        this.creatorBlacklist.recordLaunch(event.traderPublicKey, event.mint, event.symbol ?? "");
      }
      this.onTokenCreated(event);
    });
    this.pumpApi.on("metricsUpdated", (metrics) => this.onMetricsUpdated(metrics));
    this.pumpApi.on("error", (err) => logger.error("API", `PumpPortal error: ${err.message}`));

    // Track migrations for market regime + graduate analysis
    this.pumpApi.on("migration", (migrationEvent) => {
      this.marketRegime.recordMigration(migrationEvent.mint ?? "unknown", migrationEvent.symbol ?? "?");
      // Forward to graduate analyzer for trend analysis
      if (this.graduateAnalyzer) {
        this.graduateAnalyzer.recordMigration(
          migrationEvent.mint ?? "unknown",
          migrationEvent.symbol ?? "",
          migrationEvent.name ?? "",
          migrationEvent.pool ?? "",
        );
      }
      const mintStr = migrationEvent.mint ?? "unknown";
      logger.info("REGIME", `🎓 Migration detected: ${mintStr}`);
    });

    // Track dev sells for creator blacklist
    this.pumpApi.on("trade", (trade) => {
      if (trade.txType === "sell") {
        const devWallet = this.mintToDevWallet.get(trade.mint);
        if (devWallet && trade.traderPublicKey === devWallet) {
          this.creatorBlacklist.recordDevSell(devWallet, trade.mint);
          logger.warn("BLACKLIST", `Dev sell detected: ${trade.mint.slice(0, 8)} by ${devWallet.slice(0, 8)}...`);
        }
      }

      // ── Forward ALL trades to Smart Money Tracker ──
      const tradeMetrics = this.pumpApi.metrics.get(trade.mint);
      this.smartMoney.recordTrade(
        trade.traderPublicKey,
        trade.mint,
        tradeMetrics?.symbol || trade.mint.slice(0, 8),
        trade.txType,
        trade.solAmount,
        trade.tokenAmount,
      );
    });

    this.pumpApi.connect();
    this.marketIntel.start();
    this.smartMoney.start();

    // Periodically update smart money account subscriptions
    this.smartMoneySubInterval = setInterval(() => this.updateSmartMoneySubscriptions(), 5 * 60_000);

    this.positionCheckInterval = setInterval(() => this.checkOpenPositions(), this.config.positionCheckIntervalMs);
    this.pruneInterval = setInterval(() => {
      this.pumpApi.pruneStaleMetrics();
      // Prune internal Maps/Sets to prevent unbounded memory growth
      // skippedMints and lastSignals only need to hold recent items
      if (this.skippedMints.size > 5000) {
        const arr = [...this.skippedMints];
        this.skippedMints = new Set(arr.slice(-2000));
        logger.debug("SCANNER", `Pruned skippedMints: ${arr.length} → ${this.skippedMints.size}`);
      }
      if (this.lastSignals.size > 2000) {
        const entries = [...this.lastSignals.entries()];
        this.lastSignals = new Map(entries.slice(-500));
        logger.debug("SCANNER", `Pruned lastSignals: ${entries.length} → ${this.lastSignals.size}`);
      }
      if (this.mintToDevWallet.size > 5000) {
        const entries = [...this.mintToDevWallet.entries()];
        this.mintToDevWallet = new Map(entries.slice(-2000));
      }
    }, 60_000);

    const modeLabel = this.config.dryRun ? "🧪 DRY RUN" : "🔴 LIVE";
    logger.system(`=== SCANNER ACTIVE (${modeLabel}) ===`);
    this.notify(`⛏️ Pumpberg started (${modeLabel})\nWallet: \`${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-4)}\`\nBalance: ${wallet.solBalance.toFixed(4)} SOL`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.pumpApi.removeAllListeners();
    this.pumpApi.disconnect();
    this.marketIntel.stop();
    this.smartMoney.stop();
    this.postSaleMonitor.stopAll();
    if (this.positionCheckInterval) { clearInterval(this.positionCheckInterval); this.positionCheckInterval = null; }
    if (this.pruneInterval) { clearInterval(this.pruneInterval); this.pruneInterval = null; }
    if (this.smartMoneySubInterval) { clearInterval(this.smartMoneySubInterval); this.smartMoneySubInterval = null; }

    const stats = this.positions.getStats(undefined, this.startedAt);
    logger.system(`=== SCANNER STOPPED ===`);
    logger.system(`Session results: ${stats.totalTrades} trades, ${stats.wins}W/${stats.losses}L, P&L: ${stats.totalRealizedPnl >= 0 ? "+" : ""}${stats.totalRealizedPnl.toFixed(4)} SOL`);
    this.notify(`⏹️ Pumpberg stopped\nTrades: ${stats.totalTrades} | P&L: ${stats.totalRealizedPnl >= 0 ? "+" : ""}${stats.totalRealizedPnl.toFixed(4)} SOL`);
  }

  isRunning(): boolean { return this.running; }

  private async onTokenCreated(event: PumpTokenCreateEvent): Promise<void> {
    if (!this.running) return;

    // ── Spam launch detection: track tokens with same symbol in 30s window ──
    this.trackSpamLaunch(event);

    const delayMs = this.config.minTokenAgeSec * 1_000;
    logger.debug("SCANNER", `Will evaluate ${event.symbol} in ${delayMs / 1000}s`);
    setTimeout(() => {
      this.evaluateToken(event.mint).catch((err) =>
        logger.error("SCANNER", `Evaluation error for ${event.symbol}: ${err}`),
      );
    }, delayMs);
  }

  /** Track coordinated spam launches — same symbol flooding = hype signal */
  private trackSpamLaunch(event: PumpTokenCreateEvent): void {
    const sym = event.symbol;
    if (!sym || typeof sym !== "string") return;
    const key = sym.trim().toUpperCase();
    if (!key || key.length < 2) return;

    const now = Date.now();
    const WINDOW_MS = 30_000; // 30-second window

    // Prune expired entries periodically
    if (this.spamLaunches.size > 200) {
      for (const [k, v] of this.spamLaunches) {
        if (now - v.firstSeenAt > WINDOW_MS * 2) this.spamLaunches.delete(k);
      }
    }

    let entry = this.spamLaunches.get(key);
    if (!entry || now - entry.firstSeenAt > WINDOW_MS) {
      // New window — this is the first token with this symbol
      entry = { mints: [event.mint], firstMint: event.mint, firstSeenAt: now };
      this.spamLaunches.set(key, entry);
      return;
    }

    // Same symbol within window — add to the list
    if (!entry.mints.includes(event.mint)) {
      entry.mints.push(event.mint);
    }

    const count = entry.mints.length;

    // When we hit 3+ duplicates, boost the first mint as the likely real token
    if (count === 3) {
      logger.info("SCANNER", `\u{1F4A5} SPAM LAUNCH detected: ${count} tokens named "${key}" in ${WINDOW_MS / 1000}s \u2014 boosting first mint ${entry.firstMint.slice(0, 12)}...`);
      this.spamBoostMints.add(entry.firstMint);
      // If the first mint was already skipped (too thin), un-skip it for re-evaluation
      if (this.skippedMints.has(entry.firstMint) && !this.positions.hasPosition(entry.firstMint)) {
        this.skippedMints.delete(entry.firstMint);
        this.evaluateToken(entry.firstMint).catch(() => {});
      }
    } else if (count > 3 && count % 5 === 0) {
      logger.info("SCANNER", `\u{1F4A5} Spam launch "${key}" now at ${count} copies`);
    }
  }

  /** Get spam launch count for a mint (0 if not part of a spam launch) */
  getSpamLaunchCount(mint: string): number {
    for (const entry of this.spamLaunches.values()) {
      if (entry.mints.includes(mint)) return entry.mints.length;
    }
    return 0;
  }

  private async onMetricsUpdated(metrics: TokenMetrics): Promise<void> {
    if (!this.running) return;

    const pos = this.positions.getPosition(metrics.mint);
    if (pos && metrics.priceHistory.length > 0) {
      const latestPrice = metrics.priceHistory[metrics.priceHistory.length - 1]![1];
      this.positions.updatePrice(metrics.mint, latestPrice);
    }

    if (
      !this.positions.hasPosition(metrics.mint) &&
      !this.skippedMints.has(metrics.mint) &&
      !this.evaluating.has(metrics.mint) &&
      !this.candidateTokens.has(metrics.mint) &&
      metrics.recentVolumeSol > 0.5
    ) {
      const ageSec = (Date.now() - metrics.createdAt) / 1_000;
      // Only re-evaluate fresh tokens — sniping prioritizes new launches
      if (ageSec > 5 && ageSec < 90) {
        this.evaluateToken(metrics.mint).catch(() => {});
      }
    }
  }

  private async evaluateToken(mint: string): Promise<void> {
    if (this.evaluating.has(mint) || this.skippedMints.has(mint) || this.positions.hasPosition(mint) || this.candidateTokens.has(mint)) return;
    // Skip evaluation when auto-paused due to consecutive losses (not in dry run — no real risk)
    if (this.autoPaused && !this.config.dryRun) return;
    // ── Quiet hours: skip entries during low-WR UTC hours (3-6, 10-12) ──
    const utcHour = new Date().getUTCHours();
    const quietHours = [3, 4, 5, 6, 10, 11, 12];
    if (quietHours.includes(utcHour)) {
      return; // Historically 3-6% WR during these hours — not worth evaluating
    }
    // ── Concurrency cap: prevent OOM from too many concurrent evaluations ──
    // Each evaluation holds memory for LLM request/response + token metrics
    if (this.evaluating.size >= 20) {
      logger.debug("SCANNER", `⏭️ Evaluation queue full (${this.evaluating.size}) — skipping ${mint.slice(0, 12)}`);
      return;
    }
    this.evaluating.add(mint);

    try {
      const metrics = this.pumpApi.metrics.get(mint);
      if (!metrics) { logger.debug("SCANNER", `No metrics for ${mint.slice(0, 12)}, skipping`); return; }

      // ── PRE-FILTER: skip obviously dead tokens BEFORE expensive LLM call ──
      // In dry run: lightweight filter — at least 1 trade from someone other than dev
      // This prevents dead-on-arrival tokens (dev buy only) from flooding the LLM queue
      // but still evaluates far more tokens than live mode for max data collection.
      const isSpamBoosted = this.spamBoostMints.has(mint);
      // Dry run: need at least 3 buys and 3 unique buyers before wasting LLM call
      if (this.config.dryRun && !isSpamBoosted && (metrics.buyCount < 3 || metrics.uniqueBuyers.size < 3)) {
        this.skippedMints.add(mint);
        return;
      }
      // Live mode: stricter pre-filter — need 5+ unique buyers and 5+ buys before LLM
      if (!this.config.dryRun && this.tradingMode === "agent" && !isSpamBoosted && (metrics.uniqueBuyers.size < 5 || metrics.buyCount < 5)) {
        logger.debug("SCANNER", `⏭️ ${metrics.symbol}: too thin (buyers: ${metrics.uniqueBuyers.size}, buys: ${metrics.buyCount}) — skipping LLM`);
        this.skippedMints.add(mint);
        return;
      }

      // Skip blacklisted creators before LLM (not in dry run — we want data on these too)
      const devWalletEarly = this.mintToDevWallet.get(mint);
      if (!this.config.dryRun && devWalletEarly && this.creatorBlacklist.isBlacklisted(devWalletEarly)) {
        logger.debug("SCANNER", `⏭️ ${metrics.symbol}: blacklisted creator — skipping`);
        this.skippedMints.add(mint);
        return;
      }

      logger.info("SCANNER", `🔍 Evaluating ${metrics.symbol || mint.slice(0, 8)}...`, {
        mint, marketCapSol: metrics.marketCapSol, recentVolumeSol: metrics.recentVolumeSol,
        buyCount: metrics.buyCount, sellCount: metrics.sellCount,
      });

      // ── Build intelligence context ──
      const devWallet = devWalletEarly;
      const regime = this.marketRegime.getRegime();
      const regimeAdj = this.marketRegime.getScoreAdjustment();

      const context: import("./signal-engine.js").SignalContext = {
        creatorReputation: devWallet ? this.creatorBlacklist.getReputation(devWallet) : 0,
        creatorLaunchCount: 0,
        creatorBlacklisted: devWallet ? this.creatorBlacklist.isBlacklisted(devWallet) : false,
        marketRegime: regime,
        regimeScoreBoost: regimeAdj.minScoreBoost,
        regimeSizeMultiplier: regimeAdj.sizeMultiplier,
        narrativeBoost: this.marketIntel.getNarrativeBoost(metrics.name, metrics.symbol),
      };

      // LLM analysis (async, with timeout — won't block if slow)
      // Skip LLM entirely in "none" mode — pure signal-based trading
      // Pre-filter: compute heuristic score first, skip LLM for clearly bad tokens (<30)
      const preScore = this.signalEngine.score(metrics, context);
      if (this.tradingMode !== "none" && preScore.score >= 30) {
        try {
          const llmResult = await this.llmAnalyzer.analyze(
            metrics,
            context.creatorReputation,
            devWallet ? this.creatorBlacklist.getLaunchCount(devWallet) : 0,
            regime,
            this.recentWinners,
          );
          if (llmResult.success) {
            context.llmAnalysis = llmResult;
            logger.info("LLM", `🧠 ${metrics.symbol}: LLM score=${llmResult.score}, confidence=${llmResult.confidence.toFixed(2)}, narrative=${llmResult.narrative}`);
            thinkingLog.add({
              mint, symbol: metrics.symbol, type: "analysis" as any,
              decision: `LLM: ${llmResult.score}/100 (${llmResult.narrative})`,
              reasoning: llmResult.factors,
            });
          }
        } catch (err) {
          logger.warn("LLM", `LLM analysis failed for ${metrics.symbol}: ${err}`);
        }
      }

      const signal = this.signalEngine.score(metrics, context);
      this.lastSignals.set(mint, signal);

      // ── Agent-controlled mode: queue candidates instead of auto-buying ──
      if (this.tradingMode === "agent") {
        // Only skip truly garbage tokens (blacklisted/score near 0)
        if (signal.score < 10) {
          this.skippedMints.add(mint);
          return;
        }

        // ── Minimum viability filter: require actual activity to avoid dead launches ──
        // In dry run: apply moderate filter — need ≥8 unique buyers, ≥1.5 SOL volume, ≥8 buys
        // Exception: spam-boosted mints always bypass this
        // Live mode: need ≥10 unique buyers, ≥2.0 SOL volume, ≥8 buys
        //   (Relaxed from 15/3.0/10 — the tighter gates were blocking everything)
        if (this.config.dryRun && !isSpamBoosted && (metrics.uniqueBuyers.size < 8 || metrics.recentVolumeSol < 1.5 || metrics.buyCount < 8)) {
          logger.debug("SCANNER", `⏭️ ${metrics.symbol}: too thin for dry run (buyers: ${metrics.uniqueBuyers.size}, vol: ${metrics.recentVolumeSol.toFixed(2)}, buys: ${metrics.buyCount}) — skipping`);
          this.skippedMints.add(mint);
          return;
        }
        if (!this.config.dryRun && !isSpamBoosted && (metrics.uniqueBuyers.size < 10 || metrics.recentVolumeSol < 2.0 || metrics.buyCount < 8)) {
          logger.debug("SCANNER", `⏭️ ${metrics.symbol}: too thin for live (buyers: ${metrics.uniqueBuyers.size}, vol: ${metrics.recentVolumeSol.toFixed(2)}, buys: ${metrics.buyCount}) — skipping`);
          this.skippedMints.add(mint);
          return;
        }

        // ── Spam launch boost: add score bonus for coordinated launches ──
        const spamCount = this.getSpamLaunchCount(mint);
        let spamBonus = 0;
        if (spamCount >= 3 && this.spamBoostMints.has(mint)) {
          // First mint of a coordinated launch gets a big boost
          spamBonus = Math.min(25, 5 + spamCount * 2); // 3 copies = +11, 5 = +15, 10 = +25
          logger.info("SCANNER", `\u{1F4A5} ${signal.symbol}: spam launch boost +${spamBonus} (${spamCount} copies)`);
        }

        this.candidateTokens.set(mint, {
          mint,
          symbol: signal.symbol,
          name: signal.name,
          score: signal.score + spamBonus,
          suggestedSizeSol: signal.suggestedSizeSol,
          llmAnalysis: context.llmAnalysis?.success ? {
            score: context.llmAnalysis.score,
            narrative: context.llmAnalysis.narrative,
            reasoning: context.llmAnalysis.reasoning,
            confidence: context.llmAnalysis.confidence,
            factors: context.llmAnalysis.factors,
          } : undefined,
          marketCapSol: metrics.marketCapSol,
          recentVolumeSol: metrics.recentVolumeSol,
          buyCount: metrics.buyCount,
          sellCount: metrics.sellCount,
          uniqueBuyers: metrics.uniqueBuyers.size,
          bondingCurveProgress: metrics.bondingCurveProgress,
          ageSec: Math.round((Date.now() - metrics.createdAt) / 1000),
          creatorReputation: context.creatorReputation,
          marketRegime: context.marketRegime,
          discoveredAt: Date.now(),
          spamLaunchCount: spamCount >= 3 ? spamCount : undefined,
          narrativeBoost: context.narrativeBoost,
          devWalletHash: devWallet ? crypto.createHash("sha256").update(devWallet).digest("hex").slice(0, 16) : undefined,
        });

        // ── Async enrichment: fetch token details for reply count, socials, description ──
        this.pumpApi.fetchTokenDetails(mint).then((details) => {
          const cand = this.candidateTokens.get(mint);
          if (cand && details) {
            cand.replyCount = typeof details.reply_count === "number" ? details.reply_count : undefined;
            cand.hasTwitter = !!(details.twitter && String(details.twitter).length > 0);
            cand.hasWebsite = !!(details.website && String(details.website).length > 0);
            cand.hasTelegram = !!(details.telegram && String(details.telegram).length > 0);
            cand.tokenDescription = typeof details.description === "string" ? details.description.slice(0, 200) : undefined;
          }
        }).catch(() => {}); // Supplementary — don't block on failure

        // ── Async social scan: enrich candidate with social + first-mover data ──
        this.socialScanner.analyze(signal.name, signal.symbol, mint).then((social: SocialSignal) => {
          const cand = this.candidateTokens.get(mint);
          if (cand) {
            cand.socialSignal = social;
            if (social.score > 0) {
              cand.score += social.score; // Boost candidate score
            }
          }
        }).catch(() => {}); // Silently ignore failures — social data is supplementary

        logger.info("SCANNER", `📋 Candidate: ${signal.symbol} (score: ${signal.score}/100, age: ${Math.round((Date.now() - metrics.createdAt) / 1000)}s) — queued for agent`);

        // ── High-score fast-buy: different strategies for dry-run vs live ──
        const finalScore = signal.score + spamBonus;
        if (this.config.dryRun) {
          // Dry run: 75+ fast-buy, tag with LiveFilterGate result for missed-winner tracking
          if (finalScore >= 75) {
            const cand = this.candidateTokens.get(mint);
            if (cand) {
              const gate = evaluateLiveFilterGate(cand, metrics, this.config);
              cand.liveEligible = gate.eligible;
              cand.liveFilterFailReasons = gate.failReasons;
            }
            logger.system(`⚡ FAST BUY (dry): ${signal.symbol} score ${finalScore}/100 — bypassing agent review`);
            this.agentBuy(mint, signal.suggestedSizeSol, signal.symbol, {
              signalScore: finalScore,
              llmScore: context.llmAnalysis?.score,
              llmNarrative: context.llmAnalysis?.narrative,
              llmReasoning: context.llmAnalysis?.reasoning,
              llmConfidence: context.llmAnalysis?.confidence,
              creatorReputation: context.creatorReputation,
              creatorBlacklisted: context.creatorBlacklisted,
            }).then((result) => {
              if (result.success) {
                this.candidateTokens.delete(mint);
                logger.system(`⚡ FAST BUY SUCCESS: ${signal.symbol} — bought ${signal.suggestedSizeSol.toFixed(4)} SOL`);
              } else {
                logger.warn("SCANNER", `⚡ FAST BUY FAILED: ${signal.symbol} — ${result.error}`);
              }
            }).catch((err) => {
              logger.error("SCANNER", `⚡ Fast buy error for ${signal.symbol}: ${err}`);
            });
          }
        } else if (finalScore >= 95) {
          // Live mode: only ultra-high-conviction (95+), wait 8s for enrichment data
          logger.system(`⏳ DELAYED BUY: ${signal.symbol} score ${finalScore}/100 — waiting 8s for enrichment...`);
          const capturedSize = signal.suggestedSizeSol;
          const capturedSymbol = signal.symbol;
          const capturedContext = {
            signalScore: finalScore,
            llmScore: context.llmAnalysis?.score,
            llmNarrative: context.llmAnalysis?.narrative,
            llmReasoning: context.llmAnalysis?.reasoning,
            llmConfidence: context.llmAnalysis?.confidence,
            creatorReputation: context.creatorReputation,
            creatorBlacklisted: context.creatorBlacklisted,
          };
          setTimeout(() => {
            const cand = this.candidateTokens.get(mint);
            if (!cand || this.positions.hasPosition(mint)) return;
            // Re-check with latest metrics + enrichment
            const latestMetrics = this.pumpApi.metrics.get(mint);
            const gate = evaluateLiveFilterGate(cand, latestMetrics, this.config);
            cand.liveEligible = gate.eligible;
            cand.liveFilterFailReasons = gate.failReasons;
            if (!gate.eligible) {
              logger.info("SCANNER", `⏭️ ${capturedSymbol}: failed live gates after delay: ${gate.failReasons.join(", ")}`);
              return;
            }
            logger.system(`⚡ DELAYED BUY EXECUTING: ${capturedSymbol} passed live gates after 8s enrichment`);
            this.agentBuy(mint, capturedSize, capturedSymbol, capturedContext).then((result) => {
              if (result.success) {
                this.candidateTokens.delete(mint);
                logger.system(`⚡ DELAYED BUY SUCCESS: ${capturedSymbol} — bought ${capturedSize.toFixed(4)} SOL`);
              } else {
                logger.warn("SCANNER", `⚡ DELAYED BUY FAILED: ${capturedSymbol} — ${result.error}`);
              }
            }).catch((err) => {
              logger.error("SCANNER", `⚡ Delayed buy error for ${capturedSymbol}: ${err}`);
            });
          }, 8000);
        }

        // Expire stale candidates (>90s — tokens this old have already launched without us)
        const expiry = Date.now() - 90_000;
        for (const [m, c] of this.candidateTokens) {
          if (c.discoveredAt < expiry) this.candidateTokens.delete(m);
        }
        return;
      }

      // ── Standard auto-buy flow (no agent) ──
      if (signal.action === "skip") {
        this.skippedMints.add(mint);
        return;
      }

      // Risk check (skipped in dry run — no real money at risk)
      let sizeSol = signal.suggestedSizeSol;
      if (!this.config.dryRun) {
        const riskCheck = await this.riskManager.checkBuy(signal);
        if (!riskCheck.allowed) {
          logger.warn("SCANNER", `⛔ Risk blocked ${signal.symbol}: ${riskCheck.reason}`);
          thinkingLog.add({
            mint, symbol: signal.symbol, type: "risk-check",
            decision: `BLOCKED: ${riskCheck.reason}`,
            reasoning: [`Signal score was ${signal.score}/100 (PASS)`, `Risk manager rejected: ${riskCheck.reason}`],
          });
          return;
        }
        sizeSol = riskCheck.adjustedSizeSol ?? signal.suggestedSizeSol;
      }

      // ── Fee guard: skip if round-trip fees eat more than 10% of position ──
      const roundTripFees = (sizeSol * this.config.tradingFeePct * 2) + (this.config.priorityFeeSol * 2);
      const feeRatio = roundTripFees / sizeSol;
      if (feeRatio > 0.10) {
        logger.warn("SCANNER", `⛔ Fee guard blocked ${signal.symbol}: fees ${(feeRatio * 100).toFixed(1)}% of position (${roundTripFees.toFixed(4)} SOL on ${sizeSol.toFixed(4)} SOL)`);
        thinkingLog.add({
          mint, symbol: signal.symbol, type: "risk-check",
          decision: `BLOCKED: fees too high`,
          reasoning: [
            `Round-trip fees: ${roundTripFees.toFixed(4)} SOL = ${(feeRatio * 100).toFixed(1)}% of position`,
            `Position too small for profitable trading. Increase min position size or reduce priority fee.`,
          ],
        });
        return;
      }

      thinkingLog.add({
        mint, symbol: signal.symbol, type: "entry",
        decision: `BUYING ${sizeSol.toFixed(4)} SOL`,
        reasoning: [
          `Signal score: ${signal.score}/100 (threshold: ${this.config.minBuyScore})`,
          `Risk check: PASSED`,
          `Position size: ${sizeSol.toFixed(4)} SOL`,
          `Open positions: ${this.positions.getOpenPositionCount()}/${this.config.maxConcurrentPositions}`,
          `Total exposure: ${this.positions.getTotalExposureSol().toFixed(4)}/${this.config.maxTotalExposureSol} SOL`,
        ],
      });

      logger.trade(`🛒 BUYING ${signal.symbol} for ${sizeSol.toFixed(4)} SOL (score: ${signal.score})`, {
        mint, symbol: signal.symbol, size: sizeSol, score: signal.score,
      });

      // ── Dry-run: simulate confirmation delay + re-sample price ──
      if (this.config.dryRun) {
        await new Promise((resolve) => setTimeout(resolve, 3000)); // 3s confirmation delay
      }

      const result = await this.trader.buy(mint, sizeSol);

      if (!result.success) {
        logger.error("TRADE", `❌ Buy FAILED for ${signal.symbol}: ${result.error}`);
        return;
      }

      // Re-sample price after potential delay
      let latestPrice = metrics.priceHistory.length > 0
        ? metrics.priceHistory[metrics.priceHistory.length - 1]![1]
        : metrics.vSolInBondingCurve / metrics.vTokensInBondingCurve;

      // ── Dry-run slippage simulation: inflate entry price by 3% ──
      if (this.config.dryRun && latestPrice > 0) {
        const rawPrice = latestPrice;
        latestPrice = latestPrice * 1.03;
        logger.info("SCANNER", `🧪 Slippage sim: entry ${rawPrice.toExponential(3)} → ${latestPrice.toExponential(3)} (+3%)`);
      }

      const estimatedTokens = sizeSol / latestPrice;

      this.positions.openPosition({
        mint, symbol: signal.symbol, name: signal.name,
        entrySol: sizeSol, tokenAmount: estimatedTokens,
        entryPrice: latestPrice, txSignature: result.signature,
        dryRun: this.config.dryRun,
      });

      // ── Log entry to trade journal ──
      const whaleData = extractWhaleData(metrics);
      this.tradeJournal.logEntry({
        mint, symbol: signal.symbol, name: signal.name,
        signalScore: signal.score,
        llmScore: context.llmAnalysis?.score,
        llmNarrative: context.llmAnalysis?.narrative,
        llmReasoning: context.llmAnalysis?.reasoning,
        llmConfidence: context.llmAnalysis?.confidence,
        marketRegime: context.marketRegime,
        creatorReputation: context.creatorReputation,
        creatorBlacklisted: context.creatorBlacklisted,
        positionSizeSol: sizeSol,
        entryPrice: latestPrice,
        marketCapSol: metrics.marketCapSol,
        volumeSol: metrics.recentVolumeSol,
        buyCount: metrics.buyCount,
        sellCount: metrics.sellCount,
        uniqueBuyers: metrics.uniqueBuyers.size,
        bondingCurveProgress: metrics.bondingCurveProgress,
        tokenAgeSec: Math.round((Date.now() - metrics.createdAt) / 1000),
        whaleCount: whaleData.whaleCount,
        whaleVolumeSol: whaleData.whaleVolumeSol,
        narrativeBoost: context.narrativeBoost,
        devWalletHash: devWallet ? crypto.createHash("sha256").update(devWallet).digest("hex").slice(0, 16) : undefined,
        entryTxSignature: result.signature,
        configSnapshot: {
          minPositionSizeSol: this.config.minPositionSizeSol,
          maxPositionSizeSol: this.config.maxPositionSizeSol,
          stopLossPct: this.config.stopLossPct,
          takeProfitPct1: this.config.takeProfitPct1,
          takeProfitPct2: this.config.takeProfitPct2,
          maxConcurrentPositions: this.config.maxConcurrentPositions,
          maxTotalExposureSol: this.config.maxTotalExposureSol,
        },
      });

      logger.trade(`✅ BOUGHT ${signal.symbol}: ${sizeSol.toFixed(4)} SOL → ~${estimatedTokens.toFixed(0)} tokens`, {
        mint, symbol: signal.symbol, solAmount: sizeSol, tokens: estimatedTokens,
        signature: result.signature, entryPrice: latestPrice,
      });

      this.notify(`🟢 **BUY** ${signal.symbol}\nScore: ${signal.score}/100 | Size: ${sizeSol.toFixed(4)} SOL\nTx: \`${result.signature?.slice(0, 16)}...\``);
      this.pumpApi.subscribeToToken(mint);
    } finally {
      this.evaluating.delete(mint);
    }
  }

  private async checkOpenPositions(): Promise<void> {
    if (!this.running) return;
    for (const pos of this.positions.getOpenPositions()) {
      try { await this.checkPosition(pos.mint); }
      catch (err) { logger.error("SCANNER", `Position check error ${pos.symbol}: ${err}`); }
    }
  }

  private async checkPosition(mint: string): Promise<void> {
    const pos = this.positions.getPosition(mint);
    if (!pos || pos.status === "closed") return;
    const metrics = this.pumpApi.metrics.get(mint);
    if (!metrics) return;

    const currentPrice = metrics.priceHistory.length > 0
      ? metrics.priceHistory[metrics.priceHistory.length - 1]![1]
      : pos.currentPrice;

    this.positions.updatePrice(mint, currentPrice);

    // ── Stagnation failsafe (UAV / Manual modes only) ──
    // If a token has no volume shortly after entry, dump it before it dies
    if (this.tradingMode !== "agent") {
      const ageSeconds = (Date.now() - pos.openedAt) / 1_000;
      if (ageSeconds >= this.config.stagnationExitSec) {
        const tradesSinceEntry = metrics.recentTrades.filter(t => t.timestamp >= pos.openedAt);
        const priceDelta = (currentPrice - pos.entryPrice) / pos.entryPrice;
        if (tradesSinceEntry.length < this.config.stagnationMinTrades && priceDelta < 0.02) {
          logger.trade(`💀 Stagnation exit: ${pos.symbol} — only ${tradesSinceEntry.length} trades in ${ageSeconds.toFixed(0)}s, no momentum`, { mint });
          await this.exitPosition(mint, 1.0, "stagnation");
          return;
        }
      }
    }

    // Trailing stop — use fee-adjusted P&L so trailing stop only activates on real profit
    const rawPnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
    const roundTripFeePct = (this.config.tradingFeePct * 2) + (pos.entrySol > 0 ? (this.config.priorityFeeSol * 2) / pos.entrySol : 0);
    const netPnlPct = rawPnlPct - roundTripFeePct;
    // In live mode, trailing stop is disabled — the agent decides per-token exit timing.
    // In dry run, mechanical trailing stop runs for strategy experiment data collection.
    if (this.config.dryRun && netPnlPct >= this.config.trailingStopActivationPct) {
      const newStopPrice = pos.peakPrice * (1 - this.config.trailingStopDistancePct);
      if (newStopPrice > pos.trailingStopPrice) {
        this.positions.setTrailingStop(mint, newStopPrice);
      }
      if (pos.trailingStopPrice > 0 && currentPrice <= pos.trailingStopPrice) {
        logger.trade(`📉 Trailing stop hit: ${pos.symbol}`, { mint, currentPrice, stopPrice: pos.trailingStopPrice });
        await this.exitPosition(mint, 1.0, "trailing-stop");
        return;
      }
    }

    const exitCheck = this.signalEngine.shouldExit(metrics, pos.entryPrice, currentPrice, pos.openedAt, pos.entrySol);
    if (exitCheck.exit) {
      // In LIVE mode, only honor safety-critical mechanical exits.
      // The agent decides all nuanced exits (TP1, trailing, momentum, volume) per-token.
      if (!this.config.dryRun) {
        const LIVE_SAFETY_EXITS = new Set(["stop-loss", "take-profit-2", "age-timeout"]);
        if (!LIVE_SAFETY_EXITS.has(exitCheck.reason)) {
          return; // Skip — agent will evaluate this position and decide
        }
      }
      logger.trade(`🚪 Exit signal: ${pos.symbol} — ${exitCheck.reason}`, { mint, reason: exitCheck.reason, pnlPct: (netPnlPct * 100).toFixed(1) });
      await this.exitPosition(mint, exitCheck.exitRatio, exitCheck.reason as ExitReason);
    }
  }

  private async exitPosition(mint: string, exitRatio: number, reason: ExitReason): Promise<void> {
    // Prevent concurrent exits on the same mint (race between position check + other triggers)
    if (this.exiting.has(mint)) {
      logger.debug("SCANNER", `Skipping duplicate exit for ${mint.slice(0, 12)}... — already exiting`);
      return;
    }
    this.exiting.add(mint);

    const pos = this.positions.getPosition(mint);
    if (!pos) { this.exiting.delete(mint); return; }

    try { await this._doExit(mint, pos, exitRatio, reason); }
    finally { this.exiting.delete(mint); }
  }

  private async _doExit(mint: string, pos: NonNullable<ReturnType<PositionManager["getPosition"]>>, exitRatio: number, reason: ExitReason): Promise<void> {

    const isFullExit = exitRatio >= 0.99;
    const label = isFullExit ? "SELL ALL" : `SELL ${(exitRatio * 100).toFixed(0)}%`;

    thinkingLog.add({
      mint, symbol: pos.symbol, type: "exit",
      decision: `${label} — ${reason}`,
      reasoning: [
        `Current P&L: ${(pos.unrealizedPnlPct * 100).toFixed(1)}% (${pos.unrealizedPnlSol.toFixed(4)} SOL)`,
        `Exit reason: ${reason}`,
        `Hold time: ${((Date.now() - pos.openedAt) / 1000).toFixed(0)}s`,
        `Peak price: ${pos.peakPrice.toFixed(10)}`,
        `Entry price: ${pos.entryPrice.toFixed(10)}`,
      ],
    });

    logger.trade(`💰 ${label} ${pos.symbol} (${reason})`, { mint, reason, pnlPct: pos.unrealizedPnlPct });

    let result;
    if (isFullExit) {
      result = await this.trader.sell(mint, "all");
    } else {
      result = await this.trader.sellPortion(mint, exitRatio);
    }

    if (!result.success) {
      const attempts = (this.sellAttempts.get(mint) ?? 0) + 1;
      this.sellAttempts.set(mint, attempts);
      logger.error("TRADE", `❌ Sell FAILED for ${pos.symbol}: ${result.error} (attempt ${attempts})`);

      if (reason === "stop-loss" && attempts <= 1) {
        logger.trade(`Retrying sell with full balance...`);
        result = await this.trader.sell(mint, "all");
      }

      if (!result.success) {
        // After 2 failed attempts, force-close the position to stop infinite retries
        if (attempts >= 2) {
          logger.warn("TRADE", `⚠️ Force-closing ${pos.symbol} after ${attempts} failed sell attempts`);
          this.positions.recordFullExit(mint, 0, reason);
          this.pumpApi.unsubscribeFromToken(mint);
          this.sellAttempts.delete(mint);
        }
        return;
      }
    }

    this.sellAttempts.delete(mint);
    let solReceived = result.solAmount ?? 0;

    // ── Estimate SOL received from market price ──
    // PumpPortal doesn’t return actual SOL received for sells, so we estimate
    // from the current market price in both dry-run AND live modes.
    if (solReceived === 0 && pos.currentPrice > 0) {
      const tokensBeingSold = pos.tokenAmount * pos.remainingRatio * exitRatio;
      // ── Dry-run sell slippage: deflate exit price by 5% ──
      const effectivePrice = this.config.dryRun ? pos.currentPrice * 0.95 : pos.currentPrice;
      solReceived = tokensBeingSold * effectivePrice;
      if (this.config.dryRun) {
        logger.info("SCANNER", `🧪 Sell slippage sim: ${pos.currentPrice.toExponential(3)} → ${effectivePrice.toExponential(3)} (-5%)`);
      }
      logger.trade(`💰 Estimated sell proceeds: ${solReceived.toFixed(4)} SOL (price: ${effectivePrice.toFixed(12)})`);
    }

    // ── Deduct fees from both sides of the trade ──
    // Sell-side: PumpPortal fee on proceeds + priority fee
    const sellFee = solReceived * this.config.tradingFeePct + this.config.priorityFeeSol;
    solReceived = Math.max(0, solReceived - sellFee);
    // Buy-side: PumpPortal fee on entry + priority fee (already paid, must be in P&L)
    const rawCostBasis = pos.entrySol * pos.remainingRatio * exitRatio;
    const buyFee = rawCostBasis * this.config.tradingFeePct + this.config.priorityFeeSol;
    const costBasis = rawCostBasis + buyFee;
    const pnl = solReceived - costBasis;

    if (isFullExit) {
      this.positions.recordFullExit(mint, solReceived, reason, result.signature);
      this.pumpApi.unsubscribeFromToken(mint);
    } else {
      this.positions.recordPartialExit(mint, exitRatio, solReceived, reason, result.signature);
    }

    this.riskManager.recordTradeResult(pnl > 0);

    // ── Consecutive loss auto-pause (disabled in dry run) ──
    if (pnl >= 0) {
      this.consecutiveLosses = 0;
      this.autoPaused = false;
    } else {
      this.consecutiveLosses++;
      if (!this.config.dryRun && this.consecutiveLosses >= Scanner.AUTO_PAUSE_THRESHOLD && !this.autoPaused) {
        this.autoPaused = true;
        logger.warn("SCANNER", `⛔ AUTO-PAUSED: ${this.consecutiveLosses} consecutive losses — pausing new entries until conditions improve`);
        this.notify(`⛔ **AUTO-PAUSED**: ${this.consecutiveLosses} consecutive losses. No new entries until manually resumed or agent resumes.`);
      }
    }

    // ── Track outcome for market regime ──
    if (pnl > 0) {
      this.marketRegime.recordSurvival(mint, pos.symbol, pos.peakPrice);
      // Track winners for LLM narrative context
      if (pos.symbol) {
        this.recentWinners.push(pos.symbol);
        if (this.recentWinners.length > 10) this.recentWinners.shift();
      }
    } else {
      this.marketRegime.recordRug(mint, pos.symbol);
    }

    // ── Log exit to trade journal ──
    const holdTimeSec = (Date.now() - pos.openedAt) / 1000;
    const peakPnlPct = pos.peakPrice > 0 && pos.entryPrice > 0
      ? (pos.peakPrice - pos.entryPrice) / pos.entryPrice
      : 0;
    this.tradeJournal.logExit({
      mint, symbol: pos.symbol,
      exitReason: reason,
      exitPrice: pos.currentPrice,
      pnlSol: pnl,
      pnlPct: costBasis > 0 ? pnl / costBasis : 0,
      holdTimeSec,
      peakPrice: pos.peakPrice,
      peakPnlPct,
      exitTxSignatures: pos.exitTxSignatures,
      configSnapshot: {
        minPositionSizeSol: this.config.minPositionSizeSol,
        maxPositionSizeSol: this.config.maxPositionSizeSol,
        stopLossPct: this.config.stopLossPct,
        takeProfitPct1: this.config.takeProfitPct1,
        takeProfitPct2: this.config.takeProfitPct2,
        maxConcurrentPositions: this.config.maxConcurrentPositions,
        maxTotalExposureSol: this.config.maxTotalExposureSol,
      },
    });

    // ── Notify autonomous agent ──
    if (this.onTradeCompleted) {
      try { this.onTradeCompleted(pos.symbol, pnl, reason); } catch {}
    }

    // ── Missed winner tracking (dry-run only) ──
    // Log when a dry-run trade was profitable but would NOT have been taken in live mode
    if (this.config.dryRun && pnl > 0 && costBasis > 0) {
      const buyEntry = this.tradeJournal.getLastBuyEntry(mint);
      if (buyEntry && buyEntry.liveEligible === false) {
        const winPct = (pnl / costBasis * 100).toFixed(1);
        const reasons = buyEntry.liveFilterFailReasons?.join(", ") || "unknown";
        logger.warn("SCANNER", `[MISSED-WINNER] ${pos.symbol}: +${winPct}% (+${pnl.toFixed(4)} SOL) — failed live gates: ${reasons}`);
      }
    }

    const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";
    const pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL`;
    logger.trade(`${pnlEmoji} ${pos.symbol} ${label}: ${pnlStr} (${reason})`, {
      mint, reason, pnlSol: pnl, signature: result.signature,
    });

    this.notify(`${pnlEmoji} **${label}** ${pos.symbol}\nReason: ${reason} | P&L: ${pnlStr}`);

    // ── Start post-sale monitoring (track token for 10 more minutes) ──
    if (isFullExit) {
      this.postSaleMonitor.startMonitoring({
        mint,
        symbol: pos.symbol,
        exitPrice: pos.currentPrice,
        exitReason: reason,
        pnlSol: pnl,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ── Post-Sale Monitoring ──
  // ══════════════════════════════════════════════════════════════════════════════

  /** Called when post-sale monitoring completes (10 min after exit, and again at 1h) */
  private onPostSaleComplete(result: PostSaleResult): void {
    // Update the trade journal with post-sale data
    this.tradeJournal.updatePostSaleData(result.mint, {
      verdict: result.verdict ?? "unknown",
      analysis: result.analysis ?? "",
      missedUpsidePct: result.missedUpsidePct,
      priceChange10mPct: result.priceChange10mPct,
      priceChange1hPct: result.priceChange1hPct,
      graduated: result.graduated,
    });

    // Log notable results
    const verdictEmoji = result.verdict === "good-exit" || result.verdict === "token-dead"
      ? "✅" : result.verdict === "missed-graduation" ? "🎓" : "⚠️";
    logger.info("MONITOR", `${verdictEmoji} POST-SALE ${result.symbol}: ${result.verdict} — ${result.analysis?.slice(0, 200)}`);

    // Notify dashboard for significant missed opportunities
    if (result.verdict === "missed-graduation" || result.verdict === "missed-opportunity") {
      this.notify(`📡 **Post-Sale Alert: ${result.symbol}**\nVerdict: ${result.verdict}\n${result.analysis?.slice(0, 300)}`);
    }

    // Auto-generate lessons from post-sale data for persistent strategy memory
    if (this.chatAgent) {
      const strategy = this.chatAgent.strategy;
      if (result.verdict === "missed-graduation") {
        strategy.addLesson(
          `${result.symbol} graduated after we sold — our exit was too early. Consider wider trailing stops or longer hold times for tokens showing strong volume.`,
          "exit", "post-sale-monitor", 0.7,
        );
      } else if (result.verdict === "missed-opportunity" && (result.missedUpsidePct ?? 0) > 50) {
        strategy.addLesson(
          `Missed ${((result.missedUpsidePct ?? 0) * 100).toFixed(0)}% upside on ${result.symbol} after exit — the token pumped significantly. Stop-loss or trailing stop may have been too tight.`,
          "exit", "post-sale-monitor", 0.6,
        );
      } else if (result.verdict === "good-exit" || result.verdict === "token-dead") {
        strategy.addLesson(
          `Good exit on ${result.symbol} — token ${result.verdict === "token-dead" ? "died" : "dropped"} after we sold. Current exit strategy working for this type.`,
          "exit", "post-sale-monitor", 0.5,
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ── Smart Money Integration ──
  // ══════════════════════════════════════════════════════════════════════════════

  /** Handle a smart money buy signal: queue the token as a candidate with priority */
  private handleSmartMoneyBuy(signal: SmartMoneySignal): void {
    if (!this.running || this.tradingMode !== "agent") return;
    if (this.positions.hasPosition(signal.mint)) return; // already holding
    if (this.skippedMints.has(signal.mint)) return;

    // Check if already a candidate — if so, enhance it with smart money data
    const existing = this.candidateTokens.get(signal.mint);
    if (existing) {
      existing.smartMoneySignal = {
        walletRank: signal.walletRank,
        walletWinRate: signal.walletWinRate,
        walletPnlSol: signal.walletPnlSol,
        walletTrades: signal.walletCompletedRoundTrips,
        buySolAmount: signal.solAmount,
      };
      logger.info("SMART_MONEY", `🐋 Enhanced existing candidate ${existing.symbol} with smart money signal (Top #${signal.walletRank})`);
      return;
    }

    // ── Smart money as standalone buy trigger is DISABLED (0% WR on 10 trades) ──
    // Only log the signal for data collection — don't create new candidates.
    // Smart money ONLY enhances existing candidates (handled above).
    logger.info("SCANNER", `🐋📊 Smart Money Signal (data only): ${signal.symbol} — Top #${signal.walletRank} wallet bought ${signal.solAmount.toFixed(3)} SOL (not creating candidate — 0% historical WR)`);
    // Still subscribe for metric tracking
    this.pumpApi.subscribeToToken(signal.mint);
  }

  /** Handle a smart money sell signal: exit our position if we hold the same token */
  private handleSmartMoneySell(signal: SmartMoneySignal): void {
    if (!this.running) return;
    const pos = this.positions.getPosition(signal.mint);
    if (!pos || pos.status === "closed") return; // not holding this token

    logger.trade(`🐋🔴 SMART MONEY SELL EXIT: Top #${signal.walletRank} wallet sold ${signal.symbol} — exiting our position`, {
      mint: signal.mint, symbol: signal.symbol, walletRank: signal.walletRank,
    });

    this.notify(`🐋🔴 Smart Money Exit: Top #${signal.walletRank} trader sold **${signal.symbol}** — auto-exiting position`);
    this.exitPosition(signal.mint, 1.0, "smart-money-sell").catch((err) => {
      logger.error("SCANNER", `Failed smart money sell exit for ${signal.symbol}: ${err}`);
    });
  }

  /** Update PumpPortal account subscriptions to track top wallets */
  private updateSmartMoneySubscriptions(): void {
    const currentTop = this.smartMoney.getTopWallets();
    const currentSubs = this.pumpApi.getSubscribedAccounts();

    // Unsubscribe from wallets no longer in top list
    const toUnsub = currentSubs.filter((w) => !currentTop.includes(w));
    if (toUnsub.length > 0) {
      this.pumpApi.unsubscribeFromAccounts(toUnsub);
    }

    // Subscribe to new top wallets
    const toSub = currentTop.filter((w) => !currentSubs.includes(w));
    if (toSub.length > 0) {
      this.pumpApi.subscribeToAccounts(toSub);
    }
  }

  getStatus() {
    const uptimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const hours = Math.floor(uptimeMs / 3_600_000);
    const mins = Math.floor((uptimeMs % 3_600_000) / 60_000);
    const sessionStart = this.startedAt ?? Date.now();
    const rawStats = this.positions.getStats(this.config.dryRun, sessionStart);
    return {
      running: this.running,
      uptime: `${hours}h ${mins}m`,
      tradingMode: this.tradingMode,
      walletPublicKey: this.config.privateKey ? this.solana.publicKey.toBase58() : "",
      openPositions: this.positions.getOpenPositionCount(),
      trackedTokens: this.pumpApi.metrics.size,
      wsMessages: this.pumpApi.getMessageCount(),
      riskStatus: (() => {
        const rs = this.riskManager.getStatus();
        return { consecutiveLosses: rs.consecutiveLosses, coolingDown: rs.inCooldown };
      })(),
      stats: {
        totalTrades: rawStats.totalTrades,
        wins: rawStats.wins,
        losses: rawStats.losses,
        winRate: rawStats.winRate,
        totalRealizedPnl: rawStats.totalRealizedPnl,
        bestTradePnl: rawStats.bestTrade,
        worstTradePnl: rawStats.worstTrade,
      },
      dryRun: this.config.dryRun,
      config: {
        minPositionSizeSol: this.config.minPositionSizeSol,
        maxPositionSizeSol: this.config.maxPositionSizeSol,
        maxConcurrentPositions: this.config.maxConcurrentPositions,
        maxTotalExposureSol: this.config.maxTotalExposureSol,
        stopLossPct: this.config.stopLossPct,
        takeProfitPct1: this.config.takeProfitPct1,
        takeProfitPct2: this.config.takeProfitPct2,
        minBuyScore: this.config.minBuyScore,
        maxPositionAgeSec: this.config.maxPositionAgeSec,
        trailingStopActivationPct: this.config.trailingStopActivationPct,
        trailingStopDistancePct: this.config.trailingStopDistancePct,
        stagnationExitSec: this.config.stagnationExitSec,
        stagnationMinTrades: this.config.stagnationMinTrades,
        tradingFeePct: this.config.tradingFeePct,
      },
      intelligence: {
        marketRegime: this.marketRegime.getRegime(),
        regimeAdjustment: this.marketRegime.getScoreAdjustment(),
        blacklistedCreators: this.creatorBlacklist.getStats().totalBlacklisted,
        recentWinners: this.recentWinners.slice(-5),
        smartMoney: this.smartMoney.getStats(),
        postSaleMonitoring: this.postSaleMonitor.activeCount,
      },
    };
  }

  /** Sell all open positions immediately (manual panic sell) */
  async sellAllPositions(): Promise<{ sold: number; failed: number }> {
    const openPositions = this.positions.getOpenPositions();
    if (openPositions.length === 0) return { sold: 0, failed: 0 };

    logger.info("TRADE", `🚨 SELL ALL: Liquidating ${openPositions.length} open position(s)...`);
    let sold = 0;
    let failed = 0;

    for (const pos of openPositions) {
      try {
        const result = await this.trader.sell(pos.mint, "all");
        if (result.success) {
          let solReceived = result.solAmount ?? 0;
          // Estimate SOL received from market price (PumpPortal doesn’t return it)
          if (solReceived === 0 && pos.currentPrice > 0) {
            solReceived = pos.tokenAmount * pos.remainingRatio * pos.currentPrice;
            logger.trade(`💰 Estimated sell-all proceeds: ${solReceived.toFixed(4)} SOL`);
          }
          this.positions.recordFullExit(pos.mint, solReceived, "manual", result.signature);
          this.pumpApi.unsubscribeFromToken(pos.mint);
          this.sellAttempts.delete(pos.mint);
          const pnl = solReceived - pos.entrySol * pos.remainingRatio;
          const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";
          logger.trade(`${pnlEmoji} SOLD ${pos.symbol}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL (manual)`);
          sold++;
        } else {
          logger.error("TRADE", `❌ Failed to sell ${pos.symbol}: ${result.error}`);
          // Force-close even if sell fails so position doesn't linger
          this.positions.recordFullExit(pos.mint, 0, "manual");
          this.pumpApi.unsubscribeFromToken(pos.mint);
          this.sellAttempts.delete(pos.mint);
          failed++;
        }
      } catch (err) {
        logger.error("TRADE", `❌ Error selling ${pos.symbol}: ${err}`);
        this.positions.recordFullExit(pos.mint, 0, "manual");
        this.pumpApi.unsubscribeFromToken(pos.mint);
        failed++;
      }
    }

    logger.info("TRADE", `🚨 SELL ALL complete: ${sold} sold, ${failed} failed/force-closed`);
    return { sold, failed };
  }

  /** Get current candidate tokens awaiting agent review (sorted: smart money first, then freshness, max 10) */
  getCandidates(): CandidateToken[] {
    // Expire stale candidates first — tokens older than 90s are stale
    const expiry = Date.now() - 90_000;
    for (const [m, c] of this.candidateTokens) {
      if (c.discoveredAt < expiry) this.candidateTokens.delete(m);
    }
    // Sort: smart money & spam launches first, then by freshness, then by score
    return Array.from(this.candidateTokens.values())
      .sort((a, b) => {
        // Priority signals: smart money and spam launches come first
        const aPriority = (a.smartMoneySignal ? 2 : 0) + (a.spamLaunchCount ? 1 : 0);
        const bPriority = (b.smartMoneySignal ? 2 : 0) + (b.spamLaunchCount ? 1 : 0);
        if (aPriority !== bPriority) return bPriority - aPriority;

        // Within same category: prioritize newer tokens
        const ageDiff = b.discoveredAt - a.discoveredAt; // newer first
        if (Math.abs(ageDiff) > 15_000) return ageDiff;
        return b.score - a.score; // higher score first within same freshness bracket
      })
      .slice(0, 10);
  }

  /** Clear candidates after agent has reviewed them */
  clearCandidates(mints: string[]): void {
    for (const m of mints) {
      this.candidateTokens.delete(m);
      if (!this.positions.hasPosition(m)) {
        this.skippedMints.add(m); // Don't re-evaluate rejected tokens
      }
    }
  }

  getOpenPositionsSummary(): string {
    const positions = this.positions.getOpenPositions();
    if (positions.length === 0) return "No open positions.";
    return positions.map((p) => {
      const pnlStr = `${p.unrealizedPnlPct >= 0 ? "+" : ""}${(p.unrealizedPnlPct * 100).toFixed(1)}%`;
      const pnlEmoji = p.unrealizedPnlPct >= 0 ? "🟢" : "🔴";
      const holdTime = Math.round((Date.now() - p.openedAt) / 1_000);
      return `${pnlEmoji} ${p.symbol}: ${pnlStr} (${p.unrealizedPnlSol.toFixed(4)} SOL) | ${holdTime}s`;
    }).join("\n");
  }

  /** Get tracked token summaries for dashboard */
  getTrackedTokens() {
    const tokens: Array<{
      mint: string; symbol: string; name: string;
      marketCapSol: number; recentVolumeSol: number;
      buyCount: number; sellCount: number;
      uniqueBuyers: number; bondingCurveProgress: number;
      ageSec: number; lastSignalScore?: number;
    }> = [];

    for (const [mint, m] of this.pumpApi.metrics) {
      const signal = this.lastSignals.get(mint);
      tokens.push({
        mint, symbol: m.symbol, name: m.name,
        marketCapSol: m.marketCapSol, recentVolumeSol: m.recentVolumeSol,
        buyCount: m.buyCount, sellCount: m.sellCount,
        uniqueBuyers: m.uniqueBuyers.size,
        bondingCurveProgress: m.bondingCurveProgress,
        ageSec: Math.round((Date.now() - m.createdAt) / 1_000),
        lastSignalScore: signal?.score,
      });
    }

    return tokens.sort((a, b) => (b.lastSignalScore ?? 0) - (a.lastSignalScore ?? 0)).slice(0, 50);
  }

  private notify(message: string): void {
    if (this.onTradeNotification) {
      try { this.onTradeNotification(message); } catch {}
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ── Agent-initiated trading: the autonomous agent can buy/sell directly ──
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Agent-initiated buy: buy a specific token by mint address.
   * Skips the normal signal evaluation — the agent decides on its own.
   */
  async agentBuy(mint: string, solAmount?: number, symbolHint?: string, entryContext?: {
    signalScore?: number;
    llmScore?: number;
    llmNarrative?: string;
    llmReasoning?: string;
    llmConfidence?: number;
    creatorReputation?: number;
    creatorBlacklisted?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    if (!this.running) return { success: false, error: "Scanner not running" };

    if (this.positions.hasPosition(mint)) {
      return { success: false, error: "Already have a position in this token" };
    }

    // Skip risk manager cooldown in dry run — no real money at risk
    if (!this.config.dryRun) {
      const riskStatus = this.riskManager.getStatus();
      if (riskStatus.inCooldown) {
        return { success: false, error: "Risk manager in cooldown" };
      }
    }

    if (this.positions.getOpenPositionCount() >= this.config.maxConcurrentPositions) {
      return { success: false, error: "Max concurrent positions reached" };
    }

    let size = solAmount ?? this.config.minPositionSizeSol;

    // ── HARD CAP: position size must NEVER exceed maxPositionSizeSol ──
    // The agent must change the config if it wants to buy larger.
    const maxSize = this.config.maxPositionSizeSol;
    if (size > maxSize) {
      logger.warn("SCANNER", `⛔ Position size ${size.toFixed(4)} SOL exceeds max ${maxSize.toFixed(4)} SOL — clamping`);
      size = maxSize;
    }

    // Fee guard: auto-adjust size upward if round-trip fees exceed 10% of position
    // But NEVER exceed maxPositionSizeSol — block instead.
    const feeThreshold = 0.10;
    const feePctPart = this.config.tradingFeePct * 2;
    if (feePctPart < feeThreshold) {
      const minSizeForFees = (this.config.priorityFeeSol * 2) / (feeThreshold - feePctPart);
      if (size < minSizeForFees) {
        const adjusted = Math.min(Math.ceil(minSizeForFees * 1000) / 1000, maxSize);
        if (adjusted < minSizeForFees) {
          // Even at maxPositionSizeSol, fees are still too high — block the trade
          return { success: false, error: `Fees too high even at max position size (${maxSize.toFixed(4)} SOL). Increase maxPositionSizeSol or reduce priority fee.` };
        }
        logger.system(`Auto-adjusting buy size: ${size.toFixed(4)} -> ${adjusted.toFixed(4)} SOL (fees were ${((((size * feePctPart) + (this.config.priorityFeeSol * 2)) / size) * 100).toFixed(1)}% of position)`);
        size = adjusted;
      }
    }

    if (this.positions.getTotalExposureSol() + size > this.config.maxTotalExposureSol) {
      return { success: false, error: "Would exceed max total exposure" };
    }

    // ── Balance + gas reserve check ──
    // Reserve enough SOL to sell ALL open positions + this new one
    if (!this.config.dryRun) {
      const solBalance = await this.solana.getSolBalance();
      const sellGasPerPosition = this.config.priorityFeeSol + 0.005;
      const positionsAfterBuy = this.positions.getOpenPositionCount() + 1;
      const gasReserve = positionsAfterBuy * sellGasPerPosition;
      const totalReserve = Math.max(this.config.reserveSol, gasReserve);
      const required = size + this.config.priorityFeeSol + totalReserve;
      if (solBalance < required) {
        return {
          success: false,
          error: `Insufficient SOL: ${solBalance.toFixed(4)} < ${required.toFixed(4)} (need ${totalReserve.toFixed(4)} reserved for exit gas on ${positionsAfterBuy} positions)`,
        };
      }
    }

    // Fee guard: final verification (should never trigger after auto-adjust above)
    const roundTripFees = (size * this.config.tradingFeePct * 2) + (this.config.priorityFeeSol * 2);
    if (roundTripFees / size > feeThreshold) {
      return { success: false, error: `Fees too high (${(roundTripFees / size * 100).toFixed(1)}% of position). Increase size or reduce priority fee.` };
    }

    // Get token info — try candidate data, metrics, then on-chain
    let symbol = symbolHint || mint.slice(0, 8);
    let name = symbol;
    let latestPrice = 0;

    // Check candidate tokens first — they have verified symbol/name from evaluation
    const candidate = this.candidateTokens.get(mint);
    if (candidate) {
      symbol = candidate.symbol || symbol;
      name = candidate.name || name;
    }

    const metrics = this.pumpApi.metrics.get(mint);
    if (metrics) {
      symbol = metrics.symbol || symbol;
      name = metrics.name || name;
      if (metrics.priceHistory.length > 0) {
        latestPrice = metrics.priceHistory[metrics.priceHistory.length - 1]![1]!;
      } else {
        latestPrice = metrics.vSolInBondingCurve / metrics.vTokensInBondingCurve;
      }
    } else {
      // Try fetching details from pump.fun
      const details = await this.pumpApi.fetchTokenDetails(mint);
      if (details) {
        symbol = (details.symbol as string) || symbol;
        name = (details.name as string) || name;
        const vSol = details.virtual_sol_reserves as number;
        const vTokens = details.virtual_token_reserves as number;
        if (vSol && vTokens) latestPrice = vSol / vTokens;
      }
    }

    logger.trade(`🤖 AGENT BUY: ${symbol} (${mint.slice(0, 12)}...) for ${size.toFixed(4)} SOL`, {
      mint, symbol, size, source: "agent",
    });

    thinkingLog.add({
      mint, symbol, type: "entry",
      decision: `🤖 AGENT BUY: ${size.toFixed(4)} SOL`,
      reasoning: ["Agent-initiated purchase", `Position size: ${size.toFixed(4)} SOL`],
    });

    // ── Dry-run: simulate confirmation delay + re-sample price ──
    if (this.config.dryRun && latestPrice > 0) {
      await new Promise((resolve) => setTimeout(resolve, 3000)); // 3s confirmation delay
      // Re-sample price after delay (tokens move fast)
      const updatedMetrics = this.pumpApi.metrics.get(mint);
      if (updatedMetrics && updatedMetrics.priceHistory.length > 0) {
        latestPrice = updatedMetrics.priceHistory[updatedMetrics.priceHistory.length - 1]![1]!;
      }
    }

    const result = await this.trader.buy(mint, size);
    if (!result.success) {
      logger.error("TRADE", `❌ Agent buy FAILED: ${result.error}`);
      return { success: false, error: result.error };
    }

    // ── Dry-run slippage simulation: inflate entry price by 3% ──
    // Real pump.fun bonding curve buys have 2-5% slippage on small positions (0.05-0.15 SOL)
    let adjustedEntryPrice = latestPrice;
    if (this.config.dryRun && latestPrice > 0) {
      adjustedEntryPrice = latestPrice * 1.03;
      logger.info("SCANNER", `🧪 Slippage sim: entry ${latestPrice.toExponential(3)} → ${adjustedEntryPrice.toExponential(3)} (+3%)`);
    }

    const estimatedTokens = adjustedEntryPrice > 0 ? size / adjustedEntryPrice : 0;
    this.positions.openPosition({
      mint, symbol, name,
      entrySol: size, tokenAmount: estimatedTokens,
      entryPrice: adjustedEntryPrice, txSignature: result.signature,
      dryRun: this.config.dryRun,
    });

    // ── Evaluate LiveFilterGate and tag the trade ──
    // For agent-initiated buys without prior gate evaluation, run it now
    if (candidate && candidate.liveEligible === undefined) {
      const gate = evaluateLiveFilterGate(candidate, metrics, this.config);
      candidate.liveEligible = gate.eligible;
      candidate.liveFilterFailReasons = gate.failReasons;
    }

    this.tradeJournal.logEntry({
      mint, symbol, name,
      signalScore: entryContext?.signalScore ?? 0,
      llmScore: entryContext?.llmScore,
      llmNarrative: entryContext?.llmNarrative ?? "agent-initiated",
      llmReasoning: entryContext?.llmReasoning,
      llmConfidence: entryContext?.llmConfidence,
      marketRegime: this.marketRegime.getRegime(),
      creatorReputation: entryContext?.creatorReputation ?? 0,
      creatorBlacklisted: entryContext?.creatorBlacklisted ?? false,
      positionSizeSol: size,
      entryPrice: adjustedEntryPrice,
      marketCapSol: metrics?.marketCapSol ?? 0,
      volumeSol: metrics?.recentVolumeSol ?? 0,
      buyCount: metrics?.buyCount ?? 0,
      sellCount: metrics?.sellCount ?? 0,
      uniqueBuyers: metrics?.uniqueBuyers.size ?? 0,
      bondingCurveProgress: metrics?.bondingCurveProgress ?? 0,
      tokenAgeSec: metrics ? Math.round((Date.now() - metrics.createdAt) / 1000) : 0,
      spamLaunchCount: candidate?.spamLaunchCount,
      socialScore: candidate?.socialSignal?.score,
      socialFirstMover: candidate?.socialSignal?.isFirstMover,
      socialCompetingCoins: candidate?.socialSignal?.competingCoins,
      socialXTweets: candidate?.socialSignal?.xTweetCount,
      socialViralMeme: candidate?.socialSignal?.isViralMeme,
      smartMoneyRank: candidate?.smartMoneySignal?.walletRank,
      smartMoneyWinRate: candidate?.smartMoneySignal?.walletWinRate,
      whaleCount: metrics ? extractWhaleData(metrics).whaleCount : 0,
      whaleVolumeSol: metrics ? extractWhaleData(metrics).whaleVolumeSol : 0,
      replyCount: candidate?.replyCount,
      hasTwitter: candidate?.hasTwitter,
      hasWebsite: candidate?.hasWebsite,
      hasTelegram: candidate?.hasTelegram,
      tokenDescription: candidate?.tokenDescription,
      narrativeBoost: candidate?.narrativeBoost,
      devWalletHash: candidate?.devWalletHash,
      entryTxSignature: result.signature,
      liveEligible: candidate?.liveEligible,
      liveFilterFailReasons: candidate?.liveFilterFailReasons,
      configSnapshot: {
        minPositionSizeSol: this.config.minPositionSizeSol,
        maxPositionSizeSol: this.config.maxPositionSizeSol,
        stopLossPct: this.config.stopLossPct,
        takeProfitPct1: this.config.takeProfitPct1,
        takeProfitPct2: this.config.takeProfitPct2,
        maxConcurrentPositions: this.config.maxConcurrentPositions,
        maxTotalExposureSol: this.config.maxTotalExposureSol,
      },
    });

    this.pumpApi.subscribeToToken(mint);
    this.notify(`🤖 **AGENT BUY** ${symbol}\nSize: ${size.toFixed(4)} SOL`);

    return { success: true };
  }

  /**
   * Agent-initiated sell: sell a position by mint address.
   * Works even when scanner is stopped (manual sells should always be allowed).
   */
  async agentSell(mint: string): Promise<{ success: boolean; error?: string }> {
    const pos = this.positions.getPosition(mint);
    if (!pos || pos.status === "closed") {
      return { success: false, error: "No open position for this mint" };
    }

    logger.trade(`🤖 AGENT SELL: ${pos.symbol} (${mint.slice(0, 12)}...)`, {
      mint, symbol: pos.symbol, source: "agent",
    });

    await this.exitPosition(mint, 1.0, "manual");
    return { success: true };
  }

  /**
   * Agent-initiated sell by symbol name (convenience method).
   * Finds the position by matching symbol.
   */
  async agentSellBySymbol(symbol: string): Promise<{ success: boolean; error?: string }> {
    const positions = this.positions.getOpenPositions();
    const match = positions.find((p) => p.symbol.toLowerCase() === symbol.toLowerCase());
    if (!match) {
      return { success: false, error: `No open position for symbol "${symbol}"` };
    }
    return this.agentSell(match.mint);
  }
}
