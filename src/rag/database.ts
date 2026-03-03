// ── RAG Database: SQLite-backed trade storage with embedding support ──
// Stores historical trades, embeddings, and loss patterns for RAG retrieval.
// Uses sql.js (pure WASM) — no native compilation required.

import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { RAGTradeRecord, LossPattern, RAGStats, RAGMatch } from "./types.js";

// sql.js types — pure WASM SQLite, no native compilation needed
interface SqlJsDatabase {
  run(sql: string, params?: any[]): SqlJsDatabase;
  exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}
interface SqlJsStatement {
  bind(params?: any[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, any>;
  free(): boolean;
}
interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}
type InitSqlJs = () => Promise<SqlJsStatic>;

export class RAGDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Embedding cache to avoid reloading all records from SQLite on every findSimilar call */
  private embeddingCache = new Map<string, RAGTradeRecord[]>();

  constructor(dataDir: string) {
    this.dbPath = path.join(dataDir, "rag.db");
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /** Must be called before any DB operations. Loads WASM + initializes schema. */
  async initialize(): Promise<void> {
    // Dynamic import to avoid module resolution issues
    const sqlJsModule = await import("sql.js");
    const initSqlJs: InitSqlJs = (sqlJsModule.default || sqlJsModule) as any;
    const SQL = await initSqlJs();

    // Load existing DB from disk if available
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    this.init();
    logger.system(`RAG Database initialized: ${this.dbPath}`);
  }

  private ensureDb(): SqlJsDatabase {
    if (!this.db) throw new Error("RAGDatabase not initialized — call initialize() first");
    return this.db;
  }

  /** Save DB to disk (debounced — batches rapid writes) */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return; // Already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 2000); // Save at most every 2s
  }

