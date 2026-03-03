// ── LLM-powered token analysis using Anthropic Claude ──

import { logger } from "./logger.js";
import { thinkingLog } from "./thinking.js";
import type { TokenMetrics } from "./types.js";
import type { MarketRegime } from "./market-regime.js";
import { getCompactExpertKnowledge } from "./pump-fun-knowledge.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-3-haiku-20240307"; // Haiku for fast/cheap per-token scoring
const MAX_TOKENS = 150; // Response is a single JSON line — 150 tokens is plenty
const TIMEOUT_MS = 8_000; // Max 8s — we need speed

export interface LLMAnalysis {
  /** 0-100 score from the LLM */
  score: number;
  /** Short reasoning (1-2 sentences) */
  reasoning: string;
  /** Key factors identified */
  factors: string[];
  /** Confidence in the assessment (0-1) */
  confidence: number;
  /** Detected narrative/category */
  narrative: string;
  /** Time taken in ms */
  latencyMs: number;
  /** Whether the LLM call succeeded */
  success: boolean;
}

const DEFAULT_ANALYSIS: LLMAnalysis = {
  score: 50,
  reasoning: "LLM analysis unavailable — using heuristic score only",
  factors: [],
  confidence: 0,
  narrative: "unknown",
  latencyMs: 0,
  success: false,
};

/**
 * Analyzes tokens using Claude to assess meme quality, narrative strength,
 * and overall buy-worthiness. Designed to be fast (< 8s) and non-blocking.
 */
export class LLMAnalyzer {
  private apiKey: string;
  private enabled: boolean;
  private callCount = 0;
  private avgLatencyMs = 0;
  /** Cache recent analyses to avoid duplicate calls (by mint) */
  private cache = new Map<string, { analysis: LLMAnalysis; timestamp: number }>();
  private readonly cacheTtlMs = 300_000; // 5 min cache (extended from 2min to reduce API calls)
  /** Name-based cache — avoids re-scoring identical token names (e.g. "FREN" appears 10x/min) */
  private nameCache = new Map<string, { analysis: LLMAnalysis; timestamp: number }>();
  private readonly nameCacheTtlMs = 180_000; // 3 min name cache (extended from 1min)

  // ── Concurrency limiter — prevent OOM from hundreds of concurrent API calls ──
  private readonly maxConcurrent = 8; // Max 8 parallel Haiku calls
  private activeCalls = 0;
  private waitQueue: Array<() => void> = [];

