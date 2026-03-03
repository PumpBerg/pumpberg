#!/usr/bin/env npx tsx
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🧪 HYPOTHESIS TEST: Does the RAG system improve trade selection?
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// H₀ (Null):        RAG context does NOT change the LLM's ability to separate
//                    winners from losers (RAG-scored wins ≈ RAG-scored losses).
// H₁ (Alternative): RAG context DOES improve separation — tokens the RAG flags
//                    as risky actually lose more often.
//
// Methodology:
//   1. RETROSPECTIVE BACKTEST: Take completed trades from the journal
//   2. Split into Training Set (first 70%) and Test Set (last 30%)
//   3. Build RAG context from Training Set only (no data leakage)
//   4. For each Test Set trade, compute:
//      a. RAG risk score (embedding similarity to training losers)
//      b. RAG veto recommendation
//      c. TradeRAG compact context verdict (structured similarity)
//   5. Measure:
//      - Do RAG-vetoed tokens actually lose more? (veto accuracy)
//      - Does RAG risk score correlate with actual P&L? (rank correlation)
//      - What's the win rate if we only take RAG-approved trades?
//      - Welch's t-test on risk scores of actual wins vs actual losses
//
// Run: npx tsx scripts/hypothesis-test.ts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

// ── Dynamic imports (avoid TS resolution issues) ──
const { RAGDatabase } = await import("../src/rag/database.js");
const { EmbeddingService, buildFeatureText } = await import("../src/rag/embeddings.js");
const { RAGQueryEngine } = await import("../src/rag/query-engine.js");
const { BatchProcessor } = await import("../src/rag/batch-processor.js");

interface CompletedTrade {
  mint: string;
  symbol: string;
  name: string;
  timestamp: number;
  marketCapSol: number;
  volumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  signalScore: number;
  marketRegime: string;
  creatorReputation: number;
  llmNarrative: string;
  pnlSol: number;
  pnlPct: number;
  exitReason: string;
  holdTimeSec: number;
  peakPnlPct: number;
  entryPrice: number;
  exitPrice: number;
  positionSizeSol: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Step 1: Load & prepare trade data (from rag.db) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log("\n" + "═".repeat(72));
console.log("  🧪  HYPOTHESIS TEST: Does RAG improve trade selection?");
console.log("═".repeat(72) + "\n");

const ragDbPath = path.join(DATA_DIR, "rag.db");
if (!fs.existsSync(ragDbPath)) {
  console.error("❌ No rag.db found. Run the bot first.");
  process.exit(1);
}

// Load all completed trades directly from rag.db (has all 3000+ records)
const sourceDb = new RAGDatabase(DATA_DIR);
await sourceDb.initialize();

const sourceStats = sourceDb.getStats();
console.log(`📊 RAG DB: ${sourceStats.totalRecords} total records (${sourceStats.totalWins}W/${sourceStats.totalLosses}L)`);

// Get all trades with outcomes (win/loss only, skip neutral)
const allRagTrades = [
  ...sourceDb.getTradesByOutcome("loss", 100000),
  ...sourceDb.getTradesByOutcome("win", 100000),
].sort((a, b) => a.timestamp - b.timestamp);

sourceDb.close();

// Convert RAG records to CompletedTrade format
const completedTrades: CompletedTrade[] = allRagTrades.map((r) => ({
  mint: r.mint,
  symbol: r.symbol,
  name: r.name,
  timestamp: r.timestamp,
  marketCapSol: r.marketCapSol,
  volumeSol: r.volumeSol,
  buyCount: r.buyCount,
  sellCount: r.sellCount,
  uniqueBuyers: r.uniqueBuyers,
  bondingCurveProgress: r.bondingCurveProgress,
  signalScore: r.signalScore,
  marketRegime: r.marketRegime,
  creatorReputation: r.creatorReputation,
  llmNarrative: r.llmNarrative || "agent-initiated",
  pnlSol: r.pnlSol,
  pnlPct: r.pnlPct,
  exitReason: r.exitReason,
  holdTimeSec: r.holdTimeSec,
  peakPnlPct: r.peakPnlPct,
  entryPrice: r.entryPrice,
  exitPrice: r.exitPrice,
  positionSizeSol: r.entrySizeSol,
}));

console.log(`📊 Loaded ${completedTrades.length} completed trades`);

if (completedTrades.length < 30) {
  console.error("❌ Need at least 30 completed trades for a meaningful test.");
  process.exit(1);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Step 2: Train/Test split (70/30, chronological) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const splitIdx = Math.floor(completedTrades.length * 0.7);
const trainSet = completedTrades.slice(0, splitIdx);
const testSet = completedTrades.slice(splitIdx);

const trainWins = trainSet.filter(t => t.pnlSol > 0).length;
const trainLosses = trainSet.length - trainWins;
const testWins = testSet.filter(t => t.pnlSol > 0).length;
const testLosses = testSet.length - testWins;

console.log(`\n── Data Split ──`);
console.log(`  Training: ${trainSet.length} trades (${trainWins}W/${trainLosses}L, ${(trainWins/trainSet.length*100).toFixed(1)}% WR)`);
console.log(`  Test:     ${testSet.length} trades (${testWins}W/${testLosses}L, ${(testWins/testSet.length*100).toFixed(1)}% WR)`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Step 3: Build RAG database from Training data only ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`\n── Building RAG from training data (no data leakage) ──`);

// Use a fresh in-memory DB (don't touch the real rag.db)
const testDbPath = path.join(DATA_DIR, "hypothesis-test-rag.db");
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); // Clean start

const ragDb = new RAGDatabase(DATA_DIR);
// Override path to our test DB
(ragDb as any).dbPath = testDbPath;
await ragDb.initialize();

const embedder = new EmbeddingService();

console.log("  Loading SBERT model...");

// Insert training trades into RAG DB
let inserted = 0;
const records = trainSet.map(t => {
  const tokenAgeSec = 30; // Not stored, default
  const featureText = buildFeatureText({
    symbol: t.symbol,
    name: t.name,
    llmNarrative: t.llmNarrative,
    marketCapSol: t.marketCapSol,
    volumeSol: t.volumeSol,
    buyCount: t.buyCount,
    sellCount: t.sellCount,
    uniqueBuyers: t.uniqueBuyers,
    bondingCurveProgress: t.bondingCurveProgress,
    tokenAgeSec,
    signalScore: t.signalScore,
    marketRegime: t.marketRegime,
    creatorReputation: t.creatorReputation,
    exitReason: t.exitReason,
    pnlPct: t.pnlPct,
    holdTimeSec: t.holdTimeSec,
  });

  return {
    id: `${t.timestamp}-${t.mint.slice(0, 8)}`,
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    creator: "",
    timestamp: t.timestamp,
    entryPrice: t.entryPrice,
    entrySizeSol: t.positionSizeSol,
    marketCapSol: t.marketCapSol,
    volumeSol: t.volumeSol,
    buyCount: t.buyCount,
    sellCount: t.sellCount,
    uniqueBuyers: t.uniqueBuyers,
    bondingCurveProgress: t.bondingCurveProgress,
    tokenAgeSec,
    signalScore: t.signalScore,
    llmScore: 0,
    llmNarrative: t.llmNarrative,
    llmConfidence: 0,
    marketRegime: t.marketRegime,
    creatorReputation: t.creatorReputation,
    spamLaunch: false,
    spamLaunchCount: 0,
    whaleCount: 0,
    whaleVolumeSol: 0,
    socialScore: 0,
    socialFirstMover: false,
    socialCompetingCoins: 0,
    socialXTweets: 0,
    socialViralMeme: false,
    smartMoneyRank: 0,
    smartMoneyWinRate: 0,
    exitTimestamp: t.timestamp,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
    holdTimeSec: t.holdTimeSec,
    peakPrice: t.entryPrice * (1 + t.peakPnlPct),
    peakPnlPct: t.peakPnlPct,
    pnlSol: t.pnlSol,
    pnlPct: t.pnlPct,
    outcome: (t.pnlSol > 0 ? "win" : "loss") as "win" | "loss",
    featureText,
  };
});

inserted = ragDb.insertTradeBatch(records as any);
console.log(`  Inserted ${inserted} training trades into test RAG DB`);

// NOTE: Embeddings are no longer needed for risk scoring — the query engine
// now uses numeric feature similarity instead of SBERT cosine similarity.
// Skipping embedding generation saves ~10 minutes of CPU time.

// Run batch processor for categorization (heuristic, no LLM cost)
const batchProc = new BatchProcessor(ragDb, embedder);
const heuristicCats = (batchProc as any).categorizeHeuristic?.() ?? 0;
const patternsUpdated = (batchProc as any).updateLossPatterns?.() ?? 0;
console.log(`  Categorized ${heuristicCats} losses (heuristic), ${patternsUpdated} patterns`);

const stats = ragDb.getStats();
console.log(`  RAG DB: ${stats.totalRecords} records, ${stats.withEmbeddings} with embeddings, ${stats.lossPatterns} patterns\n`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Step 3b: Feature Importance Diagnostic ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`── Feature Analysis: which training features predict outcome? ──\n`);

// Point-biserial correlation for each numeric feature
const trainWinTrades = trainSet.filter(t => t.pnlSol > 0);
const trainLossTrades = trainSet.filter(t => t.pnlSol <= 0);

const featureExtractors: [string, (t: CompletedTrade) => number][] = [
  ["marketCapSol", t => t.marketCapSol],
  ["volumeSol", t => t.volumeSol],
  ["buyCount", t => t.buyCount],
  ["sellCount", t => t.sellCount],
  ["uniqueBuyers", t => t.uniqueBuyers],
  ["bondingCurve", t => t.bondingCurveProgress],
  ["signalScore", t => t.signalScore],
  ["creatorRep", t => t.creatorReputation],
  ["buyRatio", t => t.buyCount / Math.max(1, t.buyCount + t.sellCount)],
  ["log(mcap)", t => Math.log10(Math.max(0.001, t.marketCapSol))],
  ["log(vol)", t => Math.log10(Math.max(0.001, t.volumeSol))],
];

const featureMean = (trades: CompletedTrade[], fn: (t: CompletedTrade) => number) => {
  if (trades.length === 0) return 0;
  return trades.reduce((s, t) => s + fn(t), 0) / trades.length;
};

console.log(`  ${"Feature".padEnd(16)} W_mean      L_mean      Δ(W-L)      Direction`);
console.log(`  ${"─".repeat(70)}`);
for (const [name, fn] of featureExtractors) {
  const wMean = featureMean(trainWinTrades, fn);
  const lMean = featureMean(trainLossTrades, fn);
  const delta = wMean - lMean;
  const dir = Math.abs(delta) < 0.001 ? "≈" : delta > 0 ? "W > L (higher = wins more)" : "L > W (higher = loses more)";
  console.log(`  ${name.padEnd(16)} ${wMean.toFixed(4).padStart(10)}  ${lMean.toFixed(4).padStart(10)}  ${(delta >= 0 ? "+" : "") + delta.toFixed(4).padStart(10)}  ${dir}`);
}
console.log();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Step 4: Evaluate each test trade through the RAG ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`── Evaluating ${testSet.length} test trades through RAG ──\n`);

