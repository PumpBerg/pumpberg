// ── Graduate Analyzer: Track & analyze pump.fun bonding curve graduates ──
// Monitors real-time migration events from PumpPortal WebSocket,
// enriches with pump.fun + DexScreener data, analyzes post-graduation
// patterns, and generates actionable briefings for the agent to catch
// similar tokens before they graduate.

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import type { PumpCoinData } from "./market-intel.js";

const PUMP_API_V3 = "https://frontend-api-v3.pump.fun";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";
const FETCH_TIMEOUT_MS = 10_000;
const ENRICHMENT_DELAY_MS = 30_000; // Wait 30s after migration before checking Raydium performance
const PERFORMANCE_CHECK_DELAY_MS = 5 * 60_000; // Check 5min post-graduation performance
const MAX_GRADUATES = 200; // Keep last 200 for analysis
const ANALYSIS_INTERVAL_MS = 10 * 60_000; // Re-analyze patterns every 10 min
const PERSIST_FILE = "graduate-analysis.json";

// ── Types ──

export interface GraduateProfile {
  mint: string;
  name: string;
  symbol: string;
  pool?: string; // Raydium pool address
  graduatedAt: number; // timestamp
  /** Pre-graduation data from pump.fun */
  preGrad: {
    marketCapSol: number;
    ageMinutes: number; // time from creation to graduation
    replyCount: number;
    description: string;
    hasTwitter: boolean;
    hasWebsite: boolean;
    createdAt: number;
    kothMinutes: number | null; // time to King of the Hill
  };
  /** Post-graduation Raydium data from DexScreener */
  postGrad: {
    checked: boolean;
    priceUsd: number | null;
    marketCapUsd: number | null;
    volume24h: number | null;
    liquidity: number | null;
    priceChange5m: number | null;
    priceChange1h: number | null;
    checkedAt: number | null;
    /** Was this a "winner" post-graduation? (price held or grew) */
    isWinner: boolean | null;
  };
  /** Extracted themes/narratives from name + description */
  themes: string[];
}

export interface GraduatePatterns {
  /** When this analysis was generated */
  analyzedAt: number;
  /** Total graduates tracked */
  totalTracked: number;
  /** Graduates in the last hour */
  lastHourCount: number;
  /** Graduation rate estimate (grads/hour) */
  gradRatePerHour: number;
  /** Theme analysis — which narratives graduate most + perform best */
  themeBreakdown: Array<{
    theme: string;
    count: number;
    avgAgeMinutes: number;
    avgReplyCount: number;
    winnerRate: number; // % that held/grew post-graduation
    avgPostGradMcapUsd: number;
  }>;
  /** Social presence patterns */
  socialPatterns: {
    twitterRate: number; // % with twitter
    websiteRate: number; // % with website
    avgRepliesWinners: number;
    avgRepliesLosers: number;
  };
  /** Timing patterns */
  timingPatterns: {
    avgTimeToGradMinutes: number;
    medianTimeToGradMinutes: number;
    fastestGradMinutes: number;
    avgKothMinutes: number | null;
    peakHours: number[]; // UTC hours with most graduations
  };
  /** Market cap at graduation */
  mcapPatterns: {
    avgGradMcapSol: number;
    medianGradMcapSol: number;
  };
  /** Top performers — graduates that did best post-graduation */
  topPerformers: Array<{
    symbol: string;
    name: string;
    mint: string;
    postGradMcapUsd: number;
    priceChange5m: number | null;
    ageMinutes: number;
    themes: string[];
  }>;
  /** Key insights — natural language takeaways */
  keyInsights: string[];
}

