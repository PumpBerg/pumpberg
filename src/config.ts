// ── Configuration for Pumpberg ──

import fs from "node:fs";
import path from "node:path";
import { initSettings, applySettingsToEnv } from "./settings.ts";

export interface PumpTraderConfig {
  // ── Solana ──
  /** Base58-encoded private key (loaded from env PUMP_TRADER_PRIVATE_KEY) */
  privateKey: string;
  /** Solana RPC endpoint URL */
  rpcUrl: string;
  /** Solana WebSocket endpoint URL (derived from rpcUrl if omitted) */
  wsUrl?: string;
  /** PumpPortal API key (for authenticated endpoints) */
  apiKey: string;

  // ── Position sizing ──
  /** Minimum position size in SOL (default 0.01) */
  minPositionSizeSol: number;
  /** Maximum position size in SOL (default 0.5) */
  maxPositionSizeSol: number;
  /** Maximum number of concurrent open positions (default 5) */
  maxConcurrentPositions: number;
  /** Maximum total SOL exposure across all open positions (default 0.5) */
  maxTotalExposureSol: number;
  /** Minimum SOL reserve floor — actual reserve is max(this, gasNeeded for all open positions) (default 0.05) */
  reserveSol: number;

  // ── Entry criteria ──
  /** Minimum signal score (0–100) to trigger a buy (default 60) */
  minBuyScore: number;
  /** Slippage tolerance in percent for buys (default 15) */
  buySlippagePct: number;
  /** Priority fee in SOL for transactions (default 0.001) */
  priorityFeeSol: number;
  /** PumpPortal trading fee as a decimal (default 0.005 = 0.5% per trade). Round-trip = 2x this. */
  tradingFeePct: number;
  /** Minimum token age in seconds before considering (default 10 — skip hyper-early rugs) */
  minTokenAgeSec: number;
  /** Maximum token age in seconds to consider for new-launch signals (default 300) */
  maxTokenAgeSec: number;

  // ── Exit criteria ──
  /** Take-profit level 1 — exit 50% at this gain (default 0.15 = 15%) */
  takeProfitPct1: number;
  /** Take-profit level 2 — exit remaining at this gain (default 0.30 = 30%) */
  takeProfitPct2: number;
  /** Stop-loss percentage (default 0.08 = -8%) */
  stopLossPct: number;
  /** Trailing stop activation: start trailing after this gain (default 0.10 = 10%) */
  trailingStopActivationPct: number;
  /** Trailing stop distance below peak (default 0.05 = 5%) */
  trailingStopDistancePct: number;
  /** Slippage tolerance for sells (default 20) */
  sellSlippagePct: number;
  /** Max age for a position before force-exiting (seconds, default 600 = 10 min) */
  maxPositionAgeSec: number;

  // ── Stagnation failsafe (non-agent modes only) ──
  /** Seconds after entry before checking for stagnation (default 8) */
  stagnationExitSec: number;
  /** Minimum trades required in that window to stay in (default 5) */
  stagnationMinTrades: number;

  // ── Scanner behavior ──
  /** How often to re-check open positions (ms, default 2000) */
  positionCheckIntervalMs: number;
  /** How long to keep token metrics in memory (ms, default 600000 = 10 min) */
  metricsRetentionMs: number;
  /** Enable dry-run mode — log trades but don't execute (default false) */
  dryRun: boolean;
}

/** Sensible defaults for small-position scalping */
export const DEFAULT_CONFIG: PumpTraderConfig = {
  privateKey: "",
  rpcUrl: "",
  apiKey: "",

  minPositionSizeSol: 0.01,
  maxPositionSizeSol: 0.5,
  maxConcurrentPositions: 20,
  maxTotalExposureSol: 2.0,
  reserveSol: 0.05,

  minBuyScore: 60,
  buySlippagePct: 15,
  priorityFeeSol: 0.001,
  tradingFeePct: 0.005,
  minTokenAgeSec: 5,
  maxTokenAgeSec: 120,

  takeProfitPct1: 0.25,
  takeProfitPct2: 0.30,
  stopLossPct: 0.08,
  trailingStopActivationPct: 0.10,
  trailingStopDistancePct: 0.05,
  sellSlippagePct: 20,
  maxPositionAgeSec: 300,

  stagnationExitSec: 8,
  stagnationMinTrades: 5,

  positionCheckIntervalMs: 2_000,
  metricsRetentionMs: 300_000,
  dryRun: true, // Always start in dry run — toggle to LIVE from dashboard
};

/** Fields that can be persisted as runtime overrides */
const PERSISTABLE_FIELDS = [
  "minPositionSizeSol", "maxPositionSizeSol", "maxConcurrentPositions",
  "maxTotalExposureSol", "minBuyScore", "stopLossPct", "takeProfitPct1",
  "takeProfitPct2", "trailingStopActivationPct", "trailingStopDistancePct",
  "maxPositionAgeSec", "stagnationExitSec", "stagnationMinTrades",
  "tradingFeePct", "priorityFeeSol",
] as const;

/** Fields that should NOT be persisted in dry-run mode (managed by start() overrides) */
const DRY_RUN_NON_PERSISTABLE = new Set(["maxConcurrentPositions", "maxTotalExposureSol"]);

