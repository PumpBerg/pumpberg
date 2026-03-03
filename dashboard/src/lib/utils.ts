import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatTimeFull(ts: number): string {
  return new Date(ts).toLocaleString("en-US", { hour12: false });
}

export function shortenAddress(addr: string, chars = 6): string {
  if (!addr) return "";
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

export function shortenTx(sig: string, chars = 8): string {
  if (!sig) return "";
  return `${sig.slice(0, chars)}...${sig.slice(-4)}`;
}

export function formatSol(sol: number, decimals = 4): string {
  return sol.toFixed(decimals);
}

export function formatPct(pct: number): string {
  const p = pct * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