  /** Acquire a concurrency slot (blocks if at limit) */
  private async acquireSlot(): Promise<void> {
    if (this.activeCalls < this.maxConcurrent) {
      this.activeCalls++;
      return;
    }
    // Queue up and wait for a slot to open
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeCalls++;
        resolve();
      });
    });
  }

  /** Release a concurrency slot, letting the next queued call proceed */
  private releaseSlot(): void {
    this.activeCalls--;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      next();
    }
  }

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
    this.enabled = !!this.apiKey;

    if (this.enabled) {
      logger.info("LLM", `Claude analyzer enabled (model: ${MODEL})`);
    } else {
      logger.warn("LLM", "No ANTHROPIC_API_KEY found — LLM analysis disabled. Set ANTHROPIC_API_KEY in .env to enable.");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStats(): { enabled: boolean; calls: number; avgLatencyMs: number } {
    return { enabled: this.enabled, calls: this.callCount, avgLatencyMs: Math.round(this.avgLatencyMs) };
  }

  /** Optional RAG context injector — set by scanner after TradeRAG is created */
  ragContextFn?: (candidate: {
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
  }) => string;

  /**
   * Analyze a token using Claude.
   * Returns a score (0-100), reasoning, and narrative category.
   * Falls back to default (neutral) if the API is unavailable or slow.
   */
  async analyze(
    metrics: TokenMetrics,
    creatorReputation: number,
    creatorLaunchCount: number,
    marketRegime: MarketRegime,
    recentWinners: string[],
  ): Promise<LLMAnalysis> {
    if (!this.enabled) return { ...DEFAULT_ANALYSIS };

    // Check mint-based cache
    const cached = this.cache.get(metrics.mint);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.analysis;
    }

    // Check name-based cache ("FREN" appears 10+ times/min with different mints)
    const nameKey = `${metrics.name}|${metrics.symbol}`.toLowerCase();
    const nameCached = this.nameCache.get(nameKey);
    if (nameCached && Date.now() - nameCached.timestamp < this.nameCacheTtlMs) {
      // Reuse the cached analysis but also store under this mint
      this.cache.set(metrics.mint, nameCached);
      return nameCached.analysis;
    }

    const startTime = Date.now();

    // ── Concurrency gate: wait for a slot to prevent OOM from flooding API ──
    // If queue is too deep, skip this token entirely (too much backlog = stale data)
    if (this.waitQueue.length > 20) {
      logger.debug("LLM", `Skipping ${metrics.symbol}: queue backlog ${this.waitQueue.length}`);
      return { ...DEFAULT_ANALYSIS };
    }
    await this.acquireSlot();

    try {
      // Build RAG context if available
      let ragContext = "";
      if (this.ragContextFn) {
        try {
          ragContext = this.ragContextFn({
            marketCapSol: metrics.marketCapSol,
            recentVolumeSol: metrics.recentVolumeSol,
            buyCount: metrics.buyCount,
            sellCount: metrics.sellCount,
            uniqueBuyers: metrics.uniqueBuyers.size,
            bondingCurveProgress: metrics.bondingCurveProgress,
            ageSec: (Date.now() - metrics.createdAt) / 1000,
            marketRegime: marketRegime,
            creatorReputation,
            signalScore: 0, // Not available yet at this stage
          });
        } catch (err) {
          logger.warn("LLM", `RAG context failed: ${err}`);
        }
      }

      const prompt = this.buildPrompt(metrics, creatorReputation, creatorLaunchCount, marketRegime, recentWinners, ragContext);
      const response = await this.callClaude(prompt);
      const analysis = this.parseResponse(response, Date.now() - startTime);

      // Update stats
      this.callCount++;
      this.avgLatencyMs = (this.avgLatencyMs * (this.callCount - 1) + analysis.latencyMs) / this.callCount;

      // Cache result (by both mint and name)
      const cacheEntry = { analysis, timestamp: Date.now() };
      this.cache.set(metrics.mint, cacheEntry);
      this.nameCache.set(nameKey, cacheEntry);

      // Log to thinking
      thinkingLog.add({
        mint: metrics.mint,
        symbol: metrics.symbol,
        type: "evaluation",
        decision: `LLM: ${analysis.score}/100 — ${analysis.narrative}`,
        reasoning: [
          `Claude analysis (${analysis.latencyMs}ms):`,
          analysis.reasoning,
          `Factors: ${analysis.factors.join(", ")}`,
          `Confidence: ${(analysis.confidence * 100).toFixed(0)}%`,
          `Narrative: ${analysis.narrative}`,
        ],
      });

      logger.debug("LLM", `${metrics.symbol}: score=${analysis.score} narrative="${analysis.narrative}" (${analysis.latencyMs}ms)`);
      return analysis;
    } catch (err) {
      const latency = Date.now() - startTime;
      logger.error("LLM", `Analysis failed for ${metrics.symbol} (${latency}ms): ${err}`);
      return { ...DEFAULT_ANALYSIS, latencyMs: latency };
    } finally {
      this.releaseSlot();
    }
  }

  private buildPrompt(
    metrics: TokenMetrics,
    creatorReputation: number,
    creatorLaunchCount: number,
    regime: MarketRegime,
    recentWinners: string[],
    ragContext = "",
  ): string {
    const ageSec = ((Date.now() - metrics.createdAt) / 1_000).toFixed(0);
    const buyRatio = metrics.buyCount / Math.max(1, metrics.sellCount);

    return `You are a pump.fun memecoin analyst. Evaluate this new token and rate its potential (0-100).

TOKEN DATA:
- Name: "${metrics.name}"
- Symbol: $${metrics.symbol}
- Age: ${ageSec}s
- Market Cap: ${metrics.marketCapSol.toFixed(2)} SOL
- Volume (60s): ${metrics.recentVolumeSol.toFixed(2)} SOL
- Buys/Sells: ${metrics.buyCount}/${metrics.sellCount} (ratio: ${buyRatio.toFixed(1)})
- Unique Buyers: ${metrics.uniqueBuyers.size}
- Unique Sellers: ${metrics.uniqueSellers.size}
- Dev Wallet Sold: ${metrics.devHasSold ? "YES ⚠️" : "no"}
- Bonding Curve: ${(metrics.bondingCurveProgress * 100).toFixed(0)}%

CREATOR INFO:
- Creator reputation: ${creatorReputation} (negative = known rugger)
- Creator's past launches: ${creatorLaunchCount}

MARKET CONDITIONS:
- Market regime: ${regime}
${recentWinners.length > 0 ? `- Recent winning tokens: ${recentWinners.join(", ")}` : "- No recent winners tracked"}
${ragContext}
${getCompactExpertKnowledge()}
EVALUATE:
1. Name/Symbol appeal — Is it catchy, meme-worthy, or trending? Optimal symbol length is 4-6 chars.
2. Early metrics quality — Are the buy patterns organic or wash-traded? Multiple unique buyers is key.
3. Rug risk — Any red flags from creator history, dev selling, or concentration?
4. Narrative fit — Does this token fit current market trends? Strong narratives survive dumps.
5. HISTORICAL COMPARISON — If historical pattern data is provided above, factor it in but DON'T let all-losses history prevent you from scoring a fundamentally good token highly. Past losses show what failed — if THIS token is different, score it on its own merits.

Respond ONLY in this exact JSON format (no markdown, no explanation):
{"score":NUMBER_0_100,"reasoning":"SHORT_SENTENCE","factors":["FACTOR1","FACTOR2","FACTOR3"],"confidence":NUMBER_0_TO_1,"narrative":"CATEGORY"}

Narrative categories: ai, animal, political, celebrity, food, abstract, meta, trend, random, controversial
Score guide: 0-30 = likely rug/trash, 31-50 = weak, 51-70 = moderate, 71-85 = strong, 86-100 = exceptional`;
  }

  /** Strip lone surrogates that break JSON serialization (common in pump.fun token names with emoji) */
  private static sanitize(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  }

  private async callClaude(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Sanitize to remove lone surrogates that produce invalid JSON
    const safePrompt = LLMAnalyzer.sanitize(prompt);

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: 0.3, // Low temperature for consistent scoring
          messages: [{ role: "user", content: safePrompt }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = (await res.json()) as { content: Array<{ text: string }> };
      return data.content?.[0]?.text ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(raw: string, latencyMs: number): LLMAnalysis {
    try {
      // Extract JSON from response (Claude sometimes wraps it)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");

      const parsed = JSON.parse(jsonMatch[0]) as {
        score?: number;
        reasoning?: string;
        factors?: string[];
        confidence?: number;
        narrative?: string;
      };

      return {
        score: Math.max(0, Math.min(100, parsed.score ?? 50)),
        reasoning: parsed.reasoning ?? "No reasoning provided",
        factors: Array.isArray(parsed.factors) ? parsed.factors.slice(0, 5) : [],
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
        narrative: parsed.narrative ?? "unknown",
        latencyMs,
        success: true,
      };
    } catch (err) {
      logger.error("LLM", `Failed to parse LLM response: ${err}. Raw: ${raw.slice(0, 200)}`);
      return { ...DEFAULT_ANALYSIS, latencyMs };
    }
  }

  /** Clean up old cache entries */
  pruneCache(): void {
    const now = Date.now();
    for (const [mint, entry] of this.cache) {
      if (now - entry.timestamp > this.cacheTtlMs) {
        this.cache.delete(mint);
      }
    }
    for (const [name, entry] of this.nameCache) {
      if (now - entry.timestamp > this.nameCacheTtlMs) {
        this.nameCache.delete(name);
      }
    }
  }
}