/** Save current runtime config overrides to disk so they survive restarts */
export function persistConfig(config: PumpTraderConfig, dataDir: string): void {
  try {
    const overrides: Record<string, number> = {};
    for (const field of PERSISTABLE_FIELDS) {
      // In dry-run, skip capacity fields — they're managed by start() overrides
      if (config.dryRun && DRY_RUN_NON_PERSISTABLE.has(field)) continue;
      if (config[field] !== DEFAULT_CONFIG[field]) {
        overrides[field] = config[field] as number;
      }
    }
    const filePath = path.join(dataDir, "config-overrides.json");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(overrides, null, 2), "utf-8");
  } catch (err) {
    console.error("[config] Failed to persist config:", err);
  }
}

/** Load previously saved config overrides from disk */
export function loadPersistedConfig(dataDir: string): Partial<PumpTraderConfig> {
  try {
    const filePath = path.join(dataDir, "config-overrides.json");
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    const overrides = JSON.parse(raw) as Record<string, number>;
    console.log(`[config] Loaded persisted config overrides: ${Object.keys(overrides).join(", ")}`);
    return overrides;
  } catch (err) {
    console.error("[config] Failed to load persisted config:", err);
    return {};
  }
}

/** Load a .env file into process.env (simple key=value parser) */
function loadEnvFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {}
}

/** Build config from environment variables + overrides */
export function resolveConfig(overrides: Partial<PumpTraderConfig> = {}): PumpTraderConfig {
  const env = process.env;

  const base: PumpTraderConfig = {
    ...DEFAULT_CONFIG,

    // Environment variable sources
    privateKey: env.PUMP_TRADER_PRIVATE_KEY ?? env.SOLANA_PRIVATE_KEY ?? "",
    rpcUrl: env.PUMP_TRADER_RPC_URL ?? env.SOLANA_RPC_URL ?? "",
    wsUrl: env.PUMP_TRADER_WS_URL ?? env.SOLANA_WS_URL,
    apiKey: env.PUMP_TRADER_API_KEY ?? "",

    // Numeric overrides from env
    ...(env.PUMP_TRADER_MIN_POSITION_SIZE_SOL
      ? { minPositionSizeSol: Number.parseFloat(env.PUMP_TRADER_MIN_POSITION_SIZE_SOL) }
      : {}),
    ...(env.PUMP_TRADER_MAX_POSITION_SIZE_SOL
      ? { maxPositionSizeSol: Number.parseFloat(env.PUMP_TRADER_MAX_POSITION_SIZE_SOL) }
      : {}),
    ...(env.PUMP_TRADER_MAX_POSITIONS
      ? { maxConcurrentPositions: Number.parseInt(env.PUMP_TRADER_MAX_POSITIONS, 10) }
      : {}),
    ...(env.PUMP_TRADER_MAX_EXPOSURE
      ? { maxTotalExposureSol: Number.parseFloat(env.PUMP_TRADER_MAX_EXPOSURE) }
      : {}),
    ...(env.PUMP_TRADER_DRY_RUN !== undefined
      ? { dryRun: env.PUMP_TRADER_DRY_RUN === "1" || env.PUMP_TRADER_DRY_RUN === "true" }
      : {}),
  };

  return { ...base, ...overrides };
}

/** Validate that required config fields are present */
export function validateConfig(cfg: PumpTraderConfig): string[] {
  const errors: string[] = [];

  if (!cfg.privateKey) {
    errors.push("Missing PUMP_TRADER_PRIVATE_KEY (or SOLANA_PRIVATE_KEY) — wallet private key required.");
  }
  if (!cfg.rpcUrl) {
    errors.push(
      "Missing PUMP_TRADER_RPC_URL (or SOLANA_RPC_URL) — Solana RPC endpoint required. " +
        "Recommended: sign up at https://www.helius.dev (free tier: 100k credits/day).",
    );
  }
  if (cfg.minPositionSizeSol <= 0) {
    errors.push("minPositionSizeSol must be > 0.");
  }
  if (cfg.maxPositionSizeSol <= 0 || cfg.maxPositionSizeSol < cfg.minPositionSizeSol) {
    errors.push("maxPositionSizeSol must be > 0 and >= minPositionSizeSol.");
  }
  if (cfg.stopLossPct <= 0 || cfg.stopLossPct >= 1) {
    errors.push("stopLossPct must be between 0 and 1 (e.g. 0.08 for 8%).");
  }
  if (cfg.takeProfitPct1 <= 0) {
    errors.push("takeProfitPct1 must be > 0.");
  }

  return errors;
}

/**
 * Load .env file, resolve config from environment, and validate.
 * Throws if required fields are missing.
 */
export function loadConfig(envDir?: string): PumpTraderConfig {
  // Try loading .env from extension root or specified directory
  const searchDirs = [
    envDir,
    path.resolve(import.meta.dirname ?? ".", ".."),
    process.cwd(),
  ].filter(Boolean) as string[];

  // ── Load settings.json as a fallback for env vars ──
  // Settings are written by the dashboard UI; env vars take precedence.
  for (const dir of searchDirs) {
    const dataDir = path.join(dir, "data");
    if (fs.existsSync(path.join(dataDir, "settings.json"))) {
      initSettings(dataDir);
      applySettingsToEnv();
      break;
    }
  }

  for (const dir of searchDirs) {
    loadEnvFile(path.join(dir, ".env"));
  }

  const config = resolveConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error("Pumpberg config errors:\n  - " + errors.join("\n  - "));
  }
  return config;
}
