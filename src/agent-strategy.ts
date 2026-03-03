// ── Persistent Agent Strategy Memory ──
// Stores learned lessons, evolved rules, and strategy insights that survive restarts.
// The agent can read its accumulated wisdom and write new lessons based on experience.

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/** A single learned lesson from trading experience */
export interface StrategyLesson {
  id: number;
  /** When this lesson was learned */
  timestamp: number;
  /** Category for organizing lessons */
  category: "entry" | "exit" | "risk" | "narrative" | "timing" | "social" | "smart-money" | "general";
  /** The lesson text */
  lesson: string;
  /** How this lesson was derived */
  source: "post-mortem" | "autonomous-review" | "post-sale-monitor" | "user-chat" | "pattern-detection";
  /** Confidence level — increases when the same lesson is reinforced */
  confidence: number;
  /** How many times this lesson has been reinforced by similar observations */
  reinforcements: number;
  /** Whether the agent has marked this as superseded by a newer lesson */
  superseded?: boolean;
}

/** Evolving strategy rules the agent has developed */
export interface StrategyRules {
  /** Key insights about what works and what doesn't */
  coreInsights: string[];
  /** Narratives/themes the agent has found profitable */
  profitableNarratives: string[];
  /** Narratives/themes that consistently lose */
  unprofitableNarratives: string[];
  /** Exit patterns the agent has observed */
  exitInsights: string[];
  /** Entry criteria the agent has evolved */
  entryInsights: string[];
  /** Smart money / social signal observations */
  signalInsights: string[];
}

/** Full persistent strategy state */
export interface StrategyState {
  /** Version for future migrations */
  version: number;
  /** When the strategy was last updated */
  lastUpdated: number;
  /** Total trades the agent has been through (lifetime, not just current session) */
  lifetimeTrades: number;
  /** Total sessions the agent has been through */
  sessionCount: number;
  /** All learned lessons */
  lessons: StrategyLesson[];
  /** Evolved strategy rules */
  rules: StrategyRules;
  /** Session summaries — one per restart, so the agent knows its trajectory */
  sessionSummaries: SessionSummary[];
}

export interface SessionSummary {
  startedAt: number;
  endedAt: number;
  trades: number;
  wins: number;
  losses: number;
  pnlSol: number;
  winRate: number;
  keyEvents: string[];
}

const MAX_LESSONS = 100;
const MAX_SESSION_SUMMARIES = 50;
const STRATEGY_VERSION = 1;

export class AgentStrategy {
  private state: StrategyState;
  private filePath: string;
  private nextLessonId: number;
  private currentSessionStart: number;

  constructor(dataDir: string = "./data") {
    this.filePath = path.join(dataDir, "agent-strategy.json");
    this.currentSessionStart = Date.now();
    this.state = this.loadOrCreate();
    this.nextLessonId = this.state.lessons.length > 0
      ? Math.max(...this.state.lessons.map((l) => l.id)) + 1
      : 1;

    // Increment session count
    this.state.sessionCount++;
    this.persist();

    logger.info("STRATEGY", `Loaded strategy memory: ${this.state.lessons.length} lessons, ${this.state.sessionSummaries.length} past sessions, lifetime trades: ${this.state.lifetimeTrades}`);
  }

