// ── Social Scanner: Meme virality detection + pump.fun first-mover detection ──
// Searches X.com (via Brave), Reddit, Google Suggest for meme buzz,
// and pump.fun for competing coins.
// All searches are FREE and require NO API keys.

import { logger } from "./logger.js";

const PUMP_API_V3 = "https://frontend-api-v3.pump.fun";
const FETCH_TIMEOUT_MS = 5_000;

// ── Rate limiting ──
const PUMP_SEARCH_MIN_INTERVAL_MS = 2_000;
const SOCIAL_SEARCH_MIN_INTERVAL_MS = 1_500;
const BRAVE_SEARCH_MIN_INTERVAL_MS = 2_000; // Brave needs a bit more spacing

// ── Cache TTL ──
const CACHE_TTL_MS = 3 * 60_000; // 3 min — meme landscape changes fast

// ── Types ──

export interface SocialSignal {
  scanned: boolean;
  query: string;

  // ── X.com / Twitter data (via Brave Search) ──
  /** Number of tweets found mentioning this token */
  xTweetCount: number;
  /** Number of X.com profiles related to this token */
  xProfileCount: number;
  /** Total X.com results (tweets + profiles + other) */
  xTotalResults: number;
  /** Top tweet snippet (if found) */
  topTweet?: { author: string; text: string; url: string };
  /** Whether this is trending on X.com */
  isXTrending: boolean;

  // ── Social buzz (Reddit + Google Suggest) ──
  /** Number of Reddit posts found mentioning this meme */
  redditPosts: number;
  /** Total Reddit engagement (upvotes + comments) */
  redditEngagement: number;
  /** Top Reddit post (if found) */
  topRedditPost?: { title: string; ups: number; comments: number; subreddit: string };
  /** Whether Google Suggest autocompletes this as a meme */
  googleSuggestMeme: boolean;
  /** Whether Google Suggest autocompletes this as crypto */
  googleSuggestCrypto: boolean;
  /** Number of suggest completions found */
  suggestCount: number;
  /** Whether this appears to be a viral/trending meme */
  isViralMeme: boolean;

  // ── pump.fun first-mover data ──
  competingCoins: number;
  isFirstMover: boolean;
  highestCompetitorMcap: number;

  // ── Combined score ──
  score: number;
  summary: string;
}

export class SocialScanner {
  private cache = new Map<string, { data: SocialSignal; ts: number }>();
  private lastPumpSearchAt = 0;
  private lastSocialSearchAt = 0;
  private lastBraveSearchAt = 0;

  constructor() {
    logger.system(`Social Scanner: X.com (Brave) + Reddit + Google Suggest + pump.fun first-mover detection (FREE, no API keys needed)`);
  }

  /**
   * Analyze a token's social presence:
   * 1. Search X.com via Brave Search for tweets/profiles
   * 2. Search Reddit for meme posts matching the name
   * 3. Check Google Suggest for meme/crypto autocomplete
   * 4. Check pump.fun for competing coins (first-mover detection)
   */
  async analyze(name: string, symbol: string, mint: string): Promise<SocialSignal> {
    const query = this.buildSearchQuery(name, symbol);
    const cacheKey = query.toLowerCase();

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.data;
    }

    // Run all checks in parallel
    const [xResult, redditResult, suggestResult, pumpResult] = await Promise.all([
      this.searchXcom(query),
      this.searchReddit(query),
      this.searchGoogleSuggest(query),
      this.searchPumpFunDuplicates(name, symbol, mint),
    ]);

    const signal = this.buildSignal(query, xResult, redditResult, suggestResult, pumpResult);

    // Cache
    this.cache.set(cacheKey, { data: signal, ts: Date.now() });

    // Prune old entries
    if (this.cache.size > 200) {
      const cutoff = Date.now() - CACHE_TTL_MS * 2;
      for (const [k, v] of this.cache) {
        if (v.ts < cutoff) this.cache.delete(k);
      }
    }

    if (signal.score > 0) {
      logger.info("SOCIAL", `📱 ${symbol}: ${signal.summary}`);
    }

