// ── Batch Processor: periodic LLM-based loss categorization ──
// Runs on a schedule (daily or on-demand) to analyze uncategorized losses.
// Uses Claude Haiku for cost efficiency (~$0.15 per 50 trades).
// Batches trades to minimize API calls.

import { logger } from "../logger.js";
import { RAGDatabase } from "./database.js";
import { EmbeddingService, buildFeatureText } from "./embeddings.js";
import type { RAGTradeRecord, BatchAnalysisItem, BatchCategoryResult, LossPattern } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL_CHEAP = "claude-3-haiku-20240307"; // Haiku: ~$0.15 per 50 trades
const BATCH_SIZE = 50;
const MAX_TOKENS = 2000;
const TIMEOUT_MS = 60_000;

export class BatchProcessor {
  private apiKey: string;

  constructor(
    private db: RAGDatabase,
    private embedder: EmbeddingService,
    apiKey?: string,
  ) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Run full batch pipeline ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Process all pending work:
   * 1. Generate embeddings for any records missing them (free, local)
   * 2. Categorize uncategorized losses (LLM, costs ~$0.15 per batch of 50)
   * 3. Update loss pattern database
   */
  async runFullBatch(): Promise<{ embedded: number; categorized: number; patternsUpdated: number }> {
    logger.system("RAG Batch: Starting full batch processing...");

    // Step 1: Embeddings for records that don't have them (FREE)
    const embedded = await this.generateMissingEmbeddings();

    // Step 2: Categorize uncategorized losses (LLM cost)
    let categorized = 0;
    if (this.apiKey) {
      categorized = await this.categorizeLosses();
    } else {
      // Fallback: heuristic categorization (free)
      categorized = this.categorizeHeuristic();
    }

    // Step 3: Update loss pattern summary
    const patternsUpdated = this.updateLossPatterns();

    logger.system(
      `RAG Batch: ✅ Complete — ${embedded} embedded, ${categorized} categorized, ${patternsUpdated} patterns updated`,
    );

    return { embedded, categorized, patternsUpdated };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Step 1: Generate missing embeddings (FREE) ──
  // ══════════════════════════════════════════════════════════════════════════

  async generateMissingEmbeddings(): Promise<number> {
    const records = this.db.getTradesWithoutEmbeddings(200);
    if (records.length === 0) return 0;

    logger.info("RAG-BATCH", `Generating embeddings for ${records.length} records (local, free)`);

    const texts = records.map((r) => r.featureText || buildDefaultFeatureText(r));
    const embeddings = await this.embedder.embedBatch(texts);

    const updates = records.map((r, i) => ({ id: r.id, embedding: embeddings[i] }));
    this.db.updateEmbeddingBatch(updates);

    logger.info("RAG-BATCH", `✅ Generated ${records.length} embeddings`);
    return records.length;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Step 2: Categorize losses with LLM (Haiku, batched) ──
  // ══════════════════════════════════════════════════════════════════════════

  async categorizeLosses(): Promise<number> {
    const uncategorized = this.db.getTradesWithoutCategory(200);
    if (uncategorized.length === 0) return 0;

    logger.info("RAG-BATCH", `Categorizing ${uncategorized.length} losses with Claude Haiku`);
    let totalCategorized = 0;

    for (let i = 0; i < uncategorized.length; i += BATCH_SIZE) {
      const batch = uncategorized.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(uncategorized.length / BATCH_SIZE);

      logger.info("RAG-BATCH", `Processing batch ${batchNum}/${totalBatches} (${batch.length} trades)`);

      try {
        const results = await this.callLLMForCategories(batch);
        for (const result of results) {
          this.db.updateLossCategory(result.id, result.category, result.redFlags, result.confidence);
          totalCategorized++;
        }
      } catch (err) {
        logger.error("RAG-BATCH", `Batch ${batchNum} failed: ${err}`);
      }
    }

    logger.info("RAG-BATCH", `✅ Categorized ${totalCategorized} losses`);
    return totalCategorized;
  }

  /**
   * Fallback: categorize losses using heuristics (no LLM, free).
   * Less accurate but useful when no API key is available.
   */
  categorizeHeuristic(): number {
    const uncategorized = this.db.getTradesWithoutCategory(500);
    if (uncategorized.length === 0) return 0;

    let count = 0;
    for (const trade of uncategorized) {
      const { category, redFlags, confidence } = this.heuristicClassify(trade);
      this.db.updateLossCategory(trade.id, category, redFlags, confidence);
      count++;
    }

    logger.info("RAG-BATCH", `✅ Heuristic-categorized ${count} losses`);
    return count;
  }

  private heuristicClassify(trade: RAGTradeRecord): {
    category: string;
    redFlags: string[];
    confidence: number;
  } {
    const redFlags: string[] = [];

    // Stagnation: exited due to no volume
    if (trade.exitReason === "stagnation" || trade.exitReason === "volume-death") {
      redFlags.push("low_volume_at_exit");
      if (trade.uniqueBuyers < 3) redFlags.push("few_buyers");
      return { category: "stagnation", redFlags, confidence: 0.85 };
    }

    // Stop loss: fast price drop
    if (trade.exitReason === "stop-loss") {
      if (trade.holdTimeSec < 15) {
        redFlags.push("instant_dump");
        if (trade.creatorReputation < 0) redFlags.push("bad_creator");
        return { category: "instant_dump", redFlags, confidence: 0.70 };
      }

      if (trade.peakPnlPct > 0.05) {
        redFlags.push("peaked_then_crashed");
        return { category: "hype_fizzle", redFlags, confidence: 0.65 };
      }

      if (trade.sellCount > trade.buyCount * 2) {
        redFlags.push("heavy_sell_pressure");
        return { category: "whale_dump", redFlags, confidence: 0.60 };
      }

      redFlags.push("general_stop_loss");
      return { category: "slow_bleed", redFlags, confidence: 0.50 };
    }

    // Sell pressure exit
    if (trade.exitReason === "sell-pressure") {
      redFlags.push("sell_pressure_triggered");
      return { category: "whale_dump", redFlags, confidence: 0.60 };
    }

    // Default
    redFlags.push("unclassified");
    return { category: "unknown", redFlags, confidence: 0.30 };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Step 3: Update loss pattern database ──
  // ══════════════════════════════════════════════════════════════════════════

  updateLossPatterns(): number {
    const losses = this.db.getTradesByOutcome("loss", 500);
    const categorized = losses.filter((l) => l.lossCategory);

    if (categorized.length === 0) return 0;

    // Group by category
    const groups = new Map<string, RAGTradeRecord[]>();
    for (const loss of categorized) {
      const cat = loss.lossCategory!;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(loss);
    }

    const now = Date.now();
    let patternsUpdated = 0;

    for (const [category, trades] of groups) {
      // Aggregate red flags
      const allFlags = new Map<string, number>();
      for (const t of trades) {
        for (const flag of t.lossRedFlags ?? []) {
          allFlags.set(flag, (allFlags.get(flag) ?? 0) + 1);
        }
      }
      const topFlags = [...allFlags.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([f]) => f);

      // Generate avoidance rules
      const rules = this.generateAvoidanceRules(category, trades);

      const pattern: LossPattern = {
        category,
        description: this.getCategoryDescription(category),
        signals: topFlags,
        frequency: categorized.length > 0 ? trades.length / categorized.length : 0,
        avoidanceRules: rules,
        confidence: trades.reduce((s, t) => s + (t.lossConfidence ?? 0.5), 0) / trades.length,
        tradeCount: trades.length,
        updatedAt: now,
      };

      this.db.upsertLossPattern(pattern);
      patternsUpdated++;
    }

    logger.info("RAG-BATCH", `✅ Updated ${patternsUpdated} loss patterns`);
    return patternsUpdated;
  }

  private getCategoryDescription(category: string): string {
    const descriptions: Record<string, string> = {
      stagnation: "Token had no trading activity — died on the vine",
      instant_dump: "Price crashed within seconds of creation (likely rug or honeypot)",
      hype_fizzle: "Token peaked quickly then lost momentum",
      whale_dump: "Large holder(s) sold their position causing price crash",
      slow_bleed: "Gradual price decline with no recovery",
      creator_dump: "Token creator sold their holdings",
      honeypot: "Unable to sell — contract may be malicious",
      spam: "Coordinated multi-mint launch with no real demand",
      unknown: "Loss reason not yet determined",
    };
    return descriptions[category] ?? `Loss category: ${category}`;
  }

  private generateAvoidanceRules(category: string, trades: RAGTradeRecord[]): string[] {
    const rules: string[] = [];

    const avgBuyers = trades.reduce((s, t) => s + t.uniqueBuyers, 0) / trades.length;
    const avgMcap = trades.reduce((s, t) => s + t.marketCapSol, 0) / trades.length;
    const avgScore = trades.reduce((s, t) => s + t.signalScore, 0) / trades.length;
    const avgVolume = trades.reduce((s, t) => s + t.volumeSol, 0) / trades.length;

    switch (category) {
      case "stagnation":
        rules.push(`Avoid tokens with < ${Math.ceil(avgBuyers)} unique buyers at entry`);
        rules.push(`Require minimum volume of ${avgVolume.toFixed(2)} SOL`);
        break;
      case "instant_dump":
        rules.push(`Be cautious with tokens < ${avgMcap.toFixed(1)} SOL mcap`);
        rules.push("Check creator reputation before entering");
        break;
      case "hype_fizzle":
        rules.push("Set tighter take-profit targets for tokens showing early peak");
        rules.push(`Average signal score for fizzles: ${avgScore.toFixed(0)} — raise minimum`);
        break;
      case "whale_dump":
        rules.push("Monitor whale positions — if top holder > 5x your size, be cautious");
        rules.push("Set trailing stop loss when whales are active");
        break;
      case "slow_bleed":
        rules.push("Tighter stagnation timer may help exit earlier");
        break;
    }

    return rules;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── LLM Integration ──
  // ══════════════════════════════════════════════════════════════════════════

  private async callLLMForCategories(trades: RAGTradeRecord[]): Promise<BatchCategoryResult[]> {
    const items: BatchAnalysisItem[] = trades.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      name: t.name,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnlPct: t.pnlPct,
      exitReason: t.exitReason,
      holdTimeSec: t.holdTimeSec,
      peakPnlPct: t.peakPnlPct,
      marketCapSol: t.marketCapSol,
      volumeSol: t.volumeSol,
      buyCount: t.buyCount,
      sellCount: t.sellCount,
      uniqueBuyers: t.uniqueBuyers,
      bondingCurveProgress: t.bondingCurveProgress,
      llmNarrative: t.llmNarrative,
      creatorReputation: t.creatorReputation,
      signalScore: t.signalScore,
    }));

    const prompt = `You are analyzing ${items.length} losing meme coin trades from pump.fun to categorize WHY each lost.

TRADES:
${JSON.stringify(items, null, 1)}

For each trade, classify into one of these categories:
- stagnation: No volume, token died
- instant_dump: Price crashed within seconds (rug/honeypot)
- hype_fizzle: Peaked quickly then lost momentum
- whale_dump: Large holder(s) dumped
- slow_bleed: Gradual decline
- creator_dump: Creator sold their tokens
- honeypot: Can buy but can't sell
- spam: Coordinated multi-mint scam
- unknown: Can't determine

Respond with ONLY a JSON array (no markdown, no explanation):
[{"id":"...","category":"...","redFlags":["flag1","flag2"],"confidence":0.0-1.0}]`;

    const body = {
      model: MODEL_CHEAP,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as any;
      const content = data.content?.[0]?.text ?? "";

      // Parse JSON response — handle potential markdown wrapping + LLM JSON quirks
      let jsonStr = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      // Repair common LLM JSON mistakes:
      // 1. Trailing commas before } or ]
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");
      // 2. Single-quoted strings → double-quoted
      jsonStr = jsonStr.replace(/(?<=[\[{,]\s*)'([^']+)'(?=\s*:)/g, '"$1"');
      // 3. JavaScript-style comments
      jsonStr = jsonStr.replace(/\/\/[^\n]*/g, "");
      // 4. Extract array if there's text before/after it
      const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrMatch) jsonStr = arrMatch[0];

      const results: BatchCategoryResult[] = JSON.parse(jsonStr);

      return results;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
}

function buildDefaultFeatureText(record: RAGTradeRecord): string {
  return buildFeatureText({
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
    lossCategory: record.lossCategory,
  });
}
