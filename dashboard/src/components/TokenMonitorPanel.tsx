import { useState } from "react";
import { Radar, ChevronDown, ChevronUp, TrendingUp, Maximize2, Minimize2 } from "lucide-react";
import { Card, CardHeader, CardTitle, Badge, Button } from "./ui";
import { cn, formatSol, shortenAddress } from "@/lib/utils";
import type { TrackedToken } from "@/types";

interface TokenMonitorPanelProps {
  tokens: TrackedToken[];
  compact?: boolean;
  maximized?: boolean;
  onMaximize?: () => void;
}

export function TokenMonitorPanel({ tokens, compact, maximized, onMaximize }: TokenMonitorPanelProps) {
  const visibleTokens = maximized ? tokens : compact ? tokens.slice(0, 5) : tokens.slice(0, 8);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-purple-400" />
          <CardTitle>Tokens</CardTitle>
          <Badge variant="outline" className="tabular-nums">{tokens.length}</Badge>
        </div>
        {onMaximize && (
          <Button size="icon" variant="ghost" onClick={onMaximize} title={maximized ? "Minimize" : "Maximize"}>
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        )}
      </CardHeader>

      <div className={cn("overflow-y-auto", maximized ? "flex-1" : compact ? "max-h-48" : "max-h-72")}>
        {/* Header row */}
        <div className="grid grid-cols-[1fr_80px_80px_60px_60px_50px] gap-1 px-4 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-b sticky top-0 bg-card">
          <span>Token</span>
          <span className="text-right">MCap</span>
          <span className="text-right">Vol (60s)</span>
          <span className="text-right">Buys</span>
          <span className="text-right">Buyers</span>
          <span className="text-right">Score</span>
        </div>

        {tokens.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-6">No tokens tracked yet</div>
        )}

        {visibleTokens.map((token) => {
          const score = token.lastSignalScore;
          const scoreColor =
            score === undefined ? "text-muted-foreground" :
            score >= 65 ? "text-green-400" :
            score >= 45 ? "text-yellow-400" :
            "text-red-400";

          return (
            <div key={token.mint} className="grid grid-cols-[1fr_80px_80px_60px_60px_50px] gap-1 px-4 py-2 text-xs border-b last:border-0 hover:bg-white/[0.02]">
              <div className="flex items-center gap-2 min-w-0">
                <div className="truncate">
                  <span className="font-bold">{token.symbol}</span>
                  <span className="text-muted-foreground ml-1.5">{shortenAddress(token.mint, 4)}</span>
                </div>
                {token.bondingCurveProgress > 0.8 && (
                  <Badge variant="warning" className="shrink-0 text-[9px] px-1">
                    <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
                    {(token.bondingCurveProgress * 100).toFixed(0)}%
                  </Badge>
                )}
              </div>
              <span className="text-right font-mono tabular-nums">{formatSol(token.marketCapSol, 1)}</span>
              <span className="text-right font-mono tabular-nums">{formatSol(token.recentVolumeSol, 2)}</span>
              <span className="text-right font-mono tabular-nums">
                <span className="text-green-400">{token.buyCount}</span>
                <span className="text-muted-foreground">/</span>
                <span className="text-red-400">{token.sellCount}</span>
              </span>
              <span className="text-right font-mono tabular-nums">{token.uniqueBuyers}</span>
              <span className={cn("text-right font-bold tabular-nums", scoreColor)}>
                {score !== undefined ? score : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {!maximized && tokens.length > visibleTokens.length && onMaximize && (
        <button
          onClick={onMaximize}
          className="text-xs text-muted-foreground hover:text-purple-400 text-center py-1.5 border-t"
        >
          +{tokens.length - visibleTokens.length} more — click to expand
        </button>
      )}
    </Card>
  );
}