  /** Immediately persist to disk */
  saveToDisk(): void {
    if (!this.db || !this.dirty) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
      this.dirty = false;
    } catch (err) {
      logger.error("RAG-DB", `Failed to save database: ${err}`);
    }
  }

  private init(): void {
    const db = this.ensureDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        creator TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,

        -- Entry metrics
        entry_price REAL DEFAULT 0,
        entry_size_sol REAL DEFAULT 0,
        market_cap_sol REAL DEFAULT 0,
        volume_sol REAL DEFAULT 0,
        buy_count INTEGER DEFAULT 0,
        sell_count INTEGER DEFAULT 0,
        unique_buyers INTEGER DEFAULT 0,
        bonding_curve_progress REAL DEFAULT 0,
        token_age_sec REAL DEFAULT 0,

        -- Signals
        signal_score REAL DEFAULT 0,
        llm_score REAL DEFAULT 0,
        llm_narrative TEXT DEFAULT '',
        llm_confidence REAL DEFAULT 0,
        market_regime TEXT DEFAULT 'normal',
        creator_reputation REAL DEFAULT 0,
        spam_launch INTEGER DEFAULT 0,
        spam_launch_count INTEGER DEFAULT 0,
        whale_count INTEGER DEFAULT 0,
        whale_volume_sol REAL DEFAULT 0,

        -- Social signal
        social_score REAL DEFAULT 0,
        social_first_mover INTEGER DEFAULT 0,
        social_competing_coins INTEGER DEFAULT 0,
        social_x_tweets INTEGER DEFAULT 0,
        social_viral_meme INTEGER DEFAULT 0,

        -- Smart money
        smart_money_rank INTEGER DEFAULT 0,
        smart_money_win_rate REAL DEFAULT 0,

        -- Exit
        exit_timestamp INTEGER DEFAULT 0,
        exit_price REAL DEFAULT 0,
        exit_reason TEXT DEFAULT '',
        hold_time_sec REAL DEFAULT 0,
        peak_price REAL DEFAULT 0,
        peak_pnl_pct REAL DEFAULT 0,

        -- Outcome
        pnl_sol REAL DEFAULT 0,
        pnl_pct REAL DEFAULT 0,
        outcome TEXT DEFAULT 'neutral',

        -- Classification
        loss_category TEXT,
        loss_red_flags TEXT,
        loss_confidence REAL,

        -- RAG
        feature_text TEXT DEFAULT '',
        embedding BLOB
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_outcome ON trades(outcome)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_loss_category ON trades(loss_category)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol)`);

    // ── Schema migrations: add columns for enrichment data ──
    const migrationColumns: Array<[string, string]> = [
      ["spam_launch_count", "INTEGER DEFAULT 0"],
      ["social_score", "REAL DEFAULT 0"],
      ["social_first_mover", "INTEGER DEFAULT 0"],
      ["social_competing_coins", "INTEGER DEFAULT 0"],
      ["social_x_tweets", "INTEGER DEFAULT 0"],
      ["social_viral_meme", "INTEGER DEFAULT 0"],
      ["smart_money_rank", "INTEGER DEFAULT 0"],
      ["smart_money_win_rate", "REAL DEFAULT 0"],
      ["live_eligible", "INTEGER DEFAULT -1"],       // -1=not evaluated, 0=failed, 1=passed
      ["live_filter_fail_reasons", "TEXT DEFAULT ''"], // comma-separated gate failures
    ];
    for (const [col, def] of migrationColumns) {
      try { db.run(`ALTER TABLE trades ADD COLUMN ${col} ${def}`); } catch { /* column already exists */ }
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS loss_patterns (
        category TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        signals TEXT NOT NULL DEFAULT '[]',
        frequency REAL DEFAULT 0,
        avoidance_rules TEXT NOT NULL DEFAULT '[]',
        confidence REAL DEFAULT 0,
        trade_count INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS import_log (
        source TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        record_count INTEGER DEFAULT 0,
        notes TEXT DEFAULT ''
      )
    `);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Trade CRUD ──
  // ══════════════════════════════════════════════════════════════════════════

  insertTrade(record: RAGTradeRecord): void {
    const db = this.ensureDb();
    db.run(`
      INSERT OR REPLACE INTO trades (
        id, mint, symbol, name, creator, timestamp,
        entry_price, entry_size_sol, market_cap_sol, volume_sol,
        buy_count, sell_count, unique_buyers, bonding_curve_progress, token_age_sec,
        signal_score, llm_score, llm_narrative, llm_confidence,
        market_regime, creator_reputation, spam_launch, spam_launch_count,
        whale_count, whale_volume_sol,
        social_score, social_first_mover, social_competing_coins, social_x_tweets, social_viral_meme,
        smart_money_rank, smart_money_win_rate,
        exit_timestamp, exit_price, exit_reason, hold_time_sec, peak_price, peak_pnl_pct,
        pnl_sol, pnl_pct, outcome,
        loss_category, loss_red_flags, loss_confidence,
        feature_text, embedding,
        live_eligible, live_filter_fail_reasons
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?
      )
    `, [
      record.id, record.mint, record.symbol, record.name, record.creator, record.timestamp,
      record.entryPrice, record.entrySizeSol, record.marketCapSol, record.volumeSol,
      record.buyCount, record.sellCount, record.uniqueBuyers, record.bondingCurveProgress, record.tokenAgeSec,
      record.signalScore, record.llmScore, record.llmNarrative, record.llmConfidence,
      record.marketRegime, record.creatorReputation, record.spamLaunch ? 1 : 0, record.spamLaunchCount,
      record.whaleCount, record.whaleVolumeSol,
      record.socialScore, record.socialFirstMover ? 1 : 0, record.socialCompetingCoins, record.socialXTweets, record.socialViralMeme ? 1 : 0,
      record.smartMoneyRank, record.smartMoneyWinRate,
      record.exitTimestamp, record.exitPrice, record.exitReason, record.holdTimeSec, record.peakPrice, record.peakPnlPct,
      record.pnlSol, record.pnlPct, record.outcome,
      record.lossCategory ?? null,
      record.lossRedFlags ? JSON.stringify(record.lossRedFlags) : null,
      record.lossConfidence ?? null,
      record.featureText,
      record.embedding ? Array.from(new Uint8Array(record.embedding.buffer)) : null,
      record.liveEligible !== undefined ? (record.liveEligible ? 1 : 0) : -1,
      record.liveFilterFailReasons ? JSON.stringify(record.liveFilterFailReasons) : "",
    ]);
    this.embeddingCache.clear();
    this.allTradesCache = null;
    this.scheduleSave();
  }

  insertTradeBatch(records: RAGTradeRecord[]): number {
    const db = this.ensureDb();
    db.run("BEGIN TRANSACTION");
    let count = 0;
    try {
      for (const r of records) {
        this.insertTrade(r);
        count++;
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    this.scheduleSave();
    this.allTradesCache = null;
    return count;
  }

  updateEmbedding(id: string, embedding: Float32Array): void {
    const db = this.ensureDb();
    db.run(`UPDATE trades SET embedding = ? WHERE id = ?`, [
      Array.from(new Uint8Array(embedding.buffer)), id,
    ]);
    this.embeddingCache.clear();
    this.scheduleSave();
  }

  updateEmbeddingBatch(updates: Array<{ id: string; embedding: Float32Array }>): void {
    const db = this.ensureDb();
    db.run("BEGIN TRANSACTION");
    try {
      for (const { id, embedding } of updates) {
        db.run(`UPDATE trades SET embedding = ? WHERE id = ?`, [
          Array.from(new Uint8Array(embedding.buffer)), id,
        ]);
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    this.embeddingCache.clear();
    this.scheduleSave();
  }

  updateLossCategory(id: string, category: string, redFlags: string[], confidence: number): void {
    const db = this.ensureDb();
    db.run(`
      UPDATE trades SET loss_category = ?, loss_red_flags = ?, loss_confidence = ?
      WHERE id = ?
    `, [category, JSON.stringify(redFlags), confidence, id]);
    this.scheduleSave();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Queries ──
  // ══════════════════════════════════════════════════════════════════════════

  /** Helper: run a SELECT and return all rows as objects */
  private queryAll(sql: string, params: any[] = []): any[] {
    const db = this.ensureDb();
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /** Helper: run a SELECT and return the first row as an object */
  private queryOne(sql: string, params: any[] = []): any | undefined {
    const db = this.ensureDb();
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    let row: any | undefined;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }

  getTradeById(id: string): RAGTradeRecord | undefined {
    const row = this.queryOne(`SELECT * FROM trades WHERE id = ?`, [id]);
    return row ? this.rowToRecord(row) : undefined;
  }

  getTradesByOutcome(outcome: "win" | "loss" | "neutral", limit = 100): RAGTradeRecord[] {
    const rows = this.queryAll(
      `SELECT * FROM trades WHERE outcome = ? ORDER BY timestamp DESC LIMIT ?`,
      [outcome, limit],
    );
    return rows.map(r => this.rowToRecord(r));
  }

  getTradesWithoutEmbeddings(limit = 200): RAGTradeRecord[] {
    const rows = this.queryAll(
      `SELECT * FROM trades WHERE embedding IS NULL ORDER BY timestamp DESC LIMIT ?`,
      [limit],
    );
    return rows.map(r => this.rowToRecord(r));
  }

  getTradesWithoutCategory(limit = 200): RAGTradeRecord[] {
    const rows = this.queryAll(
      `SELECT * FROM trades WHERE outcome = 'loss' AND loss_category IS NULL ORDER BY timestamp DESC LIMIT ?`,
      [limit],
    );
    return rows.map(r => this.rowToRecord(r));
  }

  getRecentTrades(limit = 50): RAGTradeRecord[] {
    const rows = this.queryAll(
      `SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`,
      [limit],
    );
    return rows.map(r => this.rowToRecord(r));
  }

  /** Get all trades with embeddings for similarity search (cached) */
  getTradesWithEmbeddings(outcomeFilter?: "win" | "loss"): RAGTradeRecord[] {
    const cacheKey = outcomeFilter ?? "__all__";
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) return cached;

    let sql = `SELECT * FROM trades WHERE embedding IS NOT NULL`;
    const params: any[] = [];
    if (outcomeFilter) {
      sql += ` AND outcome = ?`;
      params.push(outcomeFilter);
    }
    sql += ` ORDER BY timestamp DESC`;
    const rows = this.queryAll(sql, params);
    const records = rows.map(r => this.rowToRecord(r));
    this.embeddingCache.set(cacheKey, records);
    return records;
  }

  /** Clear cached embeddings (called when data changes) */
  clearEmbeddingCache(): void {
    this.embeddingCache.clear();
  }

  /** Check if a trade already exists by mint + rough timestamp */
  hasTrade(mint: string, timestampMs: number, toleranceMs = 5000): boolean {
    const row = this.queryOne(
      `SELECT 1 FROM trades WHERE mint = ? AND ABS(timestamp - ?) < ? LIMIT 1`,
      [mint, timestampMs, toleranceMs],
    );
    return !!row;
  }

  getTradeCount(): number {
    const row = this.queryOne(`SELECT COUNT(*) as cnt FROM trades`);
    return row?.cnt ?? 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Similarity Search (brute-force cosine on embeddings) ──
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Find the most similar trades to a given embedding vector.
   * Uses brute-force cosine similarity (fine for <10k records).
   */
  findSimilar(
    queryEmbedding: Float32Array,
    topK = 5,
    minSimilarity = 0.60,
    outcomeFilter?: "loss" | "win",
  ): RAGMatch[] {
    const candidates = this.getTradesWithEmbeddings(outcomeFilter);
    const scored: RAGMatch[] = [];

    for (const record of candidates) {
      if (!record.embedding) continue;
      const sim = cosineSimilarity(queryEmbedding, record.embedding);
      if (sim >= minSimilarity) {
        scored.push({
          record,
          similarity: sim,
          matchReasons: this.inferMatchReasons(record, sim),
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Numeric Feature Similarity Search ──
  // ══════════════════════════════════════════════════════════════════════════

  /** Cache for all trade records (invalidated on insert) */
  private allTradesCache: RAGTradeRecord[] | null = null;

  /** Get all trades (cached). Used for numeric similarity search. */
  getAllTrades(): RAGTradeRecord[] {
    if (this.allTradesCache) return this.allTradesCache;
    const rows = this.queryAll(`SELECT * FROM trades WHERE outcome IN ('win', 'loss') ORDER BY timestamp DESC`);
    this.allTradesCache = rows.map(r => this.rowToRecord(r));
    return this.allTradesCache;
  }

  /** Invalidate the all-trades cache (called on data changes) */
  clearAllTradesCache(): void {
    this.allTradesCache = null;
  }

  /**
   * Find the most similar trades using numeric feature distance (not embeddings).
   * This produces much better separation between wins and losses because it uses
   * proper numeric distance on 14 weighted features instead of SBERT text similarity.
   */
  findSimilarByFeatures(
    candidate: CandidateFeatures,
    topK = 10,
    minSimilarity = 0.30,
    outcomeFilter?: "loss" | "win",
  ): RAGMatch[] {
    let allTrades = this.getAllTrades();
    if (outcomeFilter) {
      allTrades = allTrades.filter(t => t.outcome === outcomeFilter);
    }

    const scored: RAGMatch[] = [];

    for (const record of allTrades) {
      const sim = numericFeatureSimilarity(candidate, record);
      if (sim >= minSimilarity) {
        scored.push({
          record,
          similarity: sim,
          matchReasons: this.inferMatchReasons(record, sim),
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Loss Patterns ──
  // ══════════════════════════════════════════════════════════════════════════

  upsertLossPattern(pattern: LossPattern): void {
    const db = this.ensureDb();
    db.run(`
      INSERT OR REPLACE INTO loss_patterns
      (category, description, signals, frequency, avoidance_rules, confidence, trade_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      pattern.category,
      pattern.description,
      JSON.stringify(pattern.signals),
      pattern.frequency,
      JSON.stringify(pattern.avoidanceRules),
      pattern.confidence,
      pattern.tradeCount,
      pattern.updatedAt,
    ]);
    this.scheduleSave();
  }

  getLossPatterns(): LossPattern[] {
    const rows = this.queryAll(`SELECT * FROM loss_patterns ORDER BY frequency DESC`);
    return rows.map(r => ({
      category: r.category,
      description: r.description,
      signals: JSON.parse(r.signals || "[]"),
      frequency: r.frequency,
      avoidanceRules: JSON.parse(r.avoidance_rules || "[]"),
      confidence: r.confidence,
      tradeCount: r.trade_count,
      updatedAt: r.updated_at,
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Import Log ──
  // ══════════════════════════════════════════════════════════════════════════

  logImport(source: string, count: number, notes = ""): void {
    const db = this.ensureDb();
    db.run(`
      INSERT INTO import_log (source, imported_at, record_count, notes)
      VALUES (?, ?, ?, ?)
    `, [source, Date.now(), count, notes]);
    this.scheduleSave();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Stats ──
  // ══════════════════════════════════════════════════════════════════════════

  getStats(): RAGStats {
    const total = this.queryOne(`SELECT COUNT(*) as cnt FROM trades`);
    const wins = this.queryOne(`SELECT COUNT(*) as cnt FROM trades WHERE outcome='win'`);
    const losses = this.queryOne(`SELECT COUNT(*) as cnt FROM trades WHERE outcome='loss'`);
    const embedded = this.queryOne(`SELECT COUNT(*) as cnt FROM trades WHERE embedding IS NOT NULL`);
    const categorized = this.queryOne(`SELECT COUNT(*) as cnt FROM trades WHERE loss_category IS NOT NULL`);
    const oldest = this.queryOne(`SELECT MIN(timestamp) as ts FROM trades`);
    const newest = this.queryOne(`SELECT MAX(timestamp) as ts FROM trades`);
    const patterns = this.queryOne(`SELECT COUNT(*) as cnt FROM loss_patterns`);

    return {
      totalRecords: total?.cnt ?? 0,
      totalWins: wins?.cnt ?? 0,
      totalLosses: losses?.cnt ?? 0,
      withEmbeddings: embedded?.cnt ?? 0,
      withLossCategory: categorized?.cnt ?? 0,
      oldestRecord: oldest?.ts ?? 0,
      newestRecord: newest?.ts ?? 0,
      lossPatterns: patterns?.cnt ?? 0,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Helpers ──
  // ══════════════════════════════════════════════════════════════════════════

  private rowToRecord(row: any): RAGTradeRecord {
    return {
      id: row.id,
      mint: row.mint,
      symbol: row.symbol,
      name: row.name,
      creator: row.creator,
      timestamp: row.timestamp,
      entryPrice: row.entry_price,
      entrySizeSol: row.entry_size_sol,
      marketCapSol: row.market_cap_sol,
      volumeSol: row.volume_sol,
      buyCount: row.buy_count,
      sellCount: row.sell_count,
      uniqueBuyers: row.unique_buyers,
      bondingCurveProgress: row.bonding_curve_progress,
      tokenAgeSec: row.token_age_sec,
      signalScore: row.signal_score,
      llmScore: row.llm_score,
      llmNarrative: row.llm_narrative,
      llmConfidence: row.llm_confidence,
      marketRegime: row.market_regime,
      creatorReputation: row.creator_reputation,
      spamLaunch: !!row.spam_launch,
      spamLaunchCount: row.spam_launch_count ?? 0,
      whaleCount: row.whale_count,
      whaleVolumeSol: row.whale_volume_sol,
      socialScore: row.social_score ?? 0,
      socialFirstMover: !!row.social_first_mover,
      socialCompetingCoins: row.social_competing_coins ?? 0,
      socialXTweets: row.social_x_tweets ?? 0,
      socialViralMeme: !!row.social_viral_meme,
      smartMoneyRank: row.smart_money_rank ?? 0,
      smartMoneyWinRate: row.smart_money_win_rate ?? 0,
      exitTimestamp: row.exit_timestamp,
      exitPrice: row.exit_price,
      exitReason: row.exit_reason,
      holdTimeSec: row.hold_time_sec,
      peakPrice: row.peak_price,
      peakPnlPct: row.peak_pnl_pct,
      pnlSol: row.pnl_sol,
      pnlPct: row.pnl_pct,
      outcome: row.outcome,
      lossCategory: row.loss_category ?? undefined,
      lossRedFlags: row.loss_red_flags ? JSON.parse(row.loss_red_flags) : undefined,
      lossConfidence: row.loss_confidence ?? undefined,
      featureText: row.feature_text,
      embedding: row.embedding ? new Float32Array(new Uint8Array(row.embedding).buffer) : undefined,
      liveEligible: row.live_eligible === 1 ? true : row.live_eligible === 0 ? false : undefined,
      liveFilterFailReasons: row.live_filter_fail_reasons ? JSON.parse(row.live_filter_fail_reasons) : undefined,
    };
  }

  private inferMatchReasons(record: RAGTradeRecord, _sim: number): string[] {
    const reasons: string[] = [];
    if (record.lossCategory) reasons.push(`loss:${record.lossCategory}`);
    if (record.exitReason) reasons.push(`exit:${record.exitReason}`);
    if (record.llmNarrative) reasons.push(`narrative:${record.llmNarrative}`);
    return reasons;
  }

  close(): void {
    this.saveToDisk();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.db) this.db.close();
    this.db = null;
  }
}

// ── Math utilities ──

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ══════════════════════════════════════════════════════════════════════════
// ── Numeric Feature Similarity (replaces SBERT for risk scoring) ──
// ══════════════════════════════════════════════════════════════════════════

/** Candidate features for numeric similarity matching */
export interface CandidateFeatures {
  llmNarrative: string;
  marketCapSol: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  tokenAgeSec: number;
  signalScore: number;
  marketRegime: string;
  creatorReputation: number;
  socialScore: number;
  socialFirstMover: boolean;
  smartMoneyRank: number;
  whaleCount: number;
  whaleVolumeSol: number;
  spamLaunchCount: number;
}

/** Weights for each feature dimension — higher = more important for matching */
const FEATURE_WEIGHTS = {
  narrative: 0.15,
  marketCap: 0.12,
  volume: 0.10,
  buyPressure: 0.10,
  uniqueBuyers: 0.07,
  bondingCurve: 0.05,
  age: 0.04,
  signalScore: 0.08,
  marketRegime: 0.06,
  creatorRep: 0.04,
  socialScore: 0.07,
  isFirstMover: 0.04,
  smartMoneyRank: 0.05,
  hourOfDay: 0.03,
};

/** Narrative group hierarchy for fuzzy matching */
const NARRATIVE_GROUPS: Record<string, string[]> = {
  animal: ["dog", "cat", "frog", "pepe", "doge", "shib", "bonk", "inu", "bear", "bull", "fish", "bird", "monkey", "ape"],
  ai: ["ai", "gpt", "bot", "neural", "agent", "llm", "machine", "deep", "openai", "claude"],
  political: ["trump", "biden", "maga", "president", "election", "politic", "vote"],
  celebrity: ["elon", "musk", "kanye", "drake", "celebrity", "famous"],
  defi: ["defi", "swap", "yield", "stake", "farm", "liquidity", "lend"],
  gaming: ["game", "play", "nft", "meta", "verse", "pixel", "quest"],
  "meme-culture": ["meme", "wojak", "chad", "based", "moon", "hodl", "wagmi", "ngmi", "cope", "seethe"],
};

function getNarrativeGroup(narrative: string): string {
  const lower = narrative.toLowerCase();
  for (const [group, keywords] of Object.entries(NARRATIVE_GROUPS)) {
    if (keywords.some(k => lower.includes(k))) return group;
  }
  return "other";
}

/** Log-scale similarity — treats order-of-magnitude differences as important */
function logSimilarity(a: number, b: number): number {
  if (a <= 0 && b <= 0) return 1.0;
  if (a <= 0 || b <= 0) return 0.0;
  const logA = Math.log10(a + 1);
  const logB = Math.log10(b + 1);
  const maxLog = Math.max(logA, logB, 1);
  return 1 - Math.abs(logA - logB) / maxLog;
}

/** Similarity for signed values — same sign is important */
function signedSimilarity(a: number, b: number): number {
  if (Math.sign(a) !== Math.sign(b)) return 0.2;
  const maxAbs = Math.max(Math.abs(a), Math.abs(b), 1);
  return 1 - Math.abs(a - b) / maxAbs;
}

/**
 * Compute numeric feature similarity between a candidate and a stored trade.
 * Uses 14 weighted feature dimensions with appropriate distance metrics
 * (log-scale for numerical, categorical for strings, circular for time).
 * Returns 0-1 similarity score.
 */
export function numericFeatureSimilarity(
  candidate: CandidateFeatures,
  record: RAGTradeRecord,
): number {
  let totalScore = 0;

  // 1. Narrative (hierarchical: exact match > same group > no match)
  const candNarr = candidate.llmNarrative.toLowerCase();
  const recNarr = (record.llmNarrative ?? "").toLowerCase();
  const candGroup = getNarrativeGroup(candNarr);
  const recGroup = getNarrativeGroup(recNarr);
  let narrativeSim = 0;
  if (candNarr === recNarr) narrativeSim = 1.0;
  else if (candGroup === recGroup && candGroup !== "other") narrativeSim = 0.6;
  totalScore += narrativeSim * FEATURE_WEIGHTS.narrative;

  // 2. Market Cap (log-scale)
  totalScore += logSimilarity(candidate.marketCapSol, record.marketCapSol) * FEATURE_WEIGHTS.marketCap;

  // 3. Signal Score (linear)
  const scoreSim = 1 - Math.abs(candidate.signalScore - record.signalScore) / 100;
  totalScore += scoreSim * FEATURE_WEIGHTS.signalScore;

  // 4. Volume (log-scale)
  totalScore += logSimilarity(candidate.volumeSol, record.volumeSol) * FEATURE_WEIGHTS.volume;

  // 5. Buy pressure (ratio similarity)
  const candBuyRatio = candidate.buyCount / Math.max(1, candidate.buyCount + candidate.sellCount);
  const recBuyRatio = record.buyCount / Math.max(1, record.buyCount + record.sellCount);
  totalScore += (1 - Math.abs(candBuyRatio - recBuyRatio)) * FEATURE_WEIGHTS.buyPressure;

  // 6. Unique buyers (log-scale)
  totalScore += logSimilarity(Math.max(1, candidate.uniqueBuyers), Math.max(1, record.uniqueBuyers)) * FEATURE_WEIGHTS.uniqueBuyers;

  // 7. Bonding curve (linear)
  totalScore += (1 - Math.abs(candidate.bondingCurveProgress - record.bondingCurveProgress)) * FEATURE_WEIGHTS.bondingCurve;

  // 8. Age (linear, capped at 120s difference)
  const ageDiff = Math.abs(candidate.tokenAgeSec - record.tokenAgeSec);
  totalScore += Math.max(0, 1 - ageDiff / 120) * FEATURE_WEIGHTS.age;

  // 9. Market regime (categorical)
  const regimeSim = candidate.marketRegime === record.marketRegime ? 1.0 : 0.3;
  totalScore += regimeSim * FEATURE_WEIGHTS.marketRegime;

  // 10. Creator reputation (signed similarity)
  totalScore += signedSimilarity(candidate.creatorReputation, record.creatorReputation) * FEATURE_WEIGHTS.creatorRep;

  // 11. Social score (log-scale)
  totalScore += logSimilarity(Math.max(1, candidate.socialScore), Math.max(1, record.socialScore ?? 0)) * FEATURE_WEIGHTS.socialScore;

  // 12. First mover (categorical)
  const fmSim = candidate.socialFirstMover === (record.socialFirstMover ?? false) ? 1.0 : 0.2;
  totalScore += fmSim * FEATURE_WEIGHTS.isFirstMover;

  // 13. Smart money rank
  let smSim = 0;
  const recSmRank = record.smartMoneyRank ?? 0;
  if (candidate.smartMoneyRank === 0 && recSmRank === 0) smSim = 1.0;
  else if (candidate.smartMoneyRank > 0 && recSmRank > 0) smSim = 1 - Math.abs(candidate.smartMoneyRank - recSmRank) / 5;
  else smSim = 0.1;
  totalScore += smSim * FEATURE_WEIGHTS.smartMoneyRank;

  // 14. Hour of day (circular)
  const candHour = new Date().getHours();
  const recHour = new Date(record.timestamp).getHours();
  const hourDiff = Math.min(Math.abs(candHour - recHour), 24 - Math.abs(candHour - recHour));
  totalScore += Math.max(0, 1 - hourDiff / 6) * FEATURE_WEIGHTS.hourOfDay;

  return totalScore;
}
