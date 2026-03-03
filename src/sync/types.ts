// ── Sync payload types ──
// Defines the anonymized trade data format sent to the central server.
// Sensitive fields (wallet addresses, position sizes in SOL) are stripped.

export interface SyncTradePayload {
  // ── Metadata ──
  instanceId: string;       // Anonymous UUID of the sender
  schemaVersion: number;    // Schema version for compatibility
  syncedAt: number;         // Timestamp of sync (ms)

  // ── Token identity (public on-chain data) ──
  mint: string;
  symbol: string;
  name: string;
  creator: string;

  // ── Entry metrics (public market data) ──
  timestamp: number;        // Entry timestamp
  entryPrice: number;
  marketCapSol: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  tokenAgeSec: number;

  // ── Computed signals ──
  signalScore: number;
  llmScore: number;
  llmNarrative: string;
  llmConfidence: number;
  marketRegime: string;
  creatorReputation: number;
  spamLaunch: boolean;
  spamLaunchCount: number;

  // ── Social signals ──
  socialScore: number;
  socialFirstMover: boolean;
  socialCompetingCoins: number;
  socialXTweets: number;
  socialViralMeme: boolean;

  // ── Smart money ──
  smartMoneyRank: number;
  smartMoneyWinRate: number;

  // ── Whale data ──
  whaleCount: number;
  whaleVolumeSol: number;

  // ── Exit data ──
  exitTimestamp: number;
  exitPrice: number;
  exitReason: string;
  holdTimeSec: number;
  peakPrice: number;
  peakPnlPct: number;

  // ── Outcome (percentages only — no absolute SOL amounts) ──
  pnlPct: number;
  outcome: "win" | "loss" | "neutral";

  // ── Classification ──
  lossCategory?: string;
  lossRedFlags?: string[];
  lossConfidence?: number;

  // ── Transaction signatures (for on-chain verification) ──
  entryTxSignature?: string;
  exitTxSignatures?: string[];

  // ── Wallet identity (for Proof of Data mining) ──
  walletAddress?: string;

  // ── RAG features ──
  featureText: string;
  embedding: number[];      // 384-dim float array
}

/** Batch sync request */
export interface SyncBatchRequest {
  instanceId: string;
  schemaVersion: number;
  trades: SyncTradePayload[];
}

/** Batch sync response */
export interface SyncBatchResponse {
  ok: boolean;
  accepted: number;
  rejected: number;
  errors?: string[];
  /** Server's current pattern version (so client knows when to pull updates) */
  patternVersion?: number;
}

/** Pattern update from central server */
export interface PatternUpdate {
  version: number;
  patterns: Array<{
    category: string;
    description: string;
    redFlags: string[];
    avoidanceRule: string;
    confidence: number;
    sampleCount: number;
  }>;
  vetoThreshold: number;
  updatedAt: number;
}

/** Local sync state — persisted to data/sync-state.json */
export interface SyncState {
  lastSyncedId: string;     // ID of last successfully synced trade
  lastSyncedAt: number;     // Timestamp of last sync
  pendingCount: number;     // Trades queued but not yet synced
  totalSynced: number;      // Lifetime count of synced trades
  patternVersion: number;   // Currently installed pattern version
  consecutiveFailures: number;
}
