// ── Market Intelligence: Historical pump.fun coin analysis ──
// Periodically fetches coin data from the pump.fun API to identify
// trending narratives, successful patterns, and market conditions.
// Provides actionable intelligence to the autonomous agent.

import { logger } from "./logger.js";

const PUMP_API_V3 = "https://frontend-api-v3.pump.fun";
const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 5 * 60_000; // Every 5 minutes
const MAX_COINS_PER_QUERY = 50;

// ── Types ──

export interface PumpCoinData {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  creator: string;
  created_timestamp: number;
  market_cap: number;
  usd_market_cap: number;
  virtual_sol_reserves: number;
  virtual_token_reserves: number;
  total_supply: number;
  complete: boolean; // graduated from bonding curve
  raydium_pool: string | null;
  reply_count: number;
  last_trade_timestamp: number;
  king_of_the_hill_timestamp: number | null;
  ath_market_cap: number;
  ath_market_cap_timestamp: number;
  program: string;
  is_currently_live: boolean;
  twitter?: string;
  website?: string;
  image_uri?: string;
}

export interface NarrativeTrend {
  keyword: string;
  count: number;
  avgMarketCap: number;
  graduatedCount: number;
  graduationRate: number;
  topPerformer: { name: string; symbol: string; marketCap: number };
}

export interface MarketSnapshot {
  timestamp: number;
  /** Top coins by market cap (graduated) */
  topGraduated: PumpCoinData[];
  /** Hottest coins on bonding curve right now */
  hotOnCurve: PumpCoinData[];
  /** Recently created coins with strong early traction */
  risingStars: PumpCoinData[];
  /** Currently live-streamed coins */
  liveCoins: PumpCoinData[];
  /** Narrative/theme analysis */
  narratives: NarrativeTrend[];
  /** Overall market stats */
  stats: {
    avgGraduatedMarketCap: number;
    medianGraduatedMarketCap: number;
    totalLiveCoins: number;
    avgReplyCount: number;
    graduationThreshold: number; // typical mcap at graduation
    hotNarratives: string[];
  };
}

export interface MarketIntelReport {
  snapshot: MarketSnapshot | null;
  lastRefreshed: number;
  refreshCount: number;
  errors: number;
}

// ── Narrative keywords to track ──
const NARRATIVE_KEYWORDS = [
  "ai", "agent", "gpt", "claude", "llm", "bot",
  "trump", "maga", "biden", "politic",
  "cat", "dog", "pepe", "frog", "monkey", "ape", "bear", "bull",
  "elon", "musk", "doge",
  "sol", "solana", "eth", "btc", "bitcoin",
  "anime", "waifu", "nft",
  "moon", "rocket", "100x", "gem",
  "meme", "degen", "chad", "based",
  "food", "pizza", "burger",
  "baby", "mini", "micro",
  "king", "queen", "god",
  "war", "fight", "battle",
  "love", "heart",
];

export class MarketIntel {
  private snapshot: MarketSnapshot | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshed = 0;
  private refreshCount = 0;
  private errors = 0;
  private running = false;

