// ── Historical Data Importer: imports from trade journal + PumpPortal API ──
// Phase 1: Import your existing trade-journal.json (free, instant)
// Phase 2: Enrich with PumpPortal REST API (free, rate-limited)
// Phase 3: Forward collection via WebSocket stream capture

import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { RAGDatabase } from "./database.js";
import { EmbeddingService, buildFeatureText } from "./embeddings.js";
import type { RAGTradeRecord } from "./types.js";
import type { TradeEntry } from "../trade-journal.js";
import type { SyncClient } from "../sync/sync-client.js";

const PUMP_API_BASE = "https://frontend-api-v2.pump.fun";
const PUMPPORTAL_API_BASE = "https://pumpportal.fun/api";

/** Rate limit: delay between PumpPortal REST requests */
const API_DELAY_MS = 2000;

/**
 * Only import trades from Feb 23 2026+ (enriched data era).
 * Pre-enrichment trades (Feb 17-21) lack social/whale/smartmoney fields
 * and degrade k-NN quality. Backed up in data/rag-backup-pre-enrichment.db.
 */
const RAG_IMPORT_CUTOFF_MS = 1771804800000; // 2026-02-23T00:00:00Z

export class HistoricalImporter {
  private syncClient: SyncClient | null = null;

  constructor(
    private db: RAGDatabase,
    private embedder: EmbeddingService,
    private dataDir: string,
  ) {}