const ragQuery = new RAGQueryEngine(ragDb, embedder);

interface TestResult {
  trade: CompletedTrade;
  ragRiskScore: number;
  ragVetoed: boolean;
  ragReason: string;
  similarLosses: number;
  similarWins: number;
  actualWin: boolean;
}

const results: TestResult[] = [];
const BATCH_LOG_INTERVAL = 50;

// Expose GC for memory management with large datasets
const gc = typeof globalThis.gc === "function" ? globalThis.gc : undefined;

for (let i = 0; i < testSet.length; i++) {
  const trade = testSet[i];

  const evaluation = await ragQuery.evaluate({
    symbol: trade.symbol,
    name: trade.name,
    llmNarrative: trade.llmNarrative,
    marketCapSol: trade.marketCapSol,
    volumeSol: trade.volumeSol,
    buyCount: trade.buyCount,
    sellCount: trade.sellCount,
    uniqueBuyers: trade.uniqueBuyers,
    bondingCurveProgress: trade.bondingCurveProgress,
    tokenAgeSec: 30,
    signalScore: trade.signalScore,
    marketRegime: trade.marketRegime,
    creatorReputation: trade.creatorReputation,
  });

  // Only store the numbers we need — don't hold onto large match arrays
  results.push({
    trade,
    ragRiskScore: evaluation.riskScore,
    ragVetoed: evaluation.vetoed,
    ragReason: evaluation.reason,
    similarLosses: evaluation.similarLosses.length,
    similarWins: evaluation.similarWins.length,
    actualWin: trade.pnlSol > 0,
  });

  if ((i + 1) % BATCH_LOG_INTERVAL === 0 || i === testSet.length - 1) {
    process.stdout.write(`  Progress: ${i + 1}/${testSet.length}\n`);
  }

  // Force GC every 200 evaluations to prevent OOM
  if (gc && (i + 1) % 200 === 0) {
    gc();
  }
}

console.log(`\n  ✅ All ${results.length} test trades evaluated\n`);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Step 5: Statistical Analysis ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log("═".repeat(72));
console.log("  📊  RESULTS");
console.log("═".repeat(72));

// ── 5a: Overall veto accuracy ──
const vetoedTrades = results.filter(r => r.ragVetoed);
const approvedTrades = results.filter(r => !r.ragVetoed);

const vetoedWins = vetoedTrades.filter(r => r.actualWin).length;
const vetoedLosses = vetoedTrades.filter(r => !r.actualWin).length;
const approvedWins = approvedTrades.filter(r => r.actualWin).length;
const approvedLosses = approvedTrades.filter(r => !r.actualWin).length;

const baseWinRate = testWins / testSet.length;
const approvedWinRate = approvedTrades.length > 0 ? approvedWins / approvedTrades.length : 0;
const vetoedWinRate = vetoedTrades.length > 0 ? vetoedWins / vetoedTrades.length : 0;

console.log(`\n── A. Veto Accuracy ──`);
console.log(`  Baseline win rate (no filter):    ${(baseWinRate * 100).toFixed(1)}% (${testWins}W/${testLosses}L)`);
console.log(`  RAG-APPROVED win rate:            ${(approvedWinRate * 100).toFixed(1)}% (${approvedWins}W/${approvedLosses}L of ${approvedTrades.length})`);
console.log(`  RAG-VETOED win rate:              ${(vetoedWinRate * 100).toFixed(1)}% (${vetoedWins}W/${vetoedLosses}L of ${vetoedTrades.length})`);
const vetoLift = approvedWinRate - baseWinRate;
console.log(`  Win rate LIFT from RAG filter:    ${vetoLift >= 0 ? "+" : ""}${(vetoLift * 100).toFixed(1)} pp`);

// ── 5b: Confusion matrix ──
console.log(`\n── B. Confusion Matrix (RAG veto = "predict loss") ──`);
const tp = vetoedLosses; // Correctly vetoed (was a loss)
const fp = vetoedWins;   // Incorrectly vetoed (was a win)
const tn = approvedWins; // Correctly approved (was a win)
const fn = approvedLosses; // Missed loss (approved but lost)
const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = precision && recall ? 2 * (precision * recall) / (precision + recall) : 0;

console.log(`                    Actual Loss    Actual Win`);
console.log(`  RAG Vetoed:       ${String(tp).padStart(8)}       ${String(fp).padStart(8)}    (precision: ${(precision*100).toFixed(1)}%)`);
console.log(`  RAG Approved:     ${String(fn).padStart(8)}       ${String(tn).padStart(8)}    (recall:    ${(recall*100).toFixed(1)}%)`);
console.log(`  F1 Score:         ${f1.toFixed(3)}`);

// ── 5c: Risk score distribution: wins vs losses ──
const winRiskScores = results.filter(r => r.actualWin).map(r => r.ragRiskScore);
const lossRiskScores = results.filter(r => !r.actualWin).map(r => r.ragRiskScore);

const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
const variance = (arr: number[], m: number) => arr.length > 1 ? arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1) : 0;
const median = (arr: number[]) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const winMean = mean(winRiskScores);
const lossMean = mean(lossRiskScores);
const winVar = variance(winRiskScores, winMean);
const lossVar = variance(lossRiskScores, lossMean);

