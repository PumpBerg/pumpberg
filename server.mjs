// ── Pumpberg — Standalone dashboard server ──
// Run with: npx tsx server.mjs
// No OpenClaw required — uses the real Scanner engine.

import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Global crash handlers — log errors instead of silent death ──
function logCrash(label, err) {
  const msg = err instanceof Error ? err.stack : String(err);
  console.error(`\n[FATAL] ${label}:`, msg);
  try {
    mkdirSync("data", { recursive: true });
    appendFileSync("data/crash.log", `[${new Date().toISOString()}] ${label}: ${msg}\n`);
  } catch {}
}

process.on("uncaughtException", (err) => {
  logCrash("UNCAUGHT_EXCEPTION", err);
  // Don't exit — log and continue. The server should stay alive through crashes.
  // Only truly fatal errors (like OOM) will kill the process naturally.
});

process.on("unhandledRejection", (reason) => {
  logCrash("UNHANDLED_REJECTION", reason);
  // Don't exit — just log. Unhandled rejections shouldn't kill the process.
});

// ── Import real engine modules ──
import { loadConfig, persistConfig, loadPersistedConfig } from "./src/config.ts";
import { Scanner } from "./src/scanner.ts";
import { logger } from "./src/logger.ts";
import { thinkingLog } from "./src/thinking.ts";
import { ChatAgent } from "./src/chat-agent.ts";
import { WinnerResearch } from "./src/winner-research.ts";
import { GraduateAnalyzer } from "./src/graduate-analyzer.ts";
import { initSettings, loadSettings, updateSettings, getSettingsForApi, isSetupComplete } from "./src/settings.ts";
import { loadIdentity, getWalletAddress, setWalletAddress } from "./src/identity.ts";
import { SyncClient } from "./src/sync/sync-client.ts";
import { PointsTracker } from "./src/points.ts";
import { initAuth, registerUser, loginUser, changePassword, verifyToken, extractToken, getUserByToken, getUserApiKeys, updateUserApiKeys, getAllUsers, markSetupComplete, configureAdminWithKeys } from "./src/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Initialize settings & identity ──
// Use ./data relative to the project
const DATA_DIR = resolve(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });
initSettings(DATA_DIR);
const identity = loadIdentity(DATA_DIR);

