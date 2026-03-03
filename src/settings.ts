// ── Settings manager — replaces .env with a GUI-editable JSON store ──
//
// Settings are stored in data/settings.json and can be read/written from
// the dashboard UI. On boot, config.ts checks settings.json as a fallback
// when environment variables are not set.

import fs from "node:fs";
import path from "node:path";

export interface AppSettings {
  // ── Credentials (stored locally, never synced) ──
  solanaPrivateKey?: string;
  solanaRpcUrl?: string;
  solanaWsUrl?: string;
  pumpPortalApiKey?: string;
  anthropicApiKey?: string;
  publicKey?: string;

  // ── Identity ──
  instanceId?: string;       // Unique anonymous UUID for this installation

  // ── Data sharing ──
  dataSharingEnabled?: boolean;   // Whether to sync anonymized trades to central server
  syncServerUrl?: string;         // Central server URL (set by us, overridable)

  // ── App preferences ──
  dashboardPort?: number;
  autoStartScanner?: boolean;     // Auto-start scanner on app launch
  theme?: "dark" | "light";

  // ── Setup state ──
  setupComplete?: boolean;        // Has the user completed initial setup?
}

const SETTINGS_FILE = "settings.json";

let cachedSettings: AppSettings | null = null;
let settingsDir = "";

/** Initialize the settings manager with the data directory path */
export function initSettings(dataDir: string): void {
  settingsDir = dataDir;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  cachedSettings = null; // Force reload
}

/** Get the full path to settings.json */
function settingsPath(): string {
  return path.join(settingsDir, SETTINGS_FILE);
}

/** Load settings from disk (cached after first read) */
export function loadSettings(): AppSettings {
  if (cachedSettings) return cachedSettings;

  try {
    const filePath = settingsPath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      cachedSettings = JSON.parse(raw) as AppSettings;
      return cachedSettings;
    }
  } catch (err) {
    console.error("[settings] Failed to load settings.json:", err);
  }

  cachedSettings = {};
  return cachedSettings;
}

/** Save settings to disk */
export function saveSettings(settings: AppSettings): void {
  try {
    const filePath = settingsPath();
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
    cachedSettings = settings;
  } catch (err) {
    console.error("[settings] Failed to save settings.json:", err);
    throw err;
  }
}

/** Update specific fields without overwriting the entire file */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const merged = { ...current, ...updates };
  saveSettings(merged);
  return merged;
}

/** Get a single setting value */
export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return loadSettings()[key];
}

/** Check if initial setup has been completed */
export function isSetupComplete(): boolean {
  const s = loadSettings();
  return !!(s.setupComplete && s.solanaPrivateKey && s.solanaRpcUrl);
}

/**
 * Apply settings to process.env so that config.ts picks them up.
 * Called once at startup before loadConfig().
 * @param force — if true, overwrite existing env vars (used after setup completes)
 */
export function applySettingsToEnv(force = false): void {
  cachedSettings = null; // Force re-read from disk
  const s = loadSettings();

  // Only set env vars that aren't already set (env takes precedence) unless force=true
  const map: Record<string, string | undefined> = {
    PUMP_TRADER_PRIVATE_KEY: s.solanaPrivateKey,
    PUMP_TRADER_RPC_URL: s.solanaRpcUrl,
    PUMP_TRADER_WS_URL: s.solanaWsUrl,
    PUMP_TRADER_API_KEY: s.pumpPortalApiKey,
    ANTHROPIC_API_KEY: s.anthropicApiKey,
    PUMP_TRADER_PUBLIC_KEY: s.publicKey,
    PUMP_TRADER_DASHBOARD_PORT: s.dashboardPort?.toString(),
  };

  for (const [envKey, value] of Object.entries(map)) {
    if (value && (force || !process.env[envKey])) {
      process.env[envKey] = value;
    }
  }
}

/** Return a sanitized copy of settings for the API (masks sensitive fields) */
export function getSettingsForApi(): Record<string, unknown> {
  const s = loadSettings();
  return {
    // Show whether keys are configured, not the actual values
    solanaPrivateKeySet: !!s.solanaPrivateKey,
    solanaRpcUrl: s.solanaRpcUrl ? maskUrl(s.solanaRpcUrl) : "",
    solanaWsUrl: s.solanaWsUrl ? maskUrl(s.solanaWsUrl) : "",
    pumpPortalApiKeySet: !!s.pumpPortalApiKey,
    anthropicApiKeySet: !!s.anthropicApiKey,
    publicKey: s.publicKey || "",

    // Non-sensitive fields returned as-is
    instanceId: s.instanceId || "",
    dataSharingEnabled: s.dataSharingEnabled ?? true,
    syncServerUrl: s.syncServerUrl || "",
    dashboardPort: s.dashboardPort || 3847,
    autoStartScanner: s.autoStartScanner ?? false,
    setupComplete: s.setupComplete || false,
  };
}

/** Mask a URL to show only the host (hide API keys in URLs) */
function maskUrl(url: string): string {
  try {
    const u = new URL(url.replace("wss://", "https://").replace("ws://", "http://"));
    return `${u.protocol.replace("https:", "wss:").replace("http:", "ws:")}//${u.hostname}/***`;
  } catch {
    return "***";
  }
}
