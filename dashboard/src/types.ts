// ── Types for dashboard API responses ──

export interface LogEntry {
  id: number;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug" | "trade" | "signal" | "api" | "system";
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ThinkingEntry {
  id: number;
  timestamp: number;
  mint: string;
  symbol: string;
  type: "evaluation" | "entry" | "exit" | "risk-check" | "skip";
  decision: string;
  reasoning: string[];
  factors?: Record<string, number>;
  data?: Record<string, unknown>;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  entrySol: number;
  tokenAmount: number;
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  unrealizedPnlSol: number;
  unrealizedPnlPct: number;
  status: "open" | "partial-exit" | "closed";
  remainingRatio: number;
  totalExitSol: number;
  realizedPnlSol: number;
  openedAt: number;
  closedAt?: number;
  exitReason?: string;
  entryTxSignature?: string;
  exitTxSignatures: string[];
  trailingStopPrice: number;
  dryRun?: boolean;
}

export interface BotStatus {
  running: boolean;
  uptime: string;
  tradingMode: "agent" | "uav" | "none";
  walletPublicKey: string;
  openPositions: number;
  trackedTokens: number;
  wsMessages: number;
  dryRun: boolean;
  riskStatus: {
    consecutiveLosses: number;
    coolingDown: boolean;
    cooldownEndsAt?: number;
  };
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    totalRealizedPnl: number;
    winRate: number;
    bestTradePnl: number;
    worstTradePnl: number;
  };
  config: {
    minPositionSizeSol: number;
    maxPositionSizeSol: number;
    maxConcurrentPositions: number;
    maxTotalExposureSol: number;
    stopLossPct: number;
    takeProfitPct1: number;
    takeProfitPct2: number;
    stagnationExitSec: number;
    stagnationMinTrades: number;
    tradingFeePct: number;
  };
}

export interface WalletInfo {
  publicKey: string;
  privateKeyHint: string;
  solBalance: number;
  solPriceUsd: number;
  balanceUsd: number;
  totalBalanceSol: number;
  positionsValueUsd: number;
}

export interface TrackedToken {
  mint: string;
  symbol: string;
  name: string;
  marketCapSol: number;
  recentVolumeSol: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  bondingCurveProgress: number;
  ageSec: number;
  lastSignalScore?: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  actions?: ConfigAction[];
  autonomous?: boolean;
}

export interface ConfigAction {
  field: string;
  oldValue: number | boolean;
  newValue: number | boolean;
}

export interface AgentDecision {
  timestamp: number;
  type: "config-change" | "observation" | "warning" | "strategy";
  summary: string;
  actions: ConfigAction[];
  reasoning: string;
}
