import { useState, useEffect, useCallback } from "react";
import { Settings2, Key, Shield, Database, Save, Eye, EyeOff, CheckCircle, AlertTriangle, User } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent, Badge, Button, Input } from "./ui";
import { getSettings, updateSettings, getSetupStatus, getMe, changePassword, updateApiKeys, type SettingsResponse, type SetupStatusResponse, type AuthUser } from "@/api";

type SettingsData = SettingsResponse;
type SetupStatus = SetupStatusResponse;

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [activeTab, setActiveTab] = useState<"credentials" | "account" | "data">("credentials");

  // Form fields for credentials (only sent on save, never pre-filled with actual keys)
  const [privateKey, setPrivateKey] = useState("");
  const [rpcUrl, setRpcUrl] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [pumpApiKey, setPumpApiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [dataSharingEnabled, setDataSharingEnabled] = useState(true);

  // Account tab fields
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");

  useEffect(() => {
    Promise.all([getSettings(), getSetupStatus(), getMe()]).then(([s, st, me]) => {
      setSettings(s);
      setSetupStatus(st);
      setCurrentUser(me.user);
      setDataSharingEnabled(s.dataSharingEnabled);
      // Pre-fill non-sensitive fields
      if (s.solanaRpcUrl && !s.solanaRpcUrl.includes("***")) setRpcUrl(s.solanaRpcUrl);
      if (s.solanaWsUrl && !s.solanaWsUrl.includes("***")) setWsUrl(s.solanaWsUrl);
      if (s.publicKey) setPublicKey(s.publicKey);
    }).catch(console.error);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      // Save per-user API keys
      const keyUpdates: Record<string, string> = {};
      if (privateKey) keyUpdates.solanaPrivateKey = privateKey;
      if (rpcUrl) keyUpdates.solanaRpcUrl = rpcUrl;
      if (wsUrl) keyUpdates.solanaWsUrl = wsUrl;
      if (pumpApiKey) keyUpdates.pumpPortalApiKey = pumpApiKey;
      if (anthropicKey) keyUpdates.anthropicApiKey = anthropicKey;
      if (publicKey) keyUpdates.publicKey = publicKey;

      if (Object.keys(keyUpdates).length > 0) {
        await updateApiKeys(keyUpdates);
      }

      // Save global settings (admin-only fields like data sharing)
      const settingsUpdates: Record<string, unknown> = {};
      settingsUpdates.dataSharingEnabled = dataSharingEnabled;
      settingsUpdates.setupComplete = true;
      await updateSettings(settingsUpdates);

      // Refresh settings display
      const [updated, me] = await Promise.all([getSettings(), getMe()]);
      setSettings(updated);
      setCurrentUser(me.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [privateKey, rpcUrl, wsUrl, pumpApiKey, anthropicKey, publicKey, dataSharingEnabled]);

  const handleChangePassword = useCallback(async () => {
    setPasswordMsg("");
    setError("");
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (result.ok) {
        setPasswordMsg("Password changed successfully");
        setCurrentPassword("");
        setNewPassword("");
        setTimeout(() => setPasswordMsg(""), 3000);
      } else {
        setError(result.error || "Failed to change password");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change password");
    }
  }, [currentPassword, newPassword]);

  const tabs = [
    { id: "credentials" as const, label: "API Keys", icon: Key },
    { id: "account" as const, label: "Account", icon: User },
    { id: "data" as const, label: "Data Sharing", icon: Database },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <Card className="w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col bg-zinc-900 border-zinc-700">
        <CardHeader className="flex-shrink-0">
          <div className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-blue-400" />
            <CardTitle className="text-base">Settings</CardTitle>
            {currentUser && (
              <Badge variant={currentUser.role === "admin" ? "warning" : "outline"} className="ml-2">
                <Shield className="w-3 h-3 mr-1" />
                {currentUser.role === "admin" ? "Admin" : currentUser.username}
              </Badge>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white text-lg">&times;</button>
        </CardHeader>

        {/* Tabs */}
        <div className="flex border-b border-zinc-700 px-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-blue-400 text-blue-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        <CardContent className="flex-1 overflow-y-auto space-y-4 py-4">
          {/* ── Credentials Tab ── */}
          {activeTab === "credentials" && (
            <div className="space-y-4">
              <div className="text-xs text-zinc-400 mb-2">
                API keys are stored per-user and never shared with other accounts.
                {currentUser && !currentUser.apiKeys?.solanaPrivateKeySet && (
                  <span className="block mt-1 text-yellow-400">
                    <AlertTriangle className="inline w-3 h-3 mr-1" />
                    Complete setup by entering your Solana private key and RPC URL.
                  </span>
                )}
              </div>

              {/* Private Key */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                  Solana Private Key
                  {currentUser?.apiKeys?.solanaPrivateKeySet ? (
                    <Badge variant="success" className="text-[10px]">Configured</Badge>
                  ) : (
                    <Badge variant="danger" className="text-[10px]">Required</Badge>
                  )}
                </label>
                <div className="relative">
                  <Input
                    type={showPrivateKey ? "text" : "password"}
                    value={privateKey}
                    onChange={e => setPrivateKey(e.target.value)}
                    placeholder={currentUser?.apiKeys?.solanaPrivateKeySet ? "••••••• (already set, enter to change)" : "Base58 private key"}
                    className="pr-8 font-mono text-[11px]"
                  />
                  <button
                    onClick={() => setShowPrivateKey(!showPrivateKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                  >
                    {showPrivateKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* RPC URL */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                  Solana RPC URL
                  {currentUser?.apiKeys?.solanaRpcUrlSet ? (
                    <Badge variant="success" className="text-[10px]">Configured</Badge>
                  ) : (
                    <Badge variant="danger" className="text-[10px]">Required</Badge>
                  )}
                </label>
                <Input
                  value={rpcUrl}
                  onChange={e => setRpcUrl(e.target.value)}
                  placeholder={currentUser?.apiKeys?.solanaRpcUrlSet ? "wss://*** (already set)" : "wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY"}
                  className="font-mono text-[11px]"
                />
                <p className="text-[10px] text-zinc-500">Free tier at helius.dev (100k credits/day)</p>
              </div>

              {/* Public Key */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300">Wallet Public Key</label>
                <Input
                  value={publicKey}
                  onChange={e => setPublicKey(e.target.value)}
                  placeholder="Your Solana wallet public key"
                  className="font-mono text-[11px]"
                />
              </div>

              {/* Anthropic API Key */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                  Anthropic API Key
                  {currentUser?.apiKeys?.anthropicApiKeySet ? (
                    <Badge variant="success" className="text-[10px]">Configured</Badge>
                  ) : (
                    <Badge variant="warning" className="text-[10px]">Optional</Badge>
                  )}
                </label>
                <Input
                  type="password"
                  value={anthropicKey}
                  onChange={e => setAnthropicKey(e.target.value)}
                  placeholder={currentUser?.apiKeys?.anthropicApiKeySet ? "••••••• (already set)" : "sk-ant-..."}
                  className="font-mono text-[11px]"
                />
                <p className="text-[10px] text-zinc-500">Required for AI agent mode. Get one at console.anthropic.com</p>
              </div>

              {/* PumpPortal API Key */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300 flex items-center gap-2">
                  PumpPortal API Key
                  <Badge variant="outline" className="text-[10px]">Optional</Badge>
                </label>
                <Input
                  type="password"
                  value={pumpApiKey}
                  onChange={e => setPumpApiKey(e.target.value)}
                  placeholder={currentUser?.apiKeys?.pumpPortalApiKeySet ? "••••••• (already set)" : "For authenticated PumpPortal endpoints"}
                  className="font-mono text-[11px]"
                />
              </div>
            </div>
          )}

          {/* ── Account Tab ── */}
          {activeTab === "account" && (
            <div className="space-y-4">
              {currentUser && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-300">Username</label>
                    <div className="bg-zinc-800 rounded-md px-3 py-2 font-mono text-[11px] text-zinc-300">
                      {currentUser.username}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-300">Email</label>
                    <div className="bg-zinc-800 rounded-md px-3 py-2 font-mono text-[11px] text-zinc-300">
                      {currentUser.email}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-zinc-300">Role</label>
                    <div className="flex items-center gap-2">
                      <Badge variant={currentUser.role === "admin" ? "warning" : "outline"} className="text-sm px-3 py-1">
                        <Shield className="w-4 h-4 mr-1.5" />
                        {currentUser.role === "admin" ? "Admin" : "User"}
                      </Badge>
                    </div>
                  </div>

                  <div className="border-t border-zinc-700 pt-4 mt-4">
                    <h3 className="text-xs font-medium text-zinc-300 mb-3">Change Password</h3>
                    <div className="space-y-2">
                      <Input
                        type="password"
                        value={currentPassword}
                        onChange={e => setCurrentPassword(e.target.value)}
                        placeholder="Current password"
                        className="font-mono text-[11px]"
                      />
                      <Input
                        type="password"
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        placeholder="New password (min 8 characters)"
                        className="font-mono text-[11px]"
                      />
                      <Button size="sm" onClick={handleChangePassword} disabled={!currentPassword || !newPassword}>
                        Change Password
                      </Button>
                      {passwordMsg && (
                        <p className="text-xs text-green-400 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" /> {passwordMsg}
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-300">Instance ID</label>
                <div className="bg-zinc-800 rounded-md px-3 py-2 font-mono text-[11px] text-zinc-300">
                  {settings?.instanceId || "Loading..."}
                </div>
                <p className="text-[10px] text-zinc-500">Anonymous identifier for this installation.</p>
              </div>
            </div>
          )}

          {/* ── Data Sharing Tab ── */}
          {activeTab === "data" && (
            <div className="space-y-4">
              <div className="text-xs text-zinc-400 mb-2">
                When enabled, anonymized trade data (scores, outcomes, patterns) is synced to the central server
                to improve the AI for all users. Your wallet address and position sizes are <strong className="text-zinc-200">never</strong> shared.
              </div>

              <div className="flex items-center justify-between p-3 border border-zinc-700 rounded-md">
                <div>
                  <p className="text-xs font-medium text-zinc-200">Share anonymized trade data</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">Helps improve RAG patterns for everyone</p>
                </div>
                <button
                  onClick={() => setDataSharingEnabled(!dataSharingEnabled)}
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    dataSharingEnabled ? "bg-blue-500" : "bg-zinc-600"
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform ${
                      dataSharingEnabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              <div className="p-3 border border-zinc-700 rounded-md bg-zinc-800/50">
                <p className="text-xs font-medium text-zinc-300 mb-2">What gets shared:</p>
                <ul className="text-[10px] text-zinc-400 space-y-1">
                  <li className="flex items-center gap-1.5">
                    <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" /> Signal scores, LLM scores, market metrics
                  </li>
                  <li className="flex items-center gap-1.5">
                    <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" /> Trade outcomes (win/loss), exit reasons, PnL %
                  </li>
                  <li className="flex items-center gap-1.5">
                    <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" /> Feature embeddings & loss pattern categories
                  </li>
                  <li className="flex items-center gap-1.5">
                    <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" /> Social signals, whale data, smart money indicators
                  </li>
                </ul>
                <p className="text-xs font-medium text-zinc-300 mt-3 mb-2">What is <strong className="text-red-400">never</strong> shared:</p>
                <ul className="text-[10px] text-zinc-400 space-y-1">
                  <li className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" /> Your wallet address or private key
                  </li>
                  <li className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" /> Position sizes in SOL (only % PnL is shared)
                  </li>
                  <li className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" /> Your API keys or credentials
                  </li>
                </ul>
              </div>
            </div>
          )}
        </CardContent>

        {/* Footer */}
        <div className="flex-shrink-0 border-t border-zinc-700 px-4 py-3 flex items-center justify-between">
          <div className="text-xs">
            {error && <span className="text-red-400">{error}</span>}
            {saved && <span className="text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Saved! Restart the bot for changes to take effect.</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <Save className="w-3.5 h-3.5 mr-1.5" />
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
