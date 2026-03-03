// ── pump.fun real-time data client (PumpPortal WebSocket + REST) ──

import { EventEmitter } from "node:events";
import type { PumpTokenCreateEvent, PumpTradeEvent, PumpMigrationEvent, TokenMetrics, TradeRecord } from "./types.js";
import { logger } from "./logger.js";

const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";
const PUMP_API_BASE = "https://frontend-api-v2.pump.fun";
const PUMPPORTAL_API_BASE = "https://pumpportal.fun/api";

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface PumpApiEvents {
  tokenCreated: [PumpTokenCreateEvent];
  trade: [PumpTradeEvent];
  migration: [PumpMigrationEvent];
  metricsUpdated: [TokenMetrics];
  connected: [];
  disconnected: [];
  error: [Error];
}

export class PumpApi extends EventEmitter<PumpApiEvents> {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private intentionallyClosed = false;
  private subscribedMints = new Set<string>();
  private messageCount = 0;
  private connectionAttempts = 0;

  readonly metrics = new Map<string, TokenMetrics>();
  private retentionMs: number;

  constructor(retentionMs = 600_000) {
    super();
    this.retentionMs = retentionMs;
  }

  connect(): void {
    this.intentionallyClosed = false;
    logger.system("Connecting to PumpPortal WebSocket...", { url: PUMPPORTAL_WS_URL });
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.system("Disconnected from PumpPortal WebSocket");
  }

  private openSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    this.connectionAttempts++;
    const attempt = this.connectionAttempts;
    logger.api(`WebSocket connection attempt #${attempt}`, { url: PUMPPORTAL_WS_URL });

    const ws = new WebSocket(PUMPPORTAL_WS_URL);