  /** Attach a sync client to forward completed trades to central server */
  setSyncClient(client: SyncClient): void {
    this.syncClient = client;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Phase 1: Import from local trade-journal.json ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Import all completed trades from the local trade-journal.json file.
   * Zero API cost — uses data already on disk.
   */
  async importFromTradeJournal(): Promise<number> {
    const journalPath = path.join(this.dataDir, "trade-journal.json");
    if (!fs.existsSync(journalPath)) {
      logger.warn("RAG-IMPORT", "No trade-journal.json found — skipping local import");
      return 0;
    }

    const raw = fs.readFileSync(journalPath, "utf-8");
    const entries: TradeEntry[] = JSON.parse(raw);

    // Filter to completed trades (sells with full context), skip pre-enrichment era
    const completedTrades = entries.filter(
      (e) => e.action === "sell" && e.mint && e.exitReason && e.timestamp >= RAG_IMPORT_CUTOFF_MS,
    );

    logger.system(`RAG Import: Found ${completedTrades.length} completed trades in journal`);

    const records: RAGTradeRecord[] = [];
    for (const entry of completedTrades) {
      // Skip if already imported
      if (this.db.hasTrade(entry.mint, entry.timestamp)) continue;

      const record = this.journalEntryToRAGRecord(entry);
      records.push(record);
    }

    if (records.length === 0) {
      logger.info("RAG-IMPORT", "All journal trades already in RAG DB");
      return 0;
    }

    // Batch insert
    const inserted = this.db.insertTradeBatch(records);

    // Generate embeddings for all imported records (local, free)
    logger.system(`RAG Import: Generating embeddings for ${records.length} trades...`);
    const featureTexts = records.map((r) => r.featureText);
    const embeddings = await this.embedder.embedBatch(featureTexts);

    const updates = records.map((r, i) => ({ id: r.id, embedding: embeddings[i] }));
    this.db.updateEmbeddingBatch(updates);

    this.db.logImport("trade-journal", inserted, `Imported ${inserted} completed trades`);
    logger.system(`RAG Import: ✅ Imported ${inserted} trades from journal with embeddings`);

    return inserted;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Phase 2: Enrich with PumpPortal API ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch additional token details from PumpPortal for trades in the RAG DB.
   * Enriches records with creator info, reply counts, graduation status, etc.
   * Rate-limited to avoid hitting API limits.
   */
  async enrichFromPumpPortal(limit = 50): Promise<number> {
    // Get trades that might benefit from enrichment (missing creator data)
    const trades = this.db.getRecentTrades(limit);
    const mintsToFetch = [...new Set(trades.map((t) => t.mint))];

    logger.system(`RAG Enrich: Fetching PumpPortal data for ${mintsToFetch.length} unique tokens`);

    let enriched = 0;
    for (let i = 0; i < mintsToFetch.length; i++) {
      const mint = mintsToFetch[i];

      try {
        const details = await this.fetchTokenDetails(mint);
        if (!details) continue;

        // Update any trades for this mint with enriched data
        const matchingTrades = trades.filter((t) => t.mint === mint);
        for (const trade of matchingTrades) {
          // Update creator if missing
          if (!trade.creator && details.creator) {
            trade.creator = details.creator as string;
          }
          // Re-generate feature text with enriched data
          trade.featureText = buildFeatureText({
            symbol: trade.symbol,
            name: trade.name || (details.name as string) || "",
            llmNarrative: trade.llmNarrative,
            marketCapSol: trade.marketCapSol,
            volumeSol: trade.volumeSol,
            buyCount: trade.buyCount,
            sellCount: trade.sellCount,
            uniqueBuyers: trade.uniqueBuyers,
            bondingCurveProgress: trade.bondingCurveProgress,
            tokenAgeSec: trade.tokenAgeSec,
            signalScore: trade.signalScore,
            marketRegime: trade.marketRegime,
            creatorReputation: trade.creatorReputation,
            exitReason: trade.exitReason,
            pnlPct: trade.pnlPct,
            holdTimeSec: trade.holdTimeSec,
            lossCategory: trade.lossCategory,
          });

          // Re-insert (REPLACE) with enriched data
          this.db.insertTrade(trade);
          enriched++;
        }
      } catch (err) {
        logger.warn("RAG-ENRICH", `Failed to fetch ${mint.slice(0, 8)}: ${err}`);
      }

      // Rate limit
      if (i < mintsToFetch.length - 1) {
        await sleep(API_DELAY_MS);
      }
    }

    if (enriched > 0) {
      // Re-generate embeddings for enriched records
      const enrichedRecords = trades.filter((t) => t.creator);
      const texts = enrichedRecords.map((r) => r.featureText);
      const embeddings = await this.embedder.embedBatch(texts);
      const updates = enrichedRecords.map((r, i) => ({ id: r.id, embedding: embeddings[i] }));
      this.db.updateEmbeddingBatch(updates);

      this.db.logImport("pumpportal-enrich", enriched, `Enriched ${enriched} records`);
      logger.system(`RAG Enrich: ✅ Enriched ${enriched} records with PumpPortal data`);
    }

    return enriched;
  }

  /**
   * Import historical token data from PumpPortal for specific mints.
   * Useful for importing tokens you traded but don't have full data for.
   */
  async importFromPumpPortal(mints: string[]): Promise<number> {
    logger.system(`RAG Import: Fetching ${mints.length} tokens from PumpPortal API`);

    let imported = 0;
    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i];

      try {
        const details = await this.fetchTokenDetails(mint);
        if (!details) continue;

        // Create a basic trade record from PumpPortal data
        const record: RAGTradeRecord = {
          id: `pp-${mint.slice(0, 8)}-${Date.now()}`,
          mint,
          symbol: (details.symbol as string) || "???",
          name: (details.name as string) || "",
          creator: (details.creator as string) || "",
          timestamp: (details.created_timestamp as number) || Date.now(),
          entryPrice: 0,
          entrySizeSol: 0,
          marketCapSol: (details.market_cap as number) || 0,
          volumeSol: 0,
          buyCount: 0,
          sellCount: 0,
          uniqueBuyers: 0,
          bondingCurveProgress: (details.virtual_sol_reserves as number)
            ? Math.min(1, (details.virtual_sol_reserves as number) / 85)
            : 0,
          tokenAgeSec: 0,
          signalScore: 0,
          llmScore: 0,
          llmNarrative: "",
          llmConfidence: 0,
          marketRegime: "unknown",
          creatorReputation: 0,
          spamLaunch: false,
          whaleCount: 0,
          whaleVolumeSol: 0,
          spamLaunchCount: 0,
          socialScore: 0,
          socialFirstMover: false,
          socialCompetingCoins: 0,
          socialXTweets: 0,
          socialViralMeme: false,
          smartMoneyRank: 0,
          smartMoneyWinRate: 0,
          exitTimestamp: 0,
          exitPrice: 0,
          exitReason: "unknown",
          holdTimeSec: 0,
          peakPrice: 0,
          peakPnlPct: 0,
          pnlSol: 0,
          pnlPct: 0,
          outcome: "neutral",
          featureText: "",
        };

        record.featureText = buildFeatureText({
          symbol: record.symbol,
          name: record.name,
          llmNarrative: record.llmNarrative,
          marketCapSol: record.marketCapSol,
          volumeSol: record.volumeSol,
          buyCount: record.buyCount,
          sellCount: record.sellCount,
          uniqueBuyers: record.uniqueBuyers,
          bondingCurveProgress: record.bondingCurveProgress,
          tokenAgeSec: record.tokenAgeSec,
          signalScore: record.signalScore,
          marketRegime: record.marketRegime,
          creatorReputation: record.creatorReputation,
        });

        this.db.insertTrade(record);
        imported++;
      } catch (err) {
        logger.warn("RAG-IMPORT", `Failed to import ${mint.slice(0, 8)}: ${err}`);
      }

      if (i < mints.length - 1) await sleep(API_DELAY_MS);
    }

    if (imported > 0) {
      this.db.logImport("pumpportal-import", imported, `Imported ${imported} tokens`);
      logger.system(`RAG Import: ✅ Imported ${imported} tokens from PumpPortal`);
    }

    return imported;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Phase 3: Record a new completed trade (forward collection) ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Record a newly completed trade into the RAG database.
   * Called automatically when a position closes.
   * Generates embedding inline (fast, local).
   */
  async recordCompletedTrade(params: {
    mint: string;
    symbol: string;
    name: string;
    creator: string;
    entrySol: number;
    entryPrice: number;
    exitPrice: number;
    pnlSol: number;
    pnlPct: number;
    exitReason: string;
    holdTimeSec: number;
    peakPrice: number;
    peakPnlPct: number;
    // Entry metrics (from journal entry or candidate)
    signalScore: number;
    llmScore: number;
    llmNarrative: string;
    llmConfidence: number;
    marketCapSol: number;
    volumeSol: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    bondingCurveProgress: number;
    tokenAgeSec: number;
    marketRegime: string;
    creatorReputation: number;
    spamLaunch: boolean;
    spamLaunchCount: number;
    whaleCount: number;
    whaleVolumeSol: number;
    socialScore: number;
    socialFirstMover: boolean;
    socialCompetingCoins: number;
    socialXTweets: number;
    socialViralMeme: boolean;
    smartMoneyRank: number;
    smartMoneyWinRate: number;
  }): Promise<void> {
    const now = Date.now();

    const record: RAGTradeRecord = {
      id: `live-${params.mint.slice(0, 8)}-${now}`,
      mint: params.mint,
      symbol: params.symbol,
      name: params.name,
      creator: params.creator,
      timestamp: now - (params.holdTimeSec * 1000), // Entry time
      entryPrice: params.entryPrice,
      entrySizeSol: params.entrySol,
      marketCapSol: params.marketCapSol,
      volumeSol: params.volumeSol,
      buyCount: params.buyCount,
      sellCount: params.sellCount,
      uniqueBuyers: params.uniqueBuyers,
      bondingCurveProgress: params.bondingCurveProgress,
      tokenAgeSec: params.tokenAgeSec,
      signalScore: params.signalScore,
      llmScore: params.llmScore,
      llmNarrative: params.llmNarrative,
      llmConfidence: params.llmConfidence,
      marketRegime: params.marketRegime,
      creatorReputation: params.creatorReputation,
      spamLaunch: params.spamLaunch,
      spamLaunchCount: params.spamLaunchCount,
      whaleCount: params.whaleCount,
      whaleVolumeSol: params.whaleVolumeSol,
      socialScore: params.socialScore,
      socialFirstMover: params.socialFirstMover,
      socialCompetingCoins: params.socialCompetingCoins,
      socialXTweets: params.socialXTweets,
      socialViralMeme: params.socialViralMeme,
      smartMoneyRank: params.smartMoneyRank,
      smartMoneyWinRate: params.smartMoneyWinRate,
      exitTimestamp: now,
      exitPrice: params.exitPrice,
      exitReason: params.exitReason,
      holdTimeSec: params.holdTimeSec,
      peakPrice: params.peakPrice,
      peakPnlPct: params.peakPnlPct,
      pnlSol: params.pnlSol,
      pnlPct: params.pnlPct,
      outcome: params.pnlSol > 0 ? "win" : params.pnlSol < -0.0001 ? "loss" : "neutral",
      featureText: "",
    };

    record.featureText = buildFeatureText({
      symbol: record.symbol,
      name: record.name,
      llmNarrative: record.llmNarrative,
      marketCapSol: record.marketCapSol,
      volumeSol: record.volumeSol,
      buyCount: record.buyCount,
      sellCount: record.sellCount,
      uniqueBuyers: record.uniqueBuyers,
      bondingCurveProgress: record.bondingCurveProgress,
      tokenAgeSec: record.tokenAgeSec,
      signalScore: record.signalScore,
      marketRegime: record.marketRegime,
      creatorReputation: record.creatorReputation,
      exitReason: record.exitReason,
      pnlPct: record.pnlPct,
      holdTimeSec: record.holdTimeSec,
      spamLaunchCount: record.spamLaunchCount,
      socialScore: record.socialScore,
      socialFirstMover: record.socialFirstMover,
      socialCompetingCoins: record.socialCompetingCoins,
      socialXTweets: record.socialXTweets,
      socialViralMeme: record.socialViralMeme,
      smartMoneyRank: record.smartMoneyRank,
      smartMoneyWinRate: record.smartMoneyWinRate,
      whaleCount: record.whaleCount,
      whaleVolumeSol: record.whaleVolumeSol,
    });

    // Generate embedding inline (local, ~10ms)
    try {
      const embedding = await this.embedder.embed(record.featureText);
      record.embedding = embedding;
    } catch (err) {
      logger.warn("RAG", `Embedding failed for ${params.symbol}, saving without: ${err}`);
    }

    this.db.insertTrade(record);

    // Queue for central server sync (anonymized — no SOL amounts)
    if (this.syncClient) {
      try { this.syncClient.enqueue(record); } catch {}
    }

    logger.debug("RAG", `Recorded trade: ${params.symbol} ${record.outcome} (${(params.pnlPct * 100).toFixed(1)}%)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Helpers ──
  // ══════════════════════════════════════════════════════════════════════════

  private journalEntryToRAGRecord(entry: TradeEntry): RAGTradeRecord {
    const outcome: "win" | "loss" | "neutral" =
      (entry.pnlSol ?? 0) > 0 ? "win" : (entry.pnlSol ?? 0) < -0.0001 ? "loss" : "neutral";

    const record: RAGTradeRecord = {
      id: entry.id || `journal-${entry.mint}-${entry.timestamp}`,
      mint: entry.mint,
      symbol: entry.symbol,
      name: entry.name,
      creator: "",
      timestamp: entry.timestamp,
      entryPrice: entry.entryPrice ?? 0,
      entrySizeSol: entry.positionSizeSol ?? 0,
      marketCapSol: entry.marketCapSol ?? 0,
      volumeSol: entry.volumeSol ?? 0,
      buyCount: entry.buyCount ?? 0,
      sellCount: entry.sellCount ?? 0,
      uniqueBuyers: entry.uniqueBuyers ?? 0,
      bondingCurveProgress: entry.bondingCurveProgress ?? 0,
      tokenAgeSec: 30, // Not stored in journal, default 30s
      signalScore: entry.signalScore ?? 0,
      llmScore: entry.llmScore ?? 0,
      llmNarrative: entry.llmNarrative ?? "",
      llmConfidence: entry.llmConfidence ?? 0,
      marketRegime: entry.marketRegime ?? "unknown",
      creatorReputation: entry.creatorReputation ?? 0,
      spamLaunch: !!(entry as any).spamLaunchCount,
      spamLaunchCount: (entry as any).spamLaunchCount ?? 0,
      whaleCount: (entry as any).whaleCount ?? 0,
      whaleVolumeSol: (entry as any).whaleVolumeSol ?? 0,
      socialScore: (entry as any).socialScore ?? 0,
      socialFirstMover: !!(entry as any).socialFirstMover,
      socialCompetingCoins: (entry as any).socialCompetingCoins ?? 0,
      socialXTweets: (entry as any).socialXTweets ?? 0,
      socialViralMeme: !!(entry as any).socialViralMeme,
      smartMoneyRank: (entry as any).smartMoneyRank ?? 0,
      smartMoneyWinRate: (entry as any).smartMoneyWinRate ?? 0,
      exitTimestamp: entry.timestamp,
      exitPrice: entry.exitPrice ?? 0,
      exitReason: entry.exitReason ?? "unknown",
      holdTimeSec: entry.holdTimeSec ?? 0,
      peakPrice: entry.peakPrice ?? 0,
      peakPnlPct: entry.peakPnlPct ?? 0,
      pnlSol: entry.pnlSol ?? 0,
      pnlPct: entry.pnlPct ?? 0,
      outcome,
      featureText: "",
      liveEligible: entry.liveEligible,
      liveFilterFailReasons: entry.liveFilterFailReasons,
      entryTxSignature: entry.entryTxSignature,
      exitTxSignatures: entry.exitTxSignatures,
    };

    record.featureText = buildFeatureText({
      symbol: record.symbol,
      name: record.name,
      llmNarrative: record.llmNarrative,
      marketCapSol: record.marketCapSol,
      volumeSol: record.volumeSol,
      buyCount: record.buyCount,
      sellCount: record.sellCount,
      uniqueBuyers: record.uniqueBuyers,
      bondingCurveProgress: record.bondingCurveProgress,
      tokenAgeSec: record.tokenAgeSec,
      signalScore: record.signalScore,
      marketRegime: record.marketRegime,
      creatorReputation: record.creatorReputation,
      exitReason: record.exitReason,
      pnlPct: record.pnlPct,
      holdTimeSec: record.holdTimeSec,
      spamLaunchCount: record.spamLaunchCount,
      socialScore: record.socialScore,
      socialFirstMover: record.socialFirstMover,
      socialCompetingCoins: record.socialCompetingCoins,
      socialXTweets: record.socialXTweets,
      socialViralMeme: record.socialViralMeme,
      smartMoneyRank: record.smartMoneyRank,
      smartMoneyWinRate: record.smartMoneyWinRate,
      whaleCount: record.whaleCount,
      whaleVolumeSol: record.whaleVolumeSol,
    });

    return record;
  }

  private async fetchTokenDetails(mint: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${PUMP_API_BASE}/coins/${mint}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
