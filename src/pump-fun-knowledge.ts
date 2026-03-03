// ── Pump.fun Expert Knowledge Base ──
// Compiled from analysis of 567,876 tokens, Reddit community strategies,
// and successful bot builder insights. This is injected into the RAG system
// and LLM prompts to give the agent expert-level domain knowledge.

// ═══════════════════════════════════════════════════════════════════════════
// DATA: Analysis of 567,876 pump.fun tokens (source: obolli/wangr.com)
// ═══════════════════════════════════════════════════════════════════════════

export const TOKEN_GRADUATION_DATA = {
  totalTokensAnalyzed: 567_876,
  graduatedTokens: 2_770,
  graduationRate: 0.0043, // 0.43% — less than half a percent graduate
  matchedGraduated: 2_462,

  // Time to graduation
  medianTimeToGraduationHours: 0.17, // ~10 minutes
  meanTimeToGraduationHours: 5.8,    // skewed by outliers
  // KEY INSIGHT: If a token graduates, it usually happens in ~10 minutes

  // Best days (graduation rate)
  bestDays: {
    friday: 0.0068,    // 0.68% — BEST
    saturday: 0.0060,  // 0.60%
    sunday: 0.0060,    // 0.60%
    monday: 0.0043,    // 0.43%
    thursday: 0.0041,  // 0.41%
    wednesday: 0.0026, // 0.26%
    tuesday: 0.0004,   // 0.04% — WORST (graveyard)
  },

  // Best hours UTC (graduation rate)
  bestHoursUTC: [12, 13, 11, 3, 14], // 11-14 UTC = US morning / EU afternoon overlap

  // Token types
  legacyGradRate: 0.0166,    // 1.66% — Legacy (Metaplex) tokens graduate 5x more
  token2022GradRate: 0.0032, // 0.32% — Token2022 tokens (91% of all tokens)

  // Mayhem mode
  normalGradRate: 0.0161,    // 1.61% — Normal mode tokens
  mayhemGradRate: 0.0032,    // 0.32% — Mayhem mode (91% of tokens, 5x worse)
  normalMedianGradMinutes: 2,
  mayhemMedianGradMinutes: 21,

  // FDV at graduation
  fdvUnder100k: 0.94,  // 94% graduate with FDV < $100k
  fdvUnder500k: 0.984, // 98.4% under $500k

  // Liquidity at graduation
  liq1kTo10k: 0.732,   // 73.2% graduate with $1k-$10k liquidity
  liq10kTo50k: 0.236,  // 23.6%

  // Name/symbol patterns
  optimalSymbolLength: [4, 5, 6], // 0.45-0.46% graduation rate
  optimalNameLength: [4, 5, 6, 7, 8],
  highGradWords: ["comedian", "benny", "boxabl", "peepo", "whale", "wojak"],
  zeroGradWords: ["mori", "read"], // 4913 and 2534 uses, 0 graduations

  // URL requirement
  noUrlGradRate: 0, // 0% — tokens without metadata URL NEVER graduate
};

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGIES: Compiled from successful traders on Reddit
// ═══════════════════════════════════════════════════════════════════════════

