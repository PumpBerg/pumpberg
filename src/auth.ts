// ── Authentication & User Management ──
//
// Provides user registration, login, JWT tokens, and role-based access.
// Uses Node.js built-in crypto only — zero npm dependencies.
//
// Users stored in data/users.json. Passwords hashed with scrypt.
// JWT tokens signed with HMAC-SHA256.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Types ──

export type UserRole = "admin" | "user";

export interface StoredUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;       // scrypt hash
  salt: string;               // random salt for scrypt
  role: UserRole;
  createdAt: string;
  lastLoginAt?: string;
  setupComplete: boolean;     // true if user has entered their API keys
  // Per-user API keys (encrypted at rest would be ideal, but stored plaintext for now)
  apiKeys?: {
    solanaPrivateKey?: string;
    solanaRpcUrl?: string;
    solanaWsUrl?: string;
    pumpPortalApiKey?: string;
    anthropicApiKey?: string;
    publicKey?: string;
  };
}

export interface UserPublic {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt?: string;
  setupComplete: boolean;
  apiKeys?: {
    solanaPrivateKeySet: boolean;
    solanaRpcUrlSet: boolean;
    solanaWsUrlSet: boolean;
    pumpPortalApiKeySet: boolean;
    anthropicApiKeySet: boolean;
    publicKey?: string;
  };
}

export interface JWTPayload {
  sub: string;        // user id
  username: string;
  role: UserRole;
  iat: number;        // issued at (epoch seconds)
  exp: number;        // expires at (epoch seconds)
}

interface UserStore {
  users: StoredUser[];
  jwtSecret: string;        // random secret, generated once
  schemaVersion: number;
}

// ── Constants ──
const USERS_FILE = "users.json";
const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;  // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p

// ── State ──
let store: UserStore | null = null;
let dataDir = "";

// ── Initialization ──

export function initAuth(dir: string): void {
  dataDir = dir;
  store = null; // force reload
  const s = loadStore();

  // Seed admin account if no users exist.
  // Admin credentials come ONLY from environment variables — never hardcoded.
  // If no env vars are set, random credentials are generated and printed ONCE to console.
  // After that, they live only in data/users.json (gitignored, local-only).
  if (s.users.length === 0) {
    const adminUsername = process.env.PUMP_TRADER_ADMIN_USERNAME || `admin_${crypto.randomBytes(4).toString("hex")}`;
    const adminPassword = process.env.PUMP_TRADER_ADMIN_PASSWORD || crypto.randomBytes(16).toString("hex");
    const adminEmail = process.env.PUMP_TRADER_ADMIN_EMAIL || "admin@localhost";
    console.log("[auth] No users found — seeding admin account...");
    registerUserSync(adminUsername, adminEmail, adminPassword, "admin");
    const envSet = !!process.env.PUMP_TRADER_ADMIN_USERNAME && !!process.env.PUMP_TRADER_ADMIN_PASSWORD;
    if (!envSet) {
      console.log("[auth] ═══════════════════════════════════════════════════");
      console.log(`[auth] ✅ Admin account created:`);
      console.log(`[auth]    Username: ${adminUsername}`);
      console.log(`[auth]    Password: ${adminPassword}`);
      console.log("[auth] ═══════════════════════════════════════════════════");
      console.log("[auth] ⚠️  SAVE THESE NOW — they will NOT be shown again!");
      console.log("[auth] 💡 Or set env vars: PUMP_TRADER_ADMIN_USERNAME & PUMP_TRADER_ADMIN_PASSWORD");
    } else {
      console.log(`[auth] ✅ Admin account created (username: ${adminUsername})`);
    }
  }
}

function storePath(): string {
  return path.join(dataDir, USERS_FILE);
}

function loadStore(): UserStore {
  if (store) return store;

  try {
    const filePath = storePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      store = JSON.parse(raw) as UserStore;
      return store;
    }
  } catch (err) {
    console.error("[auth] Failed to load users.json:", err);
  }

  // First run — create empty store with a random JWT secret
  store = {
    users: [],
    jwtSecret: crypto.randomBytes(64).toString("hex"),
    schemaVersion: 1,
  };
  saveStore();
  return store;
}

function saveStore(): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("[auth] Failed to save users.json:", err);
  }
}

// ── Password Hashing (scrypt) ──

function hashPasswordSync(password: string, salt: string): string {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
  });
  return derived.toString("hex");
}

function verifyPasswordSync(password: string, salt: string, hash: string): boolean {
  const derived = hashPasswordSync(password, salt);
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(hash, "hex"));
}

// ── JWT (HMAC-SHA256) ──

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(str: string): Buffer {
  // Restore padding
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  return Buffer.from(s, "base64");
}

