# ⛏️ Pumpberg — Proof of Data Mining for Solana Memecoins

**Run a trading bot. Mine data. Earn $PUMPBERG.**

Pumpberg is an open-source autonomous trading bot for [pump.fun](https://pump.fun) that turns every user into a data miner. Each bot node scores and trades tokens using AI, then contributes anonymized trade data to a shared intelligence network. Nodes earn quality-weighted **$PUMPBERG** points redeemable for token airdrops.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Table of Contents

- [How It Works](#how-it-works)
- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Mining & Points](#mining--points)
- [Dashboard](#dashboard)
- [Architecture](#architecture)
- [Trading Modes](#trading-modes)
- [AI Agent System](#ai-agent-system)
- [Signal Engine](#signal-engine)
- [RAG Learning System](#rag-learning-system)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)

---

## How It Works

`
┌─────────────┐      ┌───────────────┐      ┌──────────────┐
│  Your Node  │─────>│  Sync Server  │─────>│  Leaderboard │
│  (bot+AI)   │      │  (aggregate)  │      │  & Airdrops  │
└─────────────┘      └───────────────┘      └──────────────┘
    │ trade                 │ verify              │ distribute
    │ score                 │ rank                │ $PUMPBERG
    │ learn                 │ deduplicate         │ tokens
    ▼                       ▼                     ▼
  local RAG DB         shared intel         your wallet
`

1. **Run your bot** — scans pump.fun tokens, scores them with 8-factor signals + Claude AI, executes trades
2. **Mine data** — every scored & traded token generates anonymized trade data (signals, outcomes, timing)
3. **Earn points** — data is quality-weighted: richer signals = more points per trade
4. **Get airdrops** — $PUMPBERG tokens are distributed proportionally from the leaderboard

## Features

### Trading Engine
- **Real-time token scanning** via PumpPortal WebSocket (new tokens, trades, migrations)
- **8-dimension signal scoring** — volume, buy pressure, unique buyers, mcap velocity, dev behavior, anti-rug, bonding curve, token age
- **Claude AI analysis** — Haiku scores each token; Sonnet 4 agent makes autonomous buy/sell decisions
- **Sub-second execution** — PumpPortal local-transaction API with priority fees
- **Tiered take-profit** — TP1 (partial) + TP2 (full) + trailing stop
- **Dry-run mode** — paper trade with real data, zero SOL at risk (default)

### AI & Learning
- **Autonomous Claude agent** — adjusts strategy, writes post-mortems, evolves over time
- **RAG system** — SQLite-backed k-NN retrieval over historical trades (14 numeric features)
- **Smart money tracking** — profiles top wallets and mirrors signals
- **Social scanner** — meme virality detection via web search (no API keys)
- **Market regime detection** — classifies market conditions (hot/normal/cold/dead)

### Proof of Data Mining
- **Quality-weighted points** — base 1pt + bonuses for social data, smart money, post-sale tracking (max 4pt per trade)
- **On-chain verification** — tx signatures recorded for auditability
- **Leaderboard** — global ranking of miners by quality-adjusted points
- **Periodic airdrops** — $PUMPBERG tokens distributed proportionally via SPL transfers

### Dashboard
- **Real-time positions** — live P&L, filled orders, open trades
- **Trade history** — every entry/exit with signal breakdown
- **AI chat** — talk to your agent, ask questions, override decisions
- **Mining panel** — view points, wallet setup, leaderboard
- **Config editor** — tune all parameters at runtime

---

## Quick Start

### Prerequisites
- **Node.js v20+**
- **Solana wallet** with SOL (or just use dry-run mode)
- **PumpPortal API key** — [pumpportal.fun](https://pumpportal.fun)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- **Helius RPC** — [helius.dev](https://helius.dev) (free tier works)

### Install

`ash
git clone https://github.com/pumpberg/pumpberg.git
cd pumpberg
npm install
cd dashboard && npm install && cd ..
`

### Configure

`ash
cp .env.example .env
# Edit .env with your keys — see .env.example for docs
`

### Run

`ash
# Terminal 1: Start the bot
npm start

# Terminal 2: Start the dashboard
npm run dashboard:dev
`

Open **http://localhost:3847** for the dashboard.

The bot starts in **dry-run mode** by default — no real SOL is risked until you toggle live mode in the dashboard.

### Enable Mining (optional)

Set your wallet in the dashboard's Mining panel or in `.env`:

`ash
PUMPBERG_WALLET_ADDRESS=YourSolanaWalletAddress
PUMPBERG_DATA_SHARING=true
`

---

## Configuration

All settings are in `.env` and can be overridden at runtime via the dashboard.

| Variable | Description | Default |
|----------|-------------|---------|
| `PUMP_TRADER_PRIVATE_KEY` | Base58 Solana private key for trading | (required) |
| `PUMP_TRADER_PUBLIC_KEY` | Corresponding public key | (required) |
| `PUMP_TRADER_API_KEY` | PumpPortal API key | (required) |
| `PUMP_TRADER_RPC_URL` | Solana RPC WebSocket URL | (required) |
| `ANTHROPIC_API_KEY` | Claude API key | (required) |
| `PUMP_TRADER_DASHBOARD_PORT` | Dashboard HTTP port | 3847 |
| `PUMP_TRADER_ADMIN_USERNAME` | Dashboard login username | admin |
| `PUMP_TRADER_ADMIN_PASSWORD` | Dashboard login password | (set on first run) |
| `PUMPBERG_DATA_SHARING` | Enable anonymous data mining | true |
| `PUMPBERG_WALLET_ADDRESS` | Wallet for earning points | (optional) |

---

## Mining & Points

### How Points Work

Every trade your bot executes (or scores in dry-run) generates a data record. Records are anonymized and synced to the Pumpberg network. Points are calculated based on data quality:

| Signal Type | Bonus Points |
|-------------|-------------|
| Base trade data | +1.0 |
| Social signals present | +0.5 |
| Smart money signals | +0.5 |
| Live trade (not dry-run) | +0.5 |
| Post-sale outcome tracked | +1.0 |
| Creator reputation data | +0.25 |
| Whale activity data | +0.25 |
| **Maximum per trade** | **4.0** |

### Leaderboard

View the global leaderboard at the `/api/leaderboard` endpoint or in the dashboard Mining panel.

### Airdrops

`` tokens are periodically airdropped to miners proportionally to their verified points. The airdrop script is at `scripts/airdrop.ts`.

---

## Architecture

`
├── server.mjs            # HTTP server, API routes, bot orchestrator
├── src/
│   ├── scanner.ts         # Token scanner & trade execution
│   ├── signals.ts         # 8-factor signal scoring engine
│   ├── chat-agent.ts      # Claude Sonnet 4 autonomous agent
│   ├── trade-journal.ts   # Trade logging & history (SQLite)
│   ├── points.ts          # Mining points tracker
│   ├── identity.ts        # Instance identity & wallet
│   ├── rag/
│   │   ├── database.ts    # RAG vector store (sql.js + MiniLM)
│   │   ├── importer.ts    # Journal → RAG pipeline
│   │   └── types.ts       # RAG record types
│   └── sync/
│       ├── sync-client.ts # Data sync to network
│       ├── anonymizer.ts  # Trade data anonymization
│       └── types.ts       # Sync payload types
├── dashboard/             # React 19 + Vite 6 + Tailwind CSS 3
│   └── src/
│       ├── App.tsx        # Main layout
│       └── components/    # UI panels (Mining, Positions, Chat, etc.)
├── scripts/
│   └── airdrop.ts         # SPL token airdrop distribution
└── sync-server/           # Centralized sync & leaderboard server
`

### Tech Stack
- **Runtime**: Node.js 20+ / TypeScript / ESM
- **AI**: Claude Sonnet 4 (agent) + Claude Haiku (scoring) via Anthropic API
- **Blockchain**: @solana/web3.js + @solana/spl-token + bs58
- **Database**: sql.js (WASM SQLite) for local RAG + trade journal
- **Embeddings**: all-MiniLM-L6-v2 via @xenova/transformers (local, 384-dim)
- **Frontend**: React 19, Vite 6, Tailwind CSS 3
- **Server**: Raw Node.js http.createServer (no Express)

---

## Trading Modes

| Mode | Description | SOL Risk |
|------|-------------|----------|
| **Dry Run** (default) | Paper trading with real market data | None |
| **Live** | Real trades on Solana mainnet | Real SOL |

Toggle between modes in the dashboard. The bot **always starts in dry-run mode** for safety.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on:
- Setting up the development environment
- Submitting bug reports and feature requests
- Code style and PR process
- Areas where we need help

---

## Security

- **Never commit** `.env` files or private keys
- The `.gitignore` is pre-configured to exclude secrets
- All synced trade data is anonymized — no wallet addresses are shared
- Transaction signatures are recorded for verification but wallet mapping stays local
- Start in dry-run mode until you understand the system

---

## Disclaimer

> :warning: **Trading memecoins is extremely risky.** The vast majority of pump.fun tokens go to zero. Only ~0.4% of tokens graduate from the bonding curve.

- This software is for **educational and research purposes only**
- **Never trade with money you can't afford to lose**
- **Always start in dry-run mode** to understand the system first
- Past performance does not guarantee future results
- The AI agent can and will make mistakes
- Network conditions, slippage, and MEV can cause unexpected losses
- The developers are not responsible for any financial losses

**Use at your own risk.**

---

## License

[MIT](LICENSE)