// ── Winner Research Module ──
// Fetches data for the highest market-cap pump.fun tokens, analyzes what made them
// successful, and stores patterns the agent can use to catch future big winners early.
// Uses pump.fun v3 API + DexScreener API for enriched data.

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const PUMP_API_V3 = "https://frontend-api-v3.pump.fun";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";
const FETCH_TIMEOUT_MS = 15_000;

// ── Types ──

export interface WinnerProfile {
  mint: string;
  symbol: string;
  name: string;
  description: string;
  /** USD market cap at time of research */
  usdMarketCap: number;
  /** SOL market cap */
  solMarketCap: number;
  /** Whether it graduated from bonding curve */
  graduated: boolean;
  /** Creator wallet address */
  creator: string;
  /** Token creation timestamp */
  createdAt: number;
  /** Time to reach "king of the hill" (ms from creation) */
  timeToKOTH: number | null;
  /** Program type: "pump" (legacy) or other */
  program: string;
  /** Reply count on pump.fun */
  replyCount: number;
  /** Social links found */
  socials: { type: string; url: string }[];
  /** Website URL */
  website: string | null;
  /** Has Twitter/X account */
  hasTwitter: boolean;
  /** Has Telegram */
  hasTelegram: boolean;
  /** Has website */
  hasWebsite: boolean;
  /** Description keywords */
  descriptionKeywords: string[];
  /** Name length */
  nameLength: number;
  /** Symbol length */
  symbolLength: number;
  /** DexScreener data (if available) */
  dexData: {
    priceUsd: number;
    volume24h: number;
    liquidity: number;
    fdv: number;
    buys24h: number;
    sells24h: number;
    priceChange24h: number;
  } | null;
  /** Age in days at time of research */
  ageDays: number;
  /** Rank in the top-mcap list (1 = highest) */
  rank: number;
}

export interface WinnerPatterns {
  /** When this analysis was generated */
  analyzedAt: number;
  /** Total tokens analyzed */
  totalAnalyzed: number;

  // ── Aggregated Pattern Data ──

  /** Most common narrative themes across winners */
  topThemes: { theme: string; count: number; avgMarketCap: number }[];
  /** Name/symbol characteristics */
  namingPatterns: {
    avgNameLength: number;
    avgSymbolLength: number;
    commonNameWords: { word: string; count: number }[];
    commonSymbolPatterns: string[];
  };
  /** Social presence correlation */
  socialPatterns: {
    withTwitterPct: number;
    withTelegramPct: number;
    withWebsitePct: number;
    withAnySocialPct: number;
    avgRepliesTop10: number;
    avgRepliesAll: number;
  };
  /** Timing patterns */
  timingPatterns: {
    avgTimeToKOTHMinutes: number;
    medianTimeToKOTHMinutes: number;
    avgAgeDays: number;
    /** Day of week distribution (0=Sun, 6=Sat) */
    dayOfWeekDistribution: Record<number, number>;
  };
  /** Program distribution */
  programDistribution: Record<string, number>;
  /** Market cap tiers */
  marketCapTiers: {
    tier: string;
    count: number;
    avgReplies: number;
    avgAge: number;
  }[];
  /** Key insights — natural language patterns for the agent */
  keyInsights: string[];
  /** Individual profiles for the top 20 */
  topProfiles: WinnerProfile[];
}

export interface ResearchReport {
  patterns: WinnerPatterns | null;
  lastRun: number;
  totalResearched: number;
  errors: string[];
  status: "idle" | "running" | "complete" | "error";
  progress: { current: number; total: number };
}

// ── Main Research Engine ──

export class WinnerResearch {
  private report: ResearchReport;
  private dataPath: string;
  private running = false;

  constructor(dataDir: string = "./data") {
    this.dataPath = path.join(dataDir, "winner-research.json");
    this.report = {
      patterns: null,
      lastRun: 0,
      totalResearched: 0,
      errors: [],
      status: "idle",
      progress: { current: 0, total: 0 },
    };
    this.load();
  }

  getReport(): ResearchReport {
    return this.report;
  }

