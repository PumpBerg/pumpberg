// ── Risk manager: enforces position limits, exposure caps, and wallet safety ──

import type { PumpTraderConfig } from "./config.js";
import type { PositionManager } from "./position-manager.js";
import type { SolanaClient } from "./solana.js";
import type { TokenSignal } from "./types.js";

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  adjustedSizeSol?: number;
}

/**
 * Gatekeeper that decides whether a trade is allowed based on:
 * - Concurrent position limit
 * - Total SOL exposure limit
 * - Wallet reserve requirement
 * - Per-token duplicate check
 * - Cooldown after losses
 */
export class RiskManager {
  private recentLosses = 0;
  private lastLossTimestamp = 0;
  private readonly LOSS_COOLDOWN_MS = 30_000; // 30s cooldown after 3 consecutive losses
  private readonly MAX_CONSECUTIVE_LOSSES = 3;

  constructor(
    private readonly config: PumpTraderConfig,
    private readonly positions: PositionManager,
    private readonly solana: SolanaClient,
  ) {}

  /** Check if a buy trade is allowed */
  async checkBuy(signal: TokenSignal): Promise<RiskCheckResult> {
    // ── Already holding this token? ──
    if (this.positions.hasPosition(signal.mint)) {
      return { allowed: false, reason: `Already holding ${signal.symbol}` };
    }

    // ── Max concurrent positions ──
    const openCount = this.positions.getOpenPositionCount();
    if (openCount >= this.config.maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `Max concurrent positions reached (${openCount}/${this.config.maxConcurrentPositions})`,
      };
    }

    // ── Total exposure limit ──
    const currentExposure = this.positions.getTotalExposureSol();
    const remainingExposure = this.config.maxTotalExposureSol - currentExposure;
    if (remainingExposure <= 0.001) {
      return {
        allowed: false,
        reason: `Max total exposure reached (${currentExposure.toFixed(4)} SOL)`,
      };
    }

    // ── Wallet balance check (dynamic gas reserve for selling open positions) ──
    const balance = await this.solana.getSolBalance();
    // Reserve enough gas to sell ALL open positions + the one we're about to buy
    // Each sell tx needs: priorityFee + ~0.005 SOL (base tx fee + rent buffer)
    const sellGasPerPosition = this.config.priorityFeeSol + 0.005;
    const positionsAfterBuy = openCount + 1;
    const gasReserve = positionsAfterBuy * sellGasPerPosition;
    const totalReserve = Math.max(this.config.reserveSol, gasReserve);
    const required = signal.suggestedSizeSol + this.config.priorityFeeSol + totalReserve;
    if (balance < required) {
      // Try a smaller position
      const maxAffordable = balance - this.config.priorityFeeSol - totalReserve;
      if (maxAffordable < 0.01) {
        return {
          allowed: false,
          reason: `Insufficient SOL balance (${balance.toFixed(4)} SOL, need ${required.toFixed(4)} SOL)`,
        };
      }
      // Adjust size down
      const adjustedSize = Math.min(maxAffordable, remainingExposure, signal.suggestedSizeSol);
      if (adjustedSize < 0.01) {
        return { allowed: false, reason: "Adjusted position size too small" };
      }
      return { allowed: true, adjustedSizeSol: adjustedSize };
    }

    // ── Loss cooldown ──
    if (this.recentLosses >= this.MAX_CONSECUTIVE_LOSSES) {
      const elapsed = Date.now() - this.lastLossTimestamp;
      if (elapsed < this.LOSS_COOLDOWN_MS) {
        const remaining = Math.ceil((this.LOSS_COOLDOWN_MS - elapsed) / 1_000);
        return {
          allowed: false,
          reason: `Loss cooldown active (${this.recentLosses} consecutive losses, ${remaining}s remaining)`,
        };
      }
      // Cooldown expired, reset
      this.recentLosses = 0;
    }

    // ── Cap to remaining exposure ──
    const finalSize = Math.min(signal.suggestedSizeSol, remainingExposure);

    return { allowed: true, adjustedSizeSol: finalSize };
  }

  /** Record a trade result for cooldown tracking */
  recordTradeResult(profit: boolean): void {
    if (profit) {
      this.recentLosses = 0;
    } else {
      this.recentLosses++;
      this.lastLossTimestamp = Date.now();
    }
  }

  /** Get current risk status summary */
  getStatus(): {
    openPositions: number;
    maxPositions: number;
    currentExposureSol: number;
    maxExposureSol: number;
    consecutiveLosses: number;
    inCooldown: boolean;
  } {
    const inCooldown =
      this.recentLosses >= this.MAX_CONSECUTIVE_LOSSES &&
      Date.now() - this.lastLossTimestamp < this.LOSS_COOLDOWN_MS;

    return {
      openPositions: this.positions.getOpenPositionCount(),
      maxPositions: this.config.maxConcurrentPositions,
      currentExposureSol: this.positions.getTotalExposureSol(),
      maxExposureSol: this.config.maxTotalExposureSol,
      consecutiveLosses: this.recentLosses,
      inCooldown,
    };
  }
}
