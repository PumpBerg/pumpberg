// ── RAG Types: data structures for the embedding-enhanced RAG pipeline ──

/** A fully-resolved trade record stored in the RAG SQLite database */
export interface RAGTradeRecord {
  /** Unique ID (timestamp-mint prefix) */
  id: string;
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  /** Trade entry timestamp (ms) */
  timestamp: number;

  // ── Entry metrics ──
  entryPrice: number;
  entrySizeSol: number;
  marketCapSol: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  tokenAgeSec: number;

  // ── Signals at entry ──
  signalScore: number;
  llmScore: number;
  llmNarrative: string;
  llmConfidence: number;
  marketRegime: string;
  creatorReputation: number;
  spamLaunch: boolean;
  spamLaunchCount: number;
  whaleCount: number;
  whaleVolumeSol: number;

  // ── Social signal (from social-scanner at entry) ──
  socialScore: number;
  socialFirstMover: boolean;
  socialCompetingCoins: number;
  socialXTweets: number;
  socialViralMeme: boolean;

  // ── Smart money signal (if top wallet triggered entry) ──
  smartMoneyRank: number;
  smartMoneyWinRate: number;

  // ── Exit data ──
  exitTimestamp: number;
  exitPrice: number;
  exitReason: string;
  holdTimeSec: number;
  peakPrice: number;
  peakPnlPct: number;

  // ── Outcome ──
  pnlSol: number;
  pnlPct: number;
  outcome: "win" | "loss" | "neutral";

  // ── Classification (filled by batch LLM or heuristic) ──
  lossCategory?: string;
  lossRedFlags?: string[];
  lossConfidence?: number;

  // ── Transaction signatures (for on-chain verification) ──
  entryTxSignature?: string;
  exitTxSignatures?: string[];

  // ── RAG fields ──
  /** Stringified feature description for embedding */
  featureText: string;
  /** Embedding vector (serialized to BLOB in SQLite) */
  embedding?: Float32Array;

  // ── Live eligibility tracking ──
  /** Would this trade have passed live-mode quality gates? */
  liveEligible?: boolean;
  /** Which gates failed, e.g. ["uniqueBuyers=3<5"] */
  liveFilterFailReasons?: string[];
}

/** Result of a RAG similarity query */
export interface RAGMatch {
  record: RAGTradeRecord;
  /** Cosine similarity score (0-1) */
  similarity: number;
  /** Which features contributed to the match */
  matchReasons: string[];
}

/** Loss pattern discovered from batch analysis */
export interface LossPattern {
  /** Category name (e.g. "creator_dump", "honeypot", "whale_exit") */
  category: string;
  /** Human-readable description */
  description: string;
  /** Red flag indicators */
  signals: string[];
  /** What percentage of total losses match this pattern */
  frequency: number;
  /** Rules to avoid this pattern */
  avoidanceRules: string[];
  /** Confidence in this pattern (0-1) */
  confidence: number;
  /** Number of trades that match this pattern */
  tradeCount: number;
  /** Last updated timestamp */
  updatedAt: number;
}

/** Stats about the RAG database */
export interface RAGStats {
  totalRecords: number;
  totalWins: number;
  totalLosses: number;
  withEmbeddings: number;
  withLossCategory: number;
  oldestRecord: number;
  newestRecord: number;
  lossPatterns: number;
}

/** Batch analysis request for LLM categorization */
export interface BatchAnalysisItem {
  id: string;
  symbol: string;
  name: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  exitReason: string;
  holdTimeSec: number;
  peakPnlPct: number;
  marketCapSol: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  llmNarrative: string;
  creatorReputation: number;
  signalScore: number;
}

/** Result from batch LLM loss categorization */
export interface BatchCategoryResult {
  id: string;
  category: string;
  redFlags: string[];
  confidence: number;
}
