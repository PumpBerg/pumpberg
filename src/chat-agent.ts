// ── Autonomous Chat Agent: self-improving AI trading strategist ──
// Proactively analyzes performance, adjusts config, learns from every trade.
// Also handles user chat messages.

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { thinkingLog } from "./thinking.js";
import { persistConfig } from "./config.js";
import type { Scanner, CandidateToken } from "./scanner.js";
import type { TradeJournal, JournalAnalysis } from "./trade-journal.js";
import type { MarketIntel } from "./market-intel.js";
import { TradeRAG } from "./trade-rag.js";
import { getExpertKnowledge, getCompactExpertKnowledge } from "./pump-fun-knowledge.js";
import { AgentStrategy, type StrategyRules, type StrategyLesson } from "./agent-strategy.js";
import type { WinnerResearch } from "./winner-research.js";
import type { GraduateAnalyzer } from "./graduate-analyzer.js";
import { RAGDatabase, EmbeddingService, RAGQueryEngine, HistoricalImporter, BatchProcessor } from "./rag/index.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const MODEL_FAST = "claude-3-haiku-20240307"; // Haiku for cheap post-mortems & simple reviews
const MAX_TOKENS_CHAT = 512;
const MAX_TOKENS_AUTONOMOUS = 768;
const TIMEOUT_MS = 45_000;

/** How often the agent reviews performance and considers adjustments (ms) */
const AUTO_REVIEW_INTERVAL_MS = 20 * 60_000; // Every 20 minutes (was 10min — halved Sonnet API cost)
/** How often the agent reviews new token candidates for buy decisions (ms) */
const TOKEN_REVIEW_INTERVAL_MS = 60_000; // Every 60 seconds (was 30s — fast-buy handles urgent buys)
const MAX_TOKENS_TOKEN_REVIEW = 512;
/** Minimum completed trades before agent starts making autonomous adjustments */
const MIN_TRADES_FOR_AUTO = 3;

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** If the agent executed any config changes */
  actions?: ConfigAction[];
  /** Whether this was an autonomous decision vs user-prompted */
  autonomous?: boolean;
}

export interface ConfigAction {
  field: string;
  oldValue: number | boolean;
  newValue: number | boolean;
}

export interface TradeAction {
  type: "buy" | "sell" | "sell-all" | "start" | "stop";
  mint?: string;
  symbol?: string;
  amount?: number;
  result?: string;
}

export interface AgentDecision {
  timestamp: number;
  type: "config-change" | "observation" | "warning" | "strategy" | "trade-action";
  summary: string;
  actions: ConfigAction[];
  tradeActions?: TradeAction[];
  reasoning: string;
}

const EDITABLE_FIELDS = [
  "minPositionSizeSol",
  "maxPositionSizeSol",
  "maxConcurrentPositions",
  "maxTotalExposureSol",
  "stopLossPct",
  "takeProfitPct1",
  "takeProfitPct2",
  "minBuyScore",
  "maxPositionAgeSec",
  "trailingStopActivationPct",
  "trailingStopDistancePct",
  "stagnationExitSec",
  "stagnationMinTrades",
  "tradingFeePct",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Hard min/max guardrails — the agent physically cannot set values outside these bounds */
const CONFIG_BOUNDS_LIVE: Record<string, { min: number; max: number }> = {
  minPositionSizeSol:       { min: 0.005, max: 0.5 },
  maxPositionSizeSol:       { min: 0.01,  max: 1.0 },
  maxConcurrentPositions:   { min: 1,     max: 10 },
  maxTotalExposureSol:      { min: 0.05,  max: 5.0 },
  stopLossPct:              { min: 0.05,  max: 0.25 },
  takeProfitPct1:           { min: 0.10,  max: 0.50 },
  takeProfitPct2:           { min: 0.20,  max: 1.00 },
  minBuyScore:              { min: 40,    max: 85 },
  maxPositionAgeSec:        { min: 45,    max: 300 },
  trailingStopActivationPct:{ min: 0.10,  max: 0.50 },
  trailingStopDistancePct:  { min: 0.05,  max: 0.20 },
  stagnationExitSec:        { min: 3,     max: 30 },
  stagnationMinTrades:      { min: 2,     max: 20 },
  tradingFeePct:             { min: 0.001, max: 0.02 },
};

/** Dry-run fields the agent CANNOT modify (managed by start() overrides) */
const DRY_RUN_LOCKED_FIELDS = new Set(["maxConcurrentPositions", "maxTotalExposureSol"]);

/** Get config bounds — in dry run, lock capacity fields to their override values */
function getConfigBounds(isDryRun: boolean): Record<string, { min: number; max: number }> {
  if (!isDryRun) return CONFIG_BOUNDS_LIVE;
  return {
    ...CONFIG_BOUNDS_LIVE,
    // In dry run, allow the dry-run override values (50/10) but don't let agent shrink them
    maxConcurrentPositions: { min: 50, max: 50 },
    maxTotalExposureSol:    { min: 10, max: 10 },
  };
}

// Default reference for prompt display
let CONFIG_BOUNDS = CONFIG_BOUNDS_LIVE;

/**
 * Strategy presets for dry-run experimentation.
 * Each preset tweaks key parameters to generate diverse training data.
 * The agent cycles through these automatically — zero extra API calls.
 */
interface StrategyPreset {
  name: string;
  description: string;
  config: Partial<Record<string, number>>;
}

const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    name: "Tight Scalp",
    description: "Quick in-and-out: tight SL (8%), moderate TP (15%/30%), short hold (60s)",
    config: { stopLossPct: 0.08, takeProfitPct1: 0.15, takeProfitPct2: 0.30, maxPositionAgeSec: 60, trailingStopActivationPct: 0.12, trailingStopDistancePct: 0.06 },
  },
  {
    name: "Wide Runner",
    description: "Let winners run: wide SL (15%), ambitious TP (30%/80%), long hold (180s)",
    config: { stopLossPct: 0.15, takeProfitPct1: 0.30, takeProfitPct2: 0.80, maxPositionAgeSec: 180, trailingStopActivationPct: 0.25, trailingStopDistancePct: 0.12 },
  },
  {
    name: "Moonshot Hunter",
    description: "Max risk-reward: very wide SL (20%), huge TP (40%/100%), long hold (300s)",
    config: { stopLossPct: 0.20, takeProfitPct1: 0.40, takeProfitPct2: 1.00, maxPositionAgeSec: 300, trailingStopActivationPct: 0.35, trailingStopDistancePct: 0.15 },
  },
  {
    name: "Conservative Sniper",
    description: "Picky entries: high min score (60), moderate SL (10%), fast exits (90s)",
    config: { minBuyScore: 60, stopLossPct: 0.10, takeProfitPct1: 0.20, takeProfitPct2: 0.50, maxPositionAgeSec: 90, trailingStopActivationPct: 0.15, trailingStopDistancePct: 0.08 },
  },
  {
    name: "Volume Chaser",
    description: "Low bar entries: low min score (40), wide SL (12%), aggressive trailing (10%/5%)",
    config: { minBuyScore: 40, stopLossPct: 0.12, takeProfitPct1: 0.25, takeProfitPct2: 0.60, maxPositionAgeSec: 120, trailingStopActivationPct: 0.10, trailingStopDistancePct: 0.05 },
  },
  {
    name: "Diamond Hands",
    description: "Never sell early: wide SL (18%), very high TP (35%/90%), max hold (300s), loose trailing",
    config: { stopLossPct: 0.18, takeProfitPct1: 0.35, takeProfitPct2: 0.90, maxPositionAgeSec: 300, trailingStopActivationPct: 0.40, trailingStopDistancePct: 0.18 },
  },
  {
    name: "Paper Hands",
    description: "Book profits fast: tight TP (12%/25%), moderate SL (10%), short hold (75s)",
    config: { stopLossPct: 0.10, takeProfitPct1: 0.12, takeProfitPct2: 0.25, maxPositionAgeSec: 75, trailingStopActivationPct: 0.10, trailingStopDistancePct: 0.05 },
  },
  {
    name: "Balanced",
    description: "Middle ground: 12% SL, 20%/50% TP, 120s hold, moderate trailing",
    config: { stopLossPct: 0.12, takeProfitPct1: 0.20, takeProfitPct2: 0.50, maxPositionAgeSec: 120, trailingStopActivationPct: 0.20, trailingStopDistancePct: 0.10 },
  },
];

/** Clamp a config value to its allowed bounds, logging if clamped */
function clampConfigValue(field: string, value: number, isDryRun: boolean = false): number {
  const activeBounds = getConfigBounds(isDryRun);
  const bounds = activeBounds[field];
  if (!bounds) return value;
  if (value < bounds.min) {
    logger.warn("AGENT", `⛔ GUARDRAIL: ${field}=${value} clamped to min=${bounds.min}`);
    return bounds.min;
  }
  if (value > bounds.max) {
    logger.warn("AGENT", `⛔ GUARDRAIL: ${field}=${value} clamped to max=${bounds.max}`);
    return bounds.max;
  }
  return value;
}

export class ChatAgent {
  private apiKey: string;
  private enabled: boolean;
  private history: ChatMessage[] = [];
  private decisions: AgentDecision[] = [];
  private nextId = 1;
  private autoReviewTimer: ReturnType<typeof setInterval> | null = null;
  private tokenReviewTimer: ReturnType<typeof setInterval> | null = null;
  private lastAutoReviewAt = 0;
  private lastTradeCountAtReview = 0;
  private scannerRef: Scanner | null = null;
  private journalRef: TradeJournal | null = null;
  private tradeRAG: TradeRAG | null = null;
  private ragDb: RAGDatabase | null = null;
  private ragEmbedder: EmbeddingService | null = null;
  private ragQuery: RAGQueryEngine | null = null;
  private ragImporter: HistoricalImporter | null = null;
  private ragBatchProcessor: BatchProcessor | null = null;
  private ragBatchTimer: ReturnType<typeof setInterval> | null = null;
  private decisionsPath: string;
  private chatHistoryPath: string;
  private dataDir: string;
  readonly strategy: AgentStrategy;

  /** Get the RAG importer for external integrations (e.g., sync client) */
  getRAGImporter(): HistoricalImporter | null {
    return this.ragImporter;
  }
  /** Pending post-mortems — batched to reduce API calls */
  private pendingPostMortems: Array<{ symbol: string; pnlSol: number; exitReason: string; timestamp: number }> = [];
  private postMortemTimer: ReturnType<typeof setTimeout> | null = null;
  /** Winner research module — injected by server */
  winnerResearch?: WinnerResearch;
  /** Graduate analyzer — injected by server */
  graduateAnalyzer?: GraduateAnalyzer;
  /** Strategy preset rotation index for dry-run experimentation */
  private strategyPresetIndex = 0;
  /** Current active strategy preset name */
  private activePresetName = "";

  constructor(apiKey?: string, dataDir?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
    this.enabled = !!this.apiKey;
    const resolvedDir = dataDir || "./data";
    this.decisionsPath = path.join(resolvedDir, "agent-decisions.json");
    this.chatHistoryPath = path.join(resolvedDir, "chat-history.json");
    this.dataDir = resolvedDir;
    this.strategy = new AgentStrategy(resolvedDir);
    this.loadDecisions();
    this.loadChatHistory();
  }

