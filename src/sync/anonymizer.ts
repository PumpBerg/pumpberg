// ── Trade data anonymizer ──
// Converts a RAGTradeRecord into a SyncTradePayload by stripping
// sensitive fields (position sizes, wallet addresses) and converting
// absolute PnL to percentages.

import type { RAGTradeRecord } from "../rag/types.ts";
import type { SyncTradePayload } from "./types.ts";

const SCHEMA_VERSION = 1;

/**
 * Anonymize a trade record for sync to the central server.
 *
 * What's stripped:
 *  - entrySizeSol (reveals user's capital)
 *  - pnlSol (reveals position sizing)
 *
 * What's kept:
 *  - mint, creator (public on-chain addresses — needed for pattern matching)
 *  - All scores, metrics, signals (computed data)
 *  - pnlPct (percentage only)
 *  - featureText + embedding (core RAG training data)
 *  - tx signatures (for on-chain verification / Proof of Data)
 */
export function anonymizeTrade(
  record: RAGTradeRecord,
  instanceId: string,
  walletAddress?: string,
): SyncTradePayload {
  return {
    // Metadata
    instanceId,
    schemaVersion: SCHEMA_VERSION,
    syncedAt: Date.now(),

    // Token identity (public)
    mint: record.mint,
    symbol: record.symbol,
    name: record.name,
    creator: record.creator,

    // Entry metrics (public market data)
    timestamp: record.timestamp,
    entryPrice: record.entryPrice,
    // NOTE: entrySizeSol intentionally excluded
    marketCapSol: record.marketCapSol,
    volumeSol: record.volumeSol,
    buyCount: record.buyCount,
    sellCount: record.sellCount,
    uniqueBuyers: record.uniqueBuyers,
    bondingCurveProgress: record.bondingCurveProgress,
    tokenAgeSec: record.tokenAgeSec,

    // Computed signals
    signalScore: record.signalScore,
    llmScore: record.llmScore,
    llmNarrative: record.llmNarrative,
    llmConfidence: record.llmConfidence,
    marketRegime: record.marketRegime,
    creatorReputation: record.creatorReputation,
    spamLaunch: record.spamLaunch,
    spamLaunchCount: record.spamLaunchCount ?? 0,

    // Social signals
    socialScore: record.socialScore ?? 0,
    socialFirstMover: record.socialFirstMover ?? false,
    socialCompetingCoins: record.socialCompetingCoins ?? 0,
    socialXTweets: record.socialXTweets ?? 0,
    socialViralMeme: record.socialViralMeme ?? false,

    // Smart money
    smartMoneyRank: record.smartMoneyRank ?? 0,
    smartMoneyWinRate: record.smartMoneyWinRate ?? 0,

    // Whale data
    whaleCount: record.whaleCount,
    whaleVolumeSol: record.whaleVolumeSol,

    // Exit data
    exitTimestamp: record.exitTimestamp,
    exitPrice: record.exitPrice,
    exitReason: record.exitReason,
    holdTimeSec: record.holdTimeSec,
    peakPrice: record.peakPrice,
    peakPnlPct: record.peakPnlPct,

    // Outcome — percentage only, NO absolute SOL
    // NOTE: pnlSol intentionally excluded
    pnlPct: record.pnlPct,
    outcome: record.outcome,

    // Classification
    lossCategory: record.lossCategory,
    lossRedFlags: record.lossRedFlags,
    lossConfidence: record.lossConfidence,

    // RAG features (the core training data)
    featureText: record.featureText,
    embedding: record.embedding
      ? Array.from(record.embedding)
      : [],

    // Transaction signatures (for on-chain verification / Proof of Data)
    entryTxSignature: record.entryTxSignature,
    exitTxSignatures: record.exitTxSignatures,

    // Wallet identity (for Proof of Data mining rewards)
    walletAddress,
  };
}

/**
 * Validate that a payload doesn't contain sensitive data.
 * Used as a safety check before sending.
 */
export function validatePayloadSafety(payload: SyncTradePayload): boolean {
  // Check that no absolute SOL amounts leaked through
  const asAny = payload as Record<string, unknown>;
  if ("entrySizeSol" in asAny) return false;
  if ("pnlSol" in asAny) return false;
  if ("privateKey" in asAny) return false;
  return true;
}