export const EXPERT_STRATEGIES = {
  // Position management (from multiple sources)
  positionManagement: {
    maxPositionPct: 10,        // Never more than 10% of bankroll on one trade
    startSmall: 0.05,          // Start with 0.05 SOL to learn ($7-8)
    takeInitialAt: "50-100%",  // Always take initial investment out at 50-100% profit
    setExitsBeforeEntry: true, // Plan your exit BEFORE you enter
  },

  // Entry criteria (from successful bot builders + manual traders)
  entryCriteria: {
    bondingCurveEntry: [0.40, 0.60],  // Sweet spot: 40-60% bonding curve with sustained volume
    maxMarketCapEntry: 25_000,        // Almost never buy over 25-30k market cap
    freshTokenPriority: true,         // Under 30s is ideal, under 60s acceptable
    requireMetadataUrl: true,         // 0% graduation rate without URL
    checkDevWallet: true,             // Always check dev wallet on Solscan
    checkHolderDistribution: true,    // Never trade without looking at holders
    checkForBundles: true,            // Use bubble maps to detect wash trading
  },

  // What makes a token graduate (from data analysis)
  graduationSignals: {
    fastGraduation: "If graduating, 50%+ happen within 10 minutes",
    volumeVelocity: "Sustained volume in first 5 minutes, not just initial spike",
    organicBuyers: "Multiple unique wallets, not just 1-3 whale wallets",
    narrativeStrength: "Strong narratives survive dumps and recover",
    communityPreExistence: "Tokens with existing Twitter/Telegram communities outperform",
    timing: "Friday-Sunday launches graduate 40-60% more than weekdays",
    avoidTuesday: "Tuesday has 0.04% graduation rate — avoid",
  },

  // Risk management (from multiple sources)
  riskManagement: {
    expect60PctLoss: true,     // 60% of ALL memecoin traders lose money
    only05PctMake10k: true,    // Only 0.5% make >$10k
    oneIn1000IsGood: true,     // For every 1000 launches, maybe 1 is good
    takeProfitsAlways: true,   // Critical: someone turned $500→$30k→$0 by not selling
    consistentSmallWins: true, // Aim for consistent 2x rather than moonshots
    diversifyBets: true,       // Many small bets, not few large ones
  },

  // Red flags (from experienced traders)
  redFlags: {
    freshDevWallet: "Wallet receiving from CEX = suspicious",
    previousRugs: "Dev has rugged before = DO NOT BUY",
    singleWalletDominance: "One wallet with >30% of buys = wash trading",
    kingOfHillBotted: "50% of KOTH tokens are botted and will dump at 50k",
    noSocials: "No Twitter/Telegram = 90% chance of rug",
    over50thDerivative: "50th copy of a meme today = dead on arrival",
    tooManyBots: "Heavy bot activity on first buys = likely coordinated dump",
  },

  // Scam patterns to detect (from scammer perspective insights)
  scamPatterns: {
    convincingSetup: "Scammers create website + Twitter + Telegram before launch",
    devWalletNeverSells: "Dev holds small bag to look legit, dumps from alt wallets",
    altWalletBuys: "5-10 SOL in alt wallet buys right after launch",
    slowDump: "Dump tokens slowly near Raydium migration to trigger pump alerts",
    profitPerScam: "Scammers average 30+ SOL per hour",
    bundledBuys: "Multiple wallets buying simultaneously = same person (use bubble maps)",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT KNOWLEDGE: Formatted for LLM injection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns expert knowledge formatted for injection into LLM prompts.
 * This gives the agent knowledge it can't get from its own trade history alone.
 */
export function getExpertKnowledge(): string {
  return `
═══ EXPERT KNOWLEDGE: PUMP.FUN TRADING (from analysis of 567,876 tokens + community strategies) ═══

📊 HARD DATA (567,876 tokens analyzed):
• Only 0.43% of tokens graduate (reach Raydium). YOU ARE FILTERING FROM THE 99.57% THAT FAIL.
• Median graduation time: ~10 MINUTES. If it hasn't graduated by then, it probably won't.
• Friday-Sunday launches graduate 40-60% more than weekdays. Tuesday is a graveyard (0.04% graduation rate).
• Best hours: 11-14 UTC (US morning/EU afternoon overlap).
• Legacy (Metaplex) tokens graduate 5x more than Token2022 tokens.
• 94% of graduated tokens have FDV under $100k at graduation.
• Tokens WITHOUT a metadata URL have 0% graduation rate.
• Optimal symbol length: 4-6 characters. Optimal name length: 4-8 characters.

🎯 WINNING STRATEGY (consensus from profitable traders):
• AIM FOR CONSISTENT 2x, NOT MOONSHOTS. Consistent doubles compound into real money.
• Entry sweet spot: 40-60% bonding curve progress WITH sustained (not spiking) volume.
• Never buy over 25-30k market cap — you're already late.
• Take initial investment out at 50-100% profit. ALWAYS. Set exits BEFORE entry.
• Position size: small bets (0.05 SOL or ~10% bankroll). Many bets > few large bets.
• Freshness is critical — under 30s is ideal, under 60s acceptable, over 90s is too late.
• Strong narratives survive dumps. If narrative is weak, even good metrics won't save it.

⚠️ PROBABILITY REALITY CHECK (don't let this stop you from trading, but be smart):
• 60% of memecoin traders lose money overall. You WILL have losing trades.
• Only 0.5% of traders make >$10k. But consistent 2x gains are achievable.
• For every 1000 launches, maybe 1 is truly good. YOUR JOB: find that 1.
• LOSSES ARE TUITION. Each loss teaches you what doesn't work. You MUST trade to learn.
• The #1 killer: not taking profits. Someone turned $500→$30k→$0 by not selling.
• The #2 killer: TIGHTENING STOPS AFTER LOSSES. Wide stops (10-15%) let winners develop. Tight stops (3-5%) stop you out of everything including winners.
• Pump.fun is EXTREMELY volatile. A 5-10% dip is NORMAL even for tokens that eventually 5x. If your stop is 5%, you'll get stopped out of winners.

🔍 MUST-CHECK BEFORE BUYING:
• Dev wallet: Fresh wallet from CEX = suspicious. Previous rugs = SKIP.
• Holder distribution: One wallet with >30% of buys = wash trading.
• Bundle detection: Multiple wallets buying simultaneously = same person.
• Socials: No Twitter/Telegram = 90% rug chance. Existing community = huge edge.
• Competing coins: If 5+ similar coins exist, you're late. First mover advantage is real.

🚫 RED FLAGS (instant skip):
• Dev has rugged before
• Fresh dev wallet receiving from CEX
• Single wallet dominates volume
• No metadata URL
• Token name > 10 chars or symbol > 8 chars
• Volume spike from 1-2 wallets only (no organic)
• Already near/past KOTH (50% of KOTH tokens are botted)

💡 KEY INSIGHT: This is a NUMBERS GAME. You will lose on most trades. The goal is:
1. Accept losses as the cost of doing business (NOT a reason to tighten config)
2. Win BIGGER on winners (let partial positions run with WIDE trailing stops)
3. Trade OFTEN enough to find the winners (being too selective = missing opportunities)
4. NEVER tighten stops, raise minBuyScore, or reduce trading frequency after losses
5. Keep stops WIDE (10-15%) so winners have room to breathe through normal volatility

🧠 LEARNING ACCELERATION:
• Each trade generates data. NO TRADE = NO LEARNING.
• Even bad trades teach you: what narratives fail, what metrics mislead, what timing is wrong.
• The agent MUST make trades to improve. An agent that never trades never learns.
• Set a MINIMUM trade frequency goal: at least 1 trade per hour of operation.
• Small losses on exploratory trades are an INVESTMENT in future performance.`;
}

/**
 * Returns a compact version for the per-token LLM analyzer (token-efficient).
 */
export function getCompactExpertKnowledge(): string {
  return `
EXPERT DATA: 0.43% of pump.fun tokens graduate. Median graduation time: 10min. Best days: Fri-Sun. Best hours: 11-14 UTC. No-URL tokens = 0% graduation. Optimal symbol 4-6 chars.
WINNING PATTERN: Entry at 40-60% bonding curve with sustained volume, take profits at 2x, small positions, freshness <30s ideal. Consistent 2x beats moonshots.
REALITY: 60% of traders lose. You MUST trade to learn. Losses are tuition. Check: dev wallet, holder distribution, bundles, socials.`;
}

/**
 * Builds RAG global lessons that include expert knowledge ALONGSIDE historical data.
 * This prevents the "all losses → never trade" paralysis.
 */
export function getExpertFraming(winRate: number, totalTrades: number): string {
  if (totalTrades < 3) return "";

  const lines: string[] = [];

  if (winRate === 0 && totalTrades >= 5) {
    lines.push(`
📚 EXPERT CONTEXT ON YOUR 0% WIN RATE:
• 60% of ALL memecoin traders lose money. Your results are NOT unusual for early learning.
• Your ${totalTrades} losing trades are VALUABLE DATA — they show you what DOESN'T work.
• The fix is NOT to tighten config or trade less. The fix is:
  1. Keep position sizes tiny (minimize loss per trade)
  2. Keep stops WIDE (10-15%) — tight stops kill winners by stopping you out during normal dips
  3. Focus on DIFFERENT patterns than what you've been trying
  4. Look for tokens with characteristics you HAVEN'T tried yet
  5. Prioritize: strong narrative + fresh (<30s) + multiple unique buyers + no red flags
• CRITICAL: DO NOT tighten any config values. Your config is fine. The market is volatile by nature.
• Your historical losses tell you WHAT TO AVOID, not to tighten config.`);
  } else if (winRate < 0.3 && totalTrades >= 5) {
    lines.push(`
📚 EXPERT CONTEXT ON LOW WIN RATE:
• ${(winRate * 100).toFixed(0)}% WR is below target but recoverable. Many profitable traders started here.
• Focus on the DIFFERENCE between your wins and losses — what made winners different?
• Tighten criteria: require more convergent signals before buying.
• But don't stop trading — reduced frequency is okay, zero frequency is not.`);
  }

  return lines.join("\n");
}
