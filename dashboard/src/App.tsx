import { useState, useEffect, useCallback, useRef } from "react";
import { X, Settings2, LogOut } from "lucide-react";
import { BotInfoPanel } from "./components/BotInfoPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { TradeHistoryPanel } from "./components/TradeHistoryPanel";
import { TokenMonitorPanel } from "./components/TokenMonitorPanel";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { LoginScreen } from "./components/LoginScreen";
import { SetupWizard } from "./components/SetupWizard";

import { getStatus, getWallet, getLogs, getThinking, getPositions, getHistory, getTokens, subscribeToStream, getAuthToken, setAuthToken, clearAuth, getMe, type AuthUser } from "./api";
import type { BotStatus, WalletInfo, LogEntry, ThinkingEntry, Position, TrackedToken } from "./types";

export type PanelId = "terminal" | "trades" | "tokens" | "thinking" | "chat" | null;

export function App() {
  // ── Auth state ──
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!getAuthToken());
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);

  // Handle login
  const handleLogin = useCallback((token: string) => {
    setAuthToken(token);
    setIsAuthenticated(true);
    // Load user info
    getMe().then(data => setCurrentUser(data.user)).catch(() => {});
  }, []);

  // Handle logout
  const handleLogout = useCallback(() => {
    clearAuth();
    setIsAuthenticated(false);
    setCurrentUser(null);
  }, []);

  // Verify token on mount
  useEffect(() => {
    if (getAuthToken()) {
      getMe().then(data => {
        setCurrentUser(data.user);
        setIsAuthenticated(true);
      }).catch(() => {
        clearAuth();
        setIsAuthenticated(false);
      });
    }
  }, []);

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  // Show setup wizard if authenticated but setup not complete
  if (currentUser && !currentUser.setupComplete) {
    return <SetupWizard onComplete={() => {
      // Reload user data after setup
      getMe().then(data => setCurrentUser(data.user)).catch(() => {});
    }} />;
  }

  return <Dashboard currentUser={currentUser} onLogout={handleLogout} />;
}

