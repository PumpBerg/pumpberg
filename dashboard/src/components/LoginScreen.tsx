import { useState } from "react";
import { Card, CardContent, Button, Input } from "./ui";
import { login } from "@/api";

interface LoginScreenProps {
  onLogin: (token: string) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await login(username, password);
      if (result.ok && result.token) {
        onLogin(result.token);
      } else {
        setError(result.error || "Login failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm bg-zinc-900 border-zinc-700">
        <div className="px-6 pt-6 pb-4 text-center">
          <img src="/logo.png" alt="Pumpberg" className="h-12 w-12 rounded mx-auto" />
          <h1 className="text-lg font-bold mt-2 tracking-tight">Pumpberg</h1>
          <p className="text-xs text-muted-foreground mt-1">Sign in to control your trading bot</p>
        </div>

        <CardContent className="pt-0">
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-300">Username</label>
              <Input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Enter username"
                autoComplete="username"
                required
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-300">Password</label>
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <div className="text-xs text-red-400 bg-red-400/10 border border-red-500/30 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
