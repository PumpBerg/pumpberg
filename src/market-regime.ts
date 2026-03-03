// ── Market regime detection: tracks recent token outcomes to gauge market conditions ──

import { logger } from "./logger.js";

interface TokenOutcome {
  mint: string;
  symbol: string;
  timestamp: number;
  /** Did the token survive > 2 min without dev selling? */
  survived: boolean;
  /** Peak market cap reached */
  peakMarketCapSol: number;
  /** Did this token eventually migrate to Raydium? */
  migrated: boolean;
  /** Was this a rug (dev sold within 60s)? */
  wasRug: boolean;
}

export type MarketRegime = "hot" | "normal" | "cold" | "dead";

/**
 * Tracks the last N token outcomes to detect market regime.
 * 
 * - "hot":   >50% tokens survive, many migrations → be aggressive
 * - "normal": 30-50% survival → normal operation
 * - "cold":  15-30% survival → reduce size, raise threshold
 * - "dead":  <15% survival → pause or tiny positions only
 */
export class MarketRegimeDetector {
  private outcomes: TokenOutcome[] = [];
  private readonly windowSize: number;
  private readonly maxAge: number;
  private migrationCount = 0;
  private totalMigrationsTracked = 0;

  constructor(windowSize = 50, maxAgeMs = 600_000) {
    this.windowSize = windowSize;
    this.maxAge = maxAgeMs;
  }

  /** Record a token that survived (wasn't rugged quickly) */
  recordSurvival(mint: string, symbol: string, peakMarketCapSol: number): void {
    this.addOutcome({ mint, symbol, timestamp: Date.now(), survived: true, peakMarketCapSol, migrated: false, wasRug: false });
  }

  /** Record a token that was rugged (dev sold quickly) */
  recordRug(mint: string, symbol: string): void {
    this.addOutcome({ mint, symbol, timestamp: Date.now(), survived: false, peakMarketCapSol: 0, migrated: false, wasRug: true });
  }

  /** Record a successful migration to Raydium */
  recordMigration(mint: string, symbol: string): void {
    this.migrationCount++;
    this.totalMigrationsTracked++;

    // Update existing outcome if we tracked this token
    const existing = this.outcomes.find((o) => o.mint === mint);
    if (existing) {
      existing.migrated = true;
      existing.survived = true;
    } else {
      this.addOutcome({ mint, symbol, timestamp: Date.now(), survived: true, peakMarketCapSol: 0, migrated: true, wasRug: false });
    }

    logger.info("REGIME", `🎯 Migration recorded: ${symbol} — total migrations seen: ${this.totalMigrationsTracked}`);
  }

  /** Get current market regime */
  getRegime(): MarketRegime {
    this.prune();
    if (this.outcomes.length < 5) return "normal"; // Not enough data

    const survivalRate = this.getSurvivalRate();
    const recentMigrations = this.getRecentMigrationRate();

    // Hot market: high survival + migrations happening
    if (survivalRate > 0.50 || recentMigrations > 0.05) return "hot";
    if (survivalRate > 0.30) return "normal";
    if (survivalRate > 0.15) return "cold";
    return "dead";
  }

  /** Get survival rate (0-1) */
  getSurvivalRate(): number {
    this.prune();
    if (this.outcomes.length === 0) return 0.5; // Assume neutral
    const survived = this.outcomes.filter((o) => o.survived).length;
    return survived / this.outcomes.length;
  }

  /** Get migration rate among recent tokens */
  getRecentMigrationRate(): number {
    this.prune();
    if (this.outcomes.length === 0) return 0;
    const migrated = this.outcomes.filter((o) => o.migrated).length;
    return migrated / this.outcomes.length;
  }

  /** Get recommended score threshold adjustment based on regime */
  getScoreAdjustment(): { minScoreBoost: number; sizeMultiplier: number } {
    const regime = this.getRegime();
    switch (regime) {
      case "hot":
        return { minScoreBoost: -5, sizeMultiplier: 1.2 }; // Slightly more aggressive
      case "normal":
        return { minScoreBoost: 0, sizeMultiplier: 1.0 };
      case "cold":
        return { minScoreBoost: 10, sizeMultiplier: 0.5 }; // Much more selective
      case "dead":
        return { minScoreBoost: 25, sizeMultiplier: 0.25 }; // Nearly paused
    }
  }

  /** Get summary for logging/display */
  getSummary(): {
    regime: MarketRegime;
    survivalRate: number;
    migrationRate: number;
    sampleSize: number;
    totalMigrations: number;
  } {
    return {
      regime: this.getRegime(),
      survivalRate: this.getSurvivalRate(),
      migrationRate: this.getRecentMigrationRate(),
      sampleSize: this.outcomes.length,
      totalMigrations: this.totalMigrationsTracked,
    };
  }

  // ─── Private ───

  private addOutcome(outcome: TokenOutcome): void {
    // Avoid duplicates
    if (this.outcomes.some((o) => o.mint === outcome.mint)) return;
    this.outcomes.push(outcome);
    // Trim to window size
    while (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAge;
    this.outcomes = this.outcomes.filter((o) => o.timestamp >= cutoff);
  }
}
