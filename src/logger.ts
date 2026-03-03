// ── Structured logging system for pump-trader ──
// All log entries are stored in memory (ring buffer) and exposed via API for the dashboard terminal.

export type LogLevel = "info" | "warn" | "error" | "debug" | "trade" | "signal" | "api" | "system";

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_LOG_ENTRIES = 2_000;
let nextId = 1;

class Logger {
  private entries: LogEntry[] = [];
  private listeners: Array<(entry: LogEntry) => void> = [];

  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = {
      id: nextId++,
      timestamp: Date.now(),
      level,
      category,
      message,
      data,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries = this.entries.slice(-MAX_LOG_ENTRIES);
    }

    // Console output with formatting
    const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
    const prefix = `[${ts}] [${level.toUpperCase().padEnd(6)}] [${category}]`;
    const line = `${prefix} ${message}`;

    switch (level) {
      case "error":
        console.error(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "debug":
        break; // silent in console, visible in dashboard
      default:
        console.log(line);
        break;
    }

    // Notify listeners (for SSE/WebSocket streaming to dashboard)
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // never crash on listener failure
      }
    }

    return entry;
  }

  // Convenience methods
  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("error", category, message, data);
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", category, message, data);
  }

  trade(message: string, data?: Record<string, unknown>): void {
    this.log("trade", "TRADE", message, data);
  }

  signal(message: string, data?: Record<string, unknown>): void {
    this.log("signal", "SIGNAL", message, data);
  }

  api(message: string, data?: Record<string, unknown>): void {
    this.log("api", "API", message, data);
  }

  system(message: string, data?: Record<string, unknown>): void {
    this.log("system", "SYSTEM", message, data);
  }

  /** Get all log entries (for initial dashboard load) */
  getAll(): LogEntry[] {
    return [...this.entries];
  }

  /** Get entries after a given ID (for polling) */
  getAfter(afterId: number): LogEntry[] {
    return this.entries.filter((e) => e.id > afterId);
  }

  /** Subscribe to new entries (returns unsubscribe function) */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Clear all logs */
  clear(): void {
    this.entries = [];
  }
}

/** Singleton logger instance */
export const logger = new Logger();
