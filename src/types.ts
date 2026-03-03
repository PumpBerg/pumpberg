// ── Shared types for the pump-trader extension ──

/** Raw new-token event from PumpPortal WebSocket */
export interface PumpTokenCreateEvent {
  txType: "create";
  signature: string;
  mint: string;
  traderPublicKey: string;
  initialBuy: number;
  solAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;
}

/** Raw trade event from PumpPortal WebSocket */
export interface PumpTradeEvent {
  txType: "buy" | "sell";
  signature: string;
  mint: string;
  traderPublicKey: string;
  tokenAmount: number;
  solAmount: number;
  newTokenBalance: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

/** Migration event — token graduated from bonding curve to Raydium */
export interface PumpMigrationEvent {
  txType?: string;
  signature: string;
  mint: string;
  name?: string;
  symbol?: string;
  pool?: string;
  [key: string]: unknown;
}

/** Aggregated token stats built from trade events */
export interface TokenMetrics {
  mint: string;
  name: string;
  symbol: string;
  createdAt: number;
  /** Current market cap in SOL */
  marketCapSol: number;
  /** Total SOL volume traded */
  totalVolumeSol: number;
  /** Volume in the last 60 seconds */
  recentVolumeSol: number;
  /** Total number of buy trades */
  buyCount: number;
  /** Total number of sell trades */
  sellCount: number;
  /** Unique buyer wallets */
  uniqueBuyers: Set<string>;
  /** Unique seller wallets */
  uniqueSellers: Set<string>;
  /** SOL in bonding curve (virtual) */
  vSolInBondingCurve: number;
  /** Tokens in bonding curve (virtual) */
  vTokensInBondingCurve: number;
  /** Price history: [timestamp, priceSol][] */
  priceHistory: [number, number][];
  /** Developer wallet address */
  devWallet: string;
  /** Whether the dev has sold any tokens */
  devHasSold: boolean;
  /** Bonding curve progress (0–1, 1 = about to migrate to Raydium) */
  bondingCurveProgress: number;
  /** Last update timestamp */
  lastUpdated: number;
  /** Individual trade records for analysis window */
  recentTrades: TradeRecord[];
}

export interface TradeRecord {
  txType: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  trader: string;
  timestamp: number;
  marketCapSol: number;
}

/** Signal score output from the signal engine */
export interface TokenSignal {
  mint: string;
  symbol: string;
  name: string;
  /** Overall score 0–100 */
  score: number;
  /** Individual factor scores */
  factors: SignalFactors;
  /** Recommended action */
  action: "buy" | "skip";
  /** Suggested position size in SOL */
  suggestedSizeSol: number;
  /** Timestamp of signal generation */
  timestamp: number;
}

export interface SignalFactors {
  volumeScore: number;
  buyPressureScore: number;
  uniqueBuyersScore: number;
  marketCapVelocityScore: number;
  devBehaviorScore: number;
  antiRugScore: number;
  bondingCurveScore: number;
  ageScore: number;
}

/** Represents an open or closed trading position */
export interface Position {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  /** SOL spent to buy */
  entrySol: number;
  /** Token amount received */
  tokenAmount: number;
  /** Price at entry (SOL per token) */
  entryPrice: number;
  /** Current estimated price (SOL per token) */
  currentPrice: number;
  /** Highest price seen since entry */
  peakPrice: number;
  /** Unrealized P&L in SOL */
  unrealizedPnlSol: number;
  /** Unrealized P&L as percentage */
  unrealizedPnlPct: number;
  /** Position status */
  status: "open" | "partial-exit" | "closed";
  /** How much of the original position remains (0–1) */
  remainingRatio: number;
  /** Total SOL received from sells */
  totalExitSol: number;
  /** Realized P&L in SOL (from partial/full exits) */
  realizedPnlSol: number;
  /** Entry timestamp */
  openedAt: number;
  /** Close timestamp (if closed) */
  closedAt?: number;
  /** Exit reason */
  exitReason?: ExitReason;
  /** Transaction signatures */
  entryTxSignature?: string;
  exitTxSignatures: string[];
  /** Trailing stop price (SOL per token) */
  trailingStopPrice: number;
  /** Whether this position was opened in dry-run mode */
  dryRun?: boolean;
}

export type ExitReason =
  | "take-profit-1"
  | "take-profit-2"
  | "stop-loss"
  | "trailing-stop"
  | "volume-death"
  | "sell-pressure"
  | "age-timeout"
  | "smart-money-sell"
  | "early-momentum-fail"
  | "stagnation"
  | "manual";

/** Trade execution request */
export interface TradeRequest {
  action: "buy" | "sell";
  mint: string;
  /** For buy: SOL amount. For sell: token amount or "all" */
  amount: number | "all";
  /** Slippage tolerance in percent */
  slippagePct: number;
  /** Priority fee in SOL */
  priorityFeeSol: number;
}

/** Trade execution result */
export interface TradeResult {
  success: boolean;
  signature?: string;
  solAmount?: number;
  tokenAmount?: number;
  error?: string;
}

/** Scanner state persisted to disk */
export interface ScannerState {
  /** Whether the scanner is actively running */
  running: boolean;
  /** Total trades executed */
  totalTrades: number;
  /** Total realized P&L in SOL */
  totalRealizedPnlSol: number;
  /** Win rate (0–1) */
  winRate: number;
  /** Number of winning trades */
  wins: number;
  /** Number of losing trades */
  losses: number;
  /** Highest single trade P&L */
  bestTradePnlSol: number;
  /** Worst single trade P&L */
  worstTradePnlSol: number;
  /** Scanner start time */
  startedAt?: number;
  /** Last activity timestamp */
  lastActivityAt?: number;
}
