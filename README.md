# Pumpberg

**Free, open-source autonomous AI trading bot for pump.fun on Solana.**

Pumpberg scans every new token launch on pump.fun in real-time, scores them with an 8-factor signal engine + Claude AI, and executes trades autonomously on Solana. Fork it, configure your keys, deploy it on your own machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

### Trading Engine
- **Real-time token scanning** via PumpPortal WebSocket -- new tokens, trades, migrations
- **8-dimension signal scoring** -- volume, buy pressure, unique buyers, mcap velocity, dev behavior, anti-rug, bonding curve, token age
- **Claude AI analysis** -- Haiku scores each token; Sonnet 4 agent makes autonomous buy/sell decisions
- **Sub-second execution** -- PumpPortal local-transaction API with priority fees
- **Tiered take-profit** -- TP1 (partial) + TP2 (full) + trailing stop
- **Dry-run mode** -- paper trade with real data, zero SOL at risk (default on startup)

### AI & Learning
- **Autonomous Claude agent** -- adjusts strategy, writes post-mortems, evolves over time
- **RAG memory system** -- SQLite-backed k-NN retrieval over historical trades (14 numeric features)
- **Smart money tracking** -- profiles top wallets and mirrors signals
- **Social scanner** -- meme virality detection via web search (no API keys needed)
- **Market regime detection** -- classifies market conditions (hot/normal/cold/dead)

### Dashboard
- **Real-time positions** -- live P&L, filled orders, open trades
- **Trade history** -- every entry/exit with signal breakdown
- **AI chat** -- talk to your agent, ask questions, override decisions
- **Thinking panel** -- watch Claude reason through buy/sell decisions in real-time
- **Config editor** -- tune all parameters at runtime without restarting

---

## Quick Start

### Prerequisites
- **Node.js v20+**
- **Solana wallet** with SOL (create one at [pumpportal.fun/trading-api](https://pumpportal.fun/trading-api))
- **Helius RPC** -- [helius.dev](https://helius.dev) (free tier)
- **Anthropic API key** -- [console.anthropic.com](https://console.anthropic.com) ($5 min credit)
- **PumpPortal API key** -- [pumpportal.fun](https://pumpportal.fun/trading-api) (free)

### Install

```bash
git clone https://github.com/PumpBerg/pumpberg.git
cd pumpberg
npm install
cd dashboard && npm install && cd ..
```

### Configure

```bash
cp .env.example .env
# Edit .env with your keys
```

```env
# Required
PUMP_TRADER_PRIVATE_KEY=your_base58_private_key
PUMP_TRADER_PUBLIC_KEY=your_solana_public_key
PUMP_TRADER_RPC_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PUMP_TRADER_API_KEY=your_pumpportal_api_key
ANTHROPIC_API_KEY=sk-ant-api03-your_key_here

# Dashboard login
PUMP_TRADER_ADMIN_USERNAME=admin
PUMP_TRADER_ADMIN_PASSWORD=set_a_strong_password
```

### Run

```bash
# Terminal 1: Start the bot + API server
npm start

# Terminal 2: Start the dashboard
npm run dashboard:dev
```

Open **http://localhost:3847** for the dashboard.

The bot starts in **dry-run mode** by default -- no real SOL is risked until you toggle live mode.

---

## Configuration

All settings live in `.env` and can be changed at runtime via the dashboard.

| Variable | Description | Default |
|----------|-------------|---------|
| `PUMP_TRADER_PRIVATE_KEY` | Base58 Solana private key for trading | (required) |
| `PUMP_TRADER_PUBLIC_KEY` | Corresponding public key | (required) |
| `PUMP_TRADER_API_KEY` | PumpPortal API key | (required) |
| `PUMP_TRADER_RPC_URL` | Solana RPC WebSocket URL | (required) |
| `ANTHROPIC_API_KEY` | Claude API key | (required for AI) |
| `PUMP_TRADER_DASHBOARD_PORT` | Dashboard HTTP port | 3847 |
| `PUMP_TRADER_ADMIN_USERNAME` | Dashboard login username | admin |
| `PUMP_TRADER_ADMIN_PASSWORD` | Dashboard login password | (set on first run) |

---

## Architecture

```
server.mjs              # HTTP server, API routes, bot orchestrator
src/
  scanner.ts            # Token scanner & trade execution loop
  signal-engine.ts      # 8-factor signal scoring
  llm-analyzer.ts       # Claude Haiku token analysis
  chat-agent.ts         # Claude Sonnet 4 autonomous agent
  trader.ts             # Trade execution via PumpPortal
  position-manager.ts   # Position tracking, TP/SL, exits
  risk-manager.ts       # Risk controls & circuit breakers
  trade-journal.ts      # Trade logging & history
  rag/
    database.ts         # RAG vector store (sql.js)
    query-engine.ts     # k-NN similarity search
    embeddings.ts       # Feature vector generation
  smart-money.ts        # Whale wallet profiling
  social-scanner.ts     # Social signal detection
  market-regime.ts      # Market condition classifier
dashboard/              # React 19 + Vite 6 + Tailwind CSS 3
  src/
    App.tsx             # Main layout
    components/         # UI panels
scripts/                # Utilities
```

### Tech Stack
- **Runtime**: Node.js 20+ / TypeScript / ESM
- **AI**: Claude Sonnet 4 (agent) + Claude Haiku (scoring) via Anthropic API
- **Blockchain**: @solana/web3.js + @solana/spl-token + bs58
- **Database**: sql.js (WASM SQLite) for local RAG + trade journal
- **Embeddings**: all-MiniLM-L6-v2 via @xenova/transformers (local, 384-dim)
- **Frontend**: React 19, Vite 6, Tailwind CSS 3
- **Server**: Raw Node.js http.createServer (zero dependencies)

---

## Trading Modes

| Mode | Description | SOL Risk |
|------|-------------|----------|
| **Dry Run** (default) | Paper trading with real market data | None |
| **Live** | Real trades on Solana mainnet | Real SOL |

Toggle between modes in the dashboard. The bot always starts in dry-run mode.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Security

- Your private key and API keys stay in `.env` on your machine -- never uploaded anywhere
- `.gitignore` is pre-configured to exclude all secrets and runtime data
- Start in dry-run mode until you understand the system
- Use a dedicated trading wallet -- never your main wallet

---

## Disclaimer

> **Trading memecoins is extremely risky.** The vast majority of pump.fun tokens go to zero. Only ~0.4% of tokens graduate from the bonding curve.

- This software is for **educational and research purposes**
- **Never trade with money you cannot afford to lose**
- **Always start in dry-run mode** to understand the system first
- Past performance does not guarantee future results
- The AI agent can and will make mistakes
- The developers are not responsible for any financial losses

**Use at your own risk.**

---

## License

[MIT](LICENSE)