console.log(`\n── C. RAG Risk Score Distribution ──`);
console.log(`  Actual WINS:   mean=${winMean.toFixed(4)}, median=${median(winRiskScores).toFixed(4)}, std=${Math.sqrt(winVar).toFixed(4)}, n=${winRiskScores.length}`);
console.log(`  Actual LOSSES: mean=${lossMean.toFixed(4)}, median=${median(lossRiskScores).toFixed(4)}, std=${Math.sqrt(lossVar).toFixed(4)}, n=${lossRiskScores.length}`);
console.log(`  Difference:    ${lossMean > winMean ? "✅ Losses have HIGHER risk scores (good!)" : "❌ Losses have LOWER risk scores (bad)"} Δ=${Math.abs(lossMean - winMean).toFixed(4)}`);

// ── 5d: Welch's t-test ──
// Tests whether the mean risk scores of wins vs losses are statistically different
function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number } {
  const nA = a.length, nB = b.length;
  if (nA < 2 || nB < 2) return { t: 0, df: 0, p: 1 };

  const mA = mean(a), mB = mean(b);
  const vA = variance(a, mA), vB = variance(b, mB);

  const sA = vA / nA, sB = vB / nB;
  const t = (mA - mB) / Math.sqrt(sA + sB);
  const df = ((sA + sB) ** 2) / ((sA ** 2) / (nA - 1) + (sB ** 2) / (nB - 1));

  // Approximate p-value from t-distribution using normal approximation
  // (exact p requires tCDF; for df>30 normal approx is reasonable)
  const absT = Math.abs(t);
  // Two-tailed p-value approximation using the Abramowitz & Stegun method
  const p = 2 * normalCDF(-absT);

  return { t, df, p };
}

// Standard normal CDF approximation (Abramowitz & Stegun formula 26.2.17)
function normalCDF(x: number): number {
  if (x >= 6) return 1;
  if (x <= -6) return 0;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

const tTest = welchTTest(lossRiskScores, winRiskScores);

console.log(`\n── D. Welch's t-test (H₀: mean risk scores are equal) ──`);
console.log(`  t-statistic:  ${tTest.t.toFixed(4)}`);
console.log(`  Degrees of freedom: ${tTest.df.toFixed(1)}`);
console.log(`  p-value:      ${tTest.p < 0.001 ? tTest.p.toExponential(3) : tTest.p.toFixed(4)}`);
console.log(`  Significance: ${tTest.p < 0.001 ? "*** p < 0.001" : tTest.p < 0.01 ? "** p < 0.01" : tTest.p < 0.05 ? "* p < 0.05" : "NOT SIGNIFICANT (p ≥ 0.05)"}`);

// ── 5e: Spearman rank correlation (risk score vs P&L) ──
function spearmanCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;

  const rank = (arr: number[]) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  };

  const rx = rank(x);
  const ry = rank(y);

  let d2sum = 0;
  for (let i = 0; i < n; i++) d2sum += (rx[i] - ry[i]) ** 2;

  return 1 - (6 * d2sum) / (n * (n * n - 1));
}

const riskScores = results.map(r => r.ragRiskScore);
const pnls = results.map(r => r.trade.pnlSol);
const rho = spearmanCorrelation(riskScores, pnls);

console.log(`\n── E. Spearman Rank Correlation (risk score ↔ P&L) ──`);
console.log(`  ρ = ${rho.toFixed(4)}`);
console.log(`  Interpretation: ${rho < -0.1 ? "✅ NEGATIVE correlation (higher risk → worse P&L, good!)" : rho > 0.1 ? "❌ POSITIVE correlation (higher risk → better P&L, bad)" : "⚠️  WEAK/NO correlation"}`);

// ── 5f: Risk score quintile analysis ──
console.log(`\n── F. Performance by Risk Score Quintile ──`);

const sortedByRisk = [...results].sort((a, b) => a.ragRiskScore - b.ragRiskScore);
const quintileSize = Math.ceil(sortedByRisk.length / 5);

for (let q = 0; q < 5; q++) {
  const start = q * quintileSize;
  const end = Math.min(start + quintileSize, sortedByRisk.length);
  const slice = sortedByRisk.slice(start, end);
  if (slice.length === 0) continue;

  const qWins = slice.filter(r => r.actualWin).length;
  const qWinRate = qWins / slice.length;
  const qAvgRisk = mean(slice.map(r => r.ragRiskScore));
  const qAvgPnl = mean(slice.map(r => r.trade.pnlSol));
  const qTotalPnl = slice.reduce((s, r) => s + r.trade.pnlSol, 0);
  const label = q === 0 ? "LOWEST risk " : q === 4 ? "HIGHEST risk" : `Quintile ${q + 1}   `;

  console.log(`  ${label}  risk=${qAvgRisk.toFixed(3)}  WR=${(qWinRate*100).toFixed(1)}%  avgP&L=${(qAvgPnl*1000).toFixed(2)}mSOL  totalP&L=${qTotalPnl.toFixed(4)}SOL  (n=${slice.length})`);
}