// ── Narrative keywords for theme extraction ──
const THEME_KEYWORDS: Array<[string, RegExp]> = [
  ["ai", /\b(ai|artificial|gpt|claude|llm|neural|machine.?learn|openai|chatgpt|gemini|copilot)\b/i],
  ["agent", /\b(agent|autonomous|auto|agentic|swarm)\b/i],
  ["meme", /\b(meme|pepe|wojak|chad|based|degen|kek|cope|seethe|lmao|bruh)\b/i],
  ["dog", /\b(dog|doge|shib|inu|puppy|woof|bark|corgi|pup)\b/i],
  ["cat", /\b(cat|kit|kitten|meow|nyan|purr|feline)\b/i],
  ["political", /\b(trump|biden|maga|politic|vote|president|election|congress)\b/i],
  ["elon", /\b(elon|musk|tesla|spacex|x\.com|grok)\b/i],
  ["anime", /\b(anime|manga|waifu|kawaii|senpai|otaku|chan|kun|sama)\b/i],
  ["food", /\b(food|pizza|burger|taco|sushi|coffee|beer|cake|cook)\b/i],
  ["gaming", /\b(game|gaming|play|quest|rpg|pvp|esport|pixel)\b/i],
  ["defi", /\b(defi|swap|yield|farm|stake|liquid|vault|amm)\b/i],
  ["celebrity", /\b(celeb|famous|star|influencer|youtuber|streamer|tiktoker)\b/i],
  ["nature", /\b(nature|earth|tree|forest|ocean|mountain|river|sun|moon|star)\b/i],
  ["money", /\b(money|cash|rich|wealth|million|billion|dollar|gold|diamond)\b/i],
  ["baby", /\b(baby|mini|micro|tiny|small|little|smol)\b/i],
  ["mythical", /\b(dragon|phoenix|unicorn|wizard|magic|myth|legend|god|zeus)\b/i],
];

export class GraduateAnalyzer {
  private graduates: GraduateProfile[] = [];
  private patterns: GraduatePatterns | null = null;
  private analysisTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private dataPath: string;

  constructor(dataDir: string) {
    this.dataPath = path.join(dataDir, PERSIST_FILE);
    this.loadFromDisk();
  }

  /** Start the analyzer — begin periodic pattern analysis */
  start(): void {
    if (this.running) return;
    this.running = true;

    logger.system("🎓 Graduate Analyzer starting...");

    // Run initial analysis after 15s
    setTimeout(() => {
      this.analyzePatterns();
    }, 15_000);

    // Re-analyze every 10 minutes
    this.analysisTimer = setInterval(() => {
      this.analyzePatterns();
    }, ANALYSIS_INTERVAL_MS);

    logger.system(`🎓 Graduate Analyzer active — tracking bonding curve graduates, re-analyzing every ${ANALYSIS_INTERVAL_MS / 60_000}min`);
  }

  /** Stop the analyzer */
  stop(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.running = false;
  }

  /**
   * Record a migration event from PumpPortal WebSocket.
   * Called by Scanner when a migration is detected.
   */
  recordMigration(mint: string, symbol?: string, name?: string, pool?: string): void {
    // Avoid duplicates
    if (this.graduates.some((g) => g.mint === mint)) return;

    const profile: GraduateProfile = {
      mint,
      name: name || "Unknown",
      symbol: symbol || mint.slice(0, 6),
      pool,
      graduatedAt: Date.now(),
      preGrad: {
        marketCapSol: 0,
        ageMinutes: 0,
        replyCount: 0,
        description: "",
        hasTwitter: false,
        hasWebsite: false,
        createdAt: 0,
        kothMinutes: null,
      },
      postGrad: {
        checked: false,
        priceUsd: null,
        marketCapUsd: null,
        volume24h: null,
        liquidity: null,
        priceChange5m: null,
        priceChange1h: null,
        checkedAt: null,
        isWinner: null,
      },
      themes: [],
    };

    this.graduates.push(profile);

    // Trim to max
    if (this.graduates.length > MAX_GRADUATES) {
      this.graduates = this.graduates.slice(-MAX_GRADUATES);
    }

    logger.info("GRADUATE", `🎓 Recorded migration: ${profile.symbol} (${mint.slice(0, 8)}...)`);

    // Stage 1: pump.fun data only (3s) — DexScreener won't have data yet
    this.queueEnrichment(mint, pool, 3_000, true);
    // Stage 2: DexScreener data (30s) — Raydium pair should exist by now
    this.queueEnrichment(mint, pool, ENRICHMENT_DELAY_MS, false);
    // Stage 3: Performance re-check (5min) — only runs if 30s didn't get data
    this.queueEnrichment(mint, pool, PERFORMANCE_CHECK_DELAY_MS, false);

    this.debouncedPersist();
  }

