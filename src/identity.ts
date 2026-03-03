// ── Instance identity system ──
//
// Each installation gets a unique anonymous UUID. The first installation
// (yours) is flagged as "owner" with an admin token for full access.
// Distributed copies are regular instances that sync data but have no admin privileges.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface InstanceIdentity {
  instanceId: string;      // Random UUID — anonymous, never tied to a wallet
  isOwner: boolean;        // True for the original developer's instance
  ownerToken: string;      // Admin bearer token (only meaningful for owner)
  createdAt: string;       // ISO timestamp of first run
  schemaVersion: number;   // For future migrations
  walletAddress?: string;  // Solana wallet for Pumpberg Proof of Data mining
}

const IDENTITY_FILE = "instance.json";
let cached: InstanceIdentity | null = null;

/** Load or create the instance identity */
export function loadIdentity(dataDir: string): InstanceIdentity {
  if (cached) return cached;

  const filePath = path.join(dataDir, IDENTITY_FILE);

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      cached = JSON.parse(raw) as InstanceIdentity;
      return cached;
    }
  } catch (err) {
    console.error("[identity] Failed to load instance.json:", err);
  }

  // First run — create new identity
  cached = createNewIdentity(dataDir);
  return cached;
}

/** Create a fresh identity for a new installation */
function createNewIdentity(dataDir: string): InstanceIdentity {
  const identity: InstanceIdentity = {
    instanceId: crypto.randomUUID(),
    isOwner: false,         // Default: regular user (owner must be explicitly bootstrapped)
    ownerToken: crypto.randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
  };

  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dataDir, IDENTITY_FILE),
      JSON.stringify(identity, null, 2),
      "utf-8"
    );
    console.log(`[identity] Created new instance: ${identity.instanceId}`);
  } catch (err) {
    console.error("[identity] Failed to save instance.json:", err);
  }

  return identity;
}

/**
 * Bootstrap the current instance as the owner.
 * Call this ONCE on your machine to mark yourself as admin.
 * After this, the instance.json will have isOwner=true.
 */
export function bootstrapOwner(dataDir: string): InstanceIdentity {
  const identity = loadIdentity(dataDir);
  identity.isOwner = true;
  identity.ownerToken = crypto.randomBytes(32).toString("hex");

  try {
    fs.writeFileSync(
      path.join(dataDir, IDENTITY_FILE),
      JSON.stringify(identity, null, 2),
      "utf-8"
    );
    console.log(`[identity] ✅ This instance is now the OWNER`);
    console.log(`[identity] Admin token: ${identity.ownerToken}`);
  } catch (err) {
    console.error("[identity] Failed to save owner identity:", err);
  }

  cached = identity;
  return identity;
}

/** Check if this instance is the owner */
export function isOwner(dataDir: string): boolean {
  return loadIdentity(dataDir).isOwner;
}

/** Get the instance ID */
export function getInstanceId(dataDir: string): string {
  return loadIdentity(dataDir).instanceId;
}

/** Get the wallet address for Proof of Data mining */
export function getWalletAddress(dataDir: string): string | undefined {
  return loadIdentity(dataDir).walletAddress;
}

/** Set the wallet address for Proof of Data mining */
export function setWalletAddress(dataDir: string, walletAddress: string): void {
  const identity = loadIdentity(dataDir);
  identity.walletAddress = walletAddress;

  try {
    fs.writeFileSync(
      path.join(dataDir, IDENTITY_FILE),
      JSON.stringify(identity, null, 2),
      "utf-8"
    );
    console.log(`[identity] Wallet address set: ${walletAddress.slice(0, 8)}...`);
  } catch (err) {
    console.error("[identity] Failed to save wallet address:", err);
  }

  cached = identity;
}
