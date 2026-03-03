// -- Trade execution via PumpPortal local-transaction API --

import type { PumpTraderConfig } from "./config.js";
import type { SolanaClient } from "./solana.js";
import type { TradeRequest, TradeResult } from "./types.js";
import { logger } from "./logger.js";

const PUMPPORTAL_TRADE_URL = "https://pumpportal.fun/api/trade-local";

export class Trader {
  constructor(
    private readonly solana: SolanaClient,
    private readonly config: PumpTraderConfig,
  ) {}

  async buy(mint: string, solAmount: number): Promise<TradeResult> {
    logger.trade(`Initiating BUY: ${solAmount.toFixed(4)} SOL -> ${mint.slice(0, 12)}...`, {
      action: "buy", mint, solAmount, slippage: this.config.buySlippagePct,
    });
    return this.executeTrade({
      action: "buy", mint, amount: solAmount,
      slippagePct: this.config.buySlippagePct,
      priorityFeeSol: this.config.priorityFeeSol,
    });
  }

  async sell(mint: string, tokenAmount: number | "all"): Promise<TradeResult> {
    // In dry-run mode, skip balance checks -- we never actually hold tokens on-chain
    if (this.config.dryRun) {
      const label = tokenAmount === "all" ? "ALL" : String(tokenAmount);
      logger.trade(`DRY RUN: SELL ${label} for ${mint.slice(0, 12)}...`);
      return {
        success: true,
        signature: "dry-run-" + Date.now().toString(36),
        solAmount: 0,
        tokenAmount: 0,
      };
    }

    let amount: number | string;
    if (tokenAmount === "all") {
      // Always send "100%" to PumpPortal -- it handles the balance lookup
      // server-side and works regardless of token program (SPL / Token-2022).
      const balance = await this.solana.getTokenBalance(mint);
      if (balance > 0) {
        logger.trade(`Initiating SELL ALL (${balance.toFixed(0)} tokens) for ${mint.slice(0, 12)}...`);
      } else {
        logger.trade(`Initiating SELL ALL for ${mint.slice(0, 12)}... (local balance=0, trying PumpPortal)`);
      }
      amount = "100%";
    } else {
      amount = tokenAmount;
      logger.trade(`Initiating SELL ${tokenAmount} tokens for ${mint.slice(0, 12)}...`);
    }

    return this.executeTrade({
      action: "sell", mint, amount: amount as number,
      slippagePct: this.config.sellSlippagePct,
      priorityFeeSol: this.config.priorityFeeSol,
    });
  }

  async sellPortion(mint: string, ratio: number): Promise<TradeResult> {
    // In dry-run mode, skip balance check -- simulate the sell
    if (this.config.dryRun) {
      logger.trade(`DRY RUN: Selling ${(ratio * 100).toFixed(0)}% of ${mint.slice(0, 12)}...`);
      return {
        success: true,
        signature: "dry-run-" + Date.now().toString(36),
        solAmount: 0,
        tokenAmount: 0,
      };
    }

    const balance = await this.solana.getTokenBalance(mint);
    if (balance <= 0) {
      logger.warn("TRADE", `Sell portion aborted: no tokens for ${mint.slice(0, 12)}...`);
      return { success: false, error: "No tokens to sell" };
    }
    const amount = Math.floor(balance * ratio);
    if (amount <= 0) return { success: false, error: "Amount too small" };
    logger.trade(`Selling ${(ratio * 100).toFixed(0)}% (${amount} tokens) of ${mint.slice(0, 12)}...`);
    return this.sell(mint, amount);
  }