  /** Load from disk or create fresh state */
  private loadOrCreate(): StrategyState {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as StrategyState;
        // Migrate if needed
        if (!parsed.version || parsed.version < STRATEGY_VERSION) {
          parsed.version = STRATEGY_VERSION;
        }
        return parsed;
      }
    } catch (err) {
      logger.error("STRATEGY", `Failed to load strategy: ${err}`);
    }

    return {
      version: STRATEGY_VERSION,
      lastUpdated: Date.now(),
      lifetimeTrades: 0,
      sessionCount: 0,
      lessons: [],
      rules: {
        coreInsights: [],
        profitableNarratives: [],
        unprofitableNarratives: [],
        exitInsights: [],
        entryInsights: [],
        signalInsights: [],
      },
      sessionSummaries: [],
    };
  }

  /** Save to disk */
  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.state.lastUpdated = Date.now();
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      logger.error("STRATEGY", `Failed to persist strategy: ${err}`);
    }
  }

  /** Add a new lesson learned from experience */
  addLesson(
    lesson: string,
    category: StrategyLesson["category"],
    source: StrategyLesson["source"],
    confidence: number = 0.5,
  ): void {
    // Check for similar existing lessons and reinforce instead of duplicating
    const existing = this.state.lessons.find(
      (l) => !l.superseded && l.category === category && this.isSimilar(l.lesson, lesson),
    );

    if (existing) {
      existing.reinforcements++;
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.timestamp = Date.now(); // Update timestamp on reinforcement
      logger.info("STRATEGY", `Reinforced lesson #${existing.id} (${existing.reinforcements}x): ${lesson.slice(0, 80)}`);
      this.persist();
      return;
    }

    const newLesson: StrategyLesson = {
      id: this.nextLessonId++,
      timestamp: Date.now(),
      category,
      lesson,
      source,
      confidence,
      reinforcements: 0,
    };

    this.state.lessons.push(newLesson);

    // Trim old low-confidence lessons if we exceed max
    if (this.state.lessons.length > MAX_LESSONS) {
      this.state.lessons.sort((a, b) => {
        // Keep: high confidence, high reinforcements, recent
        const scoreA = a.confidence * 2 + a.reinforcements * 0.3 + (a.superseded ? -10 : 0);
        const scoreB = b.confidence * 2 + b.reinforcements * 0.3 + (b.superseded ? -10 : 0);
        return scoreB - scoreA;
      });
      this.state.lessons = this.state.lessons.slice(0, MAX_LESSONS);
    }

    logger.info("STRATEGY", `New lesson #${newLesson.id} [${category}]: ${lesson.slice(0, 100)}`);
    this.persist();
  }

  /** Update evolved strategy rules */
  updateRules(rules: Partial<StrategyRules>): void {
    if (rules.coreInsights) this.state.rules.coreInsights = this.dedup(rules.coreInsights, 10);
    if (rules.profitableNarratives) this.state.rules.profitableNarratives = this.dedup(rules.profitableNarratives, 10);
    if (rules.unprofitableNarratives) this.state.rules.unprofitableNarratives = this.dedup(rules.unprofitableNarratives, 10);
    if (rules.exitInsights) this.state.rules.exitInsights = this.dedup(rules.exitInsights, 10);
    if (rules.entryInsights) this.state.rules.entryInsights = this.dedup(rules.entryInsights, 10);
    if (rules.signalInsights) this.state.rules.signalInsights = this.dedup(rules.signalInsights, 10);
    this.persist();
    logger.info("STRATEGY", `Updated strategy rules`);
  }

  /** Record a session summary when the bot stops */
  addSessionSummary(trades: number, wins: number, losses: number, pnlSol: number, keyEvents: string[]): void {
    const summary: SessionSummary = {
      startedAt: this.currentSessionStart,
      endedAt: Date.now(),
      trades,
      wins,
      losses,
      pnlSol,
      winRate: trades > 0 ? wins / trades : 0,
      keyEvents: keyEvents.slice(0, 10),
    };

    this.state.sessionSummaries.push(summary);
    this.state.lifetimeTrades += trades;

    // Trim old session summaries
    if (this.state.sessionSummaries.length > MAX_SESSION_SUMMARIES) {
      this.state.sessionSummaries = this.state.sessionSummaries.slice(-MAX_SESSION_SUMMARIES);
    }

    this.persist();
    logger.info("STRATEGY", `Session summary recorded: ${trades} trades, ${wins}W/${losses}L, P&L: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL`);
  }

  /** Increment lifetime trades counter (called after each trade exit) */
  incrementLifetimeTrades(): void {
    this.state.lifetimeTrades++;
    // Don't persist on every trade — will be saved with next lesson or session summary
  }

  /** Get formatted strategy context for inclusion in agent prompts */
  getStrategyContext(): string {
    const activeLessons = this.state.lessons
      .filter((l) => !l.superseded)
      .sort((a, b) => (b.confidence + b.reinforcements * 0.2) - (a.confidence + a.reinforcements * 0.2));

    if (activeLessons.length === 0 && this.state.sessionSummaries.length === 0) {
      return ""; // No strategy memory yet — first session
    }

    const lines: string[] = ["═══ PERSISTENT STRATEGY MEMORY (survives restarts) ═══"];
    lines.push(`Session #${this.state.sessionCount} | Lifetime Trades: ${this.state.lifetimeTrades}`);

    // Session history — show last 5
    const recentSessions = this.state.sessionSummaries.slice(-5);
    if (recentSessions.length > 0) {
      lines.push("\n📅 PREVIOUS SESSIONS:");
      for (const s of recentSessions) {
        const date = new Date(s.startedAt).toLocaleDateString();
        const duration = Math.round((s.endedAt - s.startedAt) / 60_000);
        lines.push(`  ${date} (${duration}min): ${s.trades} trades, ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%), P&L: ${s.pnlSol >= 0 ? "+" : ""}${s.pnlSol.toFixed(4)} SOL`);
        if (s.keyEvents.length > 0) {
          lines.push(`    Events: ${s.keyEvents.join(", ")}`);
        }
      }
    }

    // Evolved rules
    const r = this.state.rules;
    if (r.coreInsights.length > 0) {
      lines.push("\n🧠 CORE INSIGHTS (your evolved understanding):");
      r.coreInsights.forEach((i) => lines.push(`  • ${i}`));
    }
    if (r.profitableNarratives.length > 0) {
      lines.push("\n✅ PROFITABLE NARRATIVES:");
      r.profitableNarratives.forEach((n) => lines.push(`  • ${n}`));
    }
    if (r.unprofitableNarratives.length > 0) {
      lines.push("\n❌ UNPROFITABLE NARRATIVES:");
      r.unprofitableNarratives.forEach((n) => lines.push(`  • ${n}`));
    }
    if (r.entryInsights.length > 0) {
      lines.push("\n🎯 ENTRY INSIGHTS:");
      r.entryInsights.forEach((i) => lines.push(`  • ${i}`));
    }
    if (r.exitInsights.length > 0) {
      lines.push("\n🚪 EXIT INSIGHTS:");
      r.exitInsights.forEach((i) => lines.push(`  • ${i}`));
    }
    if (r.signalInsights.length > 0) {
      lines.push("\n📡 SIGNAL INSIGHTS:");
      r.signalInsights.forEach((i) => lines.push(`  • ${i}`));
    }

    // Top lessons (most confident / reinforced)
    const topLessons = activeLessons.slice(0, 15);
    if (topLessons.length > 0) {
      lines.push("\n📝 LEARNED LESSONS (sorted by confidence):");
      for (const l of topLessons) {
        const conf = l.confidence >= 0.8 ? "🟢" : l.confidence >= 0.5 ? "🟡" : "🔴";
        const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements + 1})` : "";
        lines.push(`  ${conf} [${l.category}]${reinforced} ${l.lesson}`);
      }
    }

    lines.push("\n💡 You can add new lessons using: ```lesson\n{\"lesson\":\"...\",\"category\":\"...\"}\n```");
    lines.push("💡 You can update strategy rules using: ```strategy\n{\"coreInsights\":[\"...\"],\"profitableNarratives\":[\"...\"]}\n```");

    return lines.join("\n");
  }
  /** Compact strategy context for token review prompts (~300 tokens vs ~650-1482) */
  getCompactContext(): string {
    const activeLessons = this.state.lessons
      .filter((l) => !l.superseded)
      .sort((a, b) => (b.confidence + b.reinforcements * 0.2) - (a.confidence + a.reinforcements * 0.2));

    if (activeLessons.length === 0 && this.state.sessionSummaries.length === 0) {
      return "";
    }

    const lines: string[] = ["STRATEGY MEMORY (compact):"];
    lines.push(`Session #${this.state.sessionCount} | Lifetime: ${this.state.lifetimeTrades} trades`);

    // Last 2 sessions only
    const recentSessions = this.state.sessionSummaries.slice(-2);
    if (recentSessions.length > 0) {
      for (const s of recentSessions) {
        const date = new Date(s.startedAt).toLocaleDateString();
        lines.push(`  ${date}: ${s.trades}t ${s.wins}W/${s.losses}L (${(s.winRate * 100).toFixed(0)}%) ${s.pnlSol >= 0 ? "+" : ""}${s.pnlSol.toFixed(4)} SOL`);
      }
    }

    // Only non-empty rule categories, one line each
    const r = this.state.rules;
    if (r.coreInsights.length > 0) lines.push(`  Core: ${r.coreInsights.slice(0, 3).join(" | ")}`);
    if (r.profitableNarratives.length > 0) lines.push(`  ✅ Narratives: ${r.profitableNarratives.join(", ")}`);
    if (r.unprofitableNarratives.length > 0) lines.push(`  ❌ Narratives: ${r.unprofitableNarratives.join(", ")}`);
    if (r.entryInsights.length > 0) lines.push(`  Entry: ${r.entryInsights.slice(0, 2).join(" | ")}`);
    if (r.exitInsights.length > 0) lines.push(`  Exit: ${r.exitInsights.slice(0, 2).join(" | ")}`);

    // Top 5 lessons only
    const topLessons = activeLessons.slice(0, 5);
    if (topLessons.length > 0) {
      lines.push("  Lessons:");
      for (const l of topLessons) {
        const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements + 1})` : "";
        lines.push(`    [${l.category}]${reinforced} ${l.lesson}`);
      }
    }

    return lines.join("\n");
  }
  /** Get state for external inspection */
  getState(): Readonly<StrategyState> {
    return this.state;
  }

  /** Simple similarity check — are two lessons saying roughly the same thing? */
  private isSimilar(a: string, b: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const na = normalize(a);
    const nb = normalize(b);

    // Exact match
    if (na === nb) return true;

    // Word overlap — if 60%+ words are shared, consider similar
    const wordsA = new Set(na.split(/\s+/));
    const wordsB = new Set(nb.split(/\s+/));
    const intersection = [...wordsA].filter((w) => wordsB.has(w));
    const minSize = Math.min(wordsA.size, wordsB.size);
    return minSize > 0 && intersection.length / minSize >= 0.6;
  }

  /** Deduplicate and limit array */
  private dedup(arr: string[], max: number): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of arr) {
      const key = item.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
    return result.slice(0, max);
  }
}
