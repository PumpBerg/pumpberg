// ── RAG Module: barrel export for all RAG components ──

export { RAGDatabase } from "./database.js";
export { EmbeddingService, buildFeatureText, EMBEDDING_DIM } from "./embeddings.js";
export { HistoricalImporter } from "./importer.js";
export { BatchProcessor } from "./batch-processor.js";
export { RAGQueryEngine } from "./query-engine.js";
export type {
  RAGTradeRecord,
  RAGMatch,
  LossPattern,
  RAGStats,
  BatchAnalysisItem,
  BatchCategoryResult,
  RAGVetoResult,
} from "./types.js";
// Re-export RAGVetoResult from query engine
export type { RAGVetoResult as VetoResult } from "./query-engine.js";