function signJWT(payload: JWTPayload): string {
  const s = loadStore();
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const signature = base64url(
    crypto.createHmac("sha256", s.jwtSecret).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    const s = loadStore();
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expectedSig = base64url(
      crypto.createHmac("sha256", s.jwtSecret).update(`${header}.${body}`).digest()
    );

    // Constant-time comparison
    if (signature.length !== expectedSig.length) return null;
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    const payload = JSON.parse(base64urlDecode(body).toString("utf-8")) as JWTPayload;

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── User Management ──

function registerUserSync(
  username: string,
  email: string,
  password: string,
  role: UserRole = "user",
): StoredUser {
  const s = loadStore();

  // Check for duplicate username/email
  const uLower = username.toLowerCase();
  const eLower = email.toLowerCase();
  if (s.users.some(u => u.username.toLowerCase() === uLower)) {
    throw new Error("Username already taken");
  }
  if (s.users.some(u => u.email.toLowerCase() === eLower)) {
    throw new Error("Email already registered");
  }

  const salt = crypto.randomBytes(32).toString("hex");
  const passwordHash = hashPasswordSync(password, salt);

  const user: StoredUser = {
    id: crypto.randomUUID(),
    username,
    email,
    passwordHash,
    salt,
    role,
    createdAt: new Date().toISOString(),
    setupComplete: false,  // All users must complete setup to enter API keys
    apiKeys: {},
  };

  s.users.push(user);
  saveStore();
  return user;
}

export function registerUser(
  username: string,
  email: string,
  password: string,
): { user: UserPublic; token: string } {
  // Validate inputs
  if (!username || username.length < 3 || username.length > 30) {
    throw new Error("Username must be 3-30 characters");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new Error("Username can only contain letters, numbers, hyphens, and underscores");
  }
  if (!email || !email.includes("@") || email.length < 5) {
    throw new Error("Invalid email address");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const user = registerUserSync(username, email, password, "user");
  const token = createToken(user);
  return { user: toPublic(user), token };
}

export function loginUser(
  username: string,
  password: string,
): { user: UserPublic; token: string } {
  const s = loadStore();
  const uLower = username.toLowerCase();
  const user = s.users.find(
    u => u.username.toLowerCase() === uLower || u.email.toLowerCase() === uLower
  );

  if (!user) {
    throw new Error("Invalid credentials");
  }

  if (!verifyPasswordSync(password, user.salt, user.passwordHash)) {
    throw new Error("Invalid credentials");
  }

  // Update last login
  user.lastLoginAt = new Date().toISOString();
  saveStore();

  const token = createToken(user);
  return { user: toPublic(user), token };
}

export function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): void {
  if (!newPassword || newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters");
  }

  const s = loadStore();
  const user = s.users.find(u => u.id === userId);
  if (!user) throw new Error("User not found");

  if (!verifyPasswordSync(currentPassword, user.salt, user.passwordHash)) {
    throw new Error("Current password is incorrect");
  }

  const newSalt = crypto.randomBytes(32).toString("hex");
  user.salt = newSalt;
  user.passwordHash = hashPasswordSync(newPassword, newSalt);
  saveStore();
}

export function getUserById(userId: string): StoredUser | null {
  const s = loadStore();
  return s.users.find(u => u.id === userId) || null;
}

export function getUserByToken(token: string): StoredUser | null {
  const payload = verifyToken(token);
  if (!payload) return null;
  return getUserById(payload.sub);
}

/** Get user's API keys (for loading into config when their bot runs) */
export function getUserApiKeys(userId: string): StoredUser["apiKeys"] {
  const user = getUserById(userId);
  return user?.apiKeys || {};
}

/** Update user's API keys */
export function updateUserApiKeys(
  userId: string,
  keys: Partial<NonNullable<StoredUser["apiKeys"]>>,
): void {
  const s = loadStore();
  const user = s.users.find(u => u.id === userId);
  if (!user) throw new Error("User not found");

  user.apiKeys = { ...user.apiKeys, ...keys };
  saveStore();
}

/** Admin: update any user's API keys (used for admin auto-fill) */
export function adminSetApiKeys(
  adminUserId: string,
  keys: Partial<NonNullable<StoredUser["apiKeys"]>>,
): void {
  const s = loadStore();
  const admin = s.users.find(u => u.id === adminUserId);
  if (!admin || admin.role !== "admin") throw new Error("Not authorized");

  admin.apiKeys = { ...admin.apiKeys, ...keys };
  saveStore();
}

// ── Helpers ──

function createToken(user: StoredUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  };
  return signJWT(payload);
}

function toPublic(user: StoredUser): UserPublic {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    setupComplete: user.setupComplete ?? false,
    apiKeys: {
      solanaPrivateKeySet: !!user.apiKeys?.solanaPrivateKey,
      solanaRpcUrlSet: !!user.apiKeys?.solanaRpcUrl,
      solanaWsUrlSet: !!user.apiKeys?.solanaWsUrl,
      pumpPortalApiKeySet: !!user.apiKeys?.pumpPortalApiKey,
      anthropicApiKeySet: !!user.apiKeys?.anthropicApiKey,
      publicKey: user.apiKeys?.publicKey,
    },
  };
}

/** Extract token from Authorization header */
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1];
}

/** Get all users (admin only) — returns public view */
export function getAllUsers(): UserPublic[] {
  const s = loadStore();
  return s.users.map(toPublic);
}

/** Mark user's setup as complete after they enter API keys */
export function markSetupComplete(userId: string): void {
  const s = loadStore();
  const user = s.users.find(u => u.id === userId);
  if (!user) {
    throw new Error("User not found");
  }
  user.setupComplete = true;
  saveStore();
}

/** Configure admin account with API keys from local config */
export function configureAdminWithKeys(apiKeys: {
  solanaPrivateKey?: string;
  solanaRpcUrl?: string;
  solanaWsUrl?: string;
  pumpPortalApiKey?: string;
  anthropicApiKey?: string;
  publicKey?: string;
}): void {
  const s = loadStore();
  const adminUser = s.users.find(u => u.role === "admin");
  
  if (!adminUser) {
    console.log("[auth] Admin not found - cannot configure keys");
    return;
  }

  // Merge API keys — only update keys that have actual values (don't clobber with undefined)
  if (!adminUser.apiKeys) adminUser.apiKeys = {};
  for (const [key, value] of Object.entries(apiKeys)) {
    if (value !== undefined && value !== null && value !== "") {
      (adminUser.apiKeys as Record<string, string>)[key] = value as string;
    }
  }

  // Mark admin setup as complete (skip wizard)
  adminUser.setupComplete = true;
  
  saveStore();
  console.log("[auth] ✅ Admin account configured with API keys");
}
