// ── Creator blacklist: tracks known rug-pull dev wallets ──

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

interface BlacklistEntry {
  wallet: string;
  /** Number of tokens launched by this wallet */
  tokenCount: number;
  /** Number of those tokens where the dev sold within 60s */
  rugCount: number;
  /** Mints this dev has launched (most recent 10) */
  recentMints: string[];
  /** Timestamp of first observation */
  firstSeen: number;
  /** Timestamp of most recent rug */
  lastRugAt: number;
}

interface CreatorHistory {
  wallet: string;
  /** All tokens this creator has launched in this session */
  launches: Array<{ mint: string; symbol: string; createdAt: number; devSoldWithin60s: boolean }>;
}

/**
 * Tracks dev wallets and their behavior.
 * A wallet is blacklisted if it has rugged 2+ tokens.
 * Persists to disk so knowledge survives restarts.
 */
export class CreatorBlacklist {
  private blacklist = new Map<string, BlacklistEntry>();
  private creators = new Map<string, CreatorHistory>();
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "creator-blacklist.json");
    this.load();
  }

  /** Record a new token launch by a dev wallet */
  recordLaunch(devWallet: string, mint: string, symbol: string): void {
    if (!devWallet) return;

    let history = this.creators.get(devWallet);
    if (!history) {
      history = { wallet: devWallet, launches: [] };
      this.creators.set(devWallet, history);
    }

    // Don't double-record same mint
    if (history.launches.some((l) => l.mint === mint)) return;

    history.launches.push({
      mint,
      symbol,
      createdAt: Date.now(),
      devSoldWithin60s: false,
    });
  }

  /** Record that a dev wallet sold tokens — check if it's within 60s of launch */
  recordDevSell(devWallet: string, mint: string): void {
    if (!devWallet) return;

    const history = this.creators.get(devWallet);
    if (!history) return;

    const launch = history.launches.find((l) => l.mint === mint);
    if (!launch || launch.devSoldWithin60s) return;

    const ageSec = (Date.now() - launch.createdAt) / 1_000;
    if (ageSec <= 120) {
      // Dev sold within 2 minutes — this is a rug signal
      launch.devSoldWithin60s = true;
      this.addToBlacklist(devWallet, mint);
    }
  }

  /** Check if a dev wallet is blacklisted */
  isBlacklisted(devWallet: string): boolean {
    if (!devWallet) return false;
    const entry = this.blacklist.get(devWallet);
    if (!entry) return false;
    // Blacklisted after 2+ rugs
    return entry.rugCount >= 2;
  }

  /** Get blacklist info for a wallet */
  getInfo(devWallet: string): BlacklistEntry | undefined {
    return this.blacklist.get(devWallet);
  }

  /** Get reputation score for a creator (0 = unknown, negative = bad, positive = good) */
  getReputation(devWallet: string): number {
    if (!devWallet) return 0;

    const entry = this.blacklist.get(devWallet);
    if (!entry) return 0;

    // Known serial launcher: penalty per rug, small bonus per non-rug
    const nonRugs = entry.tokenCount - entry.rugCount;
    return nonRugs * 2 - entry.rugCount * 15;
  }

  /** How many tokens has this creator launched (in our tracked history)? */
  getLaunchCount(devWallet: string): number {
    const entry = this.blacklist.get(devWallet);
    return entry?.tokenCount ?? 0;
  }

  /** Get blacklist stats */
  getStats(): { totalBlacklisted: number; totalTracked: number } {
    let totalBlacklisted = 0;
    for (const entry of this.blacklist.values()) {
      if (entry.rugCount >= 2) totalBlacklisted++;
    }
    return { totalBlacklisted, totalTracked: this.blacklist.size };
  }

  // ─── Private ───

  private addToBlacklist(wallet: string, mint: string): void {
    let entry = this.blacklist.get(wallet);
    if (!entry) {
      entry = {
        wallet,
        tokenCount: 0,
        rugCount: 0,
        recentMints: [],
        firstSeen: Date.now(),
        lastRugAt: 0,
      };
      this.blacklist.set(wallet, entry);
    }

    // Count this mint as a launch if not already counted
    if (!entry.recentMints.includes(mint)) {
      entry.tokenCount++;
      entry.recentMints.push(mint);
      // Keep only last 10 mints
      if (entry.recentMints.length > 10) entry.recentMints.shift();
    }

    entry.rugCount++;
    entry.lastRugAt = Date.now();

    if (entry.rugCount >= 2) {
      logger.warn("BLACKLIST", `🚫 Blacklisted creator ${wallet.slice(0, 8)}... (${entry.rugCount} rugs in ${entry.tokenCount} launches)`);
    }

    this.persist();
  }

  private persist(): void {
    try {
      const data: Record<string, BlacklistEntry> = {};
      for (const [k, v] of this.blacklist) {
        data[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      logger.error("BLACKLIST", `Failed to persist: ${err}`);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, BlacklistEntry>;
      for (const [k, v] of Object.entries(data)) {
        this.blacklist.set(k, v);
      }
      const stats = this.getStats();
      logger.info("BLACKLIST", `Loaded ${stats.totalTracked} creators (${stats.totalBlacklisted} blacklisted)`);
    } catch (err) {
      logger.error("BLACKLIST", `Failed to load blacklist: ${err}`);
    }
  }
}
