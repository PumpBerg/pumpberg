import { useState, useEffect, useCallback } from "react";
import { Wallet, Trophy, TrendingUp, Copy, Check, ExternalLink } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, Badge, Button, Input, Stat } from "./ui";
import { getMiningStatus, getPoints, setMiningWallet, getLeaderboard, type MiningStatus, type PointsSummary, type LeaderboardEntry } from "@/api";

export function MiningPanel() {
  const [mining, setMining] = useState<MiningStatus | null>(null);
  const [points, setPoints] = useState<PointsSummary | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [totalMiners, setTotalMiners] = useState(0);
  const [walletInput, setWalletInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"overview" | "leaderboard">("overview");

  const refresh = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([
        getMiningStatus().catch(() => null),
        getPoints().catch(() => null),
      ]);
      if (m) setMining(m);
      if (p) setPoints(p);
    } catch {}
  }, []);

  const loadLeaderboard = useCallback(async () => {
    try {
      const data = await getLeaderboard(50);
      setLeaderboard(data.leaderboard);
      setTotalMiners(data.totalMiners);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    loadLeaderboard();
    const interval = setInterval(() => {
      refresh();
      if (tab === "leaderboard") loadLeaderboard();
    }, 30_000);
    return () => clearInterval(interval);
  }, [refresh, loadLeaderboard, tab]);

  const handleSetWallet = async () => {
    if (!walletInput || walletInput.length < 32) {
      setError("Enter a valid Solana wallet address");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setMiningWallet(walletInput);
      setWalletInput("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set wallet");
    } finally {
      setSaving(false);
    }
  };

  const copyWallet = () => {
    if (mining?.walletAddress) {
      navigator.clipboard.writeText(mining.walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const shortenWallet = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <Card className="bg-gradient-to-br from-zinc-900 via-purple-950/20 to-zinc-900 border-purple-500/30">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <span>⛏️</span> Pumpberg Mining
          </CardTitle>
          <div className="flex gap-1">
            <button
              onClick={() => setTab("overview")}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                tab === "overview" ? "bg-purple-500/30 text-purple-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => { setTab("leaderboard"); loadLeaderboard(); }}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                tab === "leaderboard" ? "bg-purple-500/30 text-purple-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Leaderboard
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {tab === "overview" && (
          <>
            {/* Points Stats */}
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Total Points" value={points?.totalPoints?.toFixed(1) ?? "0"} />
              <Stat label="Trades Mined" value={String(points?.totalTrades ?? 0)} />
              <Stat label="Avg/Trade" value={points?.averagePointsPerTrade?.toFixed(2) ?? "0"} />
            </div>

            {/* Wallet Setup */}
            {mining?.walletAddress ? (
              <div className="flex items-center gap-2 bg-zinc-800/50 rounded-md px-3 py-2">
                <Wallet className="h-4 w-4 text-purple-400 shrink-0" />
                <span className="text-xs text-zinc-300 font-mono">{shortenWallet(mining.walletAddress)}</span>
                <button onClick={copyWallet} className="ml-auto text-zinc-400 hover:text-white">
                  {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-zinc-400">
                  Set your Solana wallet to earn $PUMPBERG points for contributing trade data.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={walletInput}
                    onChange={(e) => setWalletInput(e.target.value)}
                    placeholder="Solana wallet address..."
                    className="text-xs font-mono"
                  />
                  <Button onClick={handleSetWallet} disabled={saving} className="shrink-0 text-xs">
                    {saving ? "..." : "Set"}
                  </Button>
                </div>
                {error && <p className="text-xs text-red-400">{error}</p>}
              </div>
            )}

            {/* Mining Status */}
            <div className="flex items-center gap-2 text-xs">
              <div className={`w-1.5 h-1.5 rounded-full ${mining?.dataSharingEnabled ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
              <span className={mining?.dataSharingEnabled ? "text-green-400" : "text-zinc-400"}>
                {mining?.dataSharingEnabled ? "Mining Active" : "Mining Disabled"}
              </span>
              {mining?.totalPoints != null && mining.totalPoints > 0 && (
                <Badge className="ml-auto bg-purple-500/20 text-purple-300 border-purple-500/30">
                  {mining.totalPoints.toFixed(1)} pts
                </Badge>
              )}
            </div>

            {/* How Points Work */}
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300 transition-colors">How mining works</summary>
              <div className="mt-2 space-y-1 pl-2 border-l border-purple-500/20">
                <p>Base: <strong>1.0 pt</strong> per synced trade</p>
                <p>+0.5 social signal data</p>
                <p>+0.5 smart money data</p>
                <p>+0.5 live trade (not dry-run)</p>
                <p>+1.0 post-sale monitoring</p>
                <p>+0.25 creator reputation</p>
                <p>+0.25 whale detection</p>
                <p className="text-purple-400 mt-1">Max: 4.0 pts per trade</p>
              </div>
            </details>
          </>
        )}

        {tab === "leaderboard" && (
          <>
            <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
              <span>{totalMiners} miners</span>
              <button onClick={loadLeaderboard} className="hover:text-white transition-colors">↻ Refresh</button>
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {leaderboard.length === 0 ? (
                <p className="text-xs text-zinc-500 text-center py-4">No miners yet. Be the first!</p>
              ) : (
                leaderboard.map((entry) => (
                  <div
                    key={entry.walletAddress}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                      mining?.walletAddress === entry.walletAddress
                        ? "bg-purple-500/20 border border-purple-500/30"
                        : "bg-zinc-800/30 hover:bg-zinc-800/50"
                    }`}
                  >
                    <span className={`w-5 text-right font-bold ${
                      entry.rank <= 3 ? "text-yellow-400" : "text-zinc-500"
                    }`}>
                      {entry.rank <= 3 ? ["🥇", "🥈", "🥉"][entry.rank - 1] : `#${entry.rank}`}
                    </span>
                    <span className="font-mono text-zinc-300">{shortenWallet(entry.walletAddress)}</span>
                    <span className="ml-auto font-bold text-purple-300">{entry.totalPoints.toFixed(1)}</span>
                    <span className="text-zinc-500">{entry.totalTrades} trades</span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