function Dashboard({ currentUser, onLogout }: { currentUser: AuthUser | null; onLogout: () => void }) {
  // ── State ──
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [thinking, setThinking] = useState<ThinkingEntry[]>([]);
  const [openPositions, setOpenPositions] = useState<Position[]>([]);
  const [closedTrades, setClosedTrades] = useState<Position[]>([]);
  const [tokens, setTokens] = useState<TrackedToken[]>([]);
  const [maximizedPanel, setMaximizedPanel] = useState<PanelId>(null);
  const [connected, setConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [bottomRightTab, setBottomRightTab] = useState<"thinking" | "chat">("thinking");
  const [showSettings, setShowSettings] = useState(false);

  const unsubRef = useRef<(() => void) | null>(null);

  // ── Initial data load ──
  const loadAll = useCallback(async () => {
    try {
      const [s, w, l, t, p, h, tk] = await Promise.all([
        getStatus().catch(() => null),
        getWallet().catch(() => null),
        getLogs().catch(() => ({ entries: [], lastId: 0 })),
        getThinking().catch(() => ({ entries: [], lastId: 0 })),
        getPositions().catch(() => ({ open: [], stats: null })),
        getHistory(200, searchQuery).catch(() => ({ trades: [], total: 0 })),
        getTokens().catch(() => ({ tokens: [] })),
      ]);

      if (s) setStatus(s);
      if (w) setWallet(w);
      setLogs(l.entries);
      setThinking(t.entries);
      setOpenPositions(p.open);
      setClosedTrades(h.trades);
      setTokens(tk.tokens);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [searchQuery]);

  // ── SSE streaming for real-time updates ──
  useEffect(() => {
    loadAll();

    const unsub = subscribeToStream(
      (entry) => {
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 2000 ? next.slice(-2000) : next;
        });
        setConnected(true);
      },
      (entry) => {
        setThinking((prev) => {
          const next = [...prev, entry];
          return next.length > 500 ? next.slice(-500) : next;
        });
      },
      () => {
        setConnected(false);
      },
    );
    unsubRef.current = unsub;

    return () => { unsub(); };
  }, [loadAll]);

  // ── Periodic data refresh (positions, status, tokens, wallet) ──
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [s, p, tk, w] = await Promise.all([
          getStatus().catch(() => null),
          getPositions().catch(() => null),
          getTokens().catch(() => null),
          getWallet().catch(() => null),
        ]);
        if (s) setStatus(s);
        if (p) setOpenPositions(p.open);
        if (tk) setTokens(tk.tokens);
        if (w) setWallet(w);
      } catch {}
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  // ── Trade history search ──
  const handleTradeSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    try {
      const h = await getHistory(200, query);
      setClosedTrades(h.trades);
    } catch {}
  }, []);

  // ── Clear logs ──
  const handleClearLogs = useCallback(() => setLogs([]), []);

  // ── Refresh all ──
  const handleRefresh = useCallback(() => { loadAll(); }, [loadAll]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="h-12 border-b flex items-center justify-between px-4 shrink-0 bg-card">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Pumpberg" className="h-8 w-8 rounded" />
          <h1 className="text-sm font-bold tracking-tight">Pumpberg</h1>
          <span className="text-xs text-muted-foreground hidden sm:block">Dashboard</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {currentUser && (
            <span className="text-zinc-400 hidden sm:block">
              {currentUser.username}
              {currentUser.role === "admin" && " (admin)"}
            </span>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="h-7 w-7 rounded flex items-center justify-center hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            title="Settings"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            onClick={onLogout}
            className="h-7 w-7 rounded flex items-center justify-center hover:bg-accent transition-colors text-muted-foreground hover:text-red-400"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
          <div className={`flex items-center gap-1.5 ${connected ? "text-green-400" : "text-red-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400 animate-pulse-dot" : "bg-red-400"}`} />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </header>

      {/* Maximized panel overlay */}
      {maximizedPanel && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
          <div className="h-10 border-b flex items-center justify-between px-4 shrink-0 bg-card">
            <span className="text-sm font-bold capitalize">{maximizedPanel}</span>
            <button
              onClick={() => setMaximizedPanel(null)}
              className="h-7 w-7 rounded flex items-center justify-center hover:bg-accent transition-colors"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 p-2">
            {maximizedPanel === "terminal" && (
              <TerminalPanel logs={logs} maximized onMaximize={() => setMaximizedPanel(null)} onClear={handleClearLogs} />
            )}
            {maximizedPanel === "trades" && (
              <TradeHistoryPanel openPositions={openPositions} closedTrades={closedTrades} onSearch={handleTradeSearch} maximized onMaximize={() => setMaximizedPanel(null)} />
            )}
            {maximizedPanel === "tokens" && (
              <TokenMonitorPanel tokens={tokens} maximized onMaximize={() => setMaximizedPanel(null)} />
            )}
            {maximizedPanel === "thinking" && (
              <ThinkingPanel entries={thinking} maximized onMaximize={() => setMaximizedPanel(null)} />
            )}
            {maximizedPanel === "chat" && (
              <ChatPanel maximized onMaximize={() => setMaximizedPanel(null)} onConfigChanged={handleRefresh} />
            )}
          </div>
        </div>
      )}

      {/* Main layout: left sidebar + right (terminal + bottom panels) */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left column — Bot Info + Mining + Token Monitor */}
        <div className="w-[360px] shrink-0 border-r overflow-y-auto p-2 space-y-2">
          <BotInfoPanel status={status} wallet={wallet} onRefresh={handleRefresh} />
          <TokenMonitorPanel tokens={tokens} compact onMaximize={() => setMaximizedPanel("tokens")} />
        </div>

        {/* Right column — Terminal (top) + Trade History & Thinking (bottom) */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Terminal — top portion */}
          <div className="flex-[5] min-h-0 border-b">
            <TerminalPanel logs={logs} onMaximize={() => setMaximizedPanel("terminal")} onClear={handleClearLogs} />
          </div>

          {/* Bottom row — Trade History + Thinking side by side */}
          <div className="flex-[4] flex min-h-0">
            <div className="flex-1 min-w-0 border-r min-h-0">
              <TradeHistoryPanel
                openPositions={openPositions}
                closedTrades={closedTrades}
                onSearch={handleTradeSearch}
                compact
                onMaximize={() => setMaximizedPanel("trades")}
              />
            </div>
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {/* Tab bar */}
              <div className="flex items-center border-b shrink-0 bg-card">
                <button
                  onClick={() => setBottomRightTab("thinking")}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                    bottomRightTab === "thinking"
                      ? "border-violet-400 text-violet-400"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Thinking
                </button>
                <button
                  onClick={() => setBottomRightTab("chat")}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                    bottomRightTab === "chat"
                      ? "border-blue-400 text-blue-400"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Chat
                </button>
              </div>
              {/* Tab content */}
              <div className="flex-1 min-h-0">
                {bottomRightTab === "thinking" && (
                  <ThinkingPanel entries={thinking} compact onMaximize={() => setMaximizedPanel("thinking")} />
                )}
                {bottomRightTab === "chat" && (
                  <ChatPanel compact onMaximize={() => setMaximizedPanel("chat")} onConfigChanged={handleRefresh} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Settings modal */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