  private async executeTrade(request: TradeRequest): Promise<TradeResult> {
    const startTime = Date.now();

    if (this.config.dryRun) {
      logger.trade(`DRY RUN: ${request.action} ${request.amount} on ${request.mint.slice(0, 12)}...`);
      return {
        success: true, signature: "dry-run-" + Date.now().toString(36),
        solAmount: typeof request.amount === "number" ? request.amount : 0, tokenAmount: 0,
      };
    }

    try {
      // Step 1: Get unsigned transaction from PumpPortal
      const body: Record<string, unknown> = {
        publicKey: this.solana.publicKey.toBase58(),
        action: request.action,
        mint: request.mint,
        amount: request.amount,
        denominatedInSol: request.action === "buy" ? "true" : "false",
        slippage: request.slippagePct,
        priorityFee: request.priorityFeeSol,
        pool: "auto",
      };

      logger.api(`POST ${PUMPPORTAL_TRADE_URL}`, { body });

      const response = await fetch(PUMPPORTAL_TRADE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error("API", `PumpPortal trade API error: HTTP ${response.status}`, {
          status: response.status, body: errText,
        });
        return { success: false, error: `PumpPortal API error (${response.status}): ${errText}` };
      }

      const txData = await response.arrayBuffer();
      const serializedTx = new Uint8Array(txData);
      const apiLatency = Date.now() - startTime;
      logger.api(`Received unsigned tx (${serializedTx.length} bytes) in ${apiLatency}ms`);

      // Step 2+3: Buys use aggressive sign-send-confirm with retry-resend.
      // Sells use fire-and-forget send with background confirmation.
      if (request.action === "buy") {
        logger.trade(`Signing and sending buy tx (with retry-resend)...`);
        const { confirmed, signature } = await this.solana.signSendAndConfirm(serializedTx, 30_000);
        const totalLatency = Date.now() - startTime;
        if (confirmed) {
          logger.trade(`Buy CONFIRMED in ${totalLatency}ms: ${signature}`, {
            signature, latencyMs: totalLatency, action: request.action,
          });
        } else {
          logger.warn("TRADE", `Buy NOT confirmed (tx may have failed): ${signature}`, {
            signature, latencyMs: totalLatency,
          });
          return { success: false, error: "Transaction not confirmed" };
        }

        return {
          success: true, signature,
          solAmount: typeof request.amount === "number" ? request.amount : undefined,
        };
      } else {
        // Sells: sign+send once, confirm in background
        logger.trade(`Signing and broadcasting sell tx...`);
        const signStart = Date.now();
        const signature = await this.solana.signAndSendTransaction(serializedTx);
        const sendLatency = Date.now() - signStart;
        logger.trade(`Sell tx broadcast: ${signature} (${sendLatency}ms)`, { signature });

        this.solana.confirmTransaction(signature, 25_000).then((confirmed) => {
          const totalLatency = Date.now() - startTime;
          if (confirmed) {
            logger.trade(`Sell confirmed in ${totalLatency}ms: ${signature}`);
          } else {
            logger.warn("TRADE", `Sell tx not confirmed (may still land): ${signature}`);
          }
        }).catch(() => {});

        return {
          success: true, signature,
          solAmount: typeof request.amount === "number" ? request.amount : undefined,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const latency = Date.now() - startTime;
      logger.error("TRADE", `Trade execution failed after ${latency}ms: ${message}`, {
        action: request.action, mint: request.mint, error: message,
      });
      return { success: false, error: message };
    }
  }

  async canAffordBuy(solAmount: number, openPositionCount: number = 0): Promise<boolean> {
    const balance = await this.solana.getSolBalance();
    // Reserve enough gas to sell all open positions + the new one
    const sellGasPerPosition = this.config.priorityFeeSol + 0.005;
    const gasReserve = (openPositionCount + 1) * sellGasPerPosition;
    const totalReserve = Math.max(this.config.reserveSol, gasReserve);
    const required = solAmount + this.config.priorityFeeSol + totalReserve;
    const canAfford = balance >= required;
    if (!canAfford) {
      logger.debug("TRADE", `Cannot afford buy: balance=${balance.toFixed(4)}, required=${required.toFixed(4)} (gas reserve=${gasReserve.toFixed(4)} for ${openPositionCount + 1} positions)`);
    }
    return canAfford;
  }
}