// ── Load .env early so admin credentials are available before initAuth ──
{
  const envPath = resolve(__dirname, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

initAuth(DATA_DIR);

// ── Load config (reads settings.json → .env, validates) ──
// If config is invalid (e.g. fresh install, no keys), start in SETUP MODE
// so the dashboard can load and the user can enter their credentials.
let config;
let SETUP_MODE = false;
try {
  config = loadConfig(__dirname);
} catch (err) {
  console.warn(`[config] ${err.message}`);
  console.warn("[config] Starting in SETUP MODE — dashboard will load for configuration.");
  SETUP_MODE = true;
  // Use a minimal config so the server can start
  config = {
    privateKey: "",
    rpcUrl: "",
    wsUrl: "",
    apiKey: "",
    dryRun: true,
    minPositionSizeSol: 0.05,
    maxPositionSizeSol: 0.1,
    maxConcurrentPositions: 3,
    maxTotalExposureSol: 1.0,
    stopLossPct: 0.08,
    takeProfitPct1: 0.15,
    takeProfitPct2: 0.30,
    takeProfitPct3: 0.50,
    trailingStopActivationPct: 0.12,
    trailingStopDistancePct: 0.06,
    maxPositionAgeSec: 120,
    minBuyScore: 65,
    cooldownMs: 60000,
  };
}
const PORT = parseInt(process.env.PUMP_TRADER_DASHBOARD_PORT || process.env.PORT || "3847", 10);

// ── Configure admin account with API keys from settings/env ──
// Admin gets pre-configured on first run so they don't need to complete the setup wizard
if (!SETUP_MODE) {
  const settings = loadSettings();
  configureAdminWithKeys({
    solanaPrivateKey: settings.solanaPrivateKey,
    solanaRpcUrl: settings.solanaRpcUrl,
    solanaWsUrl: settings.solanaWsUrl,
    pumpPortalApiKey: settings.pumpPortalApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    publicKey: settings.publicKey,
  });
}

// ── Apply persisted config overrides (from previous agent/user changes) ──
const SENSITIVE_KEYS = new Set(["privateKey", "pumpPortalApiKey", "anthropicApiKey", "rpcUrl", "solanaWsUrl"]);

function redactValue(key, val) {
  if (SENSITIVE_KEYS.has(key) && typeof val === "string" && val.length > 8) {
    return val.slice(0, 4) + "..." + val.slice(-4);
  }
  return val;
}

/** Strip secrets from any log message before it reaches the public API */
function sanitizeLogMessage(msg) {
  if (typeof msg !== "string") return msg;
  // Redact base58 private keys (32-88 chars of base58 after =)
  msg = msg.replace(/(privateKey[":\s=]+)[A-HJ-NP-Za-km-z1-9]{20,}/g, "$1[REDACTED]");
  // Redact API keys
  msg = msg.replace(/(api[_-]?key[":\s=]+)[^\s"',}{\]]+/gi, "$1[REDACTED]");
  msg = msg.replace(/(sk-ant-api03-)[^\s"',}{\]]+/gi, "$1[REDACTED]");
  // Redact Anthropic keys
  msg = msg.replace(/(anthropicApiKey[":\s=]+)[^\s"',}{\]]+/gi, "$1[REDACTED]");
  // Redact pumpPortalApiKey
  msg = msg.replace(/(pumpPortalApiKey[":\s=]+)[^\s"',}{\]]+/gi, "$1[REDACTED]");
  // Redact RPC URLs with api-key param
  msg = msg.replace(/api-key=[A-Za-z0-9_-]{8,}/g, "api-key=[REDACTED]");
  return msg;
}

const savedOverrides = loadPersistedConfig(DATA_DIR);
for (const [key, value] of Object.entries(savedOverrides)) {
  if (key in config && key !== "dryRun") {
    config[key] = value;
    logger.system(`Restored config: ${key} = ${redactValue(key, value)}`);
  }
}

// ── SOL price cache ──
let cachedSolPrice = 0;
let solPriceUpdatedAt = 0;

async function fetchSolPrice() {
  if (cachedSolPrice > 0 && Date.now() - solPriceUpdatedAt < 60_000) return cachedSolPrice;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      cachedSolPrice = data?.solana?.usd ?? 0;
      solPriceUpdatedAt = Date.now();
    }
  } catch {}
  return cachedSolPrice;
}

// Derive HTTPS RPC URL from WSS for balance fetch
function wsToHttp(wsUrl) {
  return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}
// These are mutable so they can be updated after setup completes
let RPC_HTTP_URL = wsToHttp(config.rpcUrl);
let PUBLIC_KEY = process.env.PUMP_TRADER_PUBLIC_KEY || "";
let PRIVATE_KEY = config.privateKey;

async function fetchSolBalance() {
  try {
    const rpcUrl = wsToHttp(config.rpcUrl) || RPC_HTTP_URL;
    const pubKey = process.env.PUMP_TRADER_PUBLIC_KEY || PUBLIC_KEY;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pubKey] }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      return (data?.result?.value ?? 0) / 1e9;
    }
  } catch (err) {
    console.error("Balance fetch error:", err.message);
  }
  return 0;
}

// ── Create Scanner & engine instances ──
// In setup mode, these will exist but won't actually trade (no keys)
let scanner, chatAgent, winnerResearch, graduateAnalyzer, tradeJournal, syncClient;
let pointsTracker = new PointsTracker(DATA_DIR);

try {
  scanner = new Scanner(config, DATA_DIR);
  chatAgent = new ChatAgent(undefined, DATA_DIR);
  winnerResearch = new WinnerResearch(DATA_DIR);
  graduateAnalyzer = new GraduateAnalyzer(DATA_DIR);
  tradeJournal = scanner.tradeJournal;

  if (!SETUP_MODE) {
    // ── Wire autonomous agent ──
    chatAgent.winnerResearch = winnerResearch;
    chatAgent.graduateAnalyzer = graduateAnalyzer;
    scanner.graduateAnalyzer = graduateAnalyzer;
    chatAgent.startAutonomousLoop(scanner, tradeJournal);

    // Start market intelligence collection
    scanner.marketIntel.start();

    // Start graduate analyzer
    graduateAnalyzer.start();
    graduateAnalyzer.seedFromApi().catch((err) => {
      console.error("Graduate seed error:", err);
    });
  } else {
    logger.system("SETUP MODE: Engine initialized but not started — configure credentials in the dashboard.");
  }
} catch (err) {
  console.error("[engine] Failed to initialize trading engine:", err.message);
  SETUP_MODE = true;
}

// ── Initialize data sync client ──
try {
  const settingsData = loadSettings();
  syncClient = new SyncClient({
    dataDir: DATA_DIR,
    instanceId: identity.instanceId,
    walletAddress: identity.walletAddress || process.env.PUMPBERG_WALLET_ADDRESS,
    serverUrl: settingsData.syncServerUrl || undefined,
    enabled: settingsData.dataSharingEnabled !== false,
  });

  if (chatAgent) {
    function attachSyncToImporter() {
      const ragImporter = chatAgent.getRAGImporter();
      if (ragImporter) {
        ragImporter.setSyncClient(syncClient);
        console.log("[sync] Attached to RAG importer");
      } else {
        setTimeout(attachSyncToImporter, 2000);
      }
    }
    attachSyncToImporter();
  }
  syncClient.start();
} catch (err) {
  console.error("[sync] Failed to initialize sync:", err.message);
}

// Notify agent after every completed trade
if (scanner && chatAgent) {
  scanner.onTradeCompleted = (symbol, pnlSol, exitReason) => {
    chatAgent.onTradeCompleted(scanner, tradeJournal, symbol, pnlSol, exitReason).catch((err) => {
      console.error("Agent trade callback error:", err);
    });
  };
}

// ── SSE clients ──
const sseClients = new Set();

// Forward logger entries to SSE clients
logger.subscribe((entry) => {
  for (const client of sseClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
  }
});

// Forward thinking entries to SSE clients
thinkingLog.subscribe((entry) => {
  for (const client of sseClients) {
    try { client.write(`data: ${JSON.stringify({ ...entry, _type: "thinking" })}\n\n`); } catch {}
  }
});

// ── HTTP helpers ──
function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
  });
  res.end(JSON.stringify(data));
}

/** Authenticate request — returns user or null */
function authenticate(req) {
  const authHeader = req.headers["authorization"];
  const token = extractToken(authHeader);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = getUserByToken(token);
  return user;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB limit
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    req.on("data", (c) => {
      totalLen += c.length;
      if (totalLen > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error("Request body too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// ── HTTP server ──
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
    });
    return res.end();
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const query = url.searchParams;

  // ── Auth endpoints (no auth required) ──
  if (path === "/api/health" || path === "/health") {
    return json(res, { ok: true, timestamp: Date.now() });
  }

  // ── Site public pages (no auth, served before API) ──
  const SITE_PUBLIC_DIR = resolve(__dirname, "site", "public");
  const SITE_MIME = {
    ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
  };

  if (existsSync(SITE_PUBLIC_DIR)) {
    // Landing page
    if (path === "/" || path === "/index.html") {
      const fp = join(SITE_PUBLIC_DIR, "index.html");
      if (existsSync(fp)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(readFileSync(fp));
      }
    }
    // Live portal
    if (path === "/live" || path === "/live.html") {
      const fp = join(SITE_PUBLIC_DIR, "live.html");
      if (existsSync(fp)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(readFileSync(fp));
      }
    }
    // Site static assets (logo, og-image, etc.) — only files in site/public/
    if (!path.startsWith("/api/") && !path.startsWith("/dashboard")) {
      const safePath = path.replace(/\.\.\//g, "");
      const assetPath = join(SITE_PUBLIC_DIR, safePath);
      if (existsSync(assetPath) && !statSync(assetPath).isDirectory()) {
        const ext = extname(assetPath);
        res.writeHead(200, { "Content-Type": SITE_MIME[ext] || "application/octet-stream" });
        return res.end(readFileSync(assetPath));
      }
    }
  }

  // ── Rate limiting for auth endpoints ──
  if (!global.__loginAttempts) global.__loginAttempts = new Map();
  const rateMap = global.__loginAttempts;
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

  if ((path === "/api/auth/login" || path === "/api/auth/register") && req.method === "POST") {
    const now = Date.now();
    const attempts = rateMap.get(clientIp) || [];
    // Keep only attempts within the last 60 seconds
    const recent = attempts.filter(t => now - t < 60_000);
    if (recent.length >= 10) {
      return json(res, { ok: false, error: "Too many attempts. Try again in a minute." }, 429);
    }
    recent.push(now);
    rateMap.set(clientIp, recent);
    // Cleanup old entries every 100 requests
    if (rateMap.size > 1000) {
      for (const [ip, times] of rateMap) {
        if (times.every(t => now - t > 120_000)) rateMap.delete(ip);
      }
    }
  }

  if (path === "/api/auth/register" && req.method === "POST") {
    // Registration is disabled — admin account is pre-created from env vars
    return json(res, { ok: false, error: "Registration is disabled. Use the admin credentials from your .env file." }, 403);
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { username, password } = body;
      const result = loginUser(username, password);
      return json(res, { ok: true, user: result.user, token: result.token });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 401);
    }
  }

  // ── PUBLIC READ-ONLY API (no auth required) ──
  if (path.startsWith("/api/public/")) {
    // CORS for live portal
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method !== "GET") { return json(res, { error: "Method not allowed" }, 405); }

    const publicPath = path.replace("/api/public/", "");

    // GET /api/public/status
    if (publicPath === "status") {
      if (SETUP_MODE || !scanner) {
        return json(res, { running: false, setupMode: true, openPositions: 0, stats: { totalTrades: 0, wins: 0, losses: 0, totalRealizedPnl: 0, winRate: 0 } });
      }
      const s = scanner.getStatus();
      return json(res, {
        running: s.running,
        uptime: s.uptime,
        tradingMode: s.tradingMode,
        openPositions: s.openPositions,
        trackedTokens: s.trackedTokens,
        dryRun: s.dryRun,
        stats: s.stats,
      });
    }

    // GET /api/public/wallet
    if (publicPath === "wallet") {
      if (SETUP_MODE) {
        return json(res, { publicKey: "", solBalance: 0, solPriceUsd: 0 });
      }
      const [solBalance, solPriceUsd] = await Promise.all([fetchSolBalance(), fetchSolPrice()]);
      return json(res, {
        publicKey: PUBLIC_KEY,
        solBalance,
        solPriceUsd,
        balanceUsd: solBalance * solPriceUsd,
      });
    }

    // GET /api/public/positions
    if (publicPath === "positions") {
      if (SETUP_MODE || !scanner) {
        return json(res, { open: [], stats: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalRealizedPnl: 0 } });
      }
      const rawStats = scanner.positions.getStats();
      const open = scanner.positions.getOpenPositions().map(p => ({
        mint: p.mint,
        symbol: p.symbol,
        entryPriceSol: p.entryPriceSol,
        currentPrice: p.currentPrice,
        entrySolAmount: p.entrySolAmount,
        remainingRatio: p.remainingRatio,
        entryTime: p.entryTime,
        unrealizedPnl: p.unrealizedPnl,
      }));
      return json(res, {
        open,
        stats: {
          totalTrades: rawStats.totalTrades,
          wins: rawStats.wins,
          losses: rawStats.losses,
          winRate: rawStats.winRate,
          totalRealizedPnl: rawStats.totalRealizedPnl,
          bestTradePnl: rawStats.bestTrade,
          worstTradePnl: rawStats.worstTrade,
        },
      });
    }

    // GET /api/public/history
    if (publicPath.startsWith("history")) {
      if (SETUP_MODE || !scanner) {
        return json(res, { trades: [], total: 0 });
      }
      const limit = parseInt(query.get("limit") || "50", 10);
      const trades = scanner.positions.getClosedPositions(200, scanner.config.dryRun).slice(0, limit).map(t => ({
        mint: t.mint,
        symbol: t.symbol,
        realizedPnlSol: t.realizedPnlSol,
        entrySolAmount: t.entrySolAmount,
        closedAt: t.closedAt || t.sellTime,
        sellTxSignature: t.sellTxSignature,
        buyTxSignature: t.buyTxSignature,
        exitReason: t.exitReason,
      }));
      return json(res, { trades, total: trades.length });
    }

    // GET /api/public/logs
    if (publicPath.startsWith("logs")) {
      const afterId = parseInt(query.get("afterId") || "0", 10);
      const entries = afterId > 0 ? logger.getAfter(afterId) : logger.getAll();
      // Strip any sensitive data from log messages — defense in depth
      const safe = entries.slice(-200).map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        category: e.category,
        message: sanitizeLogMessage(e.message),
      }));
      return json(res, { entries: safe, lastId: safe.length > 0 ? safe[safe.length - 1].id : afterId });
    }

    // GET /api/public/thinking
    if (publicPath.startsWith("thinking")) {
      const afterId = parseInt(query.get("afterId") || "0", 10);
      const entries = afterId > 0 ? thinkingLog.getAfter(afterId) : thinkingLog.getAll();
      const safe = entries.slice(-100).map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        message: e.message,
      }));
      return json(res, { entries: safe, lastId: safe.length > 0 ? safe[safe.length - 1].id : afterId });
    }

    return json(res, { error: "Not found" }, 404);
  }

  // ── Authenticate all other API requests ──
  let currentUser = authenticate(req);
  // SSE streams use query param for auth since EventSource doesn't support headers
  if (!currentUser && path === "/api/logs/stream") {
    const tokenParam = query.get("token");
    if (tokenParam) {
      const payload = verifyToken(tokenParam);
      if (payload) currentUser = getUserByToken(tokenParam);
    }
  }
  if (path.startsWith("/api/") && !currentUser) {
    return json(res, { error: "Authentication required" }, 401);
  }

  // ── Auth endpoints (auth required) ──
  if (path === "/api/auth/me") {
    const keys = getUserApiKeys(currentUser.id);
    return json(res, {
      user: {
        id: currentUser.id,
        username: currentUser.username,
        email: currentUser.email,
        role: currentUser.role,
        createdAt: currentUser.createdAt,
        lastLoginAt: currentUser.lastLoginAt,
        setupComplete: currentUser.setupComplete ?? false,
        apiKeys: {
          solanaPrivateKeySet: !!keys?.solanaPrivateKey,
          solanaRpcUrlSet: !!keys?.solanaRpcUrl,
          solanaWsUrlSet: !!keys?.solanaWsUrl,
          pumpPortalApiKeySet: !!keys?.pumpPortalApiKey,
          anthropicApiKeySet: !!keys?.anthropicApiKey,
          publicKey: keys?.publicKey || "",
        },
      },
    });
  }

  if (path === "/api/auth/change-password" && req.method === "POST") {
    try {
      const body = await readBody(req);
      changePassword(currentUser.id, body.currentPassword, body.newPassword);
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 400);
    }
  }

  if (path === "/api/auth/api-keys" && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const allowed = ["solanaPrivateKey", "solanaRpcUrl", "solanaWsUrl", "pumpPortalApiKey", "anthropicApiKey", "publicKey"];
      const updates = {};
      for (const key of allowed) {
        if (body[key] !== undefined && body[key] !== "") updates[key] = body[key];
      }
      // Save to per-user auth store (users.json)
      updateUserApiKeys(currentUser.id, updates);
      // Also sync to settings.json so loadConfig/applySettingsToEnv picks them up
      updateSettings(updates);
      return json(res, { ok: true });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 400);
    }
  }

  if (path === "/api/auth/complete-setup" && req.method === "POST") {
    try {
      markSetupComplete(currentUser.id);
      // Also mark setup complete in settings.json
      updateSettings({ setupComplete: true });

      // ── Reload config from settings.json and exit SETUP_MODE ──
      try {
        initSettings(DATA_DIR);
        const { applySettingsToEnv } = await import("./src/settings.ts");
        applySettingsToEnv(true); // force=true to overwrite empty env vars from startup
        const { loadConfig: reloadConfig } = await import("./src/config.ts");
        config = reloadConfig(__dirname);
        SETUP_MODE = false;

        // Re-configure admin account with the new keys
        const freshSettings = loadSettings();
        configureAdminWithKeys({
          solanaPrivateKey: freshSettings.solanaPrivateKey,
          solanaRpcUrl: freshSettings.solanaRpcUrl,
          solanaWsUrl: freshSettings.solanaWsUrl,
          pumpPortalApiKey: freshSettings.pumpPortalApiKey,
          anthropicApiKey: freshSettings.anthropicApiKey,
          publicKey: freshSettings.publicKey,
        });

        // Update module-level variables so /api/wallet works immediately
        PRIVATE_KEY = config.privateKey;
        PUBLIC_KEY = process.env.PUMP_TRADER_PUBLIC_KEY || freshSettings.publicKey || "";
        RPC_HTTP_URL = wsToHttp(config.rpcUrl);

        logger.system("Setup complete — config reloaded, exiting SETUP_MODE.");
        logger.system(`Wallet: ${PUBLIC_KEY || 'not-set'}`);
        logger.system(`RPC: ${config.rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
      } catch (reloadErr) {
        console.error("[setup] Config reload after setup failed:", reloadErr.message);
        // Keys are saved; a server restart will pick them up
      }

      return json(res, { ok: true });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 400);
    }
  }

  // ── Admin-only: list all users (GET only) ──
  if (path === "/api/auth/users" && req.method === "GET" && currentUser.role === "admin") {
    return json(res, { users: getAllUsers() });
  }

  // ── In SETUP MODE, only allow setup/settings/static endpoints ──
  if (SETUP_MODE && path.startsWith("/api/") &&
      !path.startsWith("/api/status") &&
      !path.startsWith("/api/settings") &&
      !path.startsWith("/api/auth") &&
      !path.startsWith("/api/setup-status") &&
      !path.startsWith("/api/wallet")) {
    return json(res, {
      error: "Server is in setup mode. Please configure your credentials in Settings first.",
      setupMode: true,
    }, 503);
  }

  // GET /api/status — real scanner status
  if (path === "/api/status") {
    if (SETUP_MODE || !scanner) {
      return json(res, {
        setupMode: true,
        running: false,
        uptime: "0s",
        tradingMode: "none",
        walletPublicKey: "",
        openPositions: 0,
        trackedTokens: 0,
        wsMessages: 0,
        dryRun: true,
        riskStatus: { consecutiveLosses: 0, coolingDown: false },
        stats: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          totalRealizedPnl: 0,
          winRate: 0,
          bestTradePnl: 0,
          worstTradePnl: 0,
        },
        config: {
          minPositionSizeSol: config.minPositionSizeSol,
          maxPositionSizeSol: config.maxPositionSizeSol,
          maxConcurrentPositions: config.maxConcurrentPositions,
          maxTotalExposureSol: config.maxTotalExposureSol,
          stopLossPct: config.stopLossPct,
          takeProfitPct1: config.takeProfitPct1,
          takeProfitPct2: config.takeProfitPct2 || 0.30,
          stagnationExitSec: 120,
          stagnationMinTrades: 3,
          tradingFeePct: 0.01,
        },
      });
    }
    return json(res, scanner.getStatus());
  }

  // GET /api/wallet
  if (path === "/api/wallet") {
    if (SETUP_MODE) {
      return json(res, {
        publicKey: "", privateKeyHint: "not-set",
        solBalance: 0, solPriceUsd: 0, balanceUsd: 0,
        totalBalanceSol: 0, positionsValueUsd: 0,
        setupMode: true,
      });
    }
    const [solBalance, solPriceUsd] = await Promise.all([fetchSolBalance(), fetchSolPrice()]);
    const privKeyHint = PRIVATE_KEY ? `${PRIVATE_KEY.slice(0, 4)}...${PRIVATE_KEY.slice(-4)}` : "not-set";
    // Calculate total portfolio value: SOL + current value of all open positions
    const openPositions = scanner.positions.getOpenPositions();
    let positionsValueSol = 0;
    for (const pos of openPositions) {
      const currentValue = pos.tokenAmount * pos.remainingRatio * pos.currentPrice;
      positionsValueSol += currentValue;
    }
    const totalBalanceSol = solBalance + positionsValueSol;
    const positionsValueUsd = positionsValueSol * solPriceUsd;
    return json(res, {
      publicKey: PUBLIC_KEY,
      privateKeyHint: privKeyHint,
      solBalance,
      solPriceUsd,
      balanceUsd: solBalance * solPriceUsd,
      totalBalanceSol,
      positionsValueUsd,
    });
  }

  // PATCH /api/config — update config at runtime
  if (path === "/api/config" && req.method === "PATCH") {
    if (SETUP_MODE || !scanner) {
      return json(res, { ok: false, error: "Server is in setup mode. Configure credentials first." }, 400);
    }
    const body = await readBody(req);
    const allowed = ["minPositionSizeSol", "maxPositionSizeSol", "maxConcurrentPositions", "maxTotalExposureSol", "stopLossPct", "takeProfitPct1", "takeProfitPct2", "stagnationExitSec", "stagnationMinTrades", "tradingFeePct", "dryRun"];
    const updated = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        if (key === "dryRun") {
          const boolVal = body[key] === true || body[key] === "true" || body[key] === "1" || body[key] === 1;
          config[key] = boolVal;
          scanner.config[key] = boolVal;
          updated[key] = boolVal;
        } else if (key === "maxConcurrentPositions" || key === "stagnationExitSec" || key === "stagnationMinTrades") {
          const intVal = parseInt(body[key], 10);
          if (!isNaN(intVal) && intVal >= 1) {
            config[key] = intVal;
            scanner.config[key] = intVal;
            updated[key] = intVal;
          }
        } else {
          const val = parseFloat(body[key]);
          if (!isNaN(val) && val >= 0) {
            config[key] = val;
            scanner.config[key] = val;
            updated[key] = val;
          }
        }
      }
    }
    // Redact secrets from the log output
    const safeUpdated = {};
    for (const [k, v] of Object.entries(updated)) {
      safeUpdated[k] = redactValue(k, v);
    }
    logger.system(`Config updated: ${JSON.stringify(safeUpdated)}`);
    persistConfig(config, DATA_DIR);
    return json(res, { ok: true, updated });
  }

  // POST /api/control — start/stop the scanner
  if (path === "/api/control" && req.method === "POST") {
    if (SETUP_MODE || !scanner) {
      return json(res, { ok: false, error: "Server is in setup mode. Configure credentials first.", running: false }, 400);
    }
    const body = await readBody(req);
    const action = body.action;
    try {
      if (action === "start" && !scanner.isRunning()) {
        await scanner.start();
        // Trigger immediate agent review so it can assess market and adjust config
        chatAgent.triggerReview();
        return json(res, { ok: true, running: true });
      } else if (action === "stop" && scanner.isRunning()) {
        scanner.stop();
        return json(res, { ok: true, running: false });
      }
      return json(res, { ok: true, running: scanner.isRunning() });
    } catch (err) {
      logger.error("CONTROL", `Failed to ${action}: ${err.message}`);
      return json(res, { ok: false, error: err.message, running: scanner.isRunning() }, 500);
    }
  }

  // POST /api/trading-mode — cycle through agent/uav/none trading modes
  if (path === "/api/trading-mode" && req.method === "POST") {
    const modes = ["agent", "uav", "none"];
    const currentIdx = modes.indexOf(scanner.tradingMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    scanner.tradingMode = nextMode;
    chatAgent.applyTradingMode(nextMode);
    logger.system(`🔄 Trading mode changed to: ${nextMode.toUpperCase()}`);
    return json(res, { ok: true, tradingMode: nextMode });
  }

  // POST /api/sell — sell a single position by mint
  if (path === "/api/sell" && req.method === "POST") {
    const body = await readBody(req);
    const mint = body.mint;
    if (!mint || typeof mint !== "string") {
      return json(res, { error: "Missing 'mint' field" }, 400);
    }
    try {
      const result = await scanner.agentSell(mint);
      if (result.success) {
        logger.info("SYSTEM", `Manual sell executed for ${mint.slice(0, 12)}...`);
      }
      return json(res, result);
    } catch (err) {
      logger.error("SYSTEM", `Manual sell failed: ${err.message}`);
      return json(res, { success: false, error: err.message }, 500);
    }
  }

  // POST /api/sell-all — liquidate all open positions
  if (path === "/api/sell-all" && req.method === "POST") {
    try {
      const result = await scanner.sellAllPositions();
      logger.info("SYSTEM", `Sell-all executed: ${result.sold} sold, ${result.failed} failed`);
      return json(res, { ok: true, ...result });
    } catch (err) {
      logger.error("SYSTEM", `Sell-all failed: ${err.message}`);
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // GET /api/logs
  if (path === "/api/logs") {
    const afterId = parseInt(query.get("afterId") || "0", 10);
    const entries = afterId > 0 ? logger.getAfter(afterId) : logger.getAll();
    return json(res, { entries, lastId: entries.length > 0 ? entries[entries.length - 1].id : afterId });
  }

  // GET /api/logs/stream (SSE)
  if (path === "/api/logs/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: {"type":"connected"}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // GET /api/thinking
  if (path === "/api/thinking") {
    const afterId = parseInt(query.get("afterId") || "0", 10);
    const entries = afterId > 0 ? thinkingLog.getAfter(afterId) : thinkingLog.getAll();
    return json(res, { entries, lastId: entries.length > 0 ? entries[entries.length - 1].id : afterId });
  }

  // GET /api/positions
  if (path === "/api/positions") {
    const rawStats = scanner.positions.getStats();
    return json(res, {
      open: scanner.positions.getOpenPositions(),
      stats: {
        totalTrades: rawStats.totalTrades,
        wins: rawStats.wins,
        losses: rawStats.losses,
        winRate: rawStats.winRate,
        totalRealizedPnl: rawStats.totalRealizedPnl,
        bestTradePnl: rawStats.bestTrade,
        worstTradePnl: rawStats.worstTrade,
      },
    });
  }

  // GET /api/history
  if (path === "/api/history") {
    const limit = parseInt(query.get("limit") || "100", 10);
    const search = query.get("search") || "";
    let trades = scanner.positions.getClosedPositions(200, scanner.config.dryRun);
    if (search) {
      const q = search.toLowerCase();
      trades = trades.filter(t => t.symbol?.toLowerCase().includes(q) || t.mint?.toLowerCase().includes(q));
    }
    return json(res, { trades: trades.slice(0, limit), total: trades.length });
  }

  // GET /api/tokens
  if (path === "/api/tokens") {
    return json(res, { tokens: scanner.getTrackedTokens() });
  }

  // POST /api/chat — send a message to the AI agent
  if (path === "/api/chat" && req.method === "POST") {
    const body = await readBody(req);
    const message = body.message;
    if (!message || typeof message !== "string") {
      return json(res, { error: "Missing 'message' field" }, 400);
    }

    try {
      const reply = await chatAgent.chat(message, scanner, tradeJournal);
      return json(res, { ok: true, message: reply });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 500);
    }
  }

  // GET /api/chat/history — get chat history
  if (path === "/api/chat/history") {
    return json(res, { messages: chatAgent.getHistory() });
  }

  // POST /api/chat/clear — clear chat history
  if (path === "/api/chat/clear" && req.method === "POST") {
    chatAgent.clearHistory();
    return json(res, { ok: true });
  }

  // GET /api/agent/decisions — get autonomous agent decisions log
  if (path === "/api/agent/decisions") {
    const limit = parseInt(query.get("limit") || "50", 10);
    const decisions = chatAgent.getDecisions().slice(-limit);
    return json(res, { decisions });
  }

  // GET /api/journal — get trade journal entries
  if (path === "/api/journal") {
    const limit = parseInt(query.get("limit") || "50", 10);
    const entries = tradeJournal.getRecent(limit);
    return json(res, { entries });
  }

  // GET /api/journal/analysis — get trade journal analysis
  if (path === "/api/journal/analysis") {
    const analysis = tradeJournal.analyze();
    return json(res, analysis);
  }

  // GET /api/market-intel — get market intelligence data
  if (path === "/api/market-intel") {
    const report = scanner.marketIntel.getReport();
    const briefing = scanner.marketIntel.getBriefing();
    return json(res, { ...report, briefing });
  }

  // GET /api/smart-money — get smart money tracker data
  if (path === "/api/smart-money") {
    const stats = scanner.smartMoney.getStats();
    const briefing = scanner.smartMoney.getBriefing();
    return json(res, { ...stats, briefing });
  }

  // POST /api/research — trigger winner research
  if (path === "/api/research" && req.method === "POST") {
    const body = await readBody(req);
    const count = parseInt(body.count || "100", 10);
    if (winnerResearch.isRunning()) {
      return json(res, { ok: false, error: "Research already running" });
    }
    // Run async — don't block the request
    winnerResearch.runResearch(count).then(() => {
      logger.system(`Winner research completed — ${count} tokens analyzed`);
    }).catch((err) => {
      logger.error("SYSTEM", `Winner research failed: ${err.message}`);
    });
    return json(res, { ok: true, message: `Research started for top ${count} tokens` });
  }

  // GET /api/research — get research status/results
  if (path === "/api/research") {
    const report = winnerResearch.getReport();
    const briefing = winnerResearch.getBriefing();
    return json(res, { ...report, briefing });
  }

  // GET /api/graduates — get graduate analysis data
  if (path === "/api/graduates") {
    const patterns = graduateAnalyzer.getPatterns();
    const briefing = graduateAnalyzer.getBriefing();
    const totalTracked = graduateAnalyzer.getGraduates().length;
    return json(res, { patterns, briefing, totalTracked });
  }

  // ── Settings & Identity endpoints ──

  // PUT /api/settings — update settings (credentials stored locally)
  if (path === "/api/settings" && req.method === "PUT") {
    const body = await readBody(req);
    // Only allow these fields to be updated from the UI
    const allowed = [
      "solanaPrivateKey", "solanaRpcUrl", "solanaWsUrl",
      "pumpPortalApiKey", "anthropicApiKey", "publicKey",
      "dataSharingEnabled", "dashboardPort", "autoStartScanner",
      "setupComplete",
    ];
    const updates = {};
    for (const key of allowed) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    const saved = updateSettings(updates);
    return json(res, { ok: true, settings: getSettingsForApi() });
  }

  // GET /api/settings — return sanitized settings (hides sensitive fields)
  if (path === "/api/settings") {
    return json(res, {
      ...getSettingsForApi(),
      instanceId: identity.instanceId,
      isAdmin: currentUser?.role === "admin",
    });
  }

  // GET /api/setup-status — check if initial setup is done
  if (path === "/api/setup-status") {
    return json(res, {
      setupComplete: !SETUP_MODE && isSetupComplete(),
      setupMode: SETUP_MODE,
      isAdmin: currentUser?.role === "admin",
      hasPrivateKey: !!config.privateKey,
      hasRpcUrl: !!config.rpcUrl,
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    });
  }

  // ── Pumpberg Proof of Data / Mining endpoints ──

  // GET /api/points — get local points summary
  if (path === "/api/points") {
    const summary = pointsTracker.getSummary();
    summary.walletAddress = identity.walletAddress;
    return json(res, summary);
  }

  // GET /api/mining/status — get mining status overview
  if (path === "/api/mining/status") {
    const syncStats = syncClient?.getStats?.() ?? {};
    return json(res, {
      walletAddress: identity.walletAddress,
      instanceId: identity.instanceId,
      totalPoints: pointsTracker.getTotalPoints(),
      verifiedPoints: pointsTracker.getVerifiedPoints(),
      dataSharingEnabled: syncClient?.enabled ?? false,
      syncStats,
    });
  }

  // POST /api/mining/wallet — set wallet address for mining rewards
  if (path === "/api/mining/wallet" && req.method === "POST") {
    const body = await readBody(req);
    const walletAddr = body.walletAddress;
    if (!walletAddr || typeof walletAddr !== "string" || walletAddr.length < 32) {
      return json(res, { error: "Invalid Solana wallet address" }, 400);
    }
    setWalletAddress(DATA_DIR, walletAddr);
    // Update sync client with new wallet
    if (syncClient) {
      syncClient.walletAddress = walletAddr;
    }
    return json(res, { ok: true, walletAddress: walletAddr });
  }

  // GET /api/identity — return instance identity info (updated with wallet)
  if (path === "/api/identity") {
    return json(res, {
      instanceId: identity.instanceId,
      isAdmin: currentUser?.role === "admin",
      createdAt: identity.createdAt,
      setupComplete: isSetupComplete(),
      walletAddress: identity.walletAddress,
      totalPoints: pointsTracker.getTotalPoints(),
    });
  }
  const DASHBOARD_DIST = resolve(__dirname, "dashboard", "dist");
  if (existsSync(DASHBOARD_DIST)) {
    const MIME_TYPES = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    // Dashboard is served at /dashboard (or /dashboard/*)
    if (path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/dashboard?")) {
      const subPath = path.replace(/^\/dashboard\/?/, "/") || "/";
      let filePath = join(DASHBOARD_DIST, subPath === "/" ? "index.html" : subPath);
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(DASHBOARD_DIST, "index.html");
      }
      if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        const content = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": mime });
        return res.end(content);
      }
    }
    // Dashboard static assets (JS/CSS bundles) — served from root paths
    // Vite outputs assets like /assets/index-abc123.js — these need to work
    if (path.startsWith("/assets/")) {
      const filePath = join(DASHBOARD_DIST, path);
      if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        const content = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
        return res.end(content);
      }
    }
  }

  json(res, { error: "Not found" }, 404);
});

// ── Start ──
logger.system("Dashboard server starting...");
logger.system(`Wallet: ${PUBLIC_KEY}`);
logger.system(`RPC: ${config.rpcUrl.replace(/api-key=.*/, "api-key=***")}`);
logger.system(`Mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    logger.error("SERVER", `Port ${PORT} already in use. Retrying in 3s...`);
    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, 3000);
  } else {
    logCrash("SERVER_ERROR", err);
  }
});

server.listen(PORT, () => {
  logger.system(`=== Dashboard running at http://localhost:${PORT} ===`);
  console.log(`\n  Dashboard:  http://localhost:${PORT}\n`);
});
