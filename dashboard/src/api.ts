// ── API client for the Pumpberg backend ──

import type { BotStatus, ChatMessage, LogEntry, Position, ThinkingEntry, TrackedToken, WalletInfo, AgentDecision } from "./types";

const BASE = "";  // Same origin — proxied via Vite in dev

// ── Auth token management ──
let authToken: string | null = localStorage.getItem("pumpberg_token");

export function setAuthToken(token: string | null): void {
  authToken = token;
  if (token) {
    localStorage.setItem("pumpberg_token", token);
  } else {
    localStorage.removeItem("pumpberg_token");
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

export function clearAuth(): void {
  setAuthToken(null);
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return headers;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authToken ? { "Authorization": `Bearer ${authToken}` } : {},
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error("Session expired");
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error("Session expired");
  }
  return res.json();
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error("Session expired");
  }
  return res.json();
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error("Session expired");
  }
  return res.json();
}

// ── Auth API ──

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
  lastLoginAt?: string;  setupComplete: boolean;  apiKeys?: {
    solanaPrivateKeySet: boolean;
    solanaRpcUrlSet: boolean;
    solanaWsUrlSet: boolean;
    pumpPortalApiKeySet: boolean;
    anthropicApiKeySet: boolean;
    publicKey?: string;
  };
}

export async function login(username: string, password: string): Promise<{ ok: boolean; token?: string; user?: AuthUser; error?: string }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.json();
}

export async function register(username: string, email: string, password: string): Promise<{ ok: boolean; token?: string; user?: AuthUser; error?: string }> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  return res.json();
}

export async function getMe(): Promise<{ user: AuthUser }> {
  return fetchJson("/api/auth/me");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  return postJson("/api/auth/change-password", { currentPassword, newPassword });
}

export async function updateApiKeys(keys: Record<string, string>): Promise<{ ok: boolean }> {
  return putJson("/api/auth/api-keys", keys);
}

export async function completeSetup(): Promise<{ ok: boolean }> {
  return postJson("/api/auth/complete-setup", {});
}

export async function getStatus(): Promise<BotStatus> {
  return fetchJson("/api/status");
}

export async function getWallet(): Promise<WalletInfo> {
  return fetchJson("/api/wallet");
}

export async function getLogs(afterId = 0): Promise<{ entries: LogEntry[]; lastId: number }> {
  return fetchJson(`/api/logs?afterId=${afterId}`);
}

export async function getThinking(afterId = 0): Promise<{ entries: ThinkingEntry[]; lastId: number }> {
  return fetchJson(`/api/thinking?afterId=${afterId}`);
}

export async function getPositions(): Promise<{ open: Position[]; stats: BotStatus["stats"] }> {
  return fetchJson("/api/positions");
}

export async function getHistory(limit = 100, search = ""): Promise<{ trades: Position[]; total: number }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set("search", search);
  return fetchJson(`/api/history?${params}`);
}

export async function getTokens(): Promise<{ tokens: TrackedToken[] }> {
  return fetchJson("/api/tokens");
}

export async function updateConfig(updates: Record<string, number>): Promise<{ ok: boolean; updated: Record<string, number> }> {
  return patchJson("/api/config", updates);
}

export async function controlBot(action: "start" | "stop"): Promise<{ ok: boolean; running: boolean }> {
  return postJson("/api/control", { action });
}

export async function sellAllPositions(): Promise<{ ok: boolean; sold: number; failed: number }> {
  return postJson("/api/sell-all");
}

export async function sellPosition(mint: string): Promise<{ success: boolean; error?: string }> {
  return postJson("/api/sell", { mint });
}

export async function cycleTradingMode(): Promise<{ ok: boolean; tradingMode: string }> {
  return postJson("/api/trading-mode");
}

/** SSE stream for real-time logs + thinking entries */
export function subscribeToStream(
  onLog: (entry: LogEntry) => void,
  onThinking: (entry: ThinkingEntry) => void,
  onError?: (err: Event) => void,
): () => void {
  // Include auth token as query param since EventSource doesn't support headers
  const tokenParam = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  const source = new EventSource(`${BASE}/api/logs/stream${tokenParam}`);

  source.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "connected") return;
      if (data._type === "thinking") {
        const { _type, ...entry } = data;
        onThinking(entry as ThinkingEntry);
      } else {
        onLog(data as LogEntry);
      }
    } catch {}
  };

  source.onerror = (ev) => {
    onError?.(ev);
  };

  return () => source.close();
}

// ── Chat API ──

export async function sendChatMessage(message: string): Promise<{ ok: boolean; message: ChatMessage }> {
  return postJson("/api/chat", { message });
}

export async function getChatHistory(): Promise<{ messages: ChatMessage[] }> {
  return fetchJson("/api/chat/history");
}

export async function clearChatHistory(): Promise<{ ok: boolean }> {
  return postJson("/api/chat/clear");
}

// ── Agent API ──

export async function getAgentDecisions(limit = 50): Promise<{ decisions: AgentDecision[] }> {
  return fetchJson(`/api/agent/decisions?limit=${limit}`);
}

export async function getJournalAnalysis(): Promise<Record<string, unknown>> {
  return fetchJson("/api/journal/analysis");
}

// ── Settings API ──

export interface SettingsResponse {
  solanaPrivateKeySet: boolean;
  solanaRpcUrl: string;
  solanaWsUrl: string;
  pumpPortalApiKeySet: boolean;
  anthropicApiKeySet: boolean;
  publicKey: string;
  instanceId: string;
  isAdmin: boolean;
  dataSharingEnabled: boolean;
  syncServerUrl: string;
  dashboardPort: number;
  autoStartScanner: boolean;
  setupComplete: boolean;
}

export interface SetupStatusResponse {
  setupComplete: boolean;
  isAdmin: boolean;
  hasPrivateKey: boolean;
  hasRpcUrl: boolean;
  hasAnthropicKey: boolean;
}

export async function getSettings(): Promise<SettingsResponse> {
  return fetchJson("/api/settings");
}

export async function updateSettings(updates: Record<string, unknown>): Promise<{ ok: boolean; settings: SettingsResponse }> {
  return putJson("/api/settings", updates);
}

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return fetchJson("/api/setup-status");
}

// ── Pumpberg Mining / Points API ──

export interface PointsSummary {
  totalPoints: number;
  totalTrades: number;
  verifiedTrades: number;
  unverifiedTrades: number;
  averagePointsPerTrade: number;
  walletAddress?: string;
  rank?: number;
}

export interface MiningStatus {
  walletAddress?: string;
  instanceId: string;
  totalPoints: number;
  verifiedPoints: number;
  dataSharingEnabled: boolean;
  syncStats: Record<string, unknown>;
}

export interface LeaderboardEntry {
  rank: number;
  walletAddress: string;
  totalPoints: number;
  verifiedPoints: number;
  totalTrades: number;
  verifiedTrades: number;
}

export interface LeaderboardResponse {
  leaderboard: LeaderboardEntry[];
  totalMiners: number;
  totalTrades: number;
}

export async function getPoints(): Promise<PointsSummary> {
  return fetchJson("/api/points");
}

export async function getMiningStatus(): Promise<MiningStatus> {
  return fetchJson("/api/mining/status");
}

export async function setMiningWallet(walletAddress: string): Promise<{ ok: boolean; walletAddress: string }> {
  return postJson("/api/mining/wallet", { walletAddress });
}

export async function getLeaderboard(limit = 100): Promise<LeaderboardResponse> {
  return fetchJson(`/api/leaderboard?limit=${limit}`);
}
