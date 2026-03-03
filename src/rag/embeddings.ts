// ── Embedding Service: local SBERT embeddings via @xenova/transformers ──
// Runs entirely on CPU, zero API cost. Uses all-MiniLM-L6-v2 (384-dim).
// Model is downloaded once on first use (~80MB), then cached locally.

import { logger } from "../logger.js";

// Lazy-loaded transformers pipeline
let pipeline: any = null;
let extractor: any = null;

/** Embedding dimension for all-MiniLM-L6-v2 */
export const EMBEDDING_DIM = 384;

export class EmbeddingService {
  private ready = false;
  private initializing = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the embedding model. Downloads on first run (~80MB).
   * Subsequent runs use cached model.
   */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    try {
      logger.system("RAG Embeddings: Loading local SBERT model (all-MiniLM-L6-v2)...");
      const { pipeline: pipelineFn } = await import("@xenova/transformers");
      pipeline = pipelineFn;

      // Create feature-extraction pipeline (sentence embeddings)
      extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true, // Use quantized model for speed
      });

      this.ready = true;
      logger.system("RAG Embeddings: Model loaded successfully (384-dim, quantized)");
    } catch (err) {
      logger.error("RAG", `Failed to load embedding model: ${err}`);
      this.initializing = false;
      this.initPromise = null;
      throw err;
    }
  }

  /**
   * Generate embedding for a single text string.
   * Returns a Float32Array of 384 dimensions.
   */
  async embed(text: string): Promise<Float32Array> {
    await this.init();
    if (!extractor) throw new Error("Embedding model not initialized");

    const output = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  /**
   * Generate embeddings for multiple texts in batch.
   * Processes in chunks to avoid memory spikes.
   */
  async embedBatch(texts: string[], batchSize = 32): Promise<Float32Array[]> {
    await this.init();
    if (!extractor) throw new Error("Embedding model not initialized");

    const results: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(texts.length / batchSize);

      if (totalBatches > 1) {
        logger.debug("RAG", `Embedding batch ${batchNum}/${totalBatches} (${batch.length} texts)`);
      }

      // Process each text in the batch
      for (const text of batch) {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        results.push(new Float32Array(output.data));
      }
    }

    return results;
  }

  isReady(): boolean {
    return this.ready;
  }
}

/**
 * Build a feature text description from trade data for embedding.
 * This text is what gets embedded — it captures the "signature" of a trade.
 */
export function buildFeatureText(params: {
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
  exitReason?: string;
  pnlPct?: number;
  holdTimeSec?: number;
  lossCategory?: string;
  // Enrichment signals (new)
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
}): string {
  const buyRatio = params.buyCount / Math.max(1, params.buyCount + params.sellCount);
  const mcapBucket = params.marketCapSol < 5 ? "micro"
    : params.marketCapSol < 20 ? "small"
    : params.marketCapSol < 50 ? "medium"
    : params.marketCapSol < 100 ? "large"
    : "whale";

  const parts: string[] = [
    `Token ${params.symbol} "${params.name}"`,
    `narrative:${params.llmNarrative}`,
    `mcap:${mcapBucket}(${params.marketCapSol.toFixed(1)}SOL)`,
    `volume:${params.volumeSol.toFixed(1)}SOL`,
    `buyers:${params.uniqueBuyers} buys:${params.buyCount} sells:${params.sellCount}`,
    `buyRatio:${(buyRatio * 100).toFixed(0)}%`,
    `curve:${(params.bondingCurveProgress * 100).toFixed(0)}%`,
    `age:${params.tokenAgeSec.toFixed(0)}s`,
    `score:${params.signalScore}`,
    `regime:${params.marketRegime}`,
    `creator:${params.creatorReputation > 0 ? "positive" : params.creatorReputation < 0 ? "negative" : "unknown"}`,
  ];

  // NOTE: exitReason, pnlPct, holdTimeSec, lossCategory are intentionally excluded.
  // Including them causes a structural mismatch: stored texts have these fields but
  // query candidates don't, making SBERT embeddings compare apples to oranges.
  // Risk scoring now uses numeric feature similarity instead of SBERT embeddings.

  // Enrichment signals — these help the embedding distinguish winners from losers
  if (params.spamLaunchCount && params.spamLaunchCount >= 3) parts.push(`spam:${params.spamLaunchCount}copies`);
  if (params.whaleCount) parts.push(`whales:${params.whaleCount}(${(params.whaleVolumeSol ?? 0).toFixed(1)}SOL)`);
  if (params.socialScore !== undefined && params.socialScore > 0) parts.push(`social:${params.socialScore}`);
  if (params.socialFirstMover) parts.push(`firstMover`);
  if (params.socialViralMeme) parts.push(`viralMeme`);
  if (params.socialXTweets && params.socialXTweets > 0) parts.push(`tweets:${params.socialXTweets}`);
  if (params.socialCompetingCoins && params.socialCompetingCoins > 0) parts.push(`competitors:${params.socialCompetingCoins}`);
  if (params.smartMoneyRank && params.smartMoneyRank > 0) parts.push(`smartMoney:rank${params.smartMoneyRank}(wr:${((params.smartMoneyWinRate ?? 0) * 100).toFixed(0)}%)`);

  return parts.join(" | ");
}
