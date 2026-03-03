# Contributing to Pumpberg

Thank you for your interest in contributing to Pumpberg! This guide will help you get started.

## Getting Started

1. **Fork the repository** and clone your fork locally
2. **Install dependencies**: `npm install && cd dashboard && npm install`
3. **Copy the environment file**: `cp .env.example .env` and fill in your keys
4. **Start the bot in dev mode**: `npm run dev`
5. **Start the dashboard** (separate terminal): `npm run dashboard:dev`

## Development Setup

### Prerequisites
- Node.js v20+
- A Solana wallet with SOL for trading (or use dry-run mode)
- PumpPortal API key (https://pumpportal.fun)
- Anthropic API key (https://console.anthropic.com)
- Helius RPC endpoint (https://helius.dev)

### Project Structure
```
├── server.mjs          # Main HTTP server & bot orchestrator
├── src/
│   ├── scanner.ts      # Token scanner & trading engine
│   ├── signals.ts      # Multi-factor signal scoring
│   ├── chat-agent.ts   # Claude AI agent for decisions
│   ├── trade-journal.ts # Trade logging & history
│   ├── points.ts       # Mining points tracker
│   ├── identity.ts     # Instance identity & wallet
│   ├── rag/            # RAG learning system
│   └── sync/           # Data sync client
├── dashboard/          # React dashboard (Vite + Tailwind)
├── scripts/            # Utility scripts (airdrop, etc.)
└── sync-server/        # Centralized sync server (private)
```

## How to Contribute

### Reporting Bugs
- Open an issue with a clear title and description
- Include your Node.js version, OS, and relevant logs
- Redact any private keys, API keys, or wallet addresses

### Suggesting Features
- Open an issue tagged `[Feature Request]`
- Describe the use case and expected behavior

### Submitting Code
1. Create a feature branch from `main`: `git checkout -b feat/my-feature`
2. Make your changes with clear, focused commits
3. Test locally in **dry-run mode** before submitting
4. Open a pull request with a description of what changed and why

### Code Style
- TypeScript for all source files in `src/`
- ESM modules (`import`/`export`, no `require`)
- Descriptive variable names, minimal comments (code should be self-documenting)
- Use `const` by default, `let` only when mutation is needed

### Areas We'd Love Help With
- **New signal plugins** — Add new scoring dimensions to `signals.ts`
- **Dashboard improvements** — Better charts, mobile responsiveness
- **Trading strategies** — Alternative exit logic, DCA support
- **Documentation** — Tutorials, video guides, architecture docs
- **Testing** — Unit tests for signal scoring and RAG system
- **Integrations** — New DEX support, alert channels (Telegram, Discord)

## Security

- **NEVER** commit `.env` files, private keys, or API keys
- **NEVER** log wallet private keys or seed phrases
- Report security vulnerabilities privately — see [SECURITY.md](SECURITY.md) if available, or email the maintainers directly
- All data shared via the sync system is anonymized (no wallet addresses in trade data)

## Mining & Points

Pumpberg uses a "Proof of Data" model where every node contributes anonymized trade data and earns quality-weighted points. If you're working on the points system:

- Points are calculated in `src/points.ts`
- Quality weights reward trades with richer signal data
- The leaderboard is served by the sync server
- Airdrop distribution uses `scripts/airdrop.ts`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