  /** Get the latest patterns analysis */
  getPatterns(): GraduatePatterns | null {
    return this.patterns;
  }

  /** Get all tracked graduates */
  getGraduates(): GraduateProfile[] {
    return this.graduates;
  }

  /**
   * Generate a natural-language briefing about graduation trends.
   * Injected into the agent's system prompt for decision-making context.
   */
  getBriefing(): string {
    if (!this.patterns || this.graduates.length < 3) {
      return this.graduates.length > 0
        ? `🎓 GRADUATE TRACKING: ${this.graduates.length} migration(s) recorded, building analysis...`
        : "";
    }

    const p = this.patterns;
    const ageMin = Math.round((Date.now() - p.analyzedAt) / 60_000);
    const lines: string[] = [];

    lines.push(`🎓 GRADUATE ANALYSIS (${p.totalTracked} graduates tracked, ${ageMin}m ago)`);
    lines.push("");

    // Graduation rate
    lines.push(`GRADUATION RATE: ~${p.gradRatePerHour.toFixed(1)}/hour (${p.lastHourCount} in last hour)`);
    lines.push("");

    // Timing
    lines.push("GRADUATION TIMING:");
    lines.push(`  Avg time to grad: ${p.timingPatterns.avgTimeToGradMinutes.toFixed(0)}min | Median: ${p.timingPatterns.medianTimeToGradMinutes.toFixed(0)}min | Fastest: ${p.timingPatterns.fastestGradMinutes.toFixed(0)}min`);
    if (p.timingPatterns.avgKothMinutes !== null) {
      lines.push(`  Avg time to KOTH: ${p.timingPatterns.avgKothMinutes.toFixed(0)}min`);
    }
    if (p.timingPatterns.peakHours.length > 0) {
      lines.push(`  Peak graduation hours (UTC): ${p.timingPatterns.peakHours.join(", ")}`);
    }
    lines.push("");

    // Market cap at graduation
    lines.push(`MCAP AT GRADUATION: avg ${p.mcapPatterns.avgGradMcapSol.toFixed(1)} SOL | median ${p.mcapPatterns.medianGradMcapSol.toFixed(1)} SOL`);
    lines.push("");

    // Theme breakdown
    if (p.themeBreakdown.length > 0) {
      lines.push("WINNING NARRATIVES (graduates by theme):");
      for (const t of p.themeBreakdown.slice(0, 8)) {
        const winPct = (t.winnerRate * 100).toFixed(0);
        lines.push(`  "${t.theme}": ${t.count} grads, ${winPct}% winners post-grad, avg ${t.avgAgeMinutes.toFixed(0)}min to grad, avg ${t.avgReplyCount.toFixed(0)} replies`);
      }
      lines.push("");
    }

    // Social patterns
    lines.push("SOCIAL SIGNALS OF GRADUATES:");
    lines.push(`  Twitter: ${(p.socialPatterns.twitterRate * 100).toFixed(0)}% | Website: ${(p.socialPatterns.websiteRate * 100).toFixed(0)}%`);
    if (p.socialPatterns.avgRepliesWinners > 0) {
      lines.push(`  Avg replies — winners: ${p.socialPatterns.avgRepliesWinners.toFixed(0)} vs losers: ${p.socialPatterns.avgRepliesLosers.toFixed(0)}`);
    }
    lines.push("");

    // Top performers
    if (p.topPerformers.length > 0) {
      lines.push("TOP POST-GRADUATION PERFORMERS:");
      for (const t of p.topPerformers.slice(0, 5)) {
        const change = t.priceChange5m !== null ? ` (${t.priceChange5m >= 0 ? "+" : ""}${t.priceChange5m.toFixed(0)}% in 5m)` : "";
        const mcapK = (t.postGradMcapUsd / 1000).toFixed(0);
        lines.push(`  ${t.symbol}: $${mcapK}k mcap${change} — themes: ${t.themes.join(", ") || "none"} — grad in ${t.ageMinutes.toFixed(0)}min`);
      }
      lines.push("");
    }

    // Key insights
    if (p.keyInsights.length > 0) {
      lines.push("KEY GRADUATION INSIGHTS:");
      for (const insight of p.keyInsights) {
        lines.push(`  ⚡ ${insight}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Compact briefing for token review prompts — much shorter to reduce Claude input tokens.
   * Token reviews happen every 30s, so keeping this lean saves significant API cost.
   */
  getCompactBriefing(): string {
    if (!this.patterns || this.graduates.length < 3) return "";

    const p = this.patterns;
    const lines: string[] = [];

    lines.push(`🎓 GRAD TRENDS: ~${p.gradRatePerHour.toFixed(1)}/hr | avg ${p.timingPatterns.avgTimeToGradMinutes.toFixed(0)}min to grad | Twitter: ${(p.socialPatterns.twitterRate * 100).toFixed(0)}%`);

    // Top 3 themes only
    if (p.themeBreakdown.length > 0) {
      const top3 = p.themeBreakdown.slice(0, 3).map((t) =>
        `"${t.theme}"(${t.count}, ${(t.winnerRate * 100).toFixed(0)}%W)`
      ).join(", ");
      lines.push(`  Hot: ${top3}`);
    }

    // Max 2 key insights
    for (const insight of p.keyInsights.slice(0, 2)) {
      lines.push(`  ⚡ ${insight}`);
    }

    return lines.join("\n");
  }

  // ── Enrichment Pipeline ──

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced persist — avoids excessive disk writes during rapid enrichment */
  private debouncedPersist(): void {
    if (this.persistTimer) return; // Already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistToDisk();
    }, 5_000);
  }

  private queueEnrichment(mint: string, pool?: string, delay: number = 3000, pumpFunOnly = false): void {
    setTimeout(() => {
      this.enrichGraduate(mint, pool, pumpFunOnly).catch((err) =>
        logger.warn("GRADUATE", `Enrichment failed for ${mint.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      );
    }, delay);
  }

  private async enrichGraduate(mint: string, pool?: string, pumpFunOnly = false): Promise<void> {
    const grad = this.graduates.find((g) => g.mint === mint);
    if (!grad) return;

    // ── Stage 1: Pump.fun coin data (pre-graduation metrics) ──
    if (grad.preGrad.createdAt === 0) {
      try {
        const coinData = await this.fetchCoinData(mint);
        if (coinData) {
          grad.name = coinData.name;
          grad.symbol = coinData.symbol;
          grad.preGrad.marketCapSol = coinData.market_cap;
          grad.preGrad.replyCount = coinData.reply_count;
          grad.preGrad.description = (coinData.description || "").slice(0, 300);
          grad.preGrad.hasTwitter = !!(coinData.twitter);
          grad.preGrad.hasWebsite = !!(coinData.website);
          grad.preGrad.createdAt = coinData.created_timestamp;
          grad.preGrad.ageMinutes = (grad.graduatedAt - coinData.created_timestamp) / 60_000;
          if (coinData.king_of_the_hill_timestamp) {
            grad.preGrad.kothMinutes = (coinData.king_of_the_hill_timestamp - coinData.created_timestamp) / 60_000;
          }
          // Extract themes
          grad.themes = this.extractThemes(coinData.name, coinData.symbol, coinData.description || "");

          logger.info("GRADUATE", `📊 Enriched ${grad.symbol}: ${grad.preGrad.ageMinutes.toFixed(0)}min to grad, ${grad.preGrad.replyCount} replies, mcap ${grad.preGrad.marketCapSol.toFixed(1)} SOL`);
        }
      } catch (err) {
        logger.warn("GRADUATE", `Pump.fun fetch failed for ${mint.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Skip DexScreener on pump.fun-only pass (3s after migration — data won't exist yet)
    if (pumpFunOnly) {
      this.debouncedPersist();
      return;
    }

    // Skip DexScreener if we already have good data from a previous check
    if (grad.postGrad.checked && grad.postGrad.marketCapUsd !== null && grad.postGrad.marketCapUsd > 0) {
      return; // Already have data — no need to re-fetch
    }

    // ── Stage 2: DexScreener data (post-graduation Raydium performance) ──
    try {
      const dexData = await this.fetchDexScreenerData(mint);
      if (dexData) {
        grad.postGrad.checked = true;
        grad.postGrad.priceUsd = dexData.priceUsd;
        grad.postGrad.marketCapUsd = dexData.marketCapUsd;
        grad.postGrad.volume24h = dexData.volume24h;
        grad.postGrad.liquidity = dexData.liquidity;
        grad.postGrad.priceChange5m = dexData.priceChange5m;
        grad.postGrad.priceChange1h = dexData.priceChange1h;
        grad.postGrad.checkedAt = Date.now();

        // Winner = price change positive or mcap > $50k
        grad.postGrad.isWinner = (dexData.priceChange5m !== null && dexData.priceChange5m > 0)
          || (dexData.marketCapUsd !== null && dexData.marketCapUsd > 50_000);

        logger.info("GRADUATE", `📈 DexScreener for ${grad.symbol}: $${dexData.marketCapUsd?.toFixed(0) ?? "?"} mcap, ${dexData.priceChange5m?.toFixed(1) ?? "?"}% 5m change`);
      }
    } catch {
      // DexScreener may not have data yet — that's fine, we'll retry at the 5min mark
    }

    this.debouncedPersist();
  }

  /** Fetch coin data from pump.fun v3 API */
  private async fetchCoinData(mint: string): Promise<PumpCoinData | null> {
    try {
      const res = await fetch(`${PUMP_API_V3}/coins/${mint}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type");
      if (!ct || !ct.includes("json")) return null;
      return (await res.json()) as PumpCoinData;
    } catch {
      return null;
    }
  }

  /** Fetch post-graduation data from DexScreener */
  private async fetchDexScreenerData(mint: string): Promise<{
    priceUsd: number | null;
    marketCapUsd: number | null;
    volume24h: number | null;
    liquidity: number | null;
    priceChange5m: number | null;
    priceChange1h: number | null;
  } | null> {
    try {
      const res = await fetch(`${DEXSCREENER_API}/${mint}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json() as { pairs?: Array<Record<string, unknown>> };
      if (!data.pairs || data.pairs.length === 0) return null;

      // Use the highest-liquidity Raydium pair
      const pair = data.pairs
        .filter((p: Record<string, unknown>) => (p.dexId as string)?.toLowerCase().includes("raydium"))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          ((b.liquidity as { usd?: number })?.usd ?? 0) - ((a.liquidity as { usd?: number })?.usd ?? 0)
        )[0] || data.pairs[0];

      if (!pair) return null;

      const priceChange = pair.priceChange as Record<string, number> | undefined;

      return {
        priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd as string) : null,
        marketCapUsd: (pair.marketCap as number) ?? (pair.fdv as number) ?? null,
        volume24h: (pair.volume as { h24?: number })?.h24 ?? null,
        liquidity: (pair.liquidity as { usd?: number })?.usd ?? null,
        priceChange5m: priceChange?.m5 ?? null,
        priceChange1h: priceChange?.h1 ?? null,
      };
    } catch {
      return null;
    }
  }

  // ── Pattern Analysis ──

  private analyzePatterns(): void {
    if (this.graduates.length < 2) return;

    const now = Date.now();
    const oneHourAgo = now - 60 * 60_000;
    const enriched = this.graduates.filter((g) => g.preGrad.createdAt > 0);
    const withPostGrad = enriched.filter((g) => g.postGrad.checked);

    // ── Graduation rate ──
    const lastHourGrads = this.graduates.filter((g) => g.graduatedAt > oneHourAgo);
    const oldestGrad = this.graduates[0]!;
    const trackingDurationHours = Math.max(1, (now - oldestGrad.graduatedAt) / 3_600_000);
    const gradRatePerHour = this.graduates.length / trackingDurationHours;

    // ── Timing patterns ──
    const gradTimes = enriched
      .map((g) => g.preGrad.ageMinutes)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    const kothTimes = enriched
      .map((g) => g.preGrad.kothMinutes)
      .filter((t): t is number => t !== null && t > 0);
    const gradHours = this.graduates.map((g) => new Date(g.graduatedAt).getUTCHours());
    const hourCounts = new Map<number, number>();
    for (const h of gradHours) hourCounts.set(h, (hourCounts.get(h) || 0) + 1);
    const peakHours = [...hourCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h]) => h);

    // ── Theme breakdown ──
    const themeMap = new Map<string, GraduateProfile[]>();
    for (const g of enriched) {
      for (const theme of g.themes) {
        const list = themeMap.get(theme) || [];
        list.push(g);
        themeMap.set(theme, list);
      }
    }
    const themeBreakdown = [...themeMap.entries()]
      .filter(([, grads]) => grads.length >= 2)
      .map(([theme, grads]) => {
        const withPost = grads.filter((g) => g.postGrad.checked);
        const winners = withPost.filter((g) => g.postGrad.isWinner === true);
        return {
          theme,
          count: grads.length,
          avgAgeMinutes: grads.reduce((s, g) => s + g.preGrad.ageMinutes, 0) / grads.length,
          avgReplyCount: grads.reduce((s, g) => s + g.preGrad.replyCount, 0) / grads.length,
          winnerRate: withPost.length > 0 ? winners.length / withPost.length : 0,
          avgPostGradMcapUsd: withPost.length > 0
            ? withPost.reduce((s, g) => s + (g.postGrad.marketCapUsd || 0), 0) / withPost.length
            : 0,
        };
      })
      .sort((a, b) => b.count - a.count);

    // ── Social patterns ──
    const twitterCount = enriched.filter((g) => g.preGrad.hasTwitter).length;
    const websiteCount = enriched.filter((g) => g.preGrad.hasWebsite).length;
    const winners = withPostGrad.filter((g) => g.postGrad.isWinner === true);
    const losers = withPostGrad.filter((g) => g.postGrad.isWinner === false);

    // ── Market cap patterns ──
    const gradMcaps = enriched
      .map((g) => g.preGrad.marketCapSol)
      .filter((m) => m > 0)
      .sort((a, b) => a - b);

    // ── Top performers ──
    const topPerformers = withPostGrad
      .filter((g) => g.postGrad.marketCapUsd !== null && g.postGrad.marketCapUsd > 0)
      .sort((a, b) => (b.postGrad.marketCapUsd || 0) - (a.postGrad.marketCapUsd || 0))
      .slice(0, 10)
      .map((g) => ({
        symbol: g.symbol,
        name: g.name,
        mint: g.mint,
        postGradMcapUsd: g.postGrad.marketCapUsd || 0,
        priceChange5m: g.postGrad.priceChange5m,
        ageMinutes: g.preGrad.ageMinutes,
        themes: g.themes,
      }));

    // ── Key insights ──
    const insights: string[] = [];

    if (gradRatePerHour > 5) {
      insights.push(`Hot graduation market: ${gradRatePerHour.toFixed(1)} tokens/hour graduating — bullish signal, be more aggressive`);
    } else if (gradRatePerHour < 1) {
      insights.push(`Slow graduation market: ${gradRatePerHour.toFixed(1)} tokens/hour — fewer opportunities, be more selective`);
    }

    if (themeBreakdown.length > 0) {
      const topTheme = themeBreakdown[0]!;
      insights.push(`Hottest graduating narrative: "${topTheme.theme}" (${topTheme.count} graduates, ${(topTheme.winnerRate * 100).toFixed(0)}% winners)`);
    }

    const hotThemes = themeBreakdown.filter((t) => t.winnerRate > 0.5 && t.count >= 3);
    if (hotThemes.length > 0) {
      insights.push(`High-winner themes to target: ${hotThemes.map((t) => `"${t.theme}" (${(t.winnerRate * 100).toFixed(0)}%)`).join(", ")}`);
    }

    if (enriched.length > 5) {
      const twitterRate = twitterCount / enriched.length;
      if (twitterRate > 0.7) {
        insights.push(`${(twitterRate * 100).toFixed(0)}% of graduates have Twitter — social presence is a strong graduation predictor`);
      }
    }

    if (gradTimes.length > 5) {
      const fastGrads = gradTimes.filter((t) => t < 30);
      if (fastGrads.length > gradTimes.length * 0.3) {
        insights.push(`${((fastGrads.length / gradTimes.length) * 100).toFixed(0)}% graduate within 30min — fast-movers dominate, look for early velocity`);
      }
    }

    if (winners.length > 0 && losers.length > 0) {
      const winnerReplies = winners.reduce((s, g) => s + g.preGrad.replyCount, 0) / winners.length;
      const loserReplies = losers.reduce((s, g) => s + g.preGrad.replyCount, 0) / losers.length;
      if (winnerReplies > loserReplies * 1.5) {
        insights.push(`Winners avg ${winnerReplies.toFixed(0)} replies vs losers ${loserReplies.toFixed(0)} — high engagement predicts post-grad success`);
      }
    }

    this.patterns = {
      analyzedAt: now,
      totalTracked: this.graduates.length,
      lastHourCount: lastHourGrads.length,
      gradRatePerHour,
      themeBreakdown,
      socialPatterns: {
        twitterRate: enriched.length > 0 ? twitterCount / enriched.length : 0,
        websiteRate: enriched.length > 0 ? websiteCount / enriched.length : 0,
        avgRepliesWinners: winners.length > 0
          ? winners.reduce((s, g) => s + g.preGrad.replyCount, 0) / winners.length
          : 0,
        avgRepliesLosers: losers.length > 0
          ? losers.reduce((s, g) => s + g.preGrad.replyCount, 0) / losers.length
          : 0,
      },
      timingPatterns: {
        avgTimeToGradMinutes: gradTimes.length > 0
          ? gradTimes.reduce((s, t) => s + t, 0) / gradTimes.length
          : 0,
        medianTimeToGradMinutes: gradTimes.length > 0
          ? gradTimes[Math.floor(gradTimes.length / 2)]!
          : 0,
        fastestGradMinutes: gradTimes.length > 0 ? gradTimes[0]! : 0,
        avgKothMinutes: kothTimes.length > 0
          ? kothTimes.reduce((s, t) => s + t, 0) / kothTimes.length
          : null,
        peakHours,
      },
      mcapPatterns: {
        avgGradMcapSol: gradMcaps.length > 0
          ? gradMcaps.reduce((s, m) => s + m, 0) / gradMcaps.length
          : 0,
        medianGradMcapSol: gradMcaps.length > 0
          ? gradMcaps[Math.floor(gradMcaps.length / 2)]!
          : 0,
      },
      topPerformers,
      keyInsights: insights,
    };

    this.persistToDisk();
    logger.info("GRADUATE", `🎓 Analysis updated: ${this.graduates.length} graduates, ${insights.length} insights, ${themeBreakdown.length} themes`);
  }

  // ── Theme Extraction ──

  private extractThemes(name: string, symbol: string, description: string): string[] {
    const text = `${name} ${symbol} ${description}`.toLowerCase();
    const themes: string[] = [];

    for (const [theme, regex] of THEME_KEYWORDS) {
      if (regex.test(text)) {
        themes.push(theme);
      }
    }

    return themes;
  }

  // ── Persistence ──

  private persistToDisk(): void {
    try {
      const data = {
        graduates: this.graduates,
        patterns: this.patterns,
        savedAt: Date.now(),
      };
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn("GRADUATE", `Failed to persist: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;

      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const data = JSON.parse(raw);

      if (Array.isArray(data.graduates)) {
        this.graduates = data.graduates;
        logger.info("GRADUATE", `📂 Loaded ${this.graduates.length} graduates from disk`);
      }
      if (data.patterns) {
        this.patterns = data.patterns;
      }
    } catch (err) {
      logger.warn("GRADUATE", `Failed to load from disk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fetch latest graduates on startup by pulling recently graduated tokens from pump.fun API.
   *  This seeds the analyzer with historical data so it doesn't start from zero. */
  async seedFromApi(): Promise<void> {
    logger.info("GRADUATE", "🌱 Seeding graduate data from pump.fun API...");

    try {
      // Fetch top coins sorted by market cap — most will be graduated
      const res = await fetch(`${PUMP_API_V3}/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        logger.warn("GRADUATE", `Seed fetch failed: HTTP ${res.status}`);
        return;
      }

      const coins = (await res.json()) as PumpCoinData[];
      if (!Array.isArray(coins)) return;

      const graduated = coins.filter((c) => c.complete);
      let added = 0;

      for (const coin of graduated) {
        if (this.graduates.some((g) => g.mint === coin.mint)) continue;

        const profile: GraduateProfile = {
          mint: coin.mint,
          name: coin.name,
          symbol: coin.symbol,
          pool: coin.raydium_pool || undefined,
          graduatedAt: coin.king_of_the_hill_timestamp
            ? coin.king_of_the_hill_timestamp + 60_000 // Approximate graduation time (KOTH + ~1min)
            : coin.created_timestamp + 30 * 60_000, // Fallback: assume 30min graduation
          preGrad: {
            marketCapSol: coin.market_cap,
            ageMinutes: coin.king_of_the_hill_timestamp
              ? (coin.king_of_the_hill_timestamp - coin.created_timestamp) / 60_000
              : 30,
            replyCount: coin.reply_count,
            description: (coin.description || "").slice(0, 300),
            hasTwitter: !!coin.twitter,
            hasWebsite: !!coin.website,
            createdAt: coin.created_timestamp,
            kothMinutes: coin.king_of_the_hill_timestamp
              ? (coin.king_of_the_hill_timestamp - coin.created_timestamp) / 60_000
              : null,
          },
          postGrad: {
            checked: false,
            priceUsd: null,
            marketCapUsd: null,
            volume24h: null,
            liquidity: null,
            priceChange5m: null,
            priceChange1h: null,
            checkedAt: null,
            isWinner: null,
          },
          themes: this.extractThemes(coin.name, coin.symbol, coin.description || ""),
        };

        this.graduates.push(profile);
        added++;

        // Queue DexScreener enrichment — batch-friendly staggered delays, skip pump.fun (already have data)
        this.queueEnrichment(coin.mint, coin.raydium_pool || undefined, 5_000 + added * 3_000, false);
      }

      if (added > 0) {
        // Trim to max
        if (this.graduates.length > MAX_GRADUATES) {
          this.graduates = this.graduates.slice(-MAX_GRADUATES);
        }
        this.persistToDisk();
        logger.info("GRADUATE", `🌱 Seeded ${added} graduates from pump.fun API (${graduated.length} total graduated found)`);
      } else {
        logger.info("GRADUATE", `🌱 No new graduates to seed (${this.graduates.length} already tracked)`);
      }
    } catch (err) {
      logger.warn("GRADUATE", `Seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