    return signal;
  }

  /** Build a clean search query from the token name/symbol */
  private buildSearchQuery(name: string, symbol: string): string {
    const cleaned = name
      .replace(/\b(coin|token|inu|doge|pepe|sol|solana|pump|moon|elon)\b/gi, "")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim();
    return cleaned.length >= 3 ? cleaned : symbol;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── X.com Search via Brave (FREE, no auth needed) ──
  // Brave Search returns real X.com links, tweets, and profiles
  // ══════════════════════════════════════════════════════════════════════════

  private async searchXcom(query: string): Promise<XcomResult> {
    const now = Date.now();
    const elapsed = now - this.lastBraveSearchAt;
    if (elapsed < BRAVE_SEARCH_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, BRAVE_SEARCH_MIN_INTERVAL_MS - elapsed));
    }
    this.lastBraveSearchAt = Date.now();

    try {
      const searchQuery = `${query} memecoin site:x.com`;
      const url = `https://search.brave.com/search?q=${encodeURIComponent(searchQuery)}&source=web`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 3000), // Brave can be slower
      });

      if (!res.ok) {
        logger.debug("SOCIAL", `Brave Search returned ${res.status} for X.com query`);
        return { tweets: 0, profiles: 0, totalResults: 0 };
      }

      const html = await res.text();

      // Extract all unique x.com URLs from search results
      const allXLinks = [...new Set(
        [...html.matchAll(/https?:\/\/x\.com\/[^"'\s<>&]+/g)].map((m) => m[0]),
      )];

      // Filter out UI/nav links (keep only user profiles and tweet URLs)
      const meaningfulLinks = allXLinks.filter((link) => {
        const path = link.replace(/https?:\/\/x\.com\/?/, "");
        if (!path || path.startsWith("i/") || path === "home" || path === "explore") return false;
        return true;
      });

      const tweetLinks = meaningfulLinks.filter((l) => l.includes("/status/"));
      const profileLinks = meaningfulLinks.filter((l) => !l.includes("/status/") && !l.includes("/i/"));

      // Extract title/description from <a> tags pointing to x.com
      let topTweet: XcomResult["topTweet"] | undefined;
      const aTags = [...html.matchAll(/<a[^>]*href="(https?:\/\/x\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      for (const m of aTags) {
        const href = m[1];
        if (!href.includes("/status/")) continue;
        const text = m[2].replace(/<[^>]+>/g, "").trim();
        // Extract author from URL: x.com/AUTHOR/status/...
        const authorMatch = href.match(/x\.com\/(\w+)\/status\//);
        if (authorMatch && text.length > 20) {
          // The title text from Brave typically looks like:
          // "X x.com › author › status  Benzinga on X: "actual tweet content..."
          const cleanText = text
            .replace(/^X\s+x\.com\s*›[^"]*"?/, "") // Strip Brave URL prefix
            .replace(/^[^:]+on X:\s*"?/, "") // Strip "Author on X:" prefix
            .replace(/"?\s*$/, "")
            .trim();
          if (cleanText.length >= 10) {
            topTweet = {
              author: `@${authorMatch[1]}`,
              text: cleanText.slice(0, 200),
              url: href.split("?")[0], // Strip ?lang= etc
            };
            break; // Just get the first (top-ranked) tweet
          }
        }
      }

      return {
        tweets: tweetLinks.length,
        profiles: profileLinks.length,
        totalResults: meaningfulLinks.length,
        topTweet,
      };

    } catch (err) {
      logger.debug("SOCIAL", `X.com search (Brave) failed for "${query}": ${err}`);
      return { tweets: 0, profiles: 0, totalResults: 0 };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Reddit Search (FREE, no auth needed) ──
  // ══════════════════════════════════════════════════════════════════════════

  private async searchReddit(query: string): Promise<RedditResult> {
    const now = Date.now();
    const elapsed = now - this.lastSocialSearchAt;
    if (elapsed < SOCIAL_SEARCH_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, SOCIAL_SEARCH_MIN_INTERVAL_MS - elapsed));
    }
    this.lastSocialSearchAt = Date.now();

    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query + " meme")}&sort=relevance&t=week&limit=10`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 PumpTrader/1.0",
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        if (res.status === 429) {
          logger.debug("SOCIAL", `Reddit rate limited — skipping`);
        }
        return { posts: 0, engagement: 0 };
      }

      const data = (await res.json()) as RedditApiResponse;
      if (!data.data?.children?.length) {
        return { posts: 0, engagement: 0 };
      }

      const posts = data.data.children;
      let totalEngagement = 0;
      let topPost: SocialSignal["topRedditPost"] | undefined;
      let maxUps = 0;

      for (const p of posts) {
        const d = p.data;
        const engagement = (d.ups ?? 0) + (d.num_comments ?? 0);
        totalEngagement += engagement;

        if ((d.ups ?? 0) > maxUps) {
          maxUps = d.ups ?? 0;
          topPost = {
            title: (d.title ?? "").slice(0, 200),
            ups: d.ups ?? 0,
            comments: d.num_comments ?? 0,
            subreddit: d.subreddit ?? "",
          };
        }
      }

      return { posts: posts.length, engagement: totalEngagement, topPost };

    } catch (err) {
      logger.debug("SOCIAL", `Reddit search failed for "${query}": ${err}`);
      return { posts: 0, engagement: 0 };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Google Suggest (FREE, no auth needed) ──
  // ══════════════════════════════════════════════════════════════════════════

  private async searchGoogleSuggest(query: string): Promise<SuggestResult> {
    try {
      const [memeRes, cryptoRes] = await Promise.all([
        fetch(
          `https://suggestqueries.google.com/complete/search?q=${encodeURIComponent(query + " meme")}&client=firefox`,
          { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(3000) },
        ),
        fetch(
          `https://suggestqueries.google.com/complete/search?q=${encodeURIComponent(query + " crypto")}&client=firefox`,
          { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(3000) },
        ),
      ]);

      let memeCount = 0;
      let cryptoCount = 0;
      let hasMeme = false;
      let hasCrypto = false;

      if (memeRes.ok) {
        const memeData = (await memeRes.json()) as [string, string[]];
        const suggestions = memeData[1] ?? [];
        memeCount = suggestions.length;
        hasMeme = suggestions.some((s) =>
          s.toLowerCase().includes(query.toLowerCase()) && s.toLowerCase().includes("meme"),
        );
      }

      if (cryptoRes.ok) {
        const cryptoData = (await cryptoRes.json()) as [string, string[]];
        const suggestions = cryptoData[1] ?? [];
        cryptoCount = suggestions.length;
        hasCrypto = suggestions.some((s) =>
          s.toLowerCase().includes(query.toLowerCase()) &&
          (s.toLowerCase().includes("crypto") || s.toLowerCase().includes("coin") || s.toLowerCase().includes("token")),
        );
      }

      return { hasMeme, hasCrypto, totalSuggestions: memeCount + cryptoCount };

    } catch (err) {
      logger.debug("SOCIAL", `Google Suggest failed for "${query}": ${err}`);
      return { hasMeme: false, hasCrypto: false, totalSuggestions: 0 };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── pump.fun First-Mover Detection ──
  // ══════════════════════════════════════════════════════════════════════════

  private async searchPumpFunDuplicates(
    name: string,
    symbol: string,
    ourMint: string,
  ): Promise<PumpSearchResult> {
    const now = Date.now();
    const elapsed = now - this.lastPumpSearchAt;
    if (elapsed < PUMP_SEARCH_MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, PUMP_SEARCH_MIN_INTERVAL_MS - elapsed));
    }
    this.lastPumpSearchAt = Date.now();

    try {
      const searchTerm = symbol.length >= 3 ? symbol : name.split(" ")[0] ?? name;
      const url = `${PUMP_API_V3}/coins?searchTerm=${encodeURIComponent(searchTerm)}&limit=20&sort=market_cap&order=DESC&includeNsfw=false`;

      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        return { competingCoins: -1, isFirstMover: false, highestCompetitorMcap: 0 };
      }

      const coins = (await res.json()) as PumpFunCoin[];
      if (!Array.isArray(coins)) {
        return { competingCoins: -1, isFirstMover: false, highestCompetitorMcap: 0 };
      }

      const similar = coins.filter((c) => {
        if (c.mint === ourMint) return false;
        return c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          c.symbol.toLowerCase() === symbol.toLowerCase();
      });

      const highestMcap = similar.reduce((max, c) => Math.max(max, c.market_cap ?? 0), 0);
      const isFirstMover = similar.length <= 1 ||
        (similar.length <= 3 && highestMcap < 100);

      return { competingCoins: similar.length, isFirstMover, highestCompetitorMcap: highestMcap };

    } catch (err) {
      logger.debug("SOCIAL", `Pump.fun search failed for "${symbol}": ${err}`);
      return { competingCoins: -1, isFirstMover: false, highestCompetitorMcap: 0 };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Score Calculation ──
  // ══════════════════════════════════════════════════════════════════════════

  private buildSignal(
    query: string,
    xcom: XcomResult,
    reddit: RedditResult,
    suggest: SuggestResult,
    pump: PumpSearchResult,
  ): SocialSignal {
    let score = 0;
    const parts: string[] = [];

    // ── X.com / Twitter scoring (PRIMARY signal) ──
    const isXTrending = (xcom.tweets >= 5 && xcom.totalResults >= 8) ||
      xcom.tweets >= 10;
    const hasXBuzz = xcom.tweets >= 2 || (xcom.profiles >= 2 && xcom.totalResults >= 5);
    const hasXProfile = xcom.profiles >= 1;

    if (isXTrending) {
      score += 14; // X.com trending is the strongest signal
      parts.push(`🐦 TRENDING on X.com (${xcom.tweets} tweets, ${xcom.profiles} profiles)`);
    } else if (hasXBuzz) {
      score += 7;
      parts.push(`🐦 X.com buzz (${xcom.tweets} tweets, ${xcom.profiles} profiles)`);
    } else if (hasXProfile) {
      score += 3;
      parts.push(`🐦 Has X.com presence (${xcom.profiles} profiles)`);
    } else if (xcom.totalResults === 0) {
      score -= 2;
      parts.push(`🐦 No X.com presence`);
    }

    if (xcom.topTweet) {
      parts.push(`Top tweet by ${xcom.topTweet.author}: "${xcom.topTweet.text.slice(0, 80)}..."`);
    }

    // ── Reddit engagement scoring ──
    const isViralReddit = (reddit.posts >= 3 && reddit.engagement >= 500) ||
      (reddit.topPost && reddit.topPost.ups >= 200);
    const hasBuzz = reddit.posts >= 2 && reddit.engagement >= 50;

    if (isViralReddit) {
      score += 10;
      parts.push(`🔥 VIRAL on Reddit (${reddit.posts} posts, ${reddit.engagement} engagement)`);
    } else if (hasBuzz) {
      score += 5;
      parts.push(`📈 Reddit buzz (${reddit.posts} posts, ${reddit.engagement} engagement)`);
    } else if (reddit.posts > 0) {
      score += 2;
      parts.push(`📱 Some Reddit presence (${reddit.posts} posts)`);
    }

    // ── Google Suggest scoring ──
    if (suggest.hasMeme && suggest.hasCrypto) {
      score += 5;
      parts.push(`🔍 Google: trending as meme + crypto`);
    } else if (suggest.hasMeme) {
      score += 3;
      parts.push(`🔍 Google: known meme`);
    } else if (suggest.hasCrypto) {
      score += 2;
      parts.push(`🔍 Google: known in crypto`);
    }

    // ── Combined virality (X.com is now primary) ──
    const isViral = isXTrending || isViralReddit || (hasXBuzz && hasBuzz) || (hasBuzz && suggest.hasMeme);

    // ── First-mover scoring ──
    if (pump.competingCoins >= 0) {
      if (pump.isFirstMover) {
        score += 10;
        parts.push(`🥇 FIRST MOVER (${pump.competingCoins} competitors)`);
      } else if (pump.competingCoins <= 5) {
        score += 3;
        parts.push(`🏃 Early mover (${pump.competingCoins} competitors, top: ${pump.highestCompetitorMcap.toFixed(0)} SOL mcap)`);
      } else {
        score -= 3;
        parts.push(`⚠️ Saturated (${pump.competingCoins} competitors, top: ${pump.highestCompetitorMcap.toFixed(0)} SOL mcap)`);
      }
    }

    // ── Combo: viral meme + first mover = jackpot ──
    if (isViral && pump.isFirstMover) {
      score += 5;
      parts.push(`💎 JACKPOT: Viral meme + first coin!`);
    }

    // ── Combo: X.com trending + first mover ──
    if (isXTrending && pump.isFirstMover) {
      score += 3;
      parts.push(`🚀 X.com hype + first mover = moon potential`);
    }

    score = Math.max(0, Math.min(30, score)); // Raised cap from 25 to 30 with X.com
    const summary = parts.length > 0 ? parts.join(" | ") : "No social signal";

    return {
      scanned: true,
      query,
      xTweetCount: xcom.tweets,
      xProfileCount: xcom.profiles,
      xTotalResults: xcom.totalResults,
      topTweet: xcom.topTweet,
      isXTrending,
      redditPosts: reddit.posts,
      redditEngagement: reddit.engagement,
      topRedditPost: reddit.topPost,
      googleSuggestMeme: suggest.hasMeme,
      googleSuggestCrypto: suggest.hasCrypto,
      suggestCount: suggest.totalSuggestions,
      isViralMeme: isViral,
      competingCoins: pump.competingCoins,
      isFirstMover: pump.isFirstMover,
      highestCompetitorMcap: pump.highestCompetitorMcap,
      score,
      summary,
    };
  }

  /** Get stats for status endpoint */
  getStats() {
    return { cacheSize: this.cache.size };
  }
}

// ── Internal types ──

interface XcomResult {
  tweets: number;
  profiles: number;
  totalResults: number;
  topTweet?: { author: string; text: string; url: string };
}

interface RedditResult {
  posts: number;
  engagement: number;
  topPost?: SocialSignal["topRedditPost"];
}

interface SuggestResult {
  hasMeme: boolean;
  hasCrypto: boolean;
  totalSuggestions: number;
}

interface PumpSearchResult {
  competingCoins: number;
  isFirstMover: boolean;
  highestCompetitorMcap: number;
}

interface RedditApiResponse {
  data?: {
    children?: Array<{
      data: {
        title?: string;
        ups?: number;
        num_comments?: number;
        subreddit?: string;
        created_utc?: number;
      };
    }>;
  };
}

interface PumpFunCoin {
  mint: string;
  name: string;
  symbol: string;
  market_cap?: number;
  complete?: boolean;
}
