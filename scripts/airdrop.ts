#!/usr/bin/env npx tsx
// ── Pumpberg Airdrop Script ──
//
// Distributes $PUMPBERG tokens proportionally to miners based on their verified points.
//
// Usage:
//   npx tsx scripts/airdrop.ts --dry-run                  # Preview distribution
//   npx tsx scripts/airdrop.ts --execute                  # Execute airdrop
//   npx tsx scripts/airdrop.ts --execute --amount 1000000 # Custom total amount
//
// Prerequisites:
//   - $PUMPBERG token already launched on pump.fun
//   - Token mint address set in PUMPBERG_TOKEN_MINT env var
//   - Airdrop wallet private key set in PUMPBERG_AIRDROP_PRIVATE_KEY env var
//   - Sync server URL set in PUMPBERG_SYNC_SERVER env var

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferInstruction, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

// ── Configuration ──
const SYNC_SERVER = process.env.PUMPBERG_SYNC_SERVER || "https://pumpbot-production-ef7c.up.railway.app";
const TOKEN_MINT = process.env.PUMPBERG_TOKEN_MINT || "";
const AIRDROP_PRIVATE_KEY = process.env.PUMPBERG_AIRDROP_PRIVATE_KEY || "";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const DECIMALS = 6; // pump.fun default

interface LeaderboardEntry {
  rank: number;
  walletAddress: string;
  totalPoints: number;
  verifiedPoints: number;
  totalTrades: number;
}

interface AirdropRecipient {
  walletAddress: string;
  points: number;
  share: number; // 0-1, percentage of total
  tokenAmount: number;
}

async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${SYNC_SERVER}/api/leaderboard?limit=10000`);
  if (!res.ok) throw new Error(`Failed to fetch leaderboard: ${res.status}`);
  const data = await res.json() as { leaderboard: LeaderboardEntry[] };
  return data.leaderboard;
}

function calculateDistribution(
  leaderboard: LeaderboardEntry[],
  totalTokens: number,
  minPoints: number = 1.0,
): AirdropRecipient[] {
  // Filter miners with minimum points threshold
  const eligible = leaderboard.filter(m => m.totalPoints >= minPoints);

  if (eligible.length === 0) {
    console.log("No eligible miners found.");
    return [];
  }

  const totalPoints = eligible.reduce((sum, m) => sum + m.totalPoints, 0);

  return eligible.map(m => ({
    walletAddress: m.walletAddress,
    points: m.totalPoints,
    share: m.totalPoints / totalPoints,
    tokenAmount: Math.floor((m.totalPoints / totalPoints) * totalTokens),
  }));
}

async function executeAirdrop(
  recipients: AirdropRecipient[],
  connection: Connection,
  payer: Keypair,
  tokenMint: PublicKey,
): Promise<{ success: number; failed: number; signatures: string[] }> {
  let success = 0;
  let failed = 0;
  const signatures: string[] = [];

  const payerAta = await getAssociatedTokenAddress(tokenMint, payer.publicKey);

  for (const recipient of recipients) {
    if (recipient.tokenAmount <= 0) continue;

    try {
      const recipientPubkey = new PublicKey(recipient.walletAddress);
      const recipientAta = await getAssociatedTokenAddress(tokenMint, recipientPubkey);

      const tx = new Transaction();

      // Check if recipient has an ATA, create if not
      const ataInfo = await connection.getAccountInfo(recipientAta);
      if (!ataInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            recipientAta,
            recipientPubkey,
            tokenMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          )
        );
      }

      // Add transfer instruction
      const rawAmount = BigInt(recipient.tokenAmount) * BigInt(10 ** DECIMALS);
      tx.add(
        createTransferInstruction(
          payerAta,
          recipientAta,
          payer.publicKey,
          rawAmount,
          [],
          TOKEN_PROGRAM_ID,
        )
      );

      const sig = await connection.sendTransaction(tx, [payer]);
      await connection.confirmTransaction(sig, "confirmed");

      signatures.push(sig);
      success++;
      console.log(`  ✅ ${recipient.walletAddress.slice(0, 8)}... → ${recipient.tokenAmount.toLocaleString()} $PUMPBERG (${sig.slice(0, 16)}...)`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${recipient.walletAddress.slice(0, 8)}... → FAILED: ${msg}`);
    }

    // Small delay between transactions
    await new Promise(r => setTimeout(r, 500));
  }

  return { success, failed, signatures };
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run") || !args.includes("--execute");
  const amountIdx = args.indexOf("--amount");
  const totalTokens = amountIdx >= 0 ? parseInt(args[amountIdx + 1], 10) : 1_000_000;

  console.log("\n  ⛏️  Pumpberg Airdrop Tool");
  console.log("  ─────────────────────────");
  console.log(`  Mode:       ${isDryRun ? "DRY RUN (preview)" : "EXECUTE (real transfers)"}`);
  console.log(`  Total:      ${totalTokens.toLocaleString()} $PUMPBERG`);
  console.log(`  Server:     ${SYNC_SERVER}`);
  console.log(`  Token Mint: ${TOKEN_MINT || "NOT SET"}\n`);

  // Fetch leaderboard
  console.log("Fetching miner leaderboard...");
  const leaderboard = await fetchLeaderboard();
  console.log(`Found ${leaderboard.length} miners.\n`);

  // Calculate distribution
  const recipients = calculateDistribution(leaderboard, totalTokens);

  if (recipients.length === 0) {
    console.log("No eligible recipients. Exiting.");
    return;
  }

  // Print distribution preview
  console.log("Distribution Preview:");
  console.log("─".repeat(80));
  console.log(`${"Rank".padEnd(6)} ${"Wallet".padEnd(16)} ${"Points".padStart(10)} ${"Share".padStart(8)} ${"Tokens".padStart(14)}`);
  console.log("─".repeat(80));

  let rank = 0;
  for (const r of recipients.slice(0, 50)) {
    rank++;
    console.log(
      `${String(rank).padEnd(6)} ${(r.walletAddress.slice(0, 6) + "..." + r.walletAddress.slice(-4)).padEnd(16)} ` +
      `${r.points.toFixed(1).padStart(10)} ${(r.share * 100).toFixed(2).padStart(7)}% ${r.tokenAmount.toLocaleString().padStart(14)}`
    );
  }
  if (recipients.length > 50) {
    console.log(`  ... and ${recipients.length - 50} more recipients`);
  }

  console.log("─".repeat(80));
  console.log(`Total: ${recipients.length} recipients, ${recipients.reduce((s, r) => s + r.tokenAmount, 0).toLocaleString()} tokens\n`);

  if (isDryRun) {
    console.log("🔍 Dry run complete. Run with --execute to send tokens.");
    return;
  }

  // Validate execution prerequisites
  if (!TOKEN_MINT) {
    console.error("❌ PUMPBERG_TOKEN_MINT env var not set");
    process.exit(1);
  }
  if (!AIRDROP_PRIVATE_KEY) {
    console.error("❌ PUMPBERG_AIRDROP_PRIVATE_KEY env var not set");
    process.exit(1);
  }

  // Execute airdrop
  console.log("🚀 Executing airdrop...\n");
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(bs58.decode(AIRDROP_PRIVATE_KEY));
  const tokenMint = new PublicKey(TOKEN_MINT);

  const result = await executeAirdrop(recipients, connection, payer, tokenMint);

  console.log(`\n✅ Airdrop complete: ${result.success} sent, ${result.failed} failed`);
  console.log(`Tx signatures: ${result.signatures.length}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
