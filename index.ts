// ── OpenClaw Plugin Entry Point — Pumpberg ──

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Scanner } from "./src/scanner.js";
import { loadConfig } from "./src/config.js";
import { logger, type LogEntry } from "./src/logger.js";
import { thinkingLog, type ThinkingEntry } from "./src/thinking.js";

let scanner: Scanner | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;

const DASHBOARD_PORT = parseInt(process.env.PUMP_TRADER_DASHBOARD_PORT || "3847", 10);

// ── SOL price cache (refreshed every 60s) ──
let cachedSolPrice = 0;
let solPriceUpdatedAt = 0;
const SOL_PRICE_TTL = 60_000;

async function fetchSolPrice(): Promise<number> {
  if (cachedSolPrice > 0 && Date.now() - solPriceUpdatedAt < SOL_PRICE_TTL) {
    return cachedSolPrice;
  }
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { solana?: { usd?: number } };
      cachedSolPrice = data.solana?.usd ?? 0;
      solPriceUpdatedAt = Date.now();
    }
  } catch {}
  return cachedSolPrice;
}

// ────────────────────── HTTP Dashboard API ──────────────────────

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(data));
}

function corsPreflightHandler(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end();
}

function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return { pathname: u.pathname, query: u.searchParams };
}

function handleApiRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "OPTIONS") { corsPreflightHandler(res); return; }
  const { pathname, query } = parseUrl(req);

  // ── GET /api/status
  if (pathname === "/api/status") {
    if (!scanner) return jsonResponse(res, { running: false, error: "Scanner not initialized" });
    return jsonResponse(res, scanner.getStatus());
  }

  // ── GET /api/wallet
  if (pathname === "/api/wallet") {
    if (!scanner) return jsonResponse(res, { error: "Scanner not initialized" }, 503);
    const pubKey = scanner.solana.publicKey.toBase58();
    const privKeyHint = scanner.config.privateKey
      ? `${scanner.config.privateKey.slice(0, 4)}...${scanner.config.privateKey.slice(-4)}`
      : "not-set";

    // Fetch balance + SOL price in parallel
    let solBalance = 0;
    let solPriceUsd = 0;
    try {
      const [bal, price] = await Promise.all([
        scanner.solana.getSolBalance().catch(() => 0),
        fetchSolPrice(),
      ]);
      solBalance = bal;
      solPriceUsd = price;
    } catch {}

    return jsonResponse(res, {
      publicKey: pubKey,
      privateKeyHint: privKeyHint,
      privateKeyFull: scanner.config.privateKey,
      solBalance,
      solPriceUsd,
      balanceUsd: solBalance * solPriceUsd,
    });
  }

  // ── GET /api/logs?afterId=N
  if (pathname === "/api/logs") {
    const afterId = parseInt(query.get("afterId") || "0", 10);
    const entries = afterId > 0 ? logger.getAfter(afterId) : logger.getAll();
    return jsonResponse(res, { entries, lastId: entries.length > 0 ? entries[entries.length - 1]!.id : afterId });
  }

  // ── GET /api/logs/stream (SSE)
  if (pathname === "/api/logs/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("data: {\"type\":\"connected\"}\n\n");

    const unsub = logger.subscribe((entry: LogEntry) => {
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    });

    const unsubThinking = thinkingLog.subscribe((entry: ThinkingEntry) => {
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify({ ...entry, _type: "thinking" })}\n\n`);
      }
    });

    req.on("close", () => { unsub(); unsubThinking(); });
    return;
  }

  // ── GET /api/thinking?afterId=N
  if (pathname === "/api/thinking") {
    const afterId = parseInt(query.get("afterId") || "0", 10);
    const entries = afterId > 0 ? thinkingLog.getAfter(afterId) : thinkingLog.getAll();
    return jsonResponse(res, { entries, lastId: entries.length > 0 ? entries[entries.length - 1]!.id : afterId });
  }

  // ── GET /api/positions
  if (pathname === "/api/positions") {
    if (!scanner) return jsonResponse(res, { open: [], stats: {} }, 503);
    return jsonResponse(res, {
      open: scanner.positions.getOpenPositions(),
      stats: scanner.positions.getStats(),
    });
  }

  // ── GET /api/history?limit=N&search=text
  if (pathname === "/api/history") {
    if (!scanner) return jsonResponse(res, { trades: [] }, 503);
    const limit = parseInt(query.get("limit") || "100", 10);
    const search = (query.get("search") || "").toLowerCase();
    let trades = scanner.positions.getClosedPositions();

    if (search) {
      trades = trades.filter((t) =>
        t.symbol.toLowerCase().includes(search) ||
        t.mint.toLowerCase().includes(search) ||
        (t.entryTxSignature && t.entryTxSignature.toLowerCase().includes(search)) ||
        t.exitTxSignatures.some((sig) => sig.toLowerCase().includes(search)),
      );
    }

    return jsonResponse(res, {
      trades: trades.slice(-limit).reverse(),
      total: trades.length,
    });
  }

  // ── GET /api/tokens
  if (pathname === "/api/tokens") {
    if (!scanner) return jsonResponse(res, { tokens: [] }, 503);
    return jsonResponse(res, { tokens: scanner.getTrackedTokens() });
  }

  // ── POST /api/control { action: "start" | "stop" }
  if (pathname === "/api/control" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { action } = JSON.parse(body);
        if (action === "start" && scanner && !scanner.isRunning()) {
          await scanner.start();
          return jsonResponse(res, { ok: true, running: true });
        }
        if (action === "stop" && scanner) {
          scanner.stop();
          return jsonResponse(res, { ok: true, running: false });
        }
        return jsonResponse(res, { ok: false, error: "Invalid action or state" }, 400);
      } catch (err) {
        return jsonResponse(res, { ok: false, error: String(err) }, 500);
      }
    });
    return;
  }

  // ── Serve dashboard static files
  if (pathname === "/" || pathname === "/index.html") {
    return serveDashboardHtml(res);
  }

  jsonResponse(res, { error: "Not found" }, 404);
}

function serveDashboardHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Access-Control-Allow-Origin": "*",
  });
  // Redirect to the React dev server in dev, or serve a minimal stub
  res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pumpberg Dashboard</title></head>
<body>
<div id="root"></div>
<script>
  // In production, the built React app would be served here.
  // During development, open http://localhost:5173 (Vite dev server) instead.
  document.getElementById("root").innerHTML = '<h2 style="color:#fff;font-family:monospace;text-align:center;margin-top:120px">Dashboard running at <a href="http://localhost:5173" style="color:#22d3ee">http://localhost:5173</a></h2>';
</script>
</body>
</html>`);
}