  /** Start periodic market data collection */
  start(): void {
    if (this.running) return;
    this.running = true;

    logger.system("📊 Market Intelligence starting...");

    // First fetch after 10 seconds
    setTimeout(() => {
      this.refresh().catch((err) =>
        logger.error("INTEL", `Initial refresh failed: ${err}`)
      );
    }, 10_000);

    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        logger.error("INTEL", `Refresh failed: ${err}`)
      );
    }, REFRESH_INTERVAL_MS);

    logger.system(`📊 Market Intel will refresh every ${REFRESH_INTERVAL_MS / 60_000} minutes`);
  }

  /** Stop periodic collection */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.running = false;
  }

  /** Get the latest snapshot (may be null if not yet loaded) */
  getSnapshot(): MarketSnapshot | null {
    return this.snapshot;
  }

  /** Get a full report for the agent */
  getReport(): MarketIntelReport {
    return {
      snapshot: this.snapshot,
      lastRefreshed: this.lastRefreshed,
      refreshCount: this.refreshCount,
      errors: this.errors,
    };
  }

  /**
   * Build a natural-language intelligence briefing for the autonomous agent.
   * This is injected into the agent's system prompt for context.
   */
  getBriefing(): string {
    if (!this.snapshot) return "Market intelligence not yet available (still loading).";

    const s = this.snapshot;
    const ageMin = Math.round((Date.now() - s.timestamp) / 60_000);
    const lines: string[] = [];

    lines.push(`📊 MARKET INTELLIGENCE (${ageMin}m ago)`);
    lines.push("");

    // ── Top graduated coins ──
    if (s.topGraduated.length > 0) {
      lines.push("TOP GRADUATED COINS (by market cap):");
      for (const c of s.topGraduated.slice(0, 8)) {
        const mcapK = (c.market_cap / 1000).toFixed(0);
        const ageHrs = Math.round((Date.now() - c.created_timestamp) / 3_600_000);
        lines.push(`  ${c.symbol.toUpperCase()} (${c.name}) [${c.mint}]: ${mcapK}k SOL mcap, ${c.reply_count} replies, ${ageHrs}h old`);
      }
      lines.push("");
    }

    // ── Hot on bonding curve ──
    if (s.hotOnCurve.length > 0) {
      lines.push("HOT ON BONDING CURVE (active, not graduated):");
      for (const c of s.hotOnCurve.slice(0, 8)) {
        const mcap = c.market_cap.toFixed(1);
        const ageMin = Math.round((Date.now() - c.created_timestamp) / 60_000);
        const progress = ((c.virtual_sol_reserves / 1e9) / 85 * 100).toFixed(0);
        lines.push(`  ${c.symbol.toUpperCase()} (${c.name}) [${c.mint}]: ${mcap} SOL mcap, ~${progress}% to graduation, ${c.reply_count} replies, ${ageMin}m old`);
      }
      lines.push("");
    }

    // ── Rising stars ──
    if (s.risingStars.length > 0) {
      lines.push("RISING STARS (new coins with strong traction):");
      for (const c of s.risingStars.slice(0, 5)) {
        const mcap = c.market_cap.toFixed(1);
        const ageMin = Math.round((Date.now() - c.created_timestamp) / 60_000);
        lines.push(`  ${c.symbol.toUpperCase()} (${c.name}) [${c.mint}]: ${mcap} SOL mcap, ${c.reply_count} replies, ${ageMin}m old`);
      }
      lines.push("");
    }

    // ── Narrative trends ──
    if (s.narratives.length > 0) {
      lines.push("TRENDING NARRATIVES:");
      for (const n of s.narratives.slice(0, 10)) {
        const topName = n.topPerformer.symbol.toUpperCase();
        lines.push(`  "${n.keyword}": ${n.count} coins, ${n.graduatedCount} graduated (${(n.graduationRate * 100).toFixed(0)}%), avg mcap ${(n.avgMarketCap / 1000).toFixed(1)}k SOL, top: ${topName}`);
      }
      lines.push("");
    }

    // ── Overall stats ──
    lines.push("MARKET OVERVIEW:");
    lines.push(`  Avg graduated mcap: ${(s.stats.avgGraduatedMarketCap / 1000).toFixed(1)}k SOL`);
    lines.push(`  Median graduated mcap: ${(s.stats.medianGraduatedMarketCap / 1000).toFixed(1)}k SOL`);
    lines.push(`  Live coins: ${s.stats.totalLiveCoins}`);
    lines.push(`  Avg reply count (top coins): ${s.stats.avgReplyCount.toFixed(0)}`);
    if (s.stats.hotNarratives.length > 0) {
      lines.push(`  🔥 Hottest themes: ${s.stats.hotNarratives.join(", ")}`);
    }

    return lines.join("\n");
  }

  /** Compact briefing for token review prompts (~200 tokens vs ~820) */
  getCompactBriefing(): string {
    if (!this.snapshot) return "";

    const s = this.snapshot;
    const lines: string[] = [];
    lines.push("MARKET INTEL (compact):");

    // Top 3 graduated — no mint addresses
    if (s.topGraduated.length > 0) {
      const top3 = s.topGraduated.slice(0, 3).map(c => {
        const mcapK = (c.market_cap / 1000).toFixed(0);
        return `${c.symbol.toUpperCase()} ${mcapK}k SOL`;
      }).join(", ");
      lines.push(`  Top graduated: ${top3}`);
    }

    // Top 5 narratives — one line each, no mint
    if (s.narratives.length > 0) {
      const top5 = s.narratives.slice(0, 5).map(n =>
        `"${n.keyword}" ${n.count}x ${(n.graduationRate * 100).toFixed(0)}%grad`
      ).join(", ");
      lines.push(`  Narratives: ${top5}`);
    }

    // One-line stats
    lines.push(`  Avg grad mcap: ${(s.stats.avgGraduatedMarketCap / 1000).toFixed(1)}k SOL | Live: ${s.stats.totalLiveCoins}`);
    if (s.stats.hotNarratives.length > 0) {
      lines.push(`  🔥 Hot: ${s.stats.hotNarratives.slice(0, 5).join(", ")}`);
    }

    return lines.join("\n");
  }

  /** Core refresh — fetches all data sources and builds snapshot */
  private async refresh(): Promise<void> {
    const start = Date.now();
    logger.info("INTEL", "📊 Refreshing market intelligence...");

    try {
      // Fetch in parallel for speed
      const [
        topByMcap,
        recentlyTraded,
        newestCoins,
        liveCoins,
      ] = await Promise.all([
        this.fetchCoins({ sort: "market_cap", order: "DESC", limit: MAX_COINS_PER_QUERY }),
        this.fetchCoins({ sort: "last_trade_timestamp", order: "DESC", limit: MAX_COINS_PER_QUERY }),
        this.fetchCoins({ sort: "created_timestamp", order: "DESC", limit: MAX_COINS_PER_QUERY }),
        this.fetchLiveCoins(),
      ]);

      // Separate graduated vs bonding curve
      const graduated = topByMcap.filter((c) => c.complete);
      const onCurve = recentlyTraded.filter((c) => !c.complete);

      // Find rising stars: new coins (< 30 min old) with high relative engagement
      const thirtyMinAgo = Date.now() - 30 * 60_000;
      const risingStars = newestCoins
        .filter((c) => c.created_timestamp > thirtyMinAgo && c.reply_count > 5 && c.market_cap > 5)
        .sort((a, b) => b.market_cap - a.market_cap)
        .slice(0, 10);

      // Analyze narratives across all fetched coins
      const allCoins = this.deduplicateCoins([...topByMcap, ...recentlyTraded, ...newestCoins, ...liveCoins]);
      const narratives = this.analyzeNarratives(allCoins);

      // Compute market stats
      const graduatedMcaps = graduated.map((c) => c.market_cap).sort((a, b) => a - b);
      const avgGraduatedMcap = graduatedMcaps.length > 0
        ? graduatedMcaps.reduce((s, v) => s + v, 0) / graduatedMcaps.length
        : 0;
      const medianGraduatedMcap = graduatedMcaps.length > 0
        ? graduatedMcaps[Math.floor(graduatedMcaps.length / 2)]!
        : 0;
      const avgReplies = allCoins.length > 0
        ? allCoins.reduce((s, c) => s + c.reply_count, 0) / allCoins.length
        : 0;

      // Hot narratives = those with >3 coins and >30% graduation rate
      const hotNarratives = narratives
        .filter((n) => n.count >= 3 && n.graduationRate > 0.3)
        .sort((a, b) => b.graduationRate - a.graduationRate)
        .slice(0, 5)
        .map((n) => n.keyword);

      this.snapshot = {
        timestamp: Date.now(),
        topGraduated: graduated.slice(0, 15),
        hotOnCurve: onCurve
          .sort((a, b) => b.market_cap - a.market_cap)
          .slice(0, 15),
        risingStars,
        liveCoins: liveCoins.slice(0, 15),
        narratives,
        stats: {
          avgGraduatedMarketCap: avgGraduatedMcap,
          medianGraduatedMarketCap: medianGraduatedMcap,
          totalLiveCoins: liveCoins.length,
          avgReplyCount: avgReplies,
          graduationThreshold: 85, // SOL in bonding curve at graduation
          hotNarratives,
        },
      };

      this.lastRefreshed = Date.now();
      this.refreshCount++;

      const elapsed = Date.now() - start;
      logger.info("INTEL", `📊 Market intel refreshed in ${elapsed}ms — ${allCoins.length} unique coins analyzed, ${narratives.length} narratives tracked`);

    } catch (err) {
      this.errors++;
      logger.error("INTEL", `Market intel refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fetch coins from the pump.fun v3 API */
  private async fetchCoins(params: {
    sort: string;
    order: "ASC" | "DESC";
    limit: number;
    offset?: number;
  }): Promise<PumpCoinData[]> {
    const url = `${PUMP_API_V3}/coins?offset=${params.offset ?? 0}&limit=${params.limit}&sort=${params.sort}&order=${params.order}&includeNsfw=false`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "Accept": "application/json" },
      });

      if (!res.ok) {
        logger.warn("INTEL", `API ${res.status} for ${params.sort}`);
        return [];
      }

      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data as PumpCoinData[];
    } catch (err) {
      logger.warn("INTEL", `Fetch failed (${params.sort}): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Fetch currently live coins */
  private async fetchLiveCoins(): Promise<PumpCoinData[]> {
    try {
      const res = await fetch(`${PUMP_API_V3}/coins/currently-live`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "Accept": "application/json" },
      });

      if (!res.ok) return [];

      const ct = res.headers.get("content-type");
      if (!ct || !ct.includes("json")) return [];

      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data as PumpCoinData[];
    } catch {
      return [];
    }
  }

  /** Deduplicate coins by mint */
  private deduplicateCoins(coins: PumpCoinData[]): PumpCoinData[] {
    const seen = new Set<string>();
    return coins.filter((c) => {
      if (seen.has(c.mint)) return false;
      seen.add(c.mint);
      return true;
    });
  }

  /** Analyze narrative trends across coins */
  private analyzeNarratives(coins: PumpCoinData[]): NarrativeTrend[] {
    const narrativeMap = new Map<string, {
      coins: PumpCoinData[];
      graduated: number;
      totalMcap: number;
    }>();

    for (const coin of coins) {
      const text = `${coin.name} ${coin.symbol} ${coin.description || ""}`.toLowerCase();

      for (const keyword of NARRATIVE_KEYWORDS) {
        if (text.includes(keyword)) {
          let entry = narrativeMap.get(keyword);
          if (!entry) {
            entry = { coins: [], graduated: 0, totalMcap: 0 };
            narrativeMap.set(keyword, entry);
          }
          entry.coins.push(coin);
          entry.totalMcap += coin.market_cap;
          if (coin.complete) entry.graduated++;
        }
      }
    }

    const trends: NarrativeTrend[] = [];

    for (const [keyword, data] of narrativeMap) {
      if (data.coins.length < 2) continue; // Skip noise

      const topPerformer = data.coins.reduce((best, c) =>
        c.market_cap > best.market_cap ? c : best
      );

      trends.push({
        keyword,
        count: data.coins.length,
        avgMarketCap: data.totalMcap / data.coins.length,
        graduatedCount: data.graduated,
        graduationRate: data.graduated / data.coins.length,
        topPerformer: {
          name: topPerformer.name,
          symbol: topPerformer.symbol,
          marketCap: topPerformer.market_cap,
        },
      });
    }

    // Sort by count * graduation rate to surface meaningful trends
    return trends.sort((a, b) => (b.count * b.graduationRate) - (a.count * a.graduationRate));
  }

  /**
   * Get intelligence about a specific coin by mint address.
   * Useful for enriching token evaluation context.
   */
  /** Find a mint address by symbol from the current snapshot */
  findMintBySymbol(symbol: string): string | null {
    if (!this.snapshot) return null;
    const upper = symbol.toUpperCase();
    const allCoins = [
      ...this.snapshot.hotOnCurve,
      ...this.snapshot.risingStars,
      ...this.snapshot.topGraduated,
    ];
    const match = allCoins.find((c) => c.symbol.toUpperCase() === upper);
    return match?.mint ?? null;
  }

  async getCoinDetails(mint: string): Promise<PumpCoinData | null> {
    try {
      const res = await fetch(`${PUMP_API_V3}/coins/${mint}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "Accept": "application/json" },
      });

      if (!res.ok) return null;

      const ct = res.headers.get("content-type");
      if (!ct || !ct.includes("json")) return null;

      return (await res.json()) as PumpCoinData;
    } catch {
      return null;
    }
  }

  /**
   * Check if a coin's narrative matches currently hot trends.
   * Returns a score boost (0-15) based on narrative alignment.
   */
  getNarrativeBoost(name: string, symbol: string, description?: string): number {
    if (!this.snapshot) return 0;

    const text = `${name} ${symbol} ${description || ""}`.toLowerCase();
    let boost = 0;

    for (const narrative of this.snapshot.narratives) {
      if (text.includes(narrative.keyword)) {
        // Boost based on graduation rate and coin count
        if (narrative.graduationRate > 0.5 && narrative.count >= 3) {
          boost += 5;
        } else if (narrative.graduationRate > 0.3 && narrative.count >= 2) {
          boost += 3;
        } else if (narrative.count >= 5) {
          boost += 2;
        }
      }
    }

    return Math.min(15, boost); // Cap at 15
  }
}
