import { useState, useCallback } from "react";
import { Copy, Check, Key, Wallet, Power, Settings2, AlertTriangle, ToggleLeft, ToggleRight, Brain, Eye, EyeOff, Info } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, Badge, Stat, Input } from "./ui";
import { cn, copyToClipboard, shortenAddress, formatSol } from "@/lib/utils";
import type { BotStatus, WalletInfo } from "@/types";
import { controlBot, updateConfig, sellAllPositions, cycleTradingMode } from "@/api";

interface BotInfoPanelProps {
  status: BotStatus | null;
  wallet: WalletInfo | null;
  onRefresh: () => void;
}

export function BotInfoPanel({ status, wallet, onRefresh }: BotInfoPanelProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [minPosSize, setMinPosSize] = useState<string>("");
  const [maxPosSize, setMaxPosSize] = useState<string>("");
  const [maxExposure, setMaxExposure] = useState<string>("");
  const [maxPositions, setMaxPositions] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [tp1, setTp1] = useState<string>("");
  const [tp2, setTp2] = useState<string>("");
  const [stagnationSec, setStagnationSec] = useState<string>("");
  const [stagnationTrades, setStagnationTrades] = useState<string>("");
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [sellingAll, setSellingAll] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  const [cyclingTradingMode, setCyclingTradingMode] = useState(false);
  const [lastSyncedConfig, setLastSyncedConfig] = useState<string>("");

  // Sync local inputs with server config - re-sync whenever server config changes
  const cfg = status?.config;
  const cfgKey = cfg ? JSON.stringify(cfg) : "";
  if (cfg && cfgKey !== lastSyncedConfig && dirty.size === 0) {
    setMinPosSize(String(cfg.minPositionSizeSol));
    setMaxPosSize(String(cfg.maxPositionSizeSol));
    setMaxExposure(String(cfg.maxTotalExposureSol));
    setMaxPositions(String(cfg.maxConcurrentPositions));
    setStopLoss(String((cfg.stopLossPct * 100).toFixed(1)));
    setTp1(String((cfg.takeProfitPct1 * 100).toFixed(1)));
    setTp2(String((cfg.takeProfitPct2 * 100).toFixed(1)));
    setStagnationSec(String(cfg.stagnationExitSec));
    setStagnationTrades(String(cfg.stagnationMinTrades));
    setLastSyncedConfig(cfgKey);
  }

  const markDirty = (field: string) => setDirty((prev) => new Set(prev).add(field));

  const handleCopy = useCallback(async (text: string, field: string) => {
    await copyToClipboard(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  const handleControl = useCallback(async (action: "start" | "stop") => {
    setControlling(true);
    try {
      await controlBot(action);
      setTimeout(onRefresh, 500);
    } catch (err) {
      console.error("Control error:", err);
    } finally {
      setControlling(false);
    }
  }, [onRefresh]);

  const handleSaveConfig = useCallback(async () => {
    const minVal = parseFloat(minPosSize);
    const maxVal = parseFloat(maxPosSize);
    const maxExpVal = parseFloat(maxExposure);
    const maxPosVal = parseInt(maxPositions, 10);
    const slVal = parseFloat(stopLoss) / 100;
    const tp1Val = parseFloat(tp1) / 100;
    const tp2Val = parseFloat(tp2) / 100;
    const stagSecVal = parseInt(stagnationSec, 10);
    const stagTradesVal = parseInt(stagnationTrades, 10);
    if (isNaN(minVal) || isNaN(maxVal) || minVal <= 0 || maxVal <= 0 || minVal > maxVal) return;
    if (isNaN(maxExpVal) || maxExpVal <= 0) return;
    if (isNaN(maxPosVal) || maxPosVal < 1) return;
    if (isNaN(slVal) || slVal <= 0 || isNaN(tp1Val) || tp1Val <= 0 || isNaN(tp2Val) || tp2Val <= 0) return;
    if (isNaN(stagSecVal) || stagSecVal < 1 || isNaN(stagTradesVal) || stagTradesVal < 1) return;
    setSaving(true);
    try {
      await updateConfig({
        minPositionSizeSol: minVal,
        maxPositionSizeSol: maxVal,
        maxTotalExposureSol: maxExpVal,
        maxConcurrentPositions: maxPosVal,
        stopLossPct: slVal,
        takeProfitPct1: tp1Val,
        takeProfitPct2: tp2Val,
        stagnationExitSec: stagSecVal,
        stagnationMinTrades: stagTradesVal,
      });
      setDirty(new Set());
      setTimeout(onRefresh, 300);
    } catch (err) {
      console.error("Config save error:", err);
    } finally {
      setSaving(false);
    }
  }, [minPosSize, maxPosSize, maxExposure, maxPositions, stopLoss, tp1, tp2, stagnationSec, stagnationTrades, onRefresh]);

  const handleSellAll = useCallback(async () => {
    if (!confirm("SELL ALL POSITIONS?\n\nThis will immediately sell all open positions at market price. This cannot be undone.")) return;
    setSellingAll(true);
    try {
      const result = await sellAllPositions();
      console.log("Sell all result:", result);
      setTimeout(onRefresh, 500);
    } catch (err) {
      console.error("Sell all error:", err);
    } finally {
      setSellingAll(false);
    }
  }, [onRefresh]);

  const handleToggleMode = useCallback(async () => {
    const currentDryRun = status?.dryRun ?? true;
    const newMode = !currentDryRun;
    const label = newMode ? "DRY RUN (paper trading)" : "LIVE (real money)";
    if (!newMode && !confirm(`Switch to LIVE MODE?\n\nThis will use REAL SOL for trades. Are you sure?`)) return;
    setTogglingMode(true);
    try {
      await updateConfig({ dryRun: newMode ? 1 : 0 });
      setTimeout(onRefresh, 300);
    } catch (err) {
      console.error("Mode toggle error:", err);
    } finally {
      setTogglingMode(false);
    }
  }, [status?.dryRun, onRefresh]);

  const handleCycleTradingMode = useCallback(async () => {
    setCyclingTradingMode(true);
    try {
      await cycleTradingMode();
      setTimeout(onRefresh, 300);
    } catch (err) {
      console.error("Trading mode cycle error:", err);
    } finally {
      setCyclingTradingMode(false);
    }
  }, [onRefresh]);

  const running = status?.running ?? false;
  const configDirty = dirty.size > 0;
  const hasOpenPositions = (status?.openPositions ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-cyan-400" />
          Bot Info
        </CardTitle>
        <div className="flex items-center gap-2">
          {running ? (
            <Badge variant="success">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse-dot mr-1.5" />
              Running
            </Badge>
          ) : (
            <Badge variant="danger">Stopped</Badge>
          )}
          <button
            onClick={() => handleControl(running ? "stop" : "start")}
            disabled={controlling}
            title={running ? "Stop bot" : "Start bot"}
            className={cn(
              "relative h-8 w-8 rounded-full flex items-center justify-center transition-all duration-300",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-50",
              running
                ? "bg-green-500/20 text-green-400 border border-green-500/50 shadow-[0_0_12px_rgba(34,197,94,0.4)] hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/50 hover:shadow-[0_0_12px_rgba(239,68,68,0.4)]"
                : "bg-secondary text-muted-foreground border border-border hover:bg-green-500/20 hover:text-green-400 hover:border-green-500/50 hover:shadow-[0_0_12px_rgba(34,197,94,0.3)]"
            )}
          >
            {running && <span className="absolute inset-0 rounded-full bg-green-500/20 animate-ping" />}
            <Power className="h-4 w-4 relative z-10" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Wallet addresses */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between group">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Key className="h-3 w-3" />
              Public Key
            </div>
            <button
              className="flex items-center gap-1.5 text-xs font-mono hover:text-cyan-400 transition-colors"
              onClick={() => wallet && handleCopy(wallet.publicKey, "pub")}
              title="Copy public key"
            >
              {wallet ? shortenAddress(wallet.publicKey) : "-"}
              {copiedField === "pub" ? (
                <Check className="h-3 w-3 text-green-400" />
              ) : (
                <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </button>
          </div>

          <div className="flex items-center justify-between group">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Key className="h-3 w-3" />
              Private Key
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              {wallet ? wallet.privateKeyHint : "-"}
            </span>
          </div>
        </div>

        {/* SOL Balance */}
        {wallet && (
          <div className="border-t pt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Balance</span>
              <div className="text-right">
                <span className="text-lg font-bold tabular-nums">
                  {wallet.solBalance.toFixed(4)}
                </span>
                <span className="text-sm text-muted-foreground ml-1">SOL</span>
              </div>
            </div>
            {wallet.solPriceUsd > 0 && (
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-[10px] text-muted-foreground">Other Balance: ${(wallet.positionsValueUsd ?? 0).toFixed(2)} USD</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  ≈ ${wallet.balanceUsd.toFixed(2)} USD
                </span>
              </div>
            )}
          </div>
        )}

        {/* Stats */}
        {status && (
          <>
            <div className="border-t pt-2 grid grid-cols-2 gap-2">
              <button
                onClick={handleCycleTradingMode}
                disabled={cyclingTradingMode}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-md px-2 py-1 transition-all text-left",
                  "hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50",
                  status.tradingMode === "agent"
                    ? "border border-blue-500/30 bg-blue-500/5"
                    : status.tradingMode === "uav"
                    ? "border border-green-500/30 bg-green-500/5"
                    : "border border-zinc-500/30 bg-zinc-500/5",
                )}
                title="Click to cycle: Agent > UAV > No Agent"
              >
                <span className="text-[10px] text-muted-foreground leading-none">AI Mode</span>
                <span className={cn(
                  "flex items-center gap-1 text-xs font-bold leading-none",
                  status.tradingMode === "agent"
                    ? "text-blue-400"
                    : status.tradingMode === "uav"
                    ? "text-green-400"
                    : "text-zinc-400",
                )}>
                  {status.tradingMode === "agent" ? (
                    <><Brain className="h-3.5 w-3.5" />AGENT</>
                  ) : status.tradingMode === "uav" ? (
                    <><Eye className="h-3.5 w-3.5" />UAV</>
                  ) : (
                    <><EyeOff className="h-3.5 w-3.5" />OFF</>
                  )}
                </span>
              </button>
              <button
                onClick={handleToggleMode}
                disabled={togglingMode}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-md px-2 py-1 transition-all text-left",
                  "hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50",
                  status.dryRun
                    ? "border border-amber-500/30 bg-amber-500/5"
                    : "border border-red-500/30 bg-red-500/5",
                )}
                title={status.dryRun ? "Switch to LIVE mode" : "Switch to DRY RUN mode"}
              >
                <span className="text-[10px] text-muted-foreground leading-none">Mode</span>
                <span className={cn(
                  "flex items-center gap-1 text-xs font-bold leading-none",
                  status.dryRun ? "text-amber-400" : "text-red-400",
                )}>
                  {status.dryRun ? (
                    <><ToggleLeft className="h-3.5 w-3.5" />DRY RUN</>
                  ) : (
                    <><ToggleRight className="h-3.5 w-3.5" />LIVE</>
                  )}
                </span>
              </button>
              <Stat label="Open" value={`${status.openPositions}/${status.config.maxConcurrentPositions}`} />
              <Stat label="Tracked" value={status.trackedTokens} />
            </div>

            <div className="border-t pt-2 grid grid-cols-3 gap-2">
              <Stat label="Trades" value={status.stats.totalTrades} subtext={status.dryRun ? "DRY RUN" : "LIVE"} />
              <Stat
                label="Win Rate"
                value={status.stats.totalTrades > 0 ? `${(status.stats.winRate * 100).toFixed(0)}%` : "-"}
                subtext={`${status.stats.wins}W / ${status.stats.losses}L`}
              />
              <Stat
                label="P&L"
                value={`${status.stats.totalRealizedPnl >= 0 ? "+" : ""}${formatSol(status.stats.totalRealizedPnl)} SOL`}
                className={status.stats.totalRealizedPnl >= 0 ? "text-green-400" : "text-red-400"}
              />
            </div>

            {/* Editable Config */}
            <div className="border-t pt-2">
              <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                <Settings2 className="h-3 w-3 text-cyan-400" />
                Trading Config
              </div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-2">
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Min Size
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full left-0 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Smallest SOL amount the bot will use for a single trade. Lower = less risk per position.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.001" min="0.001" value={minPosSize}
                      onChange={(e) => { setMinPosSize(e.target.value); markDirty("minPos"); }}
                      className="w-full h-6 px-2 pr-8 rounded bg-secondary border border-border text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">SOL</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Max Size
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Largest SOL amount for a single trade. Higher-scoring tokens get sizes closer to this value.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.001" min="0.001" value={maxPosSize}
                      onChange={(e) => { setMaxPosSize(e.target.value); markDirty("maxPos"); }}
                      className="w-full h-6 px-2 pr-8 rounded bg-secondary border border-border text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">SOL</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Max Exposure
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full right-0 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Maximum total SOL across all open positions combined. Prevents over-committing your wallet.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.1" min="0.1" value={maxExposure}
                      onChange={(e) => { setMaxExposure(e.target.value); markDirty("maxExp"); }}
                      className="w-full h-6 px-2 pr-8 rounded bg-secondary border border-border text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">SOL</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Max Positions
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full left-0 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">How many tokens the bot can hold at the same time. More positions = more diversification but harder to monitor.</span>
                    </span>
                  </label>
                  <input
                    type="number" step="1" min="1" value={maxPositions}
                    onChange={(e) => { setMaxPositions(e.target.value); markDirty("maxPosCount"); }}
                    className="w-full h-6 px-2 rounded bg-secondary border border-border text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-colors"
                  />
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Stop Loss
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Auto-sell when price drops this percentage below entry. Limits maximum loss per trade.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.1" min="0.1" value={stopLoss}
                      onChange={(e) => { setStopLoss(e.target.value); markDirty("sl"); }}
                      className="w-full h-6 px-2 pr-6 rounded bg-secondary border border-border text-[11px] font-mono text-red-400 focus:outline-none focus:ring-1 focus:ring-red-500/50 focus:border-red-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">%</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    TP1
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full right-0 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Sell 50% of the position when price rises this far. Locks in partial profit while letting the rest ride.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.1" min="0.1" value={tp1}
                      onChange={(e) => { setTp1(e.target.value); markDirty("tp1"); }}
                      className="w-full h-6 px-2 pr-6 rounded bg-secondary border border-border text-[11px] font-mono text-green-400 focus:outline-none focus:ring-1 focus:ring-green-500/50 focus:border-green-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">%</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    TP2
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full left-0 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Sell the remaining position when price reaches this level. Fully closes the trade at a higher profit target.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="0.1" min="0.1" value={tp2}
                      onChange={(e) => { setTp2(e.target.value); markDirty("tp2"); }}
                      className="w-full h-6 px-2 pr-6 rounded bg-secondary border border-border text-[11px] font-mono text-green-400 focus:outline-none focus:ring-1 focus:ring-green-500/50 focus:border-green-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">%</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Vol Timer
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Seconds after buying before checking for dead volume. If the token has no momentum by this time, it's auto-sold.</span>
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number" step="1" min="1" value={stagnationSec}
                      onChange={(e) => { setStagnationSec(e.target.value); markDirty("stagSec"); }}
                      className="w-full h-6 px-2 pr-5 rounded bg-secondary border border-border text-[11px] font-mono text-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-500/50 focus:border-yellow-500/50 transition-colors"
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/50 pointer-events-none">s</span>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-[10px] text-muted-foreground mb-1 flex items-center gap-0.5 h-4 whitespace-nowrap">
                    Min Volume
                    <span className="relative group">
                      <Info className="h-2.5 w-2.5 text-muted-foreground/60 cursor-help" />
                      <span className="absolute bottom-full right-0 mb-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-[10px] text-zinc-100 w-56 whitespace-normal hidden group-hover:block z-50 shadow-xl pointer-events-none">Minimum number of trades a token needs within the timer window to stay alive. Fewer trades than this triggers an auto-sell.</span>
                    </span>
                  </label>
                  <input
                    type="number" step="1" min="1" value={stagnationTrades}
                    onChange={(e) => { setStagnationTrades(e.target.value); markDirty("stagTrades"); }}
                    className="w-full h-6 px-2 rounded bg-secondary border border-border text-[11px] font-mono text-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-500/50 focus:border-yellow-500/50 transition-colors"
                  />
                </div>
              </div>
              {configDirty && (
                <button
                  onClick={handleSaveConfig}
                  disabled={saving}
                  className="mt-2 w-full h-6 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Config"}
                </button>
              )}

              {/* Sell All Button */}
              {hasOpenPositions && (
                <button
                  onClick={handleSellAll}
                  disabled={sellingAll}
                  className="mt-2 w-full h-7 rounded bg-red-600/80 hover:bg-red-500 text-white text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 border border-red-500/50 hover:shadow-[0_0_12px_rgba(239,68,68,0.4)]"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {sellingAll ? "Selling..." : `Sell All (${status?.openPositions})`}
                </button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
