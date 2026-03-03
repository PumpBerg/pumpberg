import { useState, useCallback } from "react";
import { History, Search, ChevronDown, ChevronUp, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { Card, CardHeader, CardTitle, Badge, Button, Input } from "./ui";
import { cn, formatTime, formatTimeFull, formatSol, formatPct, shortenTx, shortenAddress } from "@/lib/utils";
import { sellPosition } from "@/api";
import type { Position } from "@/types";

interface TradeHistoryPanelProps {
  openPositions: Position[];
  closedTrades: Position[];
  onSearch: (query: string) => void;
  compact?: boolean;
  maximized?: boolean;
  onMaximize?: () => void;
}

export function TradeHistoryPanel({ openPositions, closedTrades, onSearch, compact, maximized, onMaximize }: TradeHistoryPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [tab, setTab] = useState<"open" | "history">("open");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [sellingMint, setSellingMint] = useState<string | null>(null);

  const handleSellPosition = useCallback(async (mint: string, symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Sell ${symbol}?\n\nThis will immediately sell at market price.`)) return;
    setSellingMint(mint);
    try {
      const result = await sellPosition(mint);
      if (!result.success) {
        alert(`Sell failed: ${result.error ?? "Unknown error"}`);
      }
    } catch (err) {
      console.error("Sell error:", err);
      alert(`Sell failed: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setSellingMint(null);
    }
  }, []);

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    onSearch(value);
  };

  const displayTrades = tab === "open" ? openPositions : closedTrades;
  const visibleTrades = maximized ? displayTrades : compact ? displayTrades.slice(0, 4) : displayTrades.slice(0, 5);

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-cyan-400" />
          <CardTitle>Trades</CardTitle>
          <Badge variant="outline" className="tabular-nums">{openPositions.length} open</Badge>
        </div>
        {onMaximize && (
          <Button size="icon" variant="ghost" onClick={onMaximize} title={maximized ? "Minimize" : "Maximize"}>
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        )}
      </CardHeader>

      {/* Tabs + search */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <button
          onClick={() => setTab("open")}
          className={cn("text-xs px-2 py-1 rounded", tab === "open" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          Open ({openPositions.length})
        </button>
        <button
          onClick={() => setTab("history")}
          className={cn("text-xs px-2 py-1 rounded", tab === "history" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          History ({closedTrades.length})
        </button>
        <div className="flex-1" />
        {(maximized || tab === "history") && (
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              className="pl-7 w-48"
              placeholder="Search tx, symbol..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Trades list */}
      <div className={cn("overflow-y-auto flex-1 min-h-0", maximized ? "" : compact ? "" : "max-h-64")}>
        {visibleTrades.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-6">
            {tab === "open" ? "No open positions" : "No trade history"}
          </div>
        )}
        {visibleTrades.map((trade) => {
          const isOpen = trade.status !== "closed";
          const pnl = isOpen ? trade.unrealizedPnlSol : trade.realizedPnlSol;
          const pnlPct = isOpen ? trade.unrealizedPnlPct : (trade.realizedPnlSol / trade.entrySol);
          const isProfit = pnl >= 0;
          const isExpanded = expandedRow === trade.id;

          return (
            <div key={trade.id} className="border-b last:border-0">
              <button
                className="w-full flex items-center gap-3 px-4 py-2.5 text-xs hover:bg-white/[0.02] transition-colors"
                onClick={() => setExpandedRow(isExpanded ? null : trade.id)}
              >
                <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", isOpen ? "bg-cyan-400" : isProfit ? "bg-green-400" : "bg-red-400")} />
                <span className="font-bold w-16 text-left truncate">{trade.symbol}</span>
                <span className="text-muted-foreground w-14 text-left">{formatSol(trade.entrySol)} SOL</span>
                <span className={cn("font-mono w-20 text-right", isProfit ? "text-green-400" : "text-red-400")}>
                  {formatPct(pnlPct)}
                </span>
                <span className={cn("font-mono w-20 text-right", isProfit ? "text-green-400" : "text-red-400")}>
                  {pnl >= 0 ? "+" : ""}{formatSol(pnl)}
                </span>
                <span className="text-muted-foreground flex-1 text-right">
                  {formatTime(trade.openedAt)}
                </span>
                {isOpen && (
                  <button
                    onClick={(e) => handleSellPosition(trade.mint, trade.symbol, e)}
                    disabled={sellingMint === trade.mint}
                    className={cn(
                      "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors",
                      "bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-500/50",
                      "disabled:opacity-50 disabled:pointer-events-none",
                    )}
                    title={`Sell ${trade.symbol}`}
                  >
                    <X className="h-3 w-3" />
                    {sellingMint === trade.mint ? "..." : "SELL"}
                  </button>
                )}
                {trade.exitReason && (
                  <Badge variant={isProfit ? "success" : "danger"} className="ml-1">
                    {trade.exitReason}
                  </Badge>
                )}
                <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", isExpanded && "rotate-180")} />
              </button>

              {isExpanded && (
                <div className="px-4 py-2 bg-black/20 text-xs space-y-1 border-t border-border/50">
                  <div className="grid grid-cols-2 gap-2">
                    <div><span className="text-muted-foreground">Mint: </span><span className="font-mono">{shortenAddress(trade.mint, 8)}</span></div>
                    <div><span className="text-muted-foreground">Name: </span>{trade.name}</div>
                    <div><span className="text-muted-foreground">Entry Price: </span><span className="font-mono">{trade.entryPrice.toExponential(4)}</span></div>
                    <div><span className="text-muted-foreground">Current: </span><span className="font-mono">{trade.currentPrice.toExponential(4)}</span></div>
                    <div><span className="text-muted-foreground">Peak: </span><span className="font-mono">{trade.peakPrice.toExponential(4)}</span></div>
                    <div><span className="text-muted-foreground">Tokens: </span><span className="font-mono">{trade.tokenAmount.toFixed(0)}</span></div>
                    <div><span className="text-muted-foreground">Opened: </span>{formatTimeFull(trade.openedAt)}</div>
                    {trade.closedAt && <div><span className="text-muted-foreground">Closed: </span>{formatTimeFull(trade.closedAt)}</div>}
                  </div>
                  {trade.entryTxSignature && (
                    <div className="flex items-center gap-1 pt-1">
                      <span className="text-muted-foreground">Entry Tx: </span>
                      <a
                        href={`https://solscan.io/tx/${trade.entryTxSignature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-cyan-400 hover:underline flex items-center gap-1"
                      >
                        {shortenTx(trade.entryTxSignature)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                  {trade.exitTxSignatures.length > 0 && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Exit Tx: </span>
                      {trade.exitTxSignatures.map((sig, i) => (
                        <a
                          key={i}
                          href={`https://solscan.io/tx/${sig}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-cyan-400 hover:underline flex items-center gap-1"
                        >
                          {shortenTx(sig)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!maximized && displayTrades.length > visibleTrades.length && onMaximize && (
        <button
          onClick={onMaximize}
          className="text-xs text-muted-foreground hover:text-cyan-400 text-center py-1.5 border-t shrink-0"
        >
          +{displayTrades.length - visibleTrades.length} more — click to expand
        </button>
      )}
    </Card>
  );
}
