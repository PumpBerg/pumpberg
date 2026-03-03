import { useState } from "react";
import { Card, CardContent, Button, Input } from "./ui";
import { login, register } from "@/api";

interface LoginScreenProps {
  onLogin: (token: string) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (mode === "login") {
        const result = await login(username, password);
        if (result.ok && result.token) {
          onLogin(result.token);
        } else {
          setError(result.error || "Login failed");
        }
      } else {
        const result = await register(username, email, password);
        if (result.ok && result.token) {
          onLogin(result.token);
        } else {
          setError(result.error || "Registration failed");
        }
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
        <div className="px-6 pt-6 pb-2 text-center">
          <img src="/logo.png" alt="Pumpberg" className="h-12 w-12 rounded mx-auto" />
          <h1 className="text-lg font-bold mt-2 tracking-tight">Pumpberg</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {mode === "login" ? "Sign in to your account" : "Create a new account"}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-700 mx-6">
          <button
            onClick={() => { setMode("login"); setError(""); }}
            className={`flex-1 py-2 text-xs font-medium border-b-2 transition-colors ${
              mode === "login"
                ? "border-blue-400 text-blue-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Sign In
          </button>
          <button
            onClick={() => { setMode("signup"); setError(""); }}
            className={`flex-1 py-2 text-xs font-medium border-b-2 transition-colors ${
              mode === "signup"
                ? "border-blue-400 text-blue-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Sign Up
          </button>
        </div>

        <CardContent className="pt-4">
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

            {mode === "signup" && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300">Email</label>
                <Input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-300">Password</label>
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "Min 8 characters" : "Enter password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
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
              {loading
                ? (mode === "login" ? "Signing in..." : "Creating account...")
                : (mode === "login" ? "Sign In" : "Create Account")
              }
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
