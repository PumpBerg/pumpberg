#!/usr/bin/env npx tsx
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📦 RAG Data Migration: Move pre-enrichment data to backup database
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Background:
//   Data collected before 2026-02-23 lacks enrichment fields (social score,
//   smart money rank, whale count, spam detection). The RAG's k-NN similarity
//   scoring works better with uniformly enriched data.
//
// This script:
//   1. Copies old data (before Feb 23) to data/rag-backup-pre-enrichment.db
//   2. Deletes old data from the active rag.db
//   3. Rebuilds loss patterns from remaining data
//   4. Verifies the migration
//
// Run: npx tsx scripts/migrate-rag-data.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

// Cutoff: Feb 23, 2026 00:00:00 UTC — enrichment fields started being populated
const CUTOFF_DATE = new Date("2026-02-23T00:00:00Z");
const CUTOFF_MS = CUTOFF_DATE.getTime();

console.log("\n" + "═".repeat(72));
console.log("  📦  RAG Data Migration: Archive pre-enrichment data");
console.log("═".repeat(72));
console.log(`\n  Cutoff date: ${CUTOFF_DATE.toISOString()}`);
console.log(`  Cutoff timestamp: ${CUTOFF_MS}\n`);

// ── Step 1: Load the source database ──
const { RAGDatabase } = await import("../src/rag/database.js");

const sourceDb = new RAGDatabase(DATA_DIR);
await sourceDb.initialize();

const statsBefore = sourceDb.getStats();
console.log(`── Source rag.db ──`);
console.log(`  Total: ${statsBefore.totalRecords} trades (${statsBefore.totalWins}W/${statsBefore.totalLosses}L)`);
console.log(`  Range: ${new Date(statsBefore.oldestRecord).toISOString()} → ${new Date(statsBefore.newestRecord).toISOString()}`);

// Count old vs new
const oldCount = (sourceDb as any).queryOne(
  `SELECT COUNT(*) as cnt FROM trades WHERE timestamp < ?`, [CUTOFF_MS]
);
const newCount = (sourceDb as any).queryOne(
  `SELECT COUNT(*) as cnt FROM trades WHERE timestamp >= ?`, [CUTOFF_MS]
);

console.log(`\n  Pre-enrichment (before ${CUTOFF_DATE.toISOString().slice(0, 10)}): ${oldCount.cnt} trades`);
console.log(`  Post-enrichment (from ${CUTOFF_DATE.toISOString().slice(0, 10)}):  ${newCount.cnt} trades`);

if (oldCount.cnt === 0) {
  console.log("\n  ✅ No old data to migrate. Exiting.");
  sourceDb.close();
  process.exit(0);
}

// ── Step 2: Create backup database ──
const backupPath = path.join(DATA_DIR, "rag-backup-pre-enrichment.db");

if (fs.existsSync(backupPath)) {
  console.log(`\n  ⚠️  Backup already exists at ${backupPath}`);
  console.log(`  Removing old backup to create fresh one...`);
  fs.unlinkSync(backupPath);
}

console.log(`\n── Creating backup database ──`);
console.log(`  Path: ${backupPath}`);

const backupDb = new RAGDatabase(DATA_DIR);
(backupDb as any).dbPath = backupPath;
await backupDb.initialize();

// ── Step 3: Copy old trades to backup ──
console.log(`\n── Copying ${oldCount.cnt} old trades to backup ──`);

const oldTrades = (sourceDb as any).queryAll(
  `SELECT * FROM trades WHERE timestamp < ? ORDER BY timestamp ASC`, [CUTOFF_MS]
);

let copied = 0;
for (const row of oldTrades) {
  const backupDbInner = (backupDb as any).ensureDb();
  backupDbInner.run(`
    INSERT OR IGNORE INTO trades (
      id, mint, symbol, name, creator, timestamp,
      entry_price, entry_size_sol, market_cap_sol, volume_sol,
      buy_count, sell_count, unique_buyers, bonding_curve_progress,
      token_age_sec, signal_score, llm_score, llm_narrative,
      llm_confidence, market_regime, creator_reputation,
      spam_launch, spam_launch_count,
      whale_count, whale_volume_sol,
      social_score, social_first_mover, social_competing_coins,
      social_x_tweets, social_viral_meme,
      smart_money_rank, smart_money_win_rate,
      exit_timestamp, exit_price, exit_reason,
      hold_time_sec, peak_price, peak_pnl_pct,
      pnl_sol, pnl_pct, outcome,
      loss_category, loss_red_flags, loss_confidence,
      feature_text, embedding
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `, [
    row.id, row.mint, row.symbol, row.name, row.creator, row.timestamp,
    row.entry_price, row.entry_size_sol, row.market_cap_sol, row.volume_sol,
    row.buy_count, row.sell_count, row.unique_buyers, row.bonding_curve_progress,
    row.token_age_sec, row.signal_score, row.llm_score, row.llm_narrative,
    row.llm_confidence, row.market_regime, row.creator_reputation,
    row.spam_launch, row.spam_launch_count,
    row.whale_count, row.whale_volume_sol,
    row.social_score, row.social_first_mover, row.social_competing_coins,
    row.social_x_tweets, row.social_viral_meme,
    row.smart_money_rank, row.smart_money_win_rate,
    row.exit_timestamp, row.exit_price, row.exit_reason,
    row.hold_time_sec, row.peak_price, row.peak_pnl_pct,
    row.pnl_sol, row.pnl_pct, row.outcome,
    row.loss_category, row.loss_red_flags, row.loss_confidence,
    row.feature_text, row.embedding,
  ]);
  copied++;

  if (copied % 2000 === 0) {
    console.log(`  Copied ${copied}/${oldCount.cnt}...`);
  }
}

