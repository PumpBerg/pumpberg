import { useState } from "react";
import { KeyRound, Rocket } from "lucide-react";
import { updateApiKeys, completeSetup } from "../api";

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [privateKey, setPrivateKey] = useState("");
  const [rpcUrl, setRpcUrl] = useState("https://api.mainnet-beta.solana.com");
  const [wsUrl, setWsUrl] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [pumpApiKey, setPumpApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Validate required fields
    if (!privateKey.trim()) {
      setError("Solana Private Key is required");
      return;
    }
    if (!rpcUrl.trim()) {
      setError("RPC URL is required");
      return;
    }
    if (!publicKey.trim()) {
      setError("Public Key is required");
      return;
    }

    setLoading(true);
    try {
      // Save API keys
      const keys: Record<string, string> = {
        solanaPrivateKey: privateKey.trim(),
        solanaRpcUrl: rpcUrl.trim(),
        publicKey: publicKey.trim(),
      };
      if (wsUrl.trim()) keys.solanaWsUrl = wsUrl.trim();
      if (anthropicKey.trim()) keys.anthropicApiKey = anthropicKey.trim();
      if (pumpApiKey.trim()) keys.pumpPortalApiKey = pumpApiKey.trim();

      await updateApiKeys(keys);

      // Mark setup complete
      await completeSetup();

      // Notify parent
      onComplete();
    } catch (err: any) {
      setError(err?.message || "Failed to save settings");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-gray-800/90 backdrop-blur-sm rounded-lg shadow-2xl border border-purple-500/20 p-8">
        <div className="flex items-center gap-3 mb-6">
          <Rocket className="w-8 h-8 text-purple-400" />
          <h1 className="text-3xl font-bold text-white">Welcome to Pumpberg!</h1>
        </div>
        
        <p className="text-gray-300 mb-6">
          To get started, please enter your API keys below. These will be stored locally on your computer and are never uploaded to any server.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Required Fields */}
          <div className="bg-gray-900/50 rounded-lg p-4 border border-purple-500/30">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-purple-400" />
              Required Configuration
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Solana Private Key <span className="text-red-400">*</span>
                </label>
                <input
                  type="password"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-purple-500"
                  placeholder="Your Solana wallet private key"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Solana RPC URL <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={rpcUrl}
                  onChange={(e) => setRpcUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-purple-500"
                  placeholder="https://api.mainnet-beta.solana.com"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Public Key <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-purple-500"
                  placeholder="Your Solana wallet public key"
                  required
                />
              </div>
            </div>
          </div>

          {/* Optional Fields */}
          <div className="bg-gray-900/30 rounded-lg p-4 border border-gray-700/30">
            <h2 className="text-lg font-semibold text-gray-300 mb-4">
              Optional Configuration
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Solana WebSocket URL
                </label>
                <input
                  type="text"
                  value={wsUrl}
                  onChange={(e) => setWsUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800/50 border border-gray-700 rounded text-white focus:outline-none focus:border-purple-500"
                  placeholder="wss://api.mainnet-beta.solana.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Anthropic API Key
                </label>
                <input
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800/50 border border-gray-700 rounded text-white focus:outline-none focus:border-purple-500"
                  placeholder="sk-ant-..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  PumpPortal API Key
                </label>
                <input
                  type="password"
                  value={pumpApiKey}
                  onChange={(e) => setPumpApiKey(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800/50 border border-gray-700 rounded text-white focus:outline-none focus:border-purple-500"
                  placeholder="Your PumpPortal API key"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 rounded px-4 py-3 text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Rocket className="w-5 h-5" />
                Complete Setup
              </>
            )}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-400">
          <p>All API keys are stored locally on your computer</p>
          <p>They are never shared or uploaded to any external server</p>
        </div>
      </div>
    </div>
  );
}
