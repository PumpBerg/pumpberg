import { useState, useRef, useEffect, useCallback } from "react";
import { MessageCircle, Send, Trash2, Maximize2, Minimize2, Loader2, Wrench, Bot, User } from "lucide-react";
import { Card, CardHeader, CardTitle, Badge, Button } from "./ui";
import { cn } from "@/lib/utils";
import { sendChatMessage, getChatHistory, clearChatHistory } from "@/api";
import type { ChatMessage } from "@/types";

interface ChatPanelProps {
  compact?: boolean;
  maximized?: boolean;
  onMaximize?: () => void;
  onConfigChanged?: () => void;
}

export function ChatPanel({ compact, maximized, onMaximize, onConfigChanged }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load history on mount
  useEffect(() => {
    getChatHistory()
      .then((data) => setMessages(data.messages))
      .catch(() => {});
  }, []);

  // Poll for autonomous agent messages every 10s
  useEffect(() => {
    const interval = setInterval(() => {
      getChatHistory()
        .then((data) => {
          setMessages((prev) => {
            // Only update if there are new messages
            if (data.messages.length > prev.length) {
              // Check if latest messages include autonomous decisions
              const newMsgs = data.messages.slice(prev.length);
              const hasAutonomous = newMsgs.some((m: ChatMessage) => m.autonomous);
              if (hasAutonomous) {
                onConfigChanged?.();
              }
              return data.messages;
            }
            return prev;
          });
        })
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(interval);
  }, [onConfigChanged]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    setSending(true);

    // Optimistically add user message
    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const result = await sendChatMessage(text);
      if (result.ok && result.message) {
        // Replace optimistic messages with server response
        setMessages((prev) => {
          // Remove the temp user message, add both from server history
          const withoutTemp = prev.filter((m) => m.id !== tempUserMsg.id);
          // The server returns the assistant message; re-add user + assistant
          return [
            ...withoutTemp,
            { ...tempUserMsg, id: result.message.id - 1 },
            result.message,
          ];
        });

        // If the agent changed config, trigger a refresh
        if (result.message.actions && result.message.actions.length > 0) {
          onConfigChanged?.();
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Failed to send message"}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, sending, onConfigChanged]);

  const handleClear = useCallback(async () => {
    await clearChatHistory().catch(() => {});
    setMessages([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-blue-400" />
          <CardTitle>Chat</CardTitle>
          <Badge variant="outline" className="tabular-nums">{messages.length}</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={handleClear} title="Clear chat">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          {onMaximize && (
            <Button size="icon" variant="ghost" onClick={onMaximize} title={maximized ? "Minimize" : "Maximize"}>
              {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </CardHeader>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-3 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs gap-2 opacity-60">
            <MessageCircle className="h-8 w-8" />
            <p>Talk to your trading agent</p>
            <p className="text-center max-w-[200px]">Ask questions, get explanations, or tell it to change settings</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex flex-col gap-1",
              msg.role === "user" ? "items-end" : "items-start",
            )}
          >
            {/* Autonomous badge */}
            {msg.autonomous && (
              <div className="flex items-center gap-1 text-[10px] text-purple-400 px-1">
                <Bot className="h-3 w-3" />
                <span>Autonomous Decision</span>
              </div>
            )}

            <div
              className={cn(
                "rounded-lg px-3 py-2 text-xs leading-relaxed max-w-[85%] whitespace-pre-wrap break-words",
                msg.role === "user"
                  ? "bg-blue-600/20 text-blue-100 border border-blue-500/20"
                  : msg.autonomous
                    ? "bg-purple-900/20 border border-purple-500/20 text-foreground"
                    : "bg-card border border-border text-foreground",
              )}
            >
              <MessageContent content={msg.content} />
            </div>

            {/* Config change actions */}
            {msg.actions && msg.actions.length > 0 && (
              <div className="flex flex-wrap gap-1 max-w-[85%]">
                {msg.actions.map((action, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  >
                    <Wrench className="h-2.5 w-2.5" />
                    {action.field}: {String(action.oldValue)} → {String(action.newValue)}
                  </span>
                ))}
              </div>
            )}

            <span className="text-[10px] text-muted-foreground px-1">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}

        {sending && (
          <div className="flex items-start gap-2">
            <div className="rounded-lg px-3 py-2 bg-card border border-border">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t px-3 py-2 flex gap-2 items-center shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent..."
          disabled={sending}
          className={cn(
            "flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50",
            "border border-border rounded-md px-3 py-1.5",
            "focus:border-blue-500/50 transition-colors",
          )}
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="shrink-0"
          title="Send"
        >
          <Send className={cn("h-3.5 w-3.5", input.trim() ? "text-blue-400" : "text-muted-foreground")} />
        </Button>
      </div>
    </Card>
  );
}

/** Simple markdown-ish renderer for agent responses */
function MessageContent({ content }: { content: string }) {
  // Split into lines and render with basic formatting
  const parts = content.split(/(\*\*.*?\*\*|`.*?`|\n)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part === "\n") return <br key={i} />;
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
