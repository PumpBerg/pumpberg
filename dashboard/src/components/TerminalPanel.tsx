import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Maximize2, Minimize2, Trash2, ChevronDown } from "lucide-react";
import { Card, CardHeader, CardTitle, Button, Badge } from "./ui";
import { cn, formatTime } from "@/lib/utils";
import type { LogEntry } from "@/types";

interface TerminalPanelProps {
  logs: LogEntry[];
  maximized?: boolean;
  onMaximize: () => void;
  onClear: () => void;
}

const LEVEL_COLORS: Record<string, string> = {
  info: "log-info",
  warn: "log-warn",
  error: "log-error",
  debug: "log-debug",
  trade: "log-trade",
  signal: "log-signal",
  api: "log-api",
  system: "log-system",
};

const LEVEL_LABELS: Record<string, string> = {
  info: "INF",
  warn: "WRN",
  error: "ERR",
  debug: "DBG",
  trade: "TRD",
  signal: "SIG",
  api: "API",
  system: "SYS",
};

export function TerminalPanel({ logs, maximized, onMaximize, onClear }: TerminalPanelProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const filteredLogs = filter ? logs.filter((l) => l.level === filter) : logs;

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [filteredLogs.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 60);
  }, []);

  const filterButtons: Array<{ label: string; value: string | null }> = [
    { label: "All", value: null },
    { label: "Trade", value: "trade" },
    { label: "Signal", value: "signal" },
    { label: "Error", value: "error" },
    { label: "API", value: "api" },
    { label: "System", value: "system" },
  ];

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-green-400" />
          <CardTitle>Terminal</CardTitle>
          <Badge variant="outline" className="ml-2 tabular-nums">{logs.length}</Badge>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-cyan-400 ml-2"
            >
              <ChevronDown className="h-3 w-3" /> Scroll to bottom
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {filterButtons.map((fb) => (
            <button
              key={fb.label}
              onClick={() => setFilter(fb.value)}
              className={cn(
                "px-2 py-0.5 text-xs rounded transition-colors",
                filter === fb.value
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {fb.label}
            </button>
          ))}
          <div className="w-px h-4 bg-border mx-1" />
          <Button size="icon" variant="ghost" onClick={onClear} title="Clear logs">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onMaximize} title={maximized ? "Minimize" : "Maximize"}>
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardHeader>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-5 bg-black/30"
      >
        {filteredLogs.length === 0 && (
          <div className="text-muted-foreground text-center py-8">
            Waiting for log entries...
            <span className="animate-blink ml-1">▌</span>
          </div>
        )}
        {filteredLogs.map((entry) => (
          <div key={entry.id} className="flex hover:bg-white/[0.02] px-1 rounded">
            <span className="text-muted-foreground/60 shrink-0 w-[72px]">
              {formatTime(entry.timestamp)}
            </span>
            <span className={cn("shrink-0 w-[32px] font-bold uppercase", LEVEL_COLORS[entry.level])}>
              {LEVEL_LABELS[entry.level] || entry.level.slice(0, 3).toUpperCase()}
            </span>
            <span className="text-muted-foreground/60 shrink-0 w-[56px] truncate">
              [{entry.category}]
            </span>
            <span className={cn("flex-1 break-all", LEVEL_COLORS[entry.level])}>
              {entry.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Live indicator */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t text-xs text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse-dot" />
        Live
      </div>
    </Card>
  );
}