// Also copy loss patterns to backup
const patterns = (sourceDb as any).queryAll(`SELECT * FROM loss_patterns`);
for (const p of patterns) {
  const backupDbInner = (backupDb as any).ensureDb();
  backupDbInner.run(`
    INSERT OR IGNORE INTO loss_patterns 
    (category, description, signals, frequency, avoidance_rules, confidence, trade_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [p.category, p.description, p.signals, p.frequency, p.avoidance_rules, p.confidence, p.trade_count, p.updated_at]);
}

// Force save backup to disk
(backupDb as any).dirty = true;
backupDb.saveToDisk();

const backupStats = backupDb.getStats();
console.log(`  ✅ Backup complete: ${backupStats.totalRecords} trades (${backupStats.totalWins}W/${backupStats.totalLosses}L)`);
console.log(`  📁 Saved to: ${backupPath}`);
console.log(`  📏 Size: ${(fs.statSync(backupPath).size / 1024 / 1024).toFixed(1)} MB`);

backupDb.close();

// ── Step 4: Delete old trades from source ──
console.log(`\n── Deleting ${oldCount.cnt} old trades from active rag.db ──`);

const sourceDbInner = (sourceDb as any).ensureDb();
sourceDbInner.run(`DELETE FROM trades WHERE timestamp < ?`, [CUTOFF_MS]);

// Clear caches
sourceDb.clearEmbeddingCache();
(sourceDb as any).allTradesCache = null;

// Force save
(sourceDb as any).dirty = true;
sourceDb.saveToDisk();

// ── Step 5: Rebuild loss patterns from remaining data ──
console.log(`\n── Rebuilding loss patterns from remaining data ──`);

// Clear old patterns (they were built from old data)
sourceDbInner.run(`DELETE FROM loss_patterns`);
(sourceDb as any).dirty = true;
sourceDb.saveToDisk();

// Re-run batch categorization on remaining data
const { EmbeddingService } = await import("../src/rag/embeddings.js");
const { BatchProcessor } = await import("../src/rag/batch-processor.js");

const embedder = new EmbeddingService();
const batchProc = new BatchProcessor(sourceDb, embedder);
const heuristicCats = (batchProc as any).categorizeHeuristic?.() ?? 0;
const patternsUpdated = (batchProc as any).updateLossPatterns?.() ?? 0;
console.log(`  Categorized ${heuristicCats} losses, updated ${patternsUpdated} patterns`);

// VACUUM to reclaim space from deleted rows before saving
(sourceDb as any).dirty = true;
sourceDbInner.run('VACUUM');
sourceDb.saveToDisk();

// ── Step 6: Verify ──
console.log(`\n── Verification ──`);

const statsAfter = sourceDb.getStats();
console.log(`  Active rag.db: ${statsAfter.totalRecords} trades (${statsAfter.totalWins}W/${statsAfter.totalLosses}L)`);
console.log(`  Range: ${new Date(statsAfter.oldestRecord).toISOString()} → ${new Date(statsAfter.newestRecord).toISOString()}`);
console.log(`  Loss patterns: ${statsAfter.lossPatterns}`);
console.log(`  📏 Size: ${(fs.statSync(path.join(DATA_DIR, "rag.db")).size / 1024 / 1024).toFixed(1)} MB`);

// Verify enrichment coverage in remaining data
const remainingEnrichment = (sourceDb as any).queryOne(
  `SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN social_score > 0 THEN 1 ELSE 0 END) as social,
    SUM(CASE WHEN whale_count > 0 THEN 1 ELSE 0 END) as whales
   FROM trades`
);
const socialPct = ((remainingEnrichment.social / remainingEnrichment.total) * 100).toFixed(1);
const whalePct = ((remainingEnrichment.whales / remainingEnrichment.total) * 100).toFixed(1);
console.log(`  Enrichment coverage: social=${socialPct}%, whales=${whalePct}%`);

sourceDb.close();

console.log(`\n${"═".repeat(72)}`);
console.log(`  ✅  Migration complete!`);
console.log(`${"═".repeat(72)}`);
console.log(`\n  Backup: ${backupPath} (${backupStats.totalRecords} old trades)`);
console.log(`  Active: data/rag.db (${statsAfter.totalRecords} enriched trades)`);
console.log(`\n  The backup is safe to keep or move elsewhere.`);
console.log(`  The active rag.db now only contains post-enrichment data.\n`);
