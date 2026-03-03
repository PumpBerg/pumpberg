import { useState } from "react";
import { Brain, ChevronDown, ChevronUp, ArrowRight, Ban, ShoppingCart, DoorOpen, ShieldAlert, Maximize2, Minimize2 } from "lucide-react";
import { Card, CardHeader, CardTitle, Badge, Button } from "./ui";
import { cn, formatTime, shortenAddress } from "@/lib/utils";
import type { ThinkingEntry } from "@/types";

interface ThinkingPanelProps {
  entries: ThinkingEntry[];
  compact?: boolean;
  maximized?: boolean;
  onMaximize?: () => void;
}

const TYPE_CONFIG: Record<string, { icon: typeof Brain; color: string; label: string }> = {
  evaluation: { icon: ArrowRight, color: "text-blue-400", label: "EVAL" },
  entry: { icon: ShoppingCart, color: "text-green-400", label: "BUY" },
  exit: { icon: DoorOpen, color: "text-orange-400", label: "SELL" },
  "risk-check": { icon: ShieldAlert, color: "text-red-400", label: "RISK" },
  skip: { icon: Ban, color: "text-gray-400", label: "SKIP" },
};

export function ThinkingPanel({ entries, compact, maximized, onMaximize }: ThinkingPanelProps) {
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);

  const reversed = [...entries].reverse();
  const visible = maximized ? reversed : compact ? reversed.slice(0, 4) : reversed.slice(0, 6);

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-violet-400" />
          <CardTitle>Thinking</CardTitle>
          <Badge variant="outline" className="tabular-nums">{entries.length}</Badge>
        </div>
        {onMaximize && (
          <Button size="icon" variant="ghost" onClick={onMaximize} title={maximized ? "Minimize" : "Maximize"}>
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        )}
      </CardHeader>

      <div className={cn("overflow-y-auto flex-1 min-h-0", maximized ? "" : compact ? "" : "max-h-72")}>
        {entries.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-6">
            No decisions recorded yet...
          </div>
        )}

        {visible.map((entry) => {
          const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.evaluation!;
          const Icon = config.icon;
          const isOpen = expandedEntry === entry.id;

          return (
            <div key={entry.id} className="border-b last:border-0">
              <button
                className="w-full flex items-start gap-2 px-4 py-2.5 text-xs hover:bg-white/[0.02] transition-colors"
                onClick={() => setExpandedEntry(isOpen ? null : entry.id)}
              >
                <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", config.color)} />
                <div className="flex-1 text-left min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn("text-[9px]", config.color)}>
                      {config.label}
                    </Badge>
                    <span className="font-bold">{entry.symbol}</span>
                    <span className="text-muted-foreground">{shortenAddress(entry.mint, 4)}</span>
                    <span className="text-muted-foreground ml-auto shrink-0">{formatTime(entry.timestamp)}</span>
                  </div>
                  <p className={cn("mt-1 font-medium", config.color)}>{entry.decision}</p>
                </div>
                <ChevronDown className={cn("h-3 w-3 text-muted-foreground mt-1 transition-transform shrink-0", isOpen && "rotate-180")} />
              </button>

              {isOpen && (
                <div className="px-4 pb-3 pl-10 space-y-1.5">
                  {/* Reasoning steps */}
                  <div className="space-y-1">
                    {entry.reasoning.map((r, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0">{i + 1}.</span>
                        <span className="text-foreground/80">{r}</span>
                      </div>
                    ))}
                  </div>

                  {/* Factor scores if available */}
                  {entry.factors && Object.keys(entry.factors).length > 0 && (
                    <div className="pt-2 border-t border-border/50">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Factor Scores</div>
                      <div className="grid grid-cols-4 gap-1">
                        {Object.entries(entry.factors).map(([key, value]) => (
                          <div key={key} className="flex items-center gap-1">
                            <div className="flex-1 bg-secondary rounded-full h-1.5">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  (value as number) >= 8 ? "bg-green-400" :
                                  (value as number) >= 5 ? "bg-yellow-400" :
                                  "bg-red-400",
                                )}
                                style={{ width: `${Math.min((value as number) * 10, 100)}%` }}
                              />
                            </div>
                            <span className="text-[9px] text-muted-foreground w-20 truncate">{key.replace(/Score$/, "")}</span>
                            <span className="text-[9px] font-mono w-4 text-right">{value as number}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!maximized && entries.length > visible.length && onMaximize && (
        <button
          onClick={onMaximize}
          className="text-xs text-muted-foreground hover:text-violet-400 text-center py-1.5 border-t shrink-0"
        >
          +{entries.length - visible.length} more — click to expand
        </button>
      )}
    </Card>
  );
}