    ws.addEventListener("open", () => {
      this.reconnectDelay = RECONNECT_DELAY_MS;
      logger.system("✅ WebSocket connected to PumpPortal", { attempt, subscribedMints: this.subscribedMints.size });

      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      logger.api("Subscribed to new token creation + migration events");

      if (this.subscribedMints.size > 0) {
        const mints = [...this.subscribedMints];
        ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
        logger.api(`Re-subscribed to ${mints.length} token trade feeds`);
      }

      // Re-subscribe to tracked account feeds (smart money wallets)
      if (this.subscribedAccounts.size > 0) {
        const accounts = [...this.subscribedAccounts];
        ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys: accounts }));
        logger.api(`Re-subscribed to ${accounts.length} account trade feeds (smart money)`);
      }

      this.emit("connected");
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        this.messageCount++;
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(raw);
        this.handleMessage(msg);
      } catch (err) {
        logger.error("WS", `Failed to parse message: ${err}`);
        this.emit("error", new Error(`Parse error: ${err}`));
      }
    });

    ws.addEventListener("close", () => {
      logger.warn("WS", "WebSocket disconnected", { messagesReceived: this.messageCount, intentional: this.intentionallyClosed });
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      logger.error("WS", `WebSocket error on attempt #${attempt}`);
      this.emit("error", new Error("WebSocket error"));
    });

    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || this.reconnectTimer) return;
    logger.system(`Reconnecting in ${(this.reconnectDelay / 1000).toFixed(1)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const txType = msg.txType as string | undefined;

    // Migration events may not have txType — they come from subscribeMigration
    if (msg.mint && (msg.pool || msg.signature) && !txType) {
      // Looks like a migration event
      const event = msg as unknown as PumpMigrationEvent;
      if (event.mint) {
        const metrics = this.metrics.get(event.mint);
        logger.info("TOKEN", `🎓 Token MIGRATED: ${metrics?.symbol || (event.mint as string).slice(0, 8)} → Raydium`, {
          mint: event.mint, signature: event.signature,
        });
        this.emit("migration", event);
      }
      return;
    }

    if (!txType) return;

    if (txType === "create") {
      const event = msg as unknown as PumpTokenCreateEvent;
      // Guard against malformed create events from the WS API
      if (!event.mint || !event.symbol) {
        logger.warn("WS", `Malformed create event — missing mint or symbol`);
        return;
      }
      this.initializeMetrics(event);
      logger.info("TOKEN", `🆕 New token: ${event.name} ($${event.symbol}) — ${event.mint.slice(0, 12)}...`, {
        mint: event.mint, symbol: event.symbol, name: event.name,
        initialBuy: event.initialBuy, solAmount: event.solAmount,
        marketCapSol: event.marketCapSol, devWallet: event.traderPublicKey,
      });
      this.emit("tokenCreated", event);
      this.subscribeToToken(event.mint);
    } else if (txType === "buy" || txType === "sell") {
      const event = msg as unknown as PumpTradeEvent;
      // Guard against malformed trade events
      if (!event.mint) return;
      this.updateMetrics(event);
      this.emit("trade", event);
    }
  }

  subscribeToToken(mint: string): void {
    if (this.subscribedMints.has(mint)) return;
    this.subscribedMints.add(mint);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
      logger.debug("WS", `Subscribed to trades: ${mint.slice(0, 12)}...`);
    }
  }

  unsubscribeFromToken(mint: string): void {
    this.subscribedMints.delete(mint);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
      logger.debug("WS", `Unsubscribed: ${mint.slice(0, 12)}...`);
    }
  }

  // ── Account trade subscriptions (for smart money tracking) ──
  private subscribedAccounts = new Set<string>();

  subscribeToAccounts(wallets: string[]): void {
    const newWallets = wallets.filter((w) => !this.subscribedAccounts.has(w));
    if (newWallets.length === 0) return;
    for (const w of newWallets) this.subscribedAccounts.add(w);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys: newWallets }));
      logger.api(`Subscribed to ${newWallets.length} account trade feed(s) (smart money)`);
    }
  }

  unsubscribeFromAccounts(wallets: string[]): void {
    for (const w of wallets) this.subscribedAccounts.delete(w);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && wallets.length > 0) {
      this.ws.send(JSON.stringify({ method: "unsubscribeAccountTrade", keys: wallets }));
      logger.api(`Unsubscribed from ${wallets.length} account trade feed(s)`);
    }
  }

  getSubscribedAccounts(): string[] {
    return [...this.subscribedAccounts];
  }

  private initializeMetrics(event: PumpTokenCreateEvent): void {
    const now = Date.now();
    const price = event.vTokensInBondingCurve > 0 ? event.vSolInBondingCurve / event.vTokensInBondingCurve : 0;
    const MIGRATION_THRESHOLD_SOL = 85;
    const progress = Math.min(1, event.vSolInBondingCurve / MIGRATION_THRESHOLD_SOL);

    this.metrics.set(event.mint, {
      mint: event.mint, name: event.name, symbol: event.symbol,
      createdAt: now, marketCapSol: event.marketCapSol,
      totalVolumeSol: event.solAmount, recentVolumeSol: event.solAmount,
      buyCount: event.initialBuy > 0 ? 1 : 0, sellCount: 0,
      uniqueBuyers: new Set(event.initialBuy > 0 ? [event.traderPublicKey] : []),
      uniqueSellers: new Set(),
      vSolInBondingCurve: event.vSolInBondingCurve,
      vTokensInBondingCurve: event.vTokensInBondingCurve,
      priceHistory: [[now, price]],
      devWallet: event.traderPublicKey, devHasSold: false,
      bondingCurveProgress: progress, lastUpdated: now, recentTrades: [],
    });
  }

  private updateMetrics(event: PumpTradeEvent): void {
    const now = Date.now();
    let metrics = this.metrics.get(event.mint);

    if (!metrics) {
      const price = event.vTokensInBondingCurve > 0 ? event.vSolInBondingCurve / event.vTokensInBondingCurve : 0;
      metrics = {
        mint: event.mint, name: "", symbol: "", createdAt: now - 60_000,
        marketCapSol: event.marketCapSol, totalVolumeSol: 0, recentVolumeSol: 0,
        buyCount: 0, sellCount: 0, uniqueBuyers: new Set(), uniqueSellers: new Set(),
        vSolInBondingCurve: event.vSolInBondingCurve,
        vTokensInBondingCurve: event.vTokensInBondingCurve,
        priceHistory: [[now, price]], devWallet: "", devHasSold: false,
        bondingCurveProgress: 0, lastUpdated: now, recentTrades: [],
      };
      this.metrics.set(event.mint, metrics);
    }

    const price = event.vTokensInBondingCurve > 0 ? event.vSolInBondingCurve / event.vTokensInBondingCurve : 0;
    metrics.marketCapSol = event.marketCapSol;
    metrics.totalVolumeSol += event.solAmount;
    metrics.vSolInBondingCurve = event.vSolInBondingCurve;
    metrics.vTokensInBondingCurve = event.vTokensInBondingCurve;
    metrics.priceHistory.push([now, price]);
    metrics.lastUpdated = now;
    metrics.bondingCurveProgress = Math.min(1, event.vSolInBondingCurve / 85);

    const trade: TradeRecord = {
      txType: event.txType, solAmount: event.solAmount,
      tokenAmount: event.tokenAmount, trader: event.traderPublicKey,
      timestamp: now, marketCapSol: event.marketCapSol,
    };
    metrics.recentTrades.push(trade);

    if (event.txType === "buy") {
      metrics.buyCount++;
      metrics.uniqueBuyers.add(event.traderPublicKey);
    } else {
      metrics.sellCount++;
      metrics.uniqueSellers.add(event.traderPublicKey);
      if (event.traderPublicKey === metrics.devWallet) {
        metrics.devHasSold = true;
        logger.warn("TOKEN", `⚠️ DEV SOLD: ${metrics.symbol || event.mint.slice(0, 8)}`, {
          mint: event.mint, solAmount: event.solAmount,
        });
      }
    }

    const cutoff = now - 60_000;
    metrics.recentVolumeSol = metrics.recentTrades
      .filter((t) => t.timestamp >= cutoff)
      .reduce((sum, t) => sum + t.solAmount, 0);

    const retentionCutoff = now - this.retentionMs;
    metrics.recentTrades = metrics.recentTrades.filter((t) => t.timestamp >= retentionCutoff);
    metrics.priceHistory = metrics.priceHistory.filter(([ts]) => ts >= retentionCutoff);

    this.emit("metricsUpdated", metrics);
  }

  pruneStaleMetrics(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [mint] of this.metrics) {
      const m = this.metrics.get(mint)!;
      if (now - m.lastUpdated > this.retentionMs) {
        this.metrics.delete(mint);
        this.unsubscribeFromToken(mint);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.debug("WS", `Pruned ${pruned} stale metrics, ${this.metrics.size} remaining`);
    }
  }

  getMessageCount(): number { return this.messageCount; }

  static async createWallet(): Promise<{ publicKey: string; privateKey: string; apiKey: string } | null> {
    try {
      logger.api("Creating new wallet via PumpPortal...");
      const res = await fetch(`${PUMPPORTAL_API_BASE}/create-wallet`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { logger.error("API", `Wallet creation failed: HTTP ${res.status}`); return null; }
      const data = (await res.json()) as { publicKey: string; privateKey: string; apiKey: string };
      logger.api("✅ Wallet created", { publicKey: data.publicKey });
      return data;
    } catch (err) {
      logger.error("API", `Wallet creation error: ${err}`);
      return null;
    }
  }

  async fetchTokenDetails(mint: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${PUMP_API_BASE}/coins/${mint}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) { logger.warn("API", `Token details failed: HTTP ${res.status}`, { mint }); return null; }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      logger.error("API", `Token details error: ${err}`, { mint });
      return null;
    }
  }
}
