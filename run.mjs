#!/usr/bin/env node
/**
 * Auto-restart wrapper for PumpTrader.
 * Usage: npx tsx run.mjs
 * 
 * - Restarts server.mjs automatically on crash
 * - Exponential backoff (3s → 30s) to avoid restart loops
 * - Resets backoff after 60s of stable uptime
 * - Logs all crashes to data/crash.log
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const MIN_RESTART_DELAY = 3_000;
const MAX_RESTART_DELAY = 30_000;
const STABLE_UPTIME_MS = 60_000; // Reset backoff after 60s stable

let restartDelay = MIN_RESTART_DELAY;
let startTime = 0;
let restartCount = 0;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [RUNNER] ${msg}`);
}

function logCrash(code, signal) {
  try {
    mkdirSync("data", { recursive: true });
    const msg = `[${new Date().toISOString()}] PROCESS_EXIT: code=${code}, signal=${signal}, uptime=${Math.round((Date.now() - startTime) / 1000)}s, restarts=${restartCount}\n`;
    appendFileSync("data/crash.log", msg);
  } catch {}
}

function startServer() {
  startTime = Date.now();
  restartCount++;
  
  log(`Starting server.mjs (attempt #${restartCount})...`);
  
  const child = spawn("npx", ["tsx", "server.mjs"], {
    stdio: "inherit",
    cwd: import.meta.dirname,
    shell: true,
  });

  child.on("exit", (code, signal) => {
    const uptime = Date.now() - startTime;
    const uptimeSec = Math.round(uptime / 1000);
    
    logCrash(code, signal);
    
    if (code === 0) {
      log(`Server exited cleanly (${uptimeSec}s uptime). Not restarting.`);
      return;
    }
    
    // Reset backoff if server was stable for a while
    if (uptime > STABLE_UPTIME_MS) {
      restartDelay = MIN_RESTART_DELAY;
    }
    
    log(`Server crashed (code=${code}, signal=${signal}, uptime=${uptimeSec}s). Restarting in ${(restartDelay / 1000).toFixed(1)}s...`);
    
    setTimeout(startServer, restartDelay);
    restartDelay = Math.min(restartDelay * 1.5, MAX_RESTART_DELAY);
  });

  child.on("error", (err) => {
    log(`Failed to spawn server: ${err.message}`);
    setTimeout(startServer, restartDelay);
    restartDelay = Math.min(restartDelay * 1.5, MAX_RESTART_DELAY);
  });
}

// Handle Ctrl+C gracefully — don't restart
process.on("SIGINT", () => {
  log("Received SIGINT — shutting down.");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Received SIGTERM — shutting down.");
  process.exit(0);
});

log("PumpTrader auto-restart runner starting...");
startServer();