// ── 5g: Simulated P&L impact ──
console.log(`\n── G. Simulated P&L: What if RAG vetoed trades? ──`);

const baselinePnl = testSet.reduce((s, t) => s + t.pnlSol, 0);
const ragFilteredPnl = approvedTrades.reduce((s, r) => s + r.trade.pnlSol, 0);
const filteredTradesDropped = vetoedTrades.length;
const pnlImprovement = ragFilteredPnl - baselinePnl;

console.log(`  Baseline P&L (all trades):     ${baselinePnl >= 0 ? "+" : ""}${baselinePnl.toFixed(4)} SOL (${testSet.length} trades)`);
console.log(`  RAG-filtered P&L:              ${ragFilteredPnl >= 0 ? "+" : ""}${ragFilteredPnl.toFixed(4)} SOL (${approvedTrades.length} trades)`);
console.log(`  Trades filtered out:           ${filteredTradesDropped}`);
console.log(`  P&L change from filtering:     ${pnlImprovement >= 0 ? "+" : ""}${pnlImprovement.toFixed(4)} SOL`);

// ── 5h: Try different risk thresholds ──
console.log(`\n── H. Optimal Risk Threshold Sweep ──`);
console.log(`  Threshold  Remaining  WinRate  TotalP&L    ΔP&L`);

