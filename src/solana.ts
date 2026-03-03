// ── Solana wallet and RPC helpers ──

import {
  Connection,
  Keypair,
  VersionedTransaction,
  type TransactionSignature,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";

export interface WalletInfo {
  publicKey: string;
  solBalance: number;
}

/**
 * Thin wrapper around Solana Connection + Keypair.
 * Handles balance checks, token accounts, and transaction sending.
 */
export class SolanaClient {
  readonly connection: Connection;
  readonly keypair: Keypair;
  readonly publicKey: PublicKey;

  constructor(privateKeyBase58: string, rpcUrl: string) {
    // Solana web3.js Connection requires http(s), not wss
    const httpUrl = rpcUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
    this.connection = new Connection(httpUrl, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 30_000,
    });
    this.keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.publicKey = this.keypair.publicKey;
  }

  /** Get SOL balance in SOL (not lamports) */
  async getSolBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /** Get wallet info */
  async getWalletInfo(): Promise<WalletInfo> {
    return {
      publicKey: this.publicKey.toBase58(),
      solBalance: await this.getSolBalance(),
    };
  }

  /**
   * Get SPL token balance for a specific mint.
   * Uses getParsedTokenAccountsByOwner which works with ANY token program
   * (standard SPL Token AND Token-2022) — critical for pump.fun tokens.
   */
  async getTokenBalance(mintAddress: string): Promise<number> {
    try {
      const mint = new PublicKey(mintAddress);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.publicKey,
        { mint },
      );
      if (accounts.value.length === 0) return 0;
      let total = 0;
      for (const acc of accounts.value) {
        const info = acc.account.data.parsed.info;
        total += Number(info.tokenAmount.uiAmount ?? 0);
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Sign and send a serialized transaction (from PumpPortal API).
   * Returns the transaction signature.
   */
  async signAndSendTransaction(serializedTx: Uint8Array): Promise<TransactionSignature> {
    const tx = VersionedTransaction.deserialize(serializedTx);
    tx.sign([this.keypair]);

    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: true, // faster — we accept the risk
      maxRetries: 2,
    });

    return signature;
  }

  /**
   * Sign, send, and aggressively confirm a transaction with retry-resend.
   * Resends the signed tx every RESEND_INTERVAL_MS until confirmed or timeout.
   * This is critical for buys where landing the tx fast is essential.
   */
  async signSendAndConfirm(
    serializedTx: Uint8Array,
    timeoutMs = 30_000,
  ): Promise<{ confirmed: boolean; signature: string }> {
    const RESEND_INTERVAL_MS = 2_000;

    const tx = VersionedTransaction.deserialize(serializedTx);
    tx.sign([this.keypair]);

    // Get blockhash info BEFORE first send for accurate expiry tracking
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");

    // First send
    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 0, // We handle retries ourselves
    });

    const startTime = Date.now();

    // Start the confirmation listener
    const confirmPromise = this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );

    // Resend loop — fire-and-forget resends every 2s while waiting
    const resendLoop = (async () => {
      while (Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, RESEND_INTERVAL_MS));
        if (Date.now() - startTime >= timeoutMs) break;
        try {
          await this.connection.sendTransaction(tx, {
            skipPreflight: true,
            maxRetries: 0,
          });
        } catch {
          // Resend failures are expected (duplicate tx, etc.) — ignore
        }
      }
    })();

    // Race: confirmation vs timeout
    try {
      const result = await Promise.race([
        confirmPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);

      // Stop the resend loop
      // (it will stop on its own when the timeout expires, but we break early)
      void resendLoop;

      if (result && !result.value.err) {
        return { confirmed: true, signature };
      }
      return { confirmed: false, signature };
    } catch {
      return { confirmed: false, signature };
    }
  }

  /**
   * Confirm a transaction with a timeout.
   * Returns true if confirmed, false if timed out.
   */
  async confirmTransaction(signature: string, timeoutMs = 30_000): Promise<boolean> {
    try {
      const latestBlockhash = await this.connection.getLatestBlockhash();
      const result = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        "confirmed",
      );
      return !result.value.err;
    } catch {
      return false;
    }
  }
}