  /** Persist decisions to disk so the agent has memory across restarts */
  private persistDecisions(): void {
    try {
      const dir = path.dirname(this.decisionsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.decisionsPath, JSON.stringify(this.decisions.slice(-200), null, 2), "utf-8");
    } catch (err) {
      logger.error("AGENT", `Failed to persist decisions: ${err}`);
    }
  }

  /** Load decisions from disk */
  private loadDecisions(): void {
    try {
      if (!fs.existsSync(this.decisionsPath)) return;
      const raw = fs.readFileSync(this.decisionsPath, "utf-8");
      this.decisions = JSON.parse(raw) as AgentDecision[];
      logger.info("AGENT", `Loaded ${this.decisions.length} previous decisions from disk`);
    } catch (err) {
      logger.error("AGENT", `Failed to load decisions: ${err}`);
    }
  }

  /** Save chat history to disk so conversations survive restarts */
  private persistChatHistory(): void {
    try {
      const dir = path.dirname(this.chatHistoryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Keep last 80 messages
      const toSave = this.history.slice(-80);
      fs.writeFileSync(this.chatHistoryPath, JSON.stringify(toSave, null, 2), "utf-8");
    } catch (err) {
      logger.error("AGENT", `Failed to persist chat history: ${err}`);
    }
  }

  /** Load chat history from disk */
  private loadChatHistory(): void {
    try {
      if (!fs.existsSync(this.chatHistoryPath)) return;
      const raw = fs.readFileSync(this.chatHistoryPath, "utf-8");
      this.history = JSON.parse(raw) as ChatMessage[];
      this.nextId = this.history.length > 0
        ? Math.max(...this.history.map((m) => m.id)) + 1
        : 1;
      logger.info("AGENT", `Loaded ${this.history.length} chat messages from previous session`);
    } catch (err) {
      logger.error("AGENT", `Failed to load chat history: ${err}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getHistory(): ChatMessage[] {
    return this.history;
  }

  getDecisions(): AgentDecision[] {
    return this.decisions;
  }

  clearHistory(): void {
    this.history = [];
    this.nextId = 1;
  }

  /** Start the autonomous review loop */
  startAutonomousLoop(scanner: Scanner, journal: TradeJournal): void {
    this.scannerRef = scanner;
    this.journalRef = journal;
    this.tradeRAG = new TradeRAG(journal);

    // ── Initialize embedding-based RAG system (async) ──
    this.initializeRAG().catch((err) => {
      logger.error("RAG", `Failed to initialize RAG system: ${err}`);
      this.ragDb = null;
      this.ragEmbedder = null;
      this.ragQuery = null;
      this.ragImporter = null;
      this.ragBatchProcessor = null;
    });

    // Give scanner a reference to the agent for persistent strategy memory
    scanner.chatAgent = this;

    // Wire RAG into the per-token LLM analyzer for compact historical context
    scanner.llmAnalyzer.ragContextFn = (candidate) =>
      this.tradeRAG!.retrieveCompact(candidate);

    if (!this.enabled) {
      logger.warn("AGENT", "Autonomous agent disabled — no ANTHROPIC_API_KEY");
      return;
    }

    logger.system("🤖 Autonomous AI agent starting...");

    // Apply timers based on current trading mode
    this.applyTradingMode(scanner.tradingMode);
  }

  /** Initialize the embedding-based RAG system asynchronously */
  private async initializeRAG(): Promise<void> {
    this.ragDb = new RAGDatabase(this.dataDir);
    await this.ragDb.initialize(); // Load WASM + open/create DB

    this.ragEmbedder = new EmbeddingService();
    this.ragQuery = new RAGQueryEngine(this.ragDb, this.ragEmbedder);
    this.ragImporter = new HistoricalImporter(this.ragDb, this.ragEmbedder, this.dataDir);
    this.ragBatchProcessor = new BatchProcessor(this.ragDb, this.ragEmbedder, this.apiKey);

    logger.system("📊 RAG embedding system initialized");

    // Import historical trades from journal (non-blocking)
    try {
      const count = await this.ragImporter.importFromTradeJournal();
      if (count > 0) {
        logger.system(`📊 RAG: Imported ${count} historical trades from journal`);
        const result = await this.ragBatchProcessor.runFullBatch();
        logger.system(`📊 RAG batch complete: ${result.embedded} embeddings, ${result.categorized} categorized, ${result.patternsUpdated} patterns`);
      }
    } catch (err) {
      logger.error("RAG", `Historical import/batch error: ${err}`);
    }

    // Schedule batch processing every 6 hours
    this.ragBatchTimer = setInterval(() => {
      this.ragBatchProcessor!.runFullBatch().then((result) => {
        if (result.embedded > 0 || result.categorized > 0) {
          logger.system(`📊 RAG scheduled batch: ${result.embedded} embeddings, ${result.categorized} categorized`);
        }
      }).catch((err) => logger.error("RAG", `Scheduled batch error: ${err}`));
    }, this.scannerRef?.config.dryRun ? 30 * 60_000 : 6 * 60 * 60_000); // 30min in dry run, 6hr in live
  }

  /** Apply trading mode — start/stop timers as needed */
  applyTradingMode(mode: "agent" | "uav" | "none"): void {
    // Clear existing timers
    if (this.autoReviewTimer) { clearInterval(this.autoReviewTimer); this.autoReviewTimer = null; }
    if (this.tokenReviewTimer) { clearInterval(this.tokenReviewTimer); this.tokenReviewTimer = null; }

    if (mode === "none") {
      logger.system("🤖 Agent OFF — no AI analysis, pure signal-based trading");
      return;
    }

    // Both "agent" and "uav" modes get auto-review (performance reviews, post-mortems)
    // Dry run: 30min interval to save API costs. Live: 10min.
    const isDryRun = this.scannerRef?.config.dryRun ?? false;
    const autoReviewMs = isDryRun ? 30 * 60_000 : AUTO_REVIEW_INTERVAL_MS;
    // Run first review after 15 seconds
    setTimeout(() => {
      this.runAutonomousReview().catch((err) =>
        logger.error("AGENT", `Auto-review error: ${err}`)
      );
    }, 15_000);

    this.autoReviewTimer = setInterval(() => {
      this.runAutonomousReview().catch((err) =>
        logger.error("AGENT", `Auto-review error: ${err}`)
      );
    }, autoReviewMs);

    logger.system(`🤖 Agent will review performance every ${autoReviewMs / 60_000} minutes${isDryRun ? " (dry-run cost saver)" : ""}`);

    // Only "agent" mode gets token review (candidate queuing + agent buy decisions)
    // Dry run: 90s interval (score 60+ fast-buys handle most tokens). Live: 30s.
    if (mode === "agent") {
      const tokenReviewMs = isDryRun ? 90_000 : TOKEN_REVIEW_INTERVAL_MS;
      this.tokenReviewTimer = setInterval(() => {
        this.runTokenReview().catch((err) =>
          logger.error("AGENT", `Token review error: ${err}`)
        );
      }, tokenReviewMs);

      logger.system(`🤖 Agent will review token candidates every ${tokenReviewMs / 1_000}s${isDryRun ? " (dry-run cost saver)" : ""}`);
    } else {
      logger.system("🤖 UAV mode — agent observes but score drives auto-buying");
    }
  }

  /** Trigger an immediate autonomous review (e.g. when scanner starts) */
  triggerReview(): void {
    if (!this.enabled || !this.scannerRef || !this.journalRef) return;
    logger.info("AGENT", "🤖 Triggering immediate review...");
    this.runAutonomousReview().catch((err) =>
      logger.error("AGENT", `Triggered review error: ${err}`)
    );
  }

  /** Stop the autonomous loop and record session summary */
  stopAutonomousLoop(): void {
    if (this.autoReviewTimer) {
      clearInterval(this.autoReviewTimer);
      this.autoReviewTimer = null;
    }
    if (this.tokenReviewTimer) {
      clearInterval(this.tokenReviewTimer);
      this.tokenReviewTimer = null;
    }

    // Record session summary to persistent strategy memory
    if (this.journalRef) {
      const analysis = this.journalRef.analyze();
      const keyEvents: string[] = [];
      // Collect notable events from this session's decisions
      const sessionDecisions = this.decisions.filter(
        (d) => d.type === "config-change" || d.type === "trade-action"
      );
      for (const d of sessionDecisions.slice(-5)) {
        keyEvents.push(d.summary.slice(0, 100));
      }
      this.strategy.addSessionSummary(
        analysis.totalTrades,
        analysis.wins,
        analysis.losses,
        analysis.totalPnl,
        keyEvents,
      );
    }

    this.persistChatHistory();
  }

  /** Handle a user chat message */
  async chat(userMessage: string, scanner: Scanner, journal: TradeJournal): Promise<ChatMessage> {
    const userMsg: ChatMessage = {
      id: this.nextId++,
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };
    this.history.push(userMsg);

    if (!this.enabled) {
      const noKeyMsg: ChatMessage = {
        id: this.nextId++,
        role: "assistant",
        content: "Chat is disabled — no ANTHROPIC_API_KEY configured.",
        timestamp: Date.now(),
      };
      this.history.push(noKeyMsg);
      return noKeyMsg;
    }

    // Handle research command
    const lowerMsg = userMessage.toLowerCase().trim();
    if (lowerMsg.match(/\b(research|study|analyze)\b.*\b(winners?|top tokens?|big coins?|best coins?)\b/) || lowerMsg === "research") {
      const countMatch = lowerMsg.match(/(\d+)/);
      const count = countMatch ? Math.min(parseInt(countMatch[1]), 200) : 100;
      if (this.winnerResearch) {
        if (this.winnerResearch.isRunning()) {
          const msg: ChatMessage = { id: this.nextId++, role: "assistant", content: "🔬 Research is already running. I'll let you know when it's done.", timestamp: Date.now() };
          this.history.push(msg);
          this.persistChatHistory();
          return msg;
        }
        // Fire async — don't block chat
        this.winnerResearch.runResearch(count).then(() => {
          logger.system(`🔬 Winner research completed — ${count} tokens analyzed`);
        }).catch((err: any) => {
          logger.error("RESEARCH", `Winner research failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        const msg: ChatMessage = { id: this.nextId++, role: "assistant", content: `🔬 **Winner Research Started!**\n\nI'm analyzing the top ${count} pump.fun tokens by market cap to learn what makes them successful.\n\nThis will take a minute or two. Once complete, the insights will automatically feed into my decision-making for every token review.\n\nI'll study:\n- Common themes & narratives\n- Social presence patterns (Twitter, Telegram, websites)\n- Naming conventions\n- Time-to-KOTH patterns\n- Market cap distribution\n- Program/platform patterns\n\nYou can check the results anytime by asking "show research" or visiting the API endpoint.`, timestamp: Date.now() };
        this.history.push(msg);
        this.persistChatHistory();
        return msg;
      } else {
        const msg: ChatMessage = { id: this.nextId++, role: "assistant", content: "Winner research module is not initialized.", timestamp: Date.now() };
        this.history.push(msg);
        this.persistChatHistory();
        return msg;
      }
    }

    // Handle "show research" command
    if (lowerMsg.match(/\b(show|get|display)\b.*\bresearch\b/) || lowerMsg === "research results" || lowerMsg === "research status") {
      if (this.winnerResearch) {
        const briefing = this.winnerResearch.getBriefing();
        const content = briefing || "No research data yet. Say **research winners** to start analyzing top pump.fun tokens.";
        const msg: ChatMessage = { id: this.nextId++, role: "assistant", content, timestamp: Date.now() };
        this.history.push(msg);
        this.persistChatHistory();
        return msg;
      }
    }

    // Handle "show graduates" / "graduate analysis" command
    if (lowerMsg.match(/\b(show|get|display)\b.*\bgraduat/) || lowerMsg.match(/\bgraduat.*\b(analysis|data|stats|trends)/)) {
      if (this.graduateAnalyzer) {
        const briefing = this.graduateAnalyzer.getBriefing();
        const content = briefing || "No graduate data yet. The analyzer is tracking bonding curve migrations in real-time — data will build up as tokens graduate to Raydium.";
        const msg: ChatMessage = { id: this.nextId++, role: "assistant", content, timestamp: Date.now() };
        this.history.push(msg);
        this.persistChatHistory();
        return msg;
      }
    }

    try {
      const systemPrompt = this.buildChatPrompt(scanner, journal);
      const conversationMessages = this.history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const responseText = await this.callClaude(systemPrompt, conversationMessages, MAX_TOKENS_CHAT);
      const { cleanText, actions, tradeActions } = this.parseAndApplyActions(responseText, scanner);

      // Execute trade actions (buy/sell/start/stop)
      await this.executeTradeActions(tradeActions, scanner);

      const assistantMsg: ChatMessage = {
        id: this.nextId++,
        role: "assistant",
        content: cleanText + this.formatTradeActionResults(tradeActions),
        timestamp: Date.now(),
        actions: actions.length > 0 ? actions : undefined,
        autonomous: false,
      };
      this.history.push(assistantMsg);

      if (actions.length > 0 || tradeActions.length > 0) {
        if (actions.length > 0) {
          logger.system(`🤖 Agent config change (user request): ${actions.map((a) => `${a.field}: ${a.oldValue} → ${a.newValue}`).join(", ")}`);
        }
        if (tradeActions.length > 0) {
          logger.system(`🤖 Agent trade actions: ${tradeActions.map((a) => `${a.type}${a.symbol ? " " + a.symbol : ""}${a.mint ? " " + a.mint.slice(0, 8) : ""}: ${a.result || "pending"}`).join(", ")}`);
        }
        this.decisions.push({
          timestamp: Date.now(),
          type: tradeActions.length > 0 ? "trade-action" : "config-change",
          summary: [
            ...actions.map((a) => `${a.field}=${a.newValue}`),
            ...tradeActions.map((a) => `${a.type}${a.symbol ? " " + a.symbol : ""}: ${a.result || "ok"}`),
          ].join(", "),
          actions,
          tradeActions: tradeActions.length > 0 ? tradeActions : undefined,
          reasoning: cleanText.slice(0, 500),
        });
        this.persistDecisions();
      }

      this.persistChatHistory();
      return assistantMsg;
    } catch (err) {
      const errMsg: ChatMessage = {
        id: this.nextId++,
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
      this.history.push(errMsg);
      this.persistChatHistory();
      return errMsg;
    }
  }

  /** Called after every trade exit — runs a focused post-mortem on the specific trade */
  async onTradeCompleted(scanner: Scanner, journal: TradeJournal, tradeSymbol: string, pnlSol: number, exitReason: string): Promise<void> {
    if (!this.enabled || !scanner.isRunning()) return;

    // Track lifetime trades in persistent strategy memory
    this.strategy.incrementLifetimeTrades();

    const stats = journal.analyze();

    // Log the trade to thinking panel
    const pnlEmoji = pnlSol >= 0 ? "🟢" : "🔴";
    thinkingLog.add({
      mint: "", symbol: tradeSymbol, type: "analysis" as any,
      decision: `${pnlEmoji} Trade completed: ${tradeSymbol} ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${exitReason})`,
      reasoning: [
        `Session: ${stats.wins}W/${stats.losses}L (${(stats.winRate * 100).toFixed(1)}%)`,
        `Total P&L: ${stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(4)} SOL`,
        `Trend: ${stats.recentTrend.direction}`,
      ],
    });

    // ── Record completed trade in RAG embedding database (forward collection) ──
    if (this.ragImporter) {
      // Find the matching exit entry in journal (most recent sell for this symbol)
      const completedTrades = journal.getCompletedTrades(20);
      const exitEntry = [...completedTrades].reverse().find(
        (e) => e.symbol === tradeSymbol && e.action === "sell"
      );
      if (exitEntry) {
        this.ragImporter.recordCompletedTrade({
          mint: exitEntry.mint,
          symbol: exitEntry.symbol,
          name: exitEntry.name || exitEntry.symbol,
          creator: "",
          entrySol: exitEntry.positionSizeSol || 0,
          entryPrice: exitEntry.entryPrice || 0,
          exitPrice: exitEntry.exitPrice || 0,
          pnlSol: exitEntry.pnlSol || 0,
          pnlPct: exitEntry.pnlPct || 0,
          exitReason: exitEntry.exitReason || exitReason,
          holdTimeSec: exitEntry.holdTimeSec || 0,
          peakPrice: exitEntry.peakPrice || 0,
          peakPnlPct: exitEntry.peakPnlPct || 0,
          signalScore: exitEntry.signalScore || 0,
          llmScore: exitEntry.llmScore || 0,
          llmNarrative: exitEntry.llmNarrative || "",
          llmConfidence: exitEntry.llmConfidence || 0,
          marketCapSol: exitEntry.marketCapSol || 0,
          volumeSol: exitEntry.volumeSol || 0,
          buyCount: exitEntry.buyCount || 0,
          sellCount: exitEntry.sellCount || 0,
          uniqueBuyers: exitEntry.uniqueBuyers || 0,
          bondingCurveProgress: exitEntry.bondingCurveProgress || 0,
          tokenAgeSec: exitEntry.tokenAgeSec || 0,
          marketRegime: exitEntry.marketRegime || "unknown",
          creatorReputation: exitEntry.creatorReputation || 0,
          spamLaunch: !!(exitEntry.spamLaunchCount),
          spamLaunchCount: exitEntry.spamLaunchCount || 0,
          whaleCount: exitEntry.whaleCount || 0,
          whaleVolumeSol: exitEntry.whaleVolumeSol || 0,
          socialScore: exitEntry.socialScore || 0,
          socialFirstMover: exitEntry.socialFirstMover || false,
          socialCompetingCoins: exitEntry.socialCompetingCoins || 0,
          socialXTweets: exitEntry.socialXTweets || 0,
          socialViralMeme: exitEntry.socialViralMeme || false,
          smartMoneyRank: exitEntry.smartMoneyRank || 0,
          smartMoneyWinRate: exitEntry.smartMoneyWinRate || 0,
        }).catch((err) => logger.warn("RAG", `Forward collection failed for ${tradeSymbol}: ${err}`));
      }
    }

    // Queue post-mortem (batched — runs after 30s of no new trades to save API costs)
    this.pendingPostMortems.push({ symbol: tradeSymbol, pnlSol, exitReason, timestamp: Date.now() });
    if (this.postMortemTimer) clearTimeout(this.postMortemTimer);
    this.postMortemTimer = setTimeout(() => {
      this.runBatchedPostMortem(scanner, journal).catch((err) =>
        logger.error("AGENT", `Batched post-mortem error: ${err}`)
      );
    }, 30_000); // Wait 30s for more trades to accumulate before sending 1 API call
  }

  /** Batched post-mortem — processes all pending trade exits in a single cheap Haiku call */
  private async runBatchedPostMortem(scanner: Scanner, journal: TradeJournal): Promise<void> {
    if (!this.enabled || this.pendingPostMortems.length === 0) return;

    const trades = this.pendingPostMortems.splice(0); // Take all pending
    this.postMortemTimer = null;

    const analysis = journal.analyze();
    const tradesList = trades.map((t) =>
      `${t.symbol}: ${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol.toFixed(4)} SOL (${t.exitReason})`
    ).join("\n");

    const systemPrompt = `You are a pump.fun memecoin trading analyst. Briefly review these completed trades.

SESSION STATS: ${analysis.wins}W/${analysis.losses}L (${(analysis.winRate * 100).toFixed(1)}% WR), P&L: ${analysis.totalPnl >= 0 ? "+" : ""}${analysis.totalPnl.toFixed(4)} SOL

RESPOND: One brief line per trade (what happened). No config changes. Max ${trades.length + 2} lines total.`;

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: `Post-mortem for ${trades.length} trade(s):\n${tradesList}` },
    ];

    try {
      // Use Haiku for post-mortems — cheap and fast, doesn't need Sonnet-level reasoning
      const responseText = await this.callClaude(systemPrompt, messages, 256, MODEL_FAST);
      const { cleanText } = this.parseAndApplyActions(responseText, scanner);

      // Record as a single batched decision
      const decision: AgentDecision = {
        timestamp: Date.now(),
        type: "observation",
        summary: `Post-mortem: ${trades.map((t) => `${t.symbol}(${t.pnlSol >= 0 ? "+" : ""}${t.pnlSol.toFixed(3)})`).join(", ")}`,
        actions: [],
        reasoning: cleanText.slice(0, 500),
      };
      this.decisions.push(decision);
      this.persistDecisions();

      // Add to chat as a single message
      const agentMsg: ChatMessage = {
        id: this.nextId++,
        role: "assistant",
        content: `📋 **Post-mortem** (${trades.length} trade${trades.length > 1 ? "s" : ""}):\n${cleanText}`,
        timestamp: Date.now(),
        autonomous: true,
      };
      this.history.push(agentMsg);
      this.persistChatHistory();

      logger.info("AGENT", `📋 Batched post-mortem: ${trades.length} trades reviewed (Haiku)`);
    } catch (err) {
      logger.error("AGENT", `Batched post-mortem failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Fast token review — reviews new token candidates and decides which to buy */
  private async runTokenReview(): Promise<void> {
    if (!this.enabled || !this.scannerRef || !this.journalRef) return;
    if (!this.scannerRef.isRunning()) return;

    const scanner = this.scannerRef;
    const candidates = scanner.getCandidates();

    if (candidates.length === 0) return; // Nothing to review — skip API call

    logger.info("AGENT", `🤖 Reviewing ${candidates.length} token candidate(s)...`);

    try {
      const systemPrompt = await this.buildTokenReviewPrompt(scanner, candidates);
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [
        {
          role: "user",
          content: `Review ${candidates.length} candidate(s). For each: BUY or SKIP + 1-line reason. Be brief.`,
        },
      ];

      // In dry run, use Haiku for ALL reviews (cost saver — fast-buy handles most 60+ tokens)
      // In live, use Haiku for 1-2 candidates, Sonnet for complex 3+ comparisons
      const isDryRunReview = scanner.config.dryRun;
      const reviewModel = isDryRunReview ? MODEL_FAST : (candidates.length <= 2 ? MODEL_FAST : undefined);
      const responseText = await this.callClaude(systemPrompt, messages, MAX_TOKENS_TOKEN_REVIEW, reviewModel);
      const { cleanText, actions, tradeActions } = this.parseAndApplyActions(responseText, scanner);

      // Execute trade actions (buys/sells)
      await this.executeTradeActions(tradeActions, scanner);

      // Clear reviewed candidates so they're not shown again
      const reviewedMints = candidates.map((c) => c.mint);
      scanner.clearCandidates(reviewedMints);

      const boughtCount = tradeActions.filter((a) => a.type === "buy" && a.result?.includes("success")).length;

      if (tradeActions.length > 0 || actions.length > 0) {
        const agentMsg: ChatMessage = {
          id: this.nextId++,
          role: "assistant",
          content: cleanText + this.formatTradeActionResults(tradeActions),
          timestamp: Date.now(),
          actions: actions.length > 0 ? actions : undefined,
          autonomous: true,
        };
        this.history.push(agentMsg);

        const decision: AgentDecision = {
          timestamp: Date.now(),
          type: tradeActions.length > 0 ? "trade-action" : "config-change",
          summary: `Token review: ${boughtCount} bought of ${candidates.length} candidates`,
          actions,
          tradeActions: tradeActions.length > 0 ? tradeActions : undefined,
          reasoning: cleanText.slice(0, 1000),
        };
        this.decisions.push(decision);
        this.persistDecisions();

        logger.system(`🤖 Token review: ${boughtCount}/${candidates.length} bought`);
        thinkingLog.add({
          mint: "", symbol: "AGENT", type: "analysis" as any,
          decision: `🤖 Token review: ${boughtCount}/${candidates.length} bought`,
          reasoning: [cleanText.slice(0, 500)],
        });
      } else {
        logger.info("AGENT", `🤖 Token review: passed on all ${candidates.length} candidates`);
      }
    } catch (err) {
      logger.error("AGENT", `Token review failed: ${err instanceof Error ? err.message : String(err)}`);
      // Still clear candidates to avoid infinite retries
      scanner.clearCandidates(candidates.map((c) => c.mint));
    }
  }

  /** Core autonomous review — analyzes performance and makes strategic adjustments */
  private async runAutonomousReview(): Promise<void> {
    if (!this.enabled || !this.scannerRef || !this.journalRef) return;
    if (!this.scannerRef.isRunning()) return;

    const scanner = this.scannerRef;
    const journal = this.journalRef;
    const analysis = journal.analyze();

    // Skip reviews when nothing is happening to save API costs
    const hasNewTrades = analysis.totalTrades > this.lastTradeCountAtReview;
    const timeSinceLastReview = Date.now() - this.lastAutoReviewAt;
    const openPositions = scanner.positions.getOpenPositions();
    // Truly idle (no open positions AND no new trades) — skip for 4x interval (40min)
    if (!hasNewTrades && openPositions.length === 0 && timeSinceLastReview < AUTO_REVIEW_INTERVAL_MS * 4) {
      return;
    }
    // Has open positions but no new trades — still review every 2 intervals to monitor them
    if (!hasNewTrades && timeSinceLastReview < AUTO_REVIEW_INTERVAL_MS * 2) {
      return;
    }

    this.lastAutoReviewAt = Date.now();
    this.lastTradeCountAtReview = analysis.totalTrades;

    // ── Dry-run strategy rotation: apply next preset for diverse data ──
    if (scanner.config.dryRun) {
      const preset = STRATEGY_PRESETS[this.strategyPresetIndex % STRATEGY_PRESETS.length]!;
      this.activePresetName = preset.name;
      for (const [field, value] of Object.entries(preset.config)) {
        if (DRY_RUN_LOCKED_FIELDS.has(field)) continue; // never touch capacity fields
        if (value === undefined) continue;
        (scanner.config as unknown as Record<string, number>)[field] = value;
      }
      logger.system(`🔬 Strategy rotation: "${preset.name}" — ${preset.description}`);
      this.strategyPresetIndex++;
    }

    logger.info("AGENT", `🤖 Running autonomous ${hasNewTrades ? "performance" : "market"} review (${analysis.totalTrades} trades)...`);

    try {
      const systemPrompt = this.buildAutonomousPrompt(scanner, journal, analysis);
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [
        {
          role: "user",
          content: `Quick review. ${hasNewTrades ? "New trades — brief analysis." : "No new trades — check positions."} Be brief: bullet points, actions taken, done. Max 3 sentences.`,
        },
      ];

      const responseText = await this.callClaude(systemPrompt, messages, MAX_TOKENS_AUTONOMOUS);
      const { cleanText, actions, tradeActions } = this.parseAndApplyActions(responseText, scanner);

      // Execute trade actions (buy/sell/start/stop)
      await this.executeTradeActions(tradeActions, scanner);

      // Add to history as autonomous message
      const agentMsg: ChatMessage = {
        id: this.nextId++,
        role: "assistant",
        content: cleanText + this.formatTradeActionResults(tradeActions),
        timestamp: Date.now(),
        actions: actions.length > 0 ? actions : undefined,
        autonomous: true,
      };
      this.history.push(agentMsg);

      // Record decision
      const hasActions = actions.length > 0 || tradeActions.length > 0;
      const decision: AgentDecision = {
        timestamp: Date.now(),
        type: tradeActions.length > 0 ? "trade-action" : (actions.length > 0 ? "config-change" : "observation"),
        summary: hasActions
          ? [
              ...actions.map((a) => `${a.field}: ${a.oldValue}→${a.newValue}`),
              ...tradeActions.map((a) => `${a.type}${a.symbol ? " " + a.symbol : ""}: ${a.result || "ok"}`),
            ].join(", ")
          : `Reviewed (${analysis.totalTrades} trades, ${(analysis.winRate * 100).toFixed(0)}% WR) — no changes`,
        actions,
        tradeActions: tradeActions.length > 0 ? tradeActions : undefined,
        reasoning: cleanText.slice(0, 1000),
      };
      this.decisions.push(decision);
      this.persistDecisions();

      if (hasActions) {
        if (actions.length > 0) {
          logger.system(`🤖 AUTONOMOUS CONFIG CHANGE: ${actions.map((a) => `${a.field}: ${a.oldValue} → ${a.newValue}`).join(", ")}`);
        }
        if (tradeActions.length > 0) {
          logger.system(`🤖 AUTONOMOUS TRADE: ${tradeActions.map((a) => `${a.type}${a.symbol ? " " + a.symbol : ""}: ${a.result || "ok"}`).join(", ")}`);
        }
        thinkingLog.add({
          mint: "", symbol: "AGENT", type: "analysis" as any,
          decision: `🤖 ${[
            ...actions.map((a) => `${a.field}=${a.newValue}`),
            ...tradeActions.map((a) => `${a.type}${a.symbol ? " " + a.symbol : ""}: ${a.result || "ok"}`),
          ].join(", ")}`,
          reasoning: [cleanText.slice(0, 500)],
        });
      } else {
        logger.info("AGENT", `🤖 Review complete — no changes needed`);
      }

      // Trim
      if (this.history.length > 100) this.history = this.history.slice(-80);
      this.persistChatHistory();
      if (this.decisions.length > 200) {
        this.decisions = this.decisions.slice(-150);
        this.persistDecisions();
      }

    } catch (err) {
      logger.error("AGENT", `Autonomous review failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildChatPrompt(scanner: Scanner, journal: TradeJournal): string {
    const base = this.buildStateContext(scanner);
    const tradeContext = journal.getTradeContext(15);
    const analysis = journal.analyze();
    const recentDecisions = this.decisions.slice(-5);

    return `You are the AI trading strategist for a pump.fun memecoin sniper bot. You help the user and actively manage trading parameters.

📝 Keep ALL responses concise — 3-5 sentences max unless the user asks for detailed analysis. Bullet points preferred. No walls of text.

${base}

RECENT TRADE LOG:
${tradeContext}

JOURNAL ANALYSIS:
- Win Rate: ${(analysis.winRate * 100).toFixed(1)}% (${analysis.wins}W/${analysis.losses}L)
- Avg Win: +${analysis.avgWin.toFixed(4)} SOL | Avg Loss: ${analysis.avgLoss.toFixed(4)} SOL
- Avg Hold: ${analysis.avgHoldTimeSec.toFixed(0)}s
- Trend: ${analysis.recentTrend.direction} (last ${analysis.recentTrend.trades}: ${(analysis.recentTrend.winRate * 100).toFixed(0)}% WR)
${analysis.patterns.length > 0 ? "\nPATTERNS DETECTED:\n" + analysis.patterns.map((p) => `  ⚡ ${p}`).join("\n") : ""}

RECENT AGENT DECISIONS:
${recentDecisions.length > 0 ? recentDecisions.map((d) => `  [${new Date(d.timestamp).toLocaleTimeString()}] ${d.type}: ${d.summary}`).join("\n") : "  None yet"}

${this.strategy.getStrategyContext()}
---

HOW TO CHANGE CONFIG:
To change any setting, include a JSON block in your response like this:

\`\`\`config
{"minPositionSizeSol": 0.03, "maxPositionSizeSol": 0.08, "stopLossPct": 0.12}
\`\`\`

CRITICAL: All Pct fields use DECIMAL format (0.12 = 12%, 0.25 = 25%, 0.08 = 8%). NEVER use whole numbers for percentage fields.
Examples: stopLossPct 12% = 0.12, takeProfitPct1 25% = 0.25, trailingStopActivationPct 10% = 0.10

Available fields: ${EDITABLE_FIELDS.join(", ")}
You CANNOT change dryRun — only the user can toggle it from the dashboard.

⛔ CONFIG GUARDRAILS (hard limits you CANNOT exceed):
${Object.entries(getConfigBounds(scanner.config.dryRun)).map(([f, b]) => `  ${f}: min=${b.min}, max=${b.max}`).join("\n")}

🚨 ANTI-DOOM-LOOP: NEVER reduce maxPositionAgeSec below 45. Values of 15-20s caused 16 consecutive losses. If losing, the fix is pickier entries (raise minBuyScore), tighter stop-losses (lower stopLossPct), or pausing — NOT shorter hold times.

The config block will be parsed and applied automatically. Include it naturally when the user asks for changes or when you recommend adjustments.

HOW TO EXECUTE TRADES:
You can directly buy/sell tokens and control the bot. Include an action block:

\`\`\`action
{"type":"buy","mint":"TOKEN_MINT_ADDRESS","amount":0.05}
\`\`\`

\`\`\`action
{"type":"sell","mint":"TOKEN_MINT_ADDRESS"}
\`\`\`

\`\`\`action
{"type":"sell","symbol":"TOKENNAME"}
\`\`\`

\`\`\`action
{"type":"sell-all"}
\`\`\`

\`\`\`action
{"type":"start"}
\`\`\`

\`\`\`action
{"type":"stop"}
\`\`\`

Action types:
- **buy**: Buy a specific token by mint address. "amount" in SOL is HARD CAPPED to maxPositionSizeSol (currently ${scanner.config.maxPositionSizeSol}). If you want to buy more, you must FIRST change maxPositionSizeSol via a config action, then buy. IMPORTANT: Use the REAL mint address from market intelligence data (shown in [brackets]). Include "symbol" too for readability. Example: {"type":"buy","mint":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU","symbol":"TOKEN","amount":0.05}
- **sell**: Sell a position by mint address or symbol name.
- **sell-all**: Close all open positions immediately.
- **start**: Start the scanner/bot.
- **stop**: Stop the scanner/bot.

You can include multiple action blocks in one response. Each one is executed independently.
When the user asks you to buy/sell something, DO IT — don't just suggest it.
NEVER specify an amount larger than maxPositionSizeSol (${scanner.config.maxPositionSizeSol} SOL). The system will reject it.

GUIDELINES:
- Be concise, direct, data-driven
- When suggesting changes, cite specific data (win rate, avg loss, pattern)
- Reference the trade log to explain decisions
- Use market intelligence data to identify trending narratives and find specific tokens to buy
- If the user asks to buy/sell, execute the action — don't ask for confirmation
- If performance is bad, proactively suggest fixes
- Use trading terminology, format with markdown
- Never reveal private keys`;
  }

  private buildAutonomousPrompt(scanner: Scanner, journal: TradeJournal, analysis: JournalAnalysis): string {
    const base = this.buildCompactStateContext(scanner);
    const tradeContext = journal.getTradeContext(15);
    const recentDecisions = this.decisions.slice(-10);

    return `You are an autonomous AI sniper agent managing a pump.fun memecoin launch sniper bot. Your strategy is EARLY-LAUNCH SNIPING — catching quality tokens in their first 30-60 seconds. The pump.fun ecosystem does NOT support longevity; tokens pump and dump fast. You are running a periodic review.

📝 RESPONSE FORMAT: 3-4 sentences max. Bullet points. No lengthy philosophy.
${scanner.config.dryRun && this.activePresetName ? `
🔬 STRATEGY EXPERIMENT MODE: Currently testing "${this.activePresetName}" preset.
Your job is to OBSERVE and ANALYZE how this strategy performs — do NOT change the config parameters that were set by the experiment rotation. Focus your review on:
- How is this strategy performing compared to previous presets?
- What types of tokens/narratives work best with these settings?
- Save lessons about what you observe with \`\`\`lesson blocks.
- You can still execute manual buy/sell actions if you see opportunities or threats.
` : ""}
${base}

═══ FULL TRADE LOG (Last 30 exits) ═══
${tradeContext}

═══ DEEP ANALYSIS ═══
Completed Trades: ${analysis.totalTrades}
Win/Loss: ${analysis.wins}W / ${analysis.losses}L (${(analysis.winRate * 100).toFixed(1)}% WR)
Total P&L: ${analysis.totalPnl >= 0 ? "+" : ""}${analysis.totalPnl.toFixed(4)} SOL
Avg Win: +${analysis.avgWin.toFixed(4)} SOL
Avg Loss: ${analysis.avgLoss.toFixed(4)} SOL
Risk/Reward: ${analysis.avgLoss !== 0 ? (Math.abs(analysis.avgWin / analysis.avgLoss)).toFixed(2) : "N/A"}x
Avg Hold: ${analysis.avgHoldTimeSec.toFixed(0)}s

EXIT REASON BREAKDOWN:
${Object.entries(analysis.exitReasonStats).map(([reason, s]) => `  ${reason}: ${s.count} trades, ${(s.winRate * 100).toFixed(0)}% WR, avg P&L ${s.avgPnl >= 0 ? "+" : ""}${s.avgPnl.toFixed(4)} SOL`).join("\n")}

MARKET REGIME PERFORMANCE:
${Object.entries(analysis.regimeStats).map(([regime, s]) => `  ${regime}: ${s.count} trades, ${(s.winRate * 100).toFixed(0)}% WR, avg P&L ${s.avgPnl >= 0 ? "+" : ""}${s.avgPnl.toFixed(4)} SOL`).join("\n")}

SIGNAL SCORE PERFORMANCE:
${Object.entries(analysis.scoreRangeStats).filter(([, s]) => s.count > 0).map(([range, s]) => `  Score ${range}: ${s.count} trades, ${(s.winRate * 100).toFixed(0)}% WR, avg P&L ${s.avgPnl >= 0 ? "+" : ""}${s.avgPnl.toFixed(4)} SOL`).join("\n")}

NARRATIVE PERFORMANCE:
${Object.entries(analysis.narrativeStats).filter(([, s]) => s.count > 0).map(([narrative, s]) => `  ${narrative}: ${s.count} trades, ${(s.winRate * 100).toFixed(0)}% WR, avg P&L ${s.avgPnl >= 0 ? "+" : ""}${s.avgPnl.toFixed(4)} SOL`).join("\n")}

TREND: ${analysis.recentTrend.direction.toUpperCase()}
Last ${analysis.recentTrend.trades} trades: ${(analysis.recentTrend.winRate * 100).toFixed(0)}% WR, avg ${analysis.recentTrend.avgPnl >= 0 ? "+" : ""}${analysis.recentTrend.avgPnl.toFixed(4)} SOL

DETECTED PATTERNS:
${analysis.patterns.length > 0 ? analysis.patterns.map((p) => `  ⚡ ${p}`).join("\n") : "  No clear patterns yet"}

${this.tradeRAG ? this.tradeRAG.getCompactLessons() : ""}

${getCompactExpertKnowledge()}

${this.strategy.getCompactContext()}

═══ PREVIOUS DECISIONS ═══
${recentDecisions.length > 0 ? recentDecisions.map((d) => `  [${new Date(d.timestamp).toLocaleTimeString()}] ${d.type}: ${d.summary}\n    Reasoning: ${d.reasoning.slice(0, 200)}`).join("\n") : "  No previous decisions"}

═══ YOUR TASK ═══
${scanner.config.dryRun ? `1. Close aging/dumping positions NOW
2. Brief strategic adjustments only if 10+ trades show a clear pattern` : `1. Evaluate EACH open position individually — decide per-token whether to HOLD or SELL based on its specific momentum, volume, and narrative
2. Close positions that are clearly dead (no volume, declining price, dev sold)
3. Let strong positions run — do NOT sell winners prematurely just because of a global rule
4. Brief strategic adjustments only if 10+ trades show a clear pattern`}

📝 RESPONSE FORMAT: Be CONCISE. 3-4 sentences max. Bullet points only.

🔥 CORE: Pump.fun is a NUMBERS GAME. Many small bets, most lose, 2-5x winners cover everything. 30% WR with 3x avg winner = PROFITABLE.
${scanner.config.dryRun ? `
🚨 ANTI-RISK-AVERSION (your #1 failure mode):
- NEVER raise minBuyScore >65, lower stopLossPct <0.08, lower trailingStopActivationPct <0.15, lower takeProfitPct1 <0.15
- Only change config after 10+ trades show a clear pattern. Losses are EXPECTED (60-80% lose).
- YOUR INSTINCT TO "PROTECT" AGAINST LOSSES IS YOUR WORST ENEMY.
- Default: Do NOT change config. Keep trading.

CONFIG: \`\`\`config {"field": value}\`\`\` — Pct fields use DECIMAL (0.12 = 12%). Fields: ${EDITABLE_FIELDS.join(", ")}
Guardrails: ${Object.entries(getConfigBounds(scanner.config.dryRun)).map(([f, b]) => `${f}:${b.min}-${b.max}`).join(", ")}` : `
🎯 LIVE EXIT MANAGEMENT — You control exits per-token:
- Only hard safety nets run mechanically (emergency stop-loss, age timeout). All other exits are YOUR decision.
- Evaluate each position's momentum individually: volume, buy pressure, narrative strength, social signals.
- A token riding a hot narrative with active buyers → HOLD even if it dipped. A token with dead volume → SELL.
- Use sell commands to exit positions when YOU decide the time is right.
- You can still adjust global config (entry thresholds, position sizes) but exit timing is YOUR call per-token.

CONFIG: \`\`\`config {"field": value}\`\`\` — Pct fields use DECIMAL (0.12 = 12%). Fields: ${EDITABLE_FIELDS.join(", ")}
Guardrails: ${Object.entries(getConfigBounds(scanner.config.dryRun)).map(([f, b]) => `${f}:${b.min}-${b.max}`).join(", ")}`}

ACTIONS:
\`\`\`action
{"type":"buy","mint":"MINT","symbol":"SYM","amount":0.05}
\`\`\`
\`\`\`action
{"type":"sell","symbol":"NAME"}
\`\`\`
Types: buy (amount capped to ${scanner.config.maxPositionSizeSol} SOL), sell (by mint or symbol), sell-all, start. Cannot stop.

LESSONS: \`\`\`lesson {"lesson":"...","category":"entry|exit|risk|narrative|timing|social|smart-money|general"}\`\`\`
STRATEGY: \`\`\`strategy {"coreInsights":["..."],"profitableNarratives":["..."]}\`\`\` Fields: coreInsights, profitableNarratives, unprofitableNarratives, exitInsights, entryInsights, signalInsights

Combine config/actions/lessons/strategy in one response. Be decisive.`;
  }

  /** Build a focused prompt for the fast token review loop */
  private async buildTokenReviewPrompt(scanner: Scanner, candidates: CandidateToken[]): Promise<string> {
    const status = scanner.getStatus();
    const openPositions = scanner.positions.getOpenPositions();
    const regime = scanner.marketRegime.getRegime();

    const positionsSummary = openPositions.length > 0
      ? openPositions.map((p) => {
          const pnlPct = (p.unrealizedPnlPct * 100).toFixed(1);
          const holdSec = Math.round((Date.now() - p.openedAt) / 1000);
          const peakPnlPct = p.peakPrice > 0 ? ((p.peakPrice - p.entryPrice) / p.entryPrice * 100).toFixed(1) : "?";
          // In live mode, show more detail for per-token exit decisions
          if (!status.dryRun) {
            const metrics = scanner.pumpApi.metrics.get(p.mint);
            const recentTrades = metrics ? metrics.recentTrades.filter(t => t.timestamp >= Date.now() - 30_000).length : 0;
            const recentBuys = metrics ? metrics.recentTrades.filter(t => t.timestamp >= Date.now() - 30_000 && t.txType === "buy").length : 0;
            return `  ${p.symbol} [${p.mint}]: ${pnlPct}% (${p.unrealizedPnlSol.toFixed(4)} SOL), peak ${peakPnlPct}%, held ${holdSec}s, 30s activity: ${recentTrades} trades (${recentBuys} buys)`;
          }
          return `  ${p.symbol}: ${pnlPct}% (${p.unrealizedPnlSol.toFixed(4)} SOL), held ${holdSec}s`;
        }).join("\n")
      : "  None";

    const candidatesList = (await Promise.all(candidates.map(async (c, i) => {
      const llmInfo = c.llmAnalysis
        ? `\n    LLM: ${c.llmAnalysis.score}/100 (${c.llmAnalysis.narrative}) — ${c.llmAnalysis.reasoning.slice(0, 150)}`
        : "";
      const freshTag = c.ageSec <= 15 ? " 🎯 ULTRA FRESH" : c.ageSec <= 30 ? " ⚡ FRESH" : c.ageSec <= 60 ? "" : " ⏳ AGING";
      const smartTag = c.smartMoneySignal
        ? ` 🐋 SMART MONEY (Top #${c.smartMoneySignal.walletRank}, WR: ${(c.smartMoneySignal.walletWinRate * 100).toFixed(0)}%, ${c.smartMoneySignal.walletTrades} trades, P&L: ${c.smartMoneySignal.walletPnlSol >= 0 ? "+" : ""}${c.smartMoneySignal.walletPnlSol.toFixed(3)} SOL)`
        : "";
      const spamTag = c.spamLaunchCount && c.spamLaunchCount >= 3
        ? ` 💥 COORDINATED LAUNCH (${c.spamLaunchCount} copies — this is the FIRST mint)`
        : "";
      const socialTag = c.socialSignal
        ? (c.socialSignal.isFirstMover && c.socialSignal.isViralMeme
            ? ` 💎 JACKPOT (viral meme + first coin!)`
            : c.socialSignal.isXTrending
              ? ` 🐦 TRENDING ON X.com (${c.socialSignal.xTweetCount} tweets)`
              : c.socialSignal.isFirstMover
                ? ` 🥇 FIRST MOVER (${c.socialSignal.competingCoins} competitors)`
                : c.socialSignal.isViralMeme
                  ? ` 🔥 VIRAL MEME (${c.socialSignal.redditEngagement} Reddit + ${c.socialSignal.xTweetCount} tweets)`
                  : c.socialSignal.xTweetCount > 0
                    ? ` 🐦 X.com (${c.socialSignal.xTweetCount} tweets, ${c.socialSignal.xProfileCount} profiles)`
                    : c.socialSignal.competingCoins > 5
                      ? ` ⚠️ SATURATED (${c.socialSignal.competingCoins} similar coins)`
                      : "")
        : "";
      const socialLine = c.socialSignal?.scanned
        ? `\n    📱 Social: ${c.socialSignal.summary}`
        : "";
      // RAG: retrieve similar past trades for this candidate
      let ragLine = "";
      if (this.tradeRAG) {
        const ragCtx = this.tradeRAG.retrieve({
          name: c.name,
          symbol: c.symbol,
          marketCapSol: c.marketCapSol,
          recentVolumeSol: c.recentVolumeSol,
          buyCount: c.buyCount,
          sellCount: c.sellCount,
          uniqueBuyers: c.uniqueBuyers,
          bondingCurveProgress: c.bondingCurveProgress,
          ageSec: c.ageSec,
          marketRegime: c.marketRegime,
          creatorReputation: c.creatorReputation,
          llmNarrative: c.llmAnalysis?.narrative,
          signalScore: c.score,
        });
        if (ragCtx.active && ragCtx.similarTrades.length > 0) {
          const stats = ragCtx.aggregateStats;
          ragLine = `\n    📊 RAG: ${stats.totalMatches} similar past trades → ${stats.wins}W/${stats.losses}L (${(stats.winRate * 100).toFixed(0)}% WR), avg P&L: ${(stats.avgPnlPct * 100).toFixed(1)}%, common exit: ${stats.mostCommonExitReason}`;
          if (stats.wins > stats.losses) ragLine += " ✅ HISTORICAL WINNERS";
          else if (stats.losses > 0 && stats.wins === 0) ragLine += " (past losses = check what's DIFFERENT about this token)";
          // Don't add scary warnings — let the agent decide
        }
      }
      // Embedding RAG: deep similarity search against historical trades
      let embeddingRagLine = "";
      if (this.ragQuery) {
        try {
          const ragResult = await this.ragQuery.evaluate({
            symbol: c.symbol,
            name: c.name,
            llmNarrative: c.llmAnalysis?.narrative || "",
            marketCapSol: c.marketCapSol,
            volumeSol: c.recentVolumeSol,
            buyCount: c.buyCount,
            sellCount: c.sellCount,
            uniqueBuyers: c.uniqueBuyers,
            bondingCurveProgress: c.bondingCurveProgress,
            tokenAgeSec: c.ageSec,
            signalScore: c.score,
            marketRegime: c.marketRegime,
            creatorReputation: c.creatorReputation,
            spamLaunchCount: c.spamLaunchCount,
            socialScore: c.socialSignal?.score,
            socialFirstMover: c.socialSignal?.isFirstMover,
            socialCompetingCoins: c.socialSignal?.competingCoins,
            socialXTweets: c.socialSignal?.xTweetCount,
            socialViralMeme: c.socialSignal?.isViralMeme,
            smartMoneyRank: c.smartMoneySignal?.walletRank,
            smartMoneyWinRate: c.smartMoneySignal?.walletWinRate,
          });
          if (ragResult.promptContext) {
            embeddingRagLine = `\n    ${ragResult.promptContext}`;
          }
        } catch {}
      }
      return `  ${i + 1}. ${c.symbol} (${c.name})${freshTag}${smartTag}${spamTag}${socialTag}
    Mint: ${c.mint}
    Signal Score: ${c.score}/100 (advisory) | Token Age: ${c.ageSec}s
    Market Cap: ${c.marketCapSol.toFixed(2)} SOL | Volume: ${c.recentVolumeSol.toFixed(2)} SOL
    Buys: ${c.buyCount} | Sells: ${c.sellCount} | Unique Buyers: ${c.uniqueBuyers}
    Bonding Curve: ${(c.bondingCurveProgress * 100).toFixed(1)}%
    Creator Rep: ${c.creatorReputation} | Regime: ${c.marketRegime}${llmInfo}${c.smartMoneySignal ? `\n    🐋 Smart wallet bought ${c.smartMoneySignal.buySolAmount.toFixed(3)} SOL — PRIORITY SIGNAL` : ""}${socialLine}${ragLine}${embeddingRagLine}`;
    }))).join("\n\n");

    const recentDecisions = this.decisions.slice(-5);
    const journal = this.journalRef!;
    const analysis = journal.analyze();

    return `You are an autonomous AI SNIPER AGENT for pump.fun memecoins. Your job is to catch quality launches EARLY — in the first 30-60 seconds of a token's life. Speed is critical. The pump.fun ecosystem does NOT support longevity — tokens pump and dump fast. You need to get in early and get out with profit.

YOU make ALL buy/sell decisions. The signal score is advisory data — it does NOT decide. YOU decide.

⚠️ TRADING MANDATE: Be selective but not frozen. Quality entries matter — look for 3+ confirming signals before buying. Don't chase every token, but DO act on strong setups. A sniper that never fires never wins. Small calculated bets on good candidates are the path to profit. Your stop-losses are your safety net.

STATE:
- Mode: ${status.dryRun ? "DRY RUN" : "LIVE"} | Regime: ${regime}
- Positions: ${status.openPositions}/${scanner.config.maxConcurrentPositions} | Exposure: ${scanner.positions.getTotalExposureSol().toFixed(4)}/${scanner.config.maxTotalExposureSol} SOL
- Position Size Range: ${scanner.config.minPositionSizeSol}–${scanner.config.maxPositionSizeSol} SOL
- Risk: ${status.riskStatus.consecutiveLosses} consecutive losses${status.riskStatus.coolingDown ? " ⚠️ COOLING DOWN" : ""}
- Session: ${analysis.wins}W/${analysis.losses}L (${analysis.totalTrades > 0 ? (analysis.winRate * 100).toFixed(0) : "0"}% WR), P&L: ${analysis.totalPnl >= 0 ? "+" : ""}${analysis.totalPnl.toFixed(4)} SOL

OPEN POSITIONS:
${positionsSummary}

═══ TOKEN CANDIDATES (newest first) ═══
${candidatesList}

${this.tradeRAG ? this.tradeRAG.getCompactLessons() : ""}

${this.ragQuery ? this.ragQuery.getStatusSummary() : ""}

${getCompactExpertKnowledge()}

${this.strategy.getCompactContext()}

${scanner.marketIntel.getCompactBriefing()}

${scanner.smartMoney.getCompactBriefing()}

${this.winnerResearch?.getCompactBriefing() ?? ""}

${this.graduateAnalyzer?.getCompactBriefing() ?? ""}

RECENT DECISIONS:
${recentDecisions.length > 0 ? recentDecisions.map((d) => `  [${new Date(d.timestamp).toLocaleTimeString()}] ${d.type}: ${d.summary}`).join("\n") : "  None yet"}

═══ SNIPING STRATEGY ═══
Key signals for quality early launches (need 3+ to trigger a buy):
1. **🐋 SMART MONEY** — If a top-ranked profitable trader has bought → HIGH PRIORITY, buy immediately.
2. **� COORDINATED LAUNCH** — 3+ tokens with SAME name/ticker created simultaneously = trending hype. Multiple scammers racing to capitalize means the NAME is hot. The FIRST mint is usually the real one — BUY IT immediately. This is one of the strongest signals.
3. **🐦 X.COM TRENDING** — Real tweets/profiles on X.com = existing community. More buzz = more buyers.
4. **💎 FIRST MOVER** — First memecoin for a trending meme = HUGE signal. With X.com (💎 JACKPOT) = highest conviction.
5. **🔥 VIRAL MEME** — High engagement on X.com AND Reddit = organic cross-platform virality.
6. **FRESHNESS** — Under 30s is ideal. Under 60s is acceptable. Over 90s = too late.
7. **Buy pressure** — 3:1+ buy:sell ratio with multiple unique buyers.
8. **Volume velocity** — >1 SOL in first 30s.
9. **Bonding curve** — Under 20% = maximum upside. 40-60% with sustained volume = graduation signal.
10. **Creator reputation** — Negative = skip. Unknown is okay for fresh tokens.
11. **Narrative fit** — Matches trending themes from market intel.
12. **LLM score** — Supporting data, not decisive.
13. **Anti-rug** — No single-wallet dominance, dev not selling.

DECISION FRAMEWORK:
- 🟢 BUY if 3+ positive signals align (e.g. fresh + good buy ratio + narrative/social + volume)
- 🟢 BUY IMMEDIATELY if JACKPOT or COORDINATED LAUNCH signal present with supporting metrics (volume > 3 SOL, 10+ buyers)
- 🟡 CONSIDER if 2 positive signals (buy if very fresh <30s and no red flags)
- 🔴 SKIP only if clear red flags present (dev sold, negative creator rep, whale dominance, dead volume)
- Smart money signals: supplementary data — use as a bonus signal, not a standalone trigger
- RAG context: informational — consider it but don't let past losses on vaguely similar tokens paralyze you. Focus on what makes THIS token different.

RED FLAGS (these DO warrant skipping):
- Creator reputation negative = known scammer
- Dev wallet has sold = rug in progress
- Token > 90s old with declining volume = dead launch
- Single wallet dominates >30% of buy volume = wash trading
- 5+ competing coins with same name = saturated
- No metadata URL = 0% graduation rate historically

To buy:
\`\`\`action
{"type":"buy","mint":"MINT_ADDRESS","amount":${scanner.config.minPositionSizeSol}}
\`\`\`

To sell an open position:
\`\`\`action
{"type":"sell","symbol":"TOKENNAME"}
\`\`\`

BE DECISIVE: In sniping, hesitation = missed opportunity. If a fresh token has 3+ positive signals, BUY IT. You have stop-losses as safety nets.
${!status.dryRun && openPositions.length > 0 ? `
═══ LIVE EXIT MANAGEMENT ═══
You are in LIVE mode. YOU decide when to exit each position individually based on its specific situation.
Only hard safety nets run mechanically: emergency stop-loss and age timeout.
For each open position, evaluate:
- Is momentum still alive? (recent buys, volume)
- Has it peaked and is now declining? → SELL
- Is it still building? → HOLD for bigger profit
- Is volume dead with no recovery? → SELL
- Consider each token's narrative strength, social signals, and smart money activity independently.
Issue sell commands per-token when YOU decide:
\`\`\`action
{"type":"sell","symbol":"TOKENNAME"}
\`\`\`
` : ""}
📝 RESPONSE FORMAT: 2-3 sentences max per decision. BUY/SKIP + 1-line reason. No lengthy analysis.`;
  }

  private buildStateContext(scanner: Scanner): string {
    const status = scanner.getStatus();
    const openPositions = scanner.positions.getOpenPositions();
    const regime = scanner.marketRegime.getRegime();
    const regimeAdj = scanner.marketRegime.getScoreAdjustment();
    const blacklistStats = scanner.creatorBlacklist.getStats();
    const llmStats = scanner.llmAnalyzer.getStats();

    const positionsSummary = openPositions.length > 0
      ? openPositions.map((p) => {
          const pnlPct = (p.unrealizedPnlPct * 100).toFixed(1);
          const holdSec = Math.round((Date.now() - p.openedAt) / 1000);
          return `  ${p.symbol}: ${pnlPct}% (${p.unrealizedPnlSol.toFixed(4)} SOL), held ${holdSec}s`;
        }).join("\n")
      : "  None";

    return `BOT STATE:
- Running: ${status.running} | Mode: ${status.dryRun ? "DRY RUN" : "LIVE"} | Uptime: ${status.uptime}
- Open Positions: ${status.openPositions}

WALLET: ${status.walletPublicKey}

CURRENT CONFIG:
  minPositionSizeSol: ${status.config.minPositionSizeSol} (min SOL per trade)
  maxPositionSizeSol: ${status.config.maxPositionSizeSol} (max SOL per trade)
  maxConcurrentPositions: ${status.config.maxConcurrentPositions}
  maxTotalExposureSol: ${status.config.maxTotalExposureSol}
  stopLossPct: ${status.config.stopLossPct} (=${(status.config.stopLossPct * 100).toFixed(1)}%)
  takeProfitPct1: ${status.config.takeProfitPct1} (=${(status.config.takeProfitPct1 * 100).toFixed(1)}%)
  takeProfitPct2: ${status.config.takeProfitPct2} (=${(status.config.takeProfitPct2 * 100).toFixed(1)}%)
  minBuyScore: ${scanner.config.minBuyScore}
  maxPositionAgeSec: ${scanner.config.maxPositionAgeSec}
  trailingStopActivationPct: ${scanner.config.trailingStopActivationPct} (=${(scanner.config.trailingStopActivationPct * 100).toFixed(1)}%)
  trailingStopDistancePct: ${scanner.config.trailingStopDistancePct} (=${(scanner.config.trailingStopDistancePct * 100).toFixed(1)}%)

INTELLIGENCE:
  Market Regime: ${regime} (boost: ${regimeAdj.minScoreBoost}, size: ${regimeAdj.sizeMultiplier}x)
  Blacklisted Creators: ${blacklistStats.totalBlacklisted}/${blacklistStats.totalTracked}
  LLM Analyzer: ${llmStats.enabled ? `Active (${llmStats.calls} calls, avg ${llmStats.avgLatencyMs}ms)` : "Disabled"}

OPEN POSITIONS:
${positionsSummary}

RISK: ${status.riskStatus.consecutiveLosses} consecutive losses, cooling: ${status.riskStatus.coolingDown}

${scanner.marketIntel.getBriefing()}

${scanner.smartMoney.getBriefing()}

${this.winnerResearch?.getBriefing() ?? ""}

${this.graduateAnalyzer?.getBriefing() ?? ""}`;
  }

  /** Compact state context for autonomous review — uses compact briefings to save tokens */
  private buildCompactStateContext(scanner: Scanner): string {
    const status = scanner.getStatus();
    const openPositions = scanner.positions.getOpenPositions();
    const regime = scanner.marketRegime.getRegime();
    const regimeAdj = scanner.marketRegime.getScoreAdjustment();

    const positionsSummary = openPositions.length > 0
      ? openPositions.map((p) => {
          const pnlPct = (p.unrealizedPnlPct * 100).toFixed(1);
          const holdSec = Math.round((Date.now() - p.openedAt) / 1000);
          return `  ${p.symbol}: ${pnlPct}% (${p.unrealizedPnlSol.toFixed(4)} SOL), held ${holdSec}s`;
        }).join("\n")
      : "  None";

    return `STATE: ${status.dryRun ? "DRY RUN" : "LIVE"} | Uptime: ${status.uptime} | Positions: ${status.openPositions}
CONFIG: size=${status.config.minPositionSizeSol}-${status.config.maxPositionSizeSol} SOL, SL=${(status.config.stopLossPct * 100).toFixed(0)}%, TP1=${(status.config.takeProfitPct1 * 100).toFixed(0)}%, TP2=${(status.config.takeProfitPct2 * 100).toFixed(0)}%, minScore=${scanner.config.minBuyScore}, maxAge=${scanner.config.maxPositionAgeSec}s
  trailing: activate=${(scanner.config.trailingStopActivationPct * 100).toFixed(0)}%, dist=${(scanner.config.trailingStopDistancePct * 100).toFixed(0)}%
Regime: ${regime} (boost: ${regimeAdj.minScoreBoost}, size: ${regimeAdj.sizeMultiplier}x)
Risk: ${status.riskStatus.consecutiveLosses} consecutive losses${status.riskStatus.coolingDown ? " ⚠️ COOLING" : ""}

OPEN POSITIONS:
${positionsSummary}

${scanner.marketIntel.getCompactBriefing()}

${scanner.smartMoney.getCompactBriefing()}

${this.winnerResearch?.getCompactBriefing() ?? ""}

${this.graduateAnalyzer?.getCompactBriefing() ?? ""}`;
  }

  /** Strip lone surrogates that break JSON serialization (common in pump.fun token names with emoji) */
  private static sanitize(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  }

  private async callClaude(
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    maxTokens: number,
    useModel: string = MODEL,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Sanitize all text to remove lone surrogates that produce invalid JSON
    const safeSystem = ChatAgent.sanitize(systemPrompt);
    const safeMessages = messages.map((m) => ({ ...m, content: ChatAgent.sanitize(m.content) }));

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens,
          temperature: 0.4,
          system: safeSystem,
          messages: safeMessages,
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

  /**
   * Parse config changes and trade actions from the response.
   * Config formats:
   *   1. ```config\n{"field": value}\n```  (JSON block — preferred)
   *   2. [SET field=value]  (legacy line format)
   * Trade action format:
   *   ```action\n{"type":"buy","mint":"...","amount":0.05}\n```
   *   Supported types: buy, sell, sell-all, start, stop
   */
  private parseAndApplyActions(
    responseText: string,
    scanner: Scanner,
  ): { cleanText: string; actions: ConfigAction[]; tradeActions: TradeAction[] } {
    const actions: ConfigAction[] = [];
    const tradeActions: TradeAction[] = [];
    let cleanText = responseText;

    // ── Parse trade action blocks ──
    const actionBlockRegex = /```action\s*\n([\s\S]*?)\n```/g;
    let actionMatch: RegExpExecArray | null;

    while ((actionMatch = actionBlockRegex.exec(responseText)) !== null) {
      try {
        const raw = JSON.parse(actionMatch[1]!) as Record<string, unknown>;
        const actionType = raw.type as string;

        // "wait" and "skip" are valid no-ops the LLM can return
        if (["wait", "skip", "pass", "hold"].includes(actionType)) {
          continue; // silently ignore — these are valid "do nothing" actions
        }
        if (!["buy", "sell", "sell-all", "start"].includes(actionType)) {
          logger.warn("AGENT", `Unknown action type: ${actionType}`);
          continue;
        }
        // NEVER allow the agent to stop the bot
        if (actionType === "stop") {
          logger.warn("AGENT", `⛔ BLOCKED: Agent tried to stop the bot — this is not allowed`);
          continue;
        }

        const ta: TradeAction = { type: actionType as TradeAction["type"] };

        if (actionType === "buy") {
          let mint = typeof raw.mint === "string" ? raw.mint.trim() : "";
          const symbol = typeof raw.symbol === "string" ? (raw.symbol as string).trim() : "";

          // Validate mint: real Solana addresses are 32-44 base58 chars (no underscores, spaces, dots)
          const isValidMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);

          if (!isValidMint) {
            // Try to resolve mint from symbol via market intel
            if (symbol && scanner.marketIntel) {
              const resolved = scanner.marketIntel.findMintBySymbol(symbol);
              if (resolved) {
                logger.info("AGENT", `Resolved symbol "${symbol}" → mint ${resolved.slice(0, 12)}...`);
                mint = resolved;
              } else {
                logger.warn("AGENT", `Buy action: invalid mint "${mint}" and could not resolve symbol "${symbol}"`);
                continue;
              }
            } else if (mint) {
              logger.warn("AGENT", `Buy action: invalid mint address "${mint}" (not a valid Solana address)`);
              continue;
            } else {
              logger.warn("AGENT", `Buy action missing mint address`);
              continue;
            }
          }

          ta.mint = mint;
          ta.amount = typeof raw.amount === "number" ? raw.amount : undefined;
          if (symbol) ta.symbol = symbol;
        } else if (actionType === "sell") {
          if (raw.mint) ta.mint = raw.mint as string;
          if (raw.symbol) ta.symbol = raw.symbol as string;
          if (!ta.mint && !ta.symbol) {
            logger.warn("AGENT", `Sell action needs mint or symbol`);
            continue;
          }
        }
        // sell-all, start, stop need no extra fields

        tradeActions.push(ta);
      } catch (err) {
        logger.warn("AGENT", `Failed to parse action JSON: ${err}`);
      }
    }

    // ── Format 1: JSON config block ──
    const jsonBlockRegex = /```config\s*\n([\s\S]*?)\n```/g;
    let jsonMatch: RegExpExecArray | null;

    while ((jsonMatch = jsonBlockRegex.exec(responseText)) !== null) {
      try {
        const configObj = JSON.parse(jsonMatch[1]!) as Record<string, number>;
        const isDryRun = scanner.config.dryRun;
        for (let [field, value] of Object.entries(configObj)) {
          if (!EDITABLE_FIELDS.includes(field as EditableField)) continue;
          if (typeof value !== "number" || isNaN(value) || value < 0) continue;

          // In dry run, skip fields locked by dry-run overrides
          if (isDryRun && DRY_RUN_LOCKED_FIELDS.has(field)) {
            logger.info("AGENT", `🧪 Dry-run: ignoring agent change to ${field} (locked for data collection)`);
            continue;
          }

          // Auto-correct: if a Pct field value > 1, assume it was given as % and convert
          if (field.endsWith("Pct") && value > 1) {
            value = value / 100;
            logger.info("AGENT", `Auto-corrected ${field}: ${value * 100}% → ${value} (decimal)`);
          }

          // Enforce hard guardrails — agent cannot exceed bounds
          value = clampConfigValue(field, value, isDryRun);

          const config = scanner.config;
          const oldValue = (config as unknown as Record<string, unknown>)[field];
          (config as unknown as Record<string, unknown>)[field] = value;

          actions.push({
            field,
            oldValue: oldValue as number,
            newValue: value,
          });
        }
      } catch (err) {
        logger.warn("AGENT", `Failed to parse config JSON: ${err}`);
      }
    }

    // ── Format 2: Legacy [SET field=value] ──
    const setRegex = /^\[SET\s+(\w+)=([\w.]+)\]\s*$/gm;
    let setMatch: RegExpExecArray | null;

    while ((setMatch = setRegex.exec(responseText)) !== null) {
      const field = setMatch[1] as string;
      const rawValue = setMatch[2] as string;

      if (!EDITABLE_FIELDS.includes(field as EditableField)) continue;

      // In dry run, skip fields locked by dry-run overrides
      const isDryRun = scanner.config.dryRun;
      if (isDryRun && DRY_RUN_LOCKED_FIELDS.has(field)) {
        logger.info("AGENT", `🧪 Dry-run: ignoring agent change to ${field} (locked for data collection)`);
        continue;
      }

      const config = scanner.config;
      const oldValue = (config as unknown as Record<string, unknown>)[field];

      let newValue: number;
      if (field === "maxConcurrentPositions" || field === "maxPositionAgeSec") {
        newValue = parseInt(rawValue, 10);
        if (isNaN(newValue) || newValue < 1) continue;
      } else {
        newValue = parseFloat(rawValue);
        if (isNaN(newValue) || newValue < 0) continue;
      }

      // Auto-correct: if a Pct field value > 1, assume it was given as % and convert
      if (field.endsWith("Pct") && newValue > 1) {
        newValue = newValue / 100;
        logger.info("AGENT", `Auto-corrected ${field}: ${newValue * 100}% → ${newValue} (decimal)`);
      }

      // Enforce hard guardrails — agent cannot exceed bounds
      newValue = clampConfigValue(field, newValue, isDryRun);

      // Don't duplicate if already set by JSON block
      if (actions.some((a) => a.field === field)) continue;

      (config as unknown as Record<string, unknown>)[field] = newValue;
      actions.push({
        field,
        oldValue: oldValue as number,
        newValue,
      });
    }

    // ── Parse lesson blocks (persistent memory) ──
    const lessonBlockRegex = /```lesson\s*\n([\s\S]*?)\n```/g;
    let lessonMatch: RegExpExecArray | null;

    while ((lessonMatch = lessonBlockRegex.exec(responseText)) !== null) {
      try {
        const raw = JSON.parse(lessonMatch[1]!) as { lesson: string; category?: string };
        if (raw.lesson && typeof raw.lesson === "string") {
          const validCategories = ["entry", "exit", "risk", "narrative", "timing", "social", "smart-money", "general"] as const;
          const category = validCategories.includes(raw.category as any) ? raw.category as StrategyLesson["category"] : "general";
          this.strategy.addLesson(raw.lesson, category, "autonomous-review");
        }
      } catch (err) {
        logger.warn("AGENT", `Failed to parse lesson JSON: ${err}`);
      }
    }

    // ── Parse strategy rule updates ──
    const strategyBlockRegex = /```strategy\s*\n([\s\S]*?)\n```/g;
    let strategyMatch: RegExpExecArray | null;

    while ((strategyMatch = strategyBlockRegex.exec(responseText)) !== null) {
      try {
        const raw = JSON.parse(strategyMatch[1]!) as Partial<StrategyRules>;
        this.strategy.updateRules(raw);
      } catch (err) {
        logger.warn("AGENT", `Failed to parse strategy JSON: ${err}`);
      }
    }

    // Clean config blocks, action blocks, lesson blocks, strategy blocks, and SET commands from visible text
    cleanText = cleanText
      .replace(/```config\s*\n[\s\S]*?\n```/g, "")
      .replace(/```action\s*\n[\s\S]*?\n```/g, "")
      .replace(/```lesson\s*\n[\s\S]*?\n```/g, "")
      .replace(/```strategy\s*\n[\s\S]*?\n```/g, "")
      .replace(/^\[SET\s+\w+=[\w.]+\]\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Persist config to disk if any config changes were made
    if (actions.length > 0) {
      persistConfig(scanner.config, this.dataDir);
    }

    return { cleanText, actions, tradeActions };
  }

  /** Execute trade actions (buy/sell/start/stop) against the scanner */
  private async executeTradeActions(tradeActions: TradeAction[], scanner: Scanner): Promise<void> {
    for (const action of tradeActions) {
      try {
        switch (action.type) {
          case "buy": {
            // ── RAG Embedding Veto Check ──
            // Before buying, check if this token matches known losing patterns
            if (this.ragQuery && action.mint) {
              const candidates = scanner.getCandidates();
              const candidate = candidates.find((c) => c.mint === action.mint);
              if (candidate) {
                try {
                  const vetoResult = await this.ragQuery.evaluate({
                    symbol: candidate.symbol,
                    name: candidate.name,
                    llmNarrative: candidate.llmAnalysis?.narrative || "",
                    marketCapSol: candidate.marketCapSol,
                    volumeSol: candidate.recentVolumeSol,
                    buyCount: candidate.buyCount,
                    sellCount: candidate.sellCount,
                    uniqueBuyers: candidate.uniqueBuyers,
                    bondingCurveProgress: candidate.bondingCurveProgress,
                    tokenAgeSec: candidate.ageSec,
                    signalScore: candidate.score,
                    marketRegime: candidate.marketRegime,
                    creatorReputation: candidate.creatorReputation,
                    spamLaunchCount: candidate.spamLaunchCount,
                    socialScore: candidate.socialSignal?.score,
                    socialFirstMover: candidate.socialSignal?.isFirstMover,
                    socialCompetingCoins: candidate.socialSignal?.competingCoins,
                    socialXTweets: candidate.socialSignal?.xTweetCount,
                    socialViralMeme: candidate.socialSignal?.isViralMeme,
                    smartMoneyRank: candidate.smartMoneySignal?.walletRank,
                    smartMoneyWinRate: candidate.smartMoneySignal?.walletWinRate,
                  });

                  if (vetoResult.vetoed) {
                    // RAG veto is now ADVISORY — log it prominently but let the agent's decision stand.
                    // The agent already has RAG context in its briefing and made a conscious choice to buy.
                    action.result = `RAG WARNING (risk: ${(vetoResult.riskScore * 100).toFixed(0)}%): ${vetoResult.reason} — agent override, proceeding with buy`;
                    logger.system(`⚠️ RAG advisory veto: ${candidate.symbol} risk ${(vetoResult.riskScore * 100).toFixed(0)}% — ${vetoResult.reason} — AGENT OVERRIDING, proceeding`);
                    // DO NOT break — let the buy continue
                  }

                  // Log elevated risk for visibility
                  if (!vetoResult.vetoed && vetoResult.riskScore > 0.5) {
                    logger.system(`⚠️ RAG warning: ${candidate.symbol} risk ${(vetoResult.riskScore * 100).toFixed(0)}% — proceeding with caution`);
                  }
                } catch (err) {
                  // RAG failure should not block trading
                  logger.warn("RAG", `Veto check failed for ${candidate.symbol}: ${err}`);
                }
              }
            }

            // Pass LLM analysis from candidate so journal records rich data for RAG
            const candidate = scanner.getCandidates().find(c => c.mint === action.mint);
            const result = await scanner.agentBuy(action.mint!, action.amount, action.symbol, candidate ? {
              signalScore: candidate.score,
              llmScore: candidate.llmAnalysis?.score,
              llmNarrative: candidate.llmAnalysis?.narrative,
              llmReasoning: candidate.llmAnalysis?.reasoning,
              llmConfidence: candidate.llmAnalysis?.confidence,
              creatorReputation: candidate.creatorReputation,
            } : undefined);
            action.result = result.success ? "Bought successfully" : `Failed: ${result.error || "unknown"}`;
            break;
          }
          case "sell": {
            if (action.symbol) {
              const result = await scanner.agentSellBySymbol(action.symbol);
              action.result = result.success ? `Sold ${action.symbol}` : `Failed: ${result.error || "unknown"}`;
            } else if (action.mint) {
              const result = await scanner.agentSell(action.mint);
              action.result = result.success ? "Sold successfully" : `Failed: ${result.error || "unknown"}`;
            } else {
              action.result = "No mint or symbol provided";
            }
            break;
          }
          case "sell-all": {
            await scanner.sellAllPositions();
            action.result = "Sold all positions";
            break;
          }
          case "start": {
            scanner.start();
            action.result = "Bot started";
            break;
          }
          case "stop": {
            // BLOCKED — agent is never allowed to stop the bot
            action.result = "BLOCKED: Agent cannot stop the bot";
            logger.warn("AGENT", `⛔ BLOCKED: stop action rejected`);
            break;
          }
        }
        logger.system(`🤖 Trade action executed: ${action.type}${action.symbol ? " " + action.symbol : ""}${action.mint ? " " + action.mint.slice(0, 8) + "..." : ""} → ${action.result}`);
      } catch (err) {
        action.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        logger.error("AGENT", `Trade action failed (${action.type}): ${action.result}`);
      }
    }
  }

  /** Format trade action results as a readable summary to append to agent messages */
  private formatTradeActionResults(tradeActions: TradeAction[]): string {
    if (tradeActions.length === 0) return "";

    const lines = tradeActions.map((a) => {
      const target = a.symbol || (a.mint ? a.mint.slice(0, 12) + "..." : "");
      const amountStr = a.amount ? ` (${a.amount} SOL)` : "";
      const icon = a.result?.startsWith("Error") ? "❌" : "✅";
      return `${icon} **${a.type.toUpperCase()}** ${target}${amountStr}: ${a.result || "pending"}`;
    });

    return `\n\n---\n**Trade Actions Executed:**\n${lines.join("\n")}`;
  }
}