for (const threshold of [0.75, 0.78, 0.80, 0.82, 0.84, 0.86, 0.88, 0.90, 0.92, 0.94, 0.96, 0.98, 1.00]) {
  const kept = results.filter(r => r.ragRiskScore < threshold);
  if (kept.length === 0) continue;
  const keptWins = kept.filter(r => r.actualWin).length;
  const keptPnl = kept.reduce((s, r) => s + r.trade.pnlSol, 0);
  const delta = keptPnl - baselinePnl;
  console.log(`  ${threshold.toFixed(2).padStart(9)}  ${String(kept.length).padStart(9)}  ${(keptWins/kept.length*100).toFixed(1).padStart(6)}%  ${(keptPnl >= 0 ? "+" : "") + keptPnl.toFixed(4).padStart(10)}  ${(delta >= 0 ? "+" : "") + delta.toFixed(4).padStart(8)}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Missed Winner Analysis (Live Eligibility) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`\n${"═".repeat(72)}`);
console.log("  🎯  MISSED WINNER ANALYSIS (Live Filter Gate)");
console.log("═".repeat(72));

// Check if live_eligible data is available in the loaded RAG trades
const tradesWithLiveData = allRagTrades.filter(r => (r as any).liveEligible !== undefined);

if (tradesWithLiveData.length > 0) {
  const liveEligible = tradesWithLiveData.filter(r => (r as any).liveEligible === true);
  const liveIneligible = tradesWithLiveData.filter(r => (r as any).liveEligible === false);
  const missedWinners = liveIneligible.filter(r => r.pnlSol > 0);
  const blockedLosers = liveIneligible.filter(r => r.pnlSol <= 0);

  console.log(`\n  Total trades with live eligibility data: ${tradesWithLiveData.length}`);
  console.log(`  Live eligible:    ${liveEligible.length} (${(liveEligible.length / tradesWithLiveData.length * 100).toFixed(1)}%)`);
  console.log(`  Live ineligible:  ${liveIneligible.length} (${(liveIneligible.length / tradesWithLiveData.length * 100).toFixed(1)}%)`);

  if (liveIneligible.length > 0) {
    console.log(`\n  Among ineligible trades:`);
    console.log(`    Blocked losers (good):   ${blockedLosers.length} (${(blockedLosers.length / liveIneligible.length * 100).toFixed(1)}%)`);
    console.log(`    Missed winners (bad):    ${missedWinners.length} (${(missedWinners.length / liveIneligible.length * 100).toFixed(1)}%)`);

    if (missedWinners.length > 0) {
      const missedPnl = missedWinners.reduce((s, r) => s + r.pnlSol, 0);
      console.log(`    Missed winner P&L:       +${missedPnl.toFixed(4)} SOL`);

      // Show most common failure reasons
      const reasonCounts = new Map<string, number>();
      for (const t of liveIneligible) {
        const reasons: string[] = (t as any).liveFilterFailReasons ?? [];
        for (const reason of reasons) {
          const key = reason.replace(/=\d+.*$/, ""); // Strip values, keep gate name
          reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
        }
      }
      if (reasonCounts.size > 0) {
        console.log(`\n  Filter gate failure frequency:`);
        const sorted = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [reason, count] of sorted) {
          const pct = (count / liveIneligible.length * 100).toFixed(1);
          console.log(`    ${reason.padEnd(30)} ${count} (${pct}%)`);
        }
      }
    }
  }

  // Win rate comparison: live eligible vs all trades
  const eligibleWins = liveEligible.filter(r => r.pnlSol > 0).length;
  const eligibleWR = liveEligible.length > 0 ? eligibleWins / liveEligible.length : 0;
  const overallWins = tradesWithLiveData.filter(r => r.pnlSol > 0).length;
  const overallWR = overallWins / tradesWithLiveData.length;
  console.log(`\n  Win rate comparison:`);
  console.log(`    All trades:       ${(overallWR * 100).toFixed(1)}% (${overallWins}/${tradesWithLiveData.length})`);
  console.log(`    Live eligible:    ${(eligibleWR * 100).toFixed(1)}% (${eligibleWins}/${liveEligible.length})`);
  console.log(`    Lift:             ${((eligibleWR - overallWR) * 100).toFixed(1)} pp`);
} else {
  console.log(`\n  ⚠️  No live eligibility data available yet.`);
  console.log(`     Run the bot in dry-run mode to collect liveEligible tags on trades.`);
  console.log(`     The LiveFilterGate will tag each trade with whether it would pass live filters.`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Final Verdict ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log(`\n${"═".repeat(72)}`);
console.log("  🏁  VERDICT");
console.log("═".repeat(72));

const significant = tTest.p < 0.05;
const correctDirection = lossMean > winMean;
const liftPositive = vetoLift > 0;
const correlationNegative = rho < -0.05;

const score = [significant, correctDirection, liftPositive, correlationNegative].filter(Boolean).length;

if (score >= 3) {
  console.log(`\n  ✅ REJECT H₀ — RAG system IS making a meaningful difference`);
  console.log(`     Evidence: ${score}/4 criteria met`);
} else if (score >= 2) {
  console.log(`\n  ⚠️  INCONCLUSIVE — Some signal, but not strong enough`);
  console.log(`     Evidence: ${score}/4 criteria met`);
} else {
  console.log(`\n  ❌ FAIL TO REJECT H₀ — RAG system is NOT separating winners from losers`);
  console.log(`     Evidence: ${score}/4 criteria met`);
}

console.log(`\n  Criteria breakdown:`);
console.log(`    ${significant ? "✅" : "❌"} Statistical significance (p < 0.05): p=${tTest.p < 0.001 ? tTest.p.toExponential(2) : tTest.p.toFixed(4)}`);
console.log(`    ${correctDirection ? "✅" : "❌"} Losses have higher risk scores: win_mean=${winMean.toFixed(4)} vs loss_mean=${lossMean.toFixed(4)}`);
console.log(`    ${liftPositive ? "✅" : "❌"} RAG filter improves win rate: ${(vetoLift*100).toFixed(1)} pp lift`);
console.log(`    ${correlationNegative ? "✅" : "❌"} Negative risk-PnL correlation: ρ=${rho.toFixed(4)}`);

console.log(`\n  ${score >= 3 ? "The RAG system has learned to identify losing patterns from training data." : score >= 2 ? "There's a weak signal — the RAG needs more diverse training data." : "The RAG system hasn't learned enough from the current data to add value yet."}`);
console.log(`  Training set: ${trainSet.length} trades | Test set: ${testSet.length} trades | RAG DB: ${stats.withEmbeddings} embedded records`);
console.log();

// ── Cleanup test DB ──
try {
  ragDb.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch {}
