// ── Thinking/reasoning log — records the bot's decision-making process ──

export interface ThinkingEntry {
  id: number;
  timestamp: number;
  mint: string;
  symbol: string;
  type: "evaluation" | "entry" | "exit" | "risk-check" | "skip";
  decision: string;
  reasoning: string[];
  factors?: Record<string, number>;
  data?: Record<string, unknown>;
}

const MAX_THINKING_ENTRIES = 500;
let nextThinkingId = 1;

class ThinkingLog {
  private entries: ThinkingEntry[] = [];
  private listeners: Array<(entry: ThinkingEntry) => void> = [];

  add(entry: Omit<ThinkingEntry, "id" | "timestamp">): ThinkingEntry {
    const full: ThinkingEntry = {
      ...entry,
      id: nextThinkingId++,
      timestamp: Date.now(),
    };

    this.entries.push(full);
    if (this.entries.length > MAX_THINKING_ENTRIES) {
      this.entries = this.entries.slice(-MAX_THINKING_ENTRIES);
    }

    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {}
    }

    return full;
  }

  getAll(): ThinkingEntry[] {
    return [...this.entries];
  }

  getAfter(afterId: number): ThinkingEntry[] {
    return this.entries.filter((e) => e.id > afterId);
  }

  subscribe(listener: (entry: ThinkingEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

export const thinkingLog = new ThinkingLog();