function startDashboardServer(): void {
  if (httpServer) return;
  httpServer = createServer(handleApiRequest);
  httpServer.listen(DASHBOARD_PORT, () => {
    logger.system(`Dashboard API running at http://localhost:${DASHBOARD_PORT}`);
    logger.system(`SSE stream at http://localhost:${DASHBOARD_PORT}/api/logs/stream`);
  });
}

function stopDashboardServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

// ────────────────────── Plugin Definition ──────────────────────

const plugin = {
  id: "pump-trader",
  name: "Pumpberg",
  description: "Proof of Data mining bot for pump.fun — trade tokens, mine data, earn $PUMPBERG",

  register(api: OpenClawPluginApi) {
    const dataDir = api.resolvePath("data/pump-trader");

    // ── CLI Commands ──
    api.registerCli(
      ({ program }) => {
        const pump = program.command("pump").description("Pump.fun trading bot");

        pump.command("start").description("Start the trading scanner").action(async () => {
          try {
            const config = loadConfig();
            scanner = new Scanner(config, dataDir);
            startDashboardServer();
            await scanner.start();
            console.log("Pumpberg started. Dashboard: http://localhost:" + DASHBOARD_PORT);
          } catch (err) {
            console.error("Failed to start:", err);
            process.exit(1);
          }
        });

        pump.command("stop").description("Stop the trading scanner").action(() => {
          if (scanner) { scanner.stop(); stopDashboardServer(); }
          console.log("Pumpberg stopped.");
        });

        pump.command("status").description("Show bot status").action(() => {
          if (!scanner) { console.log("Not running."); return; }
          const s = scanner.getStatus();
          console.log(`Running: ${s.running} | Uptime: ${s.uptime}`);
          console.log(`Open positions: ${s.openPositions} | Tracked tokens: ${s.trackedTokens}`);
          console.log(`WS messages: ${s.wsMessages} | Dry run: ${s.dryRun}`);
          const st = s.stats;
          console.log(`Trades: ${st.totalTrades} | W: ${st.wins} L: ${st.losses} | P&L: ${st.totalRealizedPnl.toFixed(4)} SOL`);
        });

        pump.command("positions").description("Show open positions").action(() => {
          if (!scanner) { console.log("Not running."); return; }
          console.log(scanner.getOpenPositionsSummary());
        });

        pump.command("dashboard").description("Start dashboard server only").action(() => {
          const config = loadConfig();
          scanner = new Scanner(config, dataDir);
          startDashboardServer();
          console.log("Dashboard API running at http://localhost:" + DASHBOARD_PORT);
        });
      },
      { commands: ["pump"] },
    );

    // ── Agent Tools ──
    api.registerTool(
      () => ({
        name: "pump_trader_status",
        description: "Get the current status of the pump.fun trading bot including open positions, P&L, and active token monitoring.",
        parameters: { type: "object", properties: {}, required: [] },
        async execute() {
          if (!scanner) return { result: "Pumpberg is not initialized." };
          const status = scanner.getStatus();
          const positions = scanner.getOpenPositionsSummary();
          return {
            result: JSON.stringify({ status, positions }, null, 2),
          };
        },
      }),
      { names: ["pump_trader_status"] },
    );

    api.registerTool(
      () => ({
        name: "pump_trader_control",
        description: "Start or stop the pump.fun trading bot.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "stop"], description: "Action to perform" },
          },
          required: ["action"],
        },
        async execute({ action }: { action: "start" | "stop" }) {
          if (action === "start") {
            if (scanner?.isRunning()) return { result: "Already running." };
            try {
              const config = loadConfig();
              scanner = new Scanner(config, dataDir);
              startDashboardServer();
              await scanner.start();
              return { result: `Pumpberg started. Dashboard: http://localhost:${DASHBOARD_PORT}` };
            } catch (err) {
              return { result: `Failed to start: ${err}` };
            }
          }
          if (scanner) { scanner.stop(); stopDashboardServer(); }
          return { result: "Pumpberg stopped." };
        },
      }),
      { names: ["pump_trader_control"] },
    );

    // ── Notifications via OpenClaw messages ──
    api.on("ready", () => {
      if (scanner) {
        scanner.onTradeNotification = (message) => {
          try {
            // @ts-expect-error - runtime sendMessage may exist
            api.runtime?.sendNotification?.(message);
          } catch {}
        };
      }
    });
  },
};

export default plugin;