  getPatterns(): WinnerPatterns | null {
    return this.report.patterns;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run the full research pipeline:
   * 1. Fetch top pump.fun tokens by market cap
   * 2. Enrich with DexScreener data
   * 3. Analyze patterns
   * 4. Store results
   */
  async runResearch(count: number = 100): Promise<WinnerPatterns> {
    if (this.running) {
      throw new Error("Research already in progress");
    }

    this.running = true;
    this.report.status = "running";
    this.report.errors = [];
    this.report.progress = { current: 0, total: count };

    logger.system(`🔬 Starting winner research — analyzing top ${count} pump.fun tokens...`);

    try {
      // Step 1: Fetch top tokens from pump.fun
      const profiles = await this.fetchTopTokens(count);
      logger.info("RESEARCH", `📊 Fetched ${profiles.length} token profiles from pump.fun`);

      // Step 2: Enrich with DexScreener (batch by 30 to avoid rate limits)
      await this.enrichWithDexScreener(profiles);
      logger.info("RESEARCH", `📊 Enriched ${profiles.length} tokens with DexScreener data`);

      // Step 3: Analyze patterns
      const patterns = this.analyzePatterns(profiles);
      logger.info("RESEARCH", `📊 Pattern analysis complete — ${patterns.keyInsights.length} insights found`);

      // Step 4: Store
      this.report.patterns = patterns;
      this.report.lastRun = Date.now();
      this.report.totalResearched = profiles.length;
      this.report.status = "complete";
      this.persist();

      logger.system(`🔬 Winner research complete! Analyzed ${profiles.length} tokens, found ${patterns.keyInsights.length} key insights`);

      return patterns;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.report.errors.push(msg);
      this.report.status = "error";
      logger.error("RESEARCH", `Research failed: ${msg}`);
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** Fetch top tokens by market cap from pump.fun */
  private async fetchTopTokens(count: number): Promise<WinnerProfile[]> {
    const profiles: WinnerProfile[] = [];
    const batchSize = 50;
    const batches = Math.ceil(count / batchSize);

    for (let i = 0; i < batches; i++) {
      const offset = i * batchSize;
      const limit = Math.min(batchSize, count - offset);

      try {
        const url = `${PUMP_API_V3}/coins?offset=${offset}&limit=${limit}&sort=market_cap&order=DESC&includeNsfw=false`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });

        if (!res.ok) {
          logger.warn("RESEARCH", `pump.fun API ${res.status} for batch ${i}`);
          continue;
        }

        const coins = (await res.json()) as any[];
        if (!Array.isArray(coins)) continue;

        for (let j = 0; j < coins.length; j++) {
          const c = coins[j];
          const rank = offset + j + 1;
          const now = Date.now();
          const createdAt = c.created_timestamp ?? now;
          const kotTimestamp = c.king_of_the_hill_timestamp;

          // Extract keywords from description
          const desc = (c.description || "").toLowerCase();
          const descWords = desc
            .replace(/https?:\/\/\S+/g, "")
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w: string) => w.length >= 3)
            .slice(0, 20);

          const profile: WinnerProfile = {
            mint: c.mint,
            symbol: c.symbol || "",
            name: c.name || "",
            description: (c.description || "").slice(0, 500),
            usdMarketCap: c.usd_market_cap ?? 0,
            solMarketCap: c.market_cap ?? 0,
            graduated: c.complete ?? false,
            creator: c.creator || "",
            createdAt,
            timeToKOTH: kotTimestamp ? (kotTimestamp - createdAt) : null,
            program: c.program || "unknown",
            replyCount: c.reply_count ?? 0,
            socials: [],
            website: c.website || null,
            hasTwitter: !!(c.twitter),
            hasTelegram: false,
            hasWebsite: !!(c.website),
            descriptionKeywords: descWords,
            nameLength: (c.name || "").length,
            symbolLength: (c.symbol || "").length,
            dexData: null,
            ageDays: (now - createdAt) / (24 * 3600_000),
            rank,
          };

          // Check description for social links
          if (desc.includes("t.me/") || desc.includes("telegram")) {
            profile.hasTelegram = true;
          }
          if (desc.includes("twitter.com/") || desc.includes("x.com/")) {
            profile.hasTwitter = true;
          }
          if (desc.includes("http") && !desc.includes("pump.fun")) {
            profile.hasWebsite = true;
          }

          profiles.push(profile);
          this.report.progress.current = profiles.length;
        }

        // Small delay between batches to avoid rate limiting
        if (i < batches - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("RESEARCH", `Batch ${i} fetch failed: ${msg}`);
        this.report.errors.push(`Batch ${i}: ${msg}`);
      }
    }

    return profiles;
  }

  /** Enrich profiles with DexScreener data (socials, volume, liquidity) */
  private async enrichWithDexScreener(profiles: WinnerProfile[]): Promise<void> {
    // DexScreener API allows up to 30 token addresses per request
    const batchSize = 30;
    const batches = Math.ceil(profiles.length / batchSize);
    const mintIndex = new Map<string, WinnerProfile>();
    for (const p of profiles) mintIndex.set(p.mint, p);

    for (let i = 0; i < batches; i++) {
      const batch = profiles.slice(i * batchSize, (i + 1) * batchSize);
      const mints = batch.map((p) => p.mint).join(",");

      try {
        const res = await fetch(`${DEXSCREENER_API}/${mints}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });

        if (!res.ok) {
          logger.warn("RESEARCH", `DexScreener ${res.status} for batch ${i}`);
          continue;
        }

        const data = (await res.json()) as any;
        const pairs = data?.pairs;
        if (!Array.isArray(pairs)) continue;

        // Group pairs by base token mint, take the one with highest liquidity
        const bestPair = new Map<string, any>();
        for (const pair of pairs) {
          const baseMint = pair.baseToken?.address;
          if (!baseMint) continue;
          const existing = bestPair.get(baseMint);
          if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
            bestPair.set(baseMint, pair);
          }
        }

        for (const [mint, pair] of bestPair) {
          const profile = mintIndex.get(mint);
          if (!profile) continue;

          profile.dexData = {
            priceUsd: parseFloat(pair.priceUsd) || 0,
            volume24h: pair.volume?.h24 ?? 0,
            liquidity: pair.liquidity?.usd ?? 0,
            fdv: pair.fdv ?? 0,
            buys24h: pair.txns?.h24?.buys ?? 0,
            sells24h: pair.txns?.h24?.sells ?? 0,
            priceChange24h: pair.priceChange?.h24 ?? 0,
          };

          // Enrich socials from DexScreener
          const socials = pair.info?.socials;
          if (Array.isArray(socials)) {
            profile.socials = socials.map((s: any) => ({ type: s.type, url: s.url }));
            for (const s of socials) {
              if (s.type === "twitter") profile.hasTwitter = true;
              if (s.type === "telegram") profile.hasTelegram = true;
            }
          }
          if (pair.info?.websites?.length > 0) {
            profile.hasWebsite = true;
            profile.website = pair.info.websites[0]?.url ?? profile.website;
          }
        }

        // Rate limit courtesy
        if (i < batches - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("RESEARCH", `DexScreener batch ${i} failed: ${msg}`);
      }
    }
  }

  /** Analyze patterns across all winner profiles */
  private analyzePatterns(profiles: WinnerProfile[]): WinnerPatterns {
    const now = Date.now();

    // ── Theme extraction ──
    const themeCounts = new Map<string, { count: number; totalMcap: number }>();
    const themeKeywords = [
      "ai", "agent", "gpt", "claude", "llm", "bot", "intelligence",
      "trump", "maga", "politic", "president", "election",
      "cat", "dog", "pepe", "frog", "monkey", "ape", "bear", "bull", "penguin", "duck",
      "elon", "musk", "doge",
      "sol", "solana", "eth", "btc", "bitcoin", "crypto",
      "anime", "waifu", "nft", "art",
      "moon", "rocket", "100x", "gem", "pump",
      "meme", "degen", "chad", "based", "gigachad",
      "baby", "mini", "micro",
      "king", "queen", "god", "lord",
      "cash", "money", "rich", "gold", "diamond",
      "love", "heart",
      "dark", "devil", "hell",
      "game", "gaming", "play",
      "music", "dance",
    ];

    for (const p of profiles) {
      const text = `${p.name} ${p.symbol} ${p.description}`.toLowerCase();
      for (const kw of themeKeywords) {
        if (text.includes(kw)) {
          const entry = themeCounts.get(kw) ?? { count: 0, totalMcap: 0 };
          entry.count++;
          entry.totalMcap += p.usdMarketCap;
          themeCounts.set(kw, entry);
        }
      }
    }

    const topThemes = [...themeCounts.entries()]
      .filter(([, v]) => v.count >= 2)
      .map(([theme, v]) => ({
        theme,
        count: v.count,
        avgMarketCap: v.totalMcap / v.count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    // ── Name/Symbol analysis ──
    const allNameWords = new Map<string, number>();
    for (const p of profiles) {
      const words = p.name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length >= 2);
      for (const w of words) {
        allNameWords.set(w, (allNameWords.get(w) ?? 0) + 1);
      }
    }
    const commonNameWords = [...allNameWords.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word, count]) => ({ word, count }));

    // Common symbol patterns
    const symbolPatterns: string[] = [];
    const allCaps = profiles.filter(p => p.symbol === p.symbol.toUpperCase()).length;
    const allLower = profiles.filter(p => p.symbol === p.symbol.toLowerCase()).length;
    if (allCaps > profiles.length * 0.5) symbolPatterns.push(`${((allCaps / profiles.length) * 100).toFixed(0)}% use ALL CAPS symbols`);
    if (allLower > profiles.length * 0.3) symbolPatterns.push(`${((allLower / profiles.length) * 100).toFixed(0)}% use all lowercase symbols`);

    const avgNameLen = profiles.reduce((s, p) => s + p.nameLength, 0) / profiles.length;
    const avgSymLen = profiles.reduce((s, p) => s + p.symbolLength, 0) / profiles.length;

    // ── Social presence ──
    const withTwitter = profiles.filter(p => p.hasTwitter).length;
    const withTelegram = profiles.filter(p => p.hasTelegram).length;
    const withWebsite = profiles.filter(p => p.hasWebsite).length;
    const withAnySocial = profiles.filter(p => p.hasTwitter || p.hasTelegram || p.hasWebsite).length;
    const top10 = profiles.slice(0, 10);
    const avgRepliesTop10 = top10.reduce((s, p) => s + p.replyCount, 0) / top10.length;
    const avgRepliesAll = profiles.reduce((s, p) => s + p.replyCount, 0) / profiles.length;

    // ── Timing patterns ──
    const kothTimes = profiles
      .filter(p => p.timeToKOTH !== null && p.timeToKOTH! > 0)
      .map(p => p.timeToKOTH! / 60_000); // convert to minutes
    const avgKOTH = kothTimes.length > 0 ? kothTimes.reduce((s, v) => s + v, 0) / kothTimes.length : 0;
    const sortedKOTH = [...kothTimes].sort((a, b) => a - b);
    const medianKOTH = sortedKOTH.length > 0 ? sortedKOTH[Math.floor(sortedKOTH.length / 2)] : 0;
    const avgAge = profiles.reduce((s, p) => s + p.ageDays, 0) / profiles.length;

    const dayDistrib: Record<number, number> = {};
    for (const p of profiles) {
      const day = new Date(p.createdAt).getUTCDay();
      dayDistrib[day] = (dayDistrib[day] ?? 0) + 1;
    }

    // ── Program distribution ──
    const progDist: Record<string, number> = {};
    for (const p of profiles) {
      progDist[p.program] = (progDist[p.program] ?? 0) + 1;
    }

    // ── Market cap tiers ──
    const tiers = [
      { tier: "$100M+", min: 100_000_000, max: Infinity },
      { tier: "$10M-$100M", min: 10_000_000, max: 100_000_000 },
      { tier: "$1M-$10M", min: 1_000_000, max: 10_000_000 },
      { tier: "$100K-$1M", min: 100_000, max: 1_000_000 },
      { tier: "<$100K", min: 0, max: 100_000 },
    ];
    const marketCapTiers = tiers.map(t => {
      const inTier = profiles.filter(p => p.usdMarketCap >= t.min && p.usdMarketCap < t.max);
      return {
        tier: t.tier,
        count: inTier.length,
        avgReplies: inTier.length > 0 ? inTier.reduce((s, p) => s + p.replyCount, 0) / inTier.length : 0,
        avgAge: inTier.length > 0 ? inTier.reduce((s, p) => s + p.ageDays, 0) / inTier.length : 0,
      };
    });

    // ── Generate key insights ──
    const insights: string[] = [];

    // Social presence insight
    const socialPct = (withAnySocial / profiles.length * 100).toFixed(0);
    insights.push(`${socialPct}% of top winners have at least one social link (Twitter, Telegram, or website)`);

    const twitterPct = (withTwitter / profiles.length * 100).toFixed(0);
    insights.push(`${twitterPct}% of top winners have a Twitter/X presence — this is a STRONG signal`);

    if (withTelegram > profiles.length * 0.3) {
      insights.push(`${((withTelegram / profiles.length) * 100).toFixed(0)}% have Telegram — community engagement matters`);
    }

    // Reply count insight
    insights.push(`Top 10 winners average ${avgRepliesTop10.toFixed(0)} replies vs ${avgRepliesAll.toFixed(0)} for all top tokens — viral social engagement is a key differentiator`);

    // Naming insight
    insights.push(`Winning tokens have avg name length ${avgNameLen.toFixed(1)} chars, symbol length ${avgSymLen.toFixed(1)} chars`);
    if (commonNameWords.length > 0) {
      insights.push(`Most common words in winner names: ${commonNameWords.slice(0, 10).map(w => w.word).join(", ")}`);
    }

    // Theme insight
    if (topThemes.length > 0) {
      const top5Themes = topThemes.slice(0, 5).map(t => `"${t.theme}" (${t.count})`).join(", ");
      insights.push(`Hottest narrative themes among winners: ${top5Themes}`);
    }

    // Graduated insight
    const gradPct = (profiles.filter(p => p.graduated).length / profiles.length * 100).toFixed(0);
    insights.push(`${gradPct}% of top tokens have graduated from the bonding curve`);

    // KOTH timing insight
    if (medianKOTH > 0) {
      insights.push(`Median time to King of the Hill: ${medianKOTH.toFixed(1)} minutes — early momentum is critical`);
    }

    // Market cap tier insight
    for (const t of marketCapTiers) {
      if (t.count > 0) {
        insights.push(`${t.tier}: ${t.count} tokens (avg ${t.avgReplies.toFixed(0)} replies, avg ${t.avgAge.toFixed(0)} days old)`);
      }
    }

    // Top profiles analysis — what the truly elite winners have in common
    const topN = Math.min(20, profiles.length);
    const topProfiles = profiles.slice(0, topN);
    const topWithTwitter = topProfiles.filter(p => p.hasTwitter).length;
    if (topWithTwitter > topN * 0.6) {
      insights.push(`${((topWithTwitter / topN) * 100).toFixed(0)}% of the TOP ${topN} winners have Twitter — social proof is near-mandatory for mega-cap outcomes`);
    }

    // Volume insight from DexScreener
    const withDex = profiles.filter(p => p.dexData);
    if (withDex.length > 5) {
      const avgVol = withDex.reduce((s, p) => s + (p.dexData?.volume24h ?? 0), 0) / withDex.length;
      const avgLiq = withDex.reduce((s, p) => s + (p.dexData?.liquidity ?? 0), 0) / withDex.length;
      insights.push(`Average 24h volume for top winners: $${(avgVol / 1_000_000).toFixed(1)}M, avg liquidity: $${(avgLiq / 1_000_000).toFixed(1)}M`);
    }

    return {
      analyzedAt: now,
      totalAnalyzed: profiles.length,
      topThemes,
      namingPatterns: {
        avgNameLength: avgNameLen,
        avgSymbolLength: avgSymLen,
        commonNameWords,
        commonSymbolPatterns: symbolPatterns,
      },
      socialPatterns: {
        withTwitterPct: withTwitter / profiles.length,
        withTelegramPct: withTelegram / profiles.length,
        withWebsitePct: withWebsite / profiles.length,
        withAnySocialPct: withAnySocial / profiles.length,
        avgRepliesTop10,
        avgRepliesAll,
      },
      timingPatterns: {
        avgTimeToKOTHMinutes: avgKOTH,
        medianTimeToKOTHMinutes: medianKOTH,
        avgAgeDays: avgAge,
        dayOfWeekDistribution: dayDistrib,
      },
      programDistribution: progDist,
      marketCapTiers,
      keyInsights: insights,
      topProfiles,
    };
  }

  /**
   * Build a natural-language briefing for injection into agent prompts.
   * Summarizes the key patterns learned from studying winners.
   */
  getBriefing(): string {
    const patterns = this.report.patterns;
    if (!patterns) return "";

    const ageHrs = Math.round((Date.now() - patterns.analyzedAt) / 3_600_000);
    const lines: string[] = [];

    lines.push(`═══ WINNER RESEARCH (${patterns.totalAnalyzed} top pump.fun tokens analyzed, ${ageHrs}h ago) ═══`);
    lines.push("");

    // Key insights
    lines.push("KEY INSIGHTS FROM TOP WINNERS:");
    for (const insight of patterns.keyInsights) {
      lines.push(`  • ${insight}`);
    }
    lines.push("");

    // Top themes
    if (patterns.topThemes.length > 0) {
      lines.push("WINNING NARRATIVES (themes found in high-mcap tokens):");
      for (const t of patterns.topThemes.slice(0, 15)) {
        lines.push(`  "${t.theme}": ${t.count} winners, avg mcap $${(t.avgMarketCap / 1_000_000).toFixed(1)}M`);
      }
      lines.push("");
    }

    // Social proof requirements
    lines.push("SOCIAL PROOF REQUIREMENTS:");
    lines.push(`  Twitter: ${(patterns.socialPatterns.withTwitterPct * 100).toFixed(0)}% of winners`);
    lines.push(`  Telegram: ${(patterns.socialPatterns.withTelegramPct * 100).toFixed(0)}% of winners`);
    lines.push(`  Website: ${(patterns.socialPatterns.withWebsitePct * 100).toFixed(0)}% of winners`);
    lines.push(`  Any social: ${(patterns.socialPatterns.withAnySocialPct * 100).toFixed(0)}% of winners`);
    lines.push(`  Avg replies (top 10): ${patterns.socialPatterns.avgRepliesTop10.toFixed(0)}`);
    lines.push("");

    // Naming patterns
    lines.push("NAMING PATTERNS:");
    lines.push(`  Avg name length: ${patterns.namingPatterns.avgNameLength.toFixed(1)} chars`);
    lines.push(`  Avg symbol length: ${patterns.namingPatterns.avgSymbolLength.toFixed(1)} chars`);
    if (patterns.namingPatterns.commonNameWords.length > 0) {
      lines.push(`  Common words: ${patterns.namingPatterns.commonNameWords.slice(0, 10).map(w => w.word).join(", ")}`);
    }
    lines.push("");

    // Top 10 profiles
    lines.push("TOP 10 WINNERS (by market cap):");
    for (const p of patterns.topProfiles.slice(0, 10)) {
      const socials = [
        p.hasTwitter ? "Twitter" : null,
        p.hasTelegram ? "Telegram" : null,
        p.hasWebsite ? "Website" : null,
      ].filter(Boolean).join("+") || "No socials";
      const mcapStr = p.usdMarketCap >= 1_000_000
        ? `$${(p.usdMarketCap / 1_000_000).toFixed(1)}M`
        : `$${(p.usdMarketCap / 1_000).toFixed(0)}K`;
      lines.push(`  #${p.rank} ${p.symbol.toUpperCase()} (${p.name}): ${mcapStr} mcap, ${p.replyCount} replies, ${p.ageDays.toFixed(0)}d old, ${socials}${p.graduated ? " ✅graduated" : ""}`);
    }

    lines.push("");
    lines.push("USE THIS KNOWLEDGE TO:");
    lines.push("  1. Prioritize tokens with social links (especially Twitter) — they have much higher upside");
    lines.push("  2. Look for tokens riding trending narratives (AI, political figures, popular memes)");
    lines.push("  3. Favor tokens with early community engagement (replies, KOTH speed)");
    lines.push("  4. Use naming patterns to identify well-crafted vs lazy tokens");

    return lines.join("\n");
  }

  /** Compact briefing for token review prompts (~150 tokens vs ~982) */
  getCompactBriefing(): string {
    const patterns = this.report.patterns;
    if (!patterns) return "";

    const lines: string[] = [];
    lines.push("WINNER RESEARCH (compact):");

    // Top 3 themes only
    if (patterns.topThemes.length > 0) {
      const top3 = patterns.topThemes.slice(0, 3).map(t => `"${t.theme}" (${t.count}x)`).join(", ");
      lines.push(`  Hot narratives: ${top3}`);
    }

    // Top 3 insights only
    for (const insight of patterns.keyInsights.slice(0, 3)) {
      lines.push(`  • ${insight}`);
    }

    // Social summary — one line
    lines.push(`  Social: ${(patterns.socialPatterns.withTwitterPct * 100).toFixed(0)}% winners have Twitter, ${(patterns.socialPatterns.withAnySocialPct * 100).toFixed(0)}% any social`);

    return lines.join("\n");
  }

  // ── Persistence ──

  private persist(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(this.report, null, 2), "utf-8");
    } catch (err) {
      logger.error("RESEARCH", `Failed to persist research: ${err}`);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;
      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const data = JSON.parse(raw) as ResearchReport;
      if (data.patterns) {
        this.report = data;
        this.report.status = "complete"; // Reset status on load
        logger.info("RESEARCH", `Loaded winner research: ${data.totalResearched} tokens analyzed`);
      }
    } catch (err) {
      logger.error("RESEARCH", `Failed to load research: ${err}`);
    }
  }
}
