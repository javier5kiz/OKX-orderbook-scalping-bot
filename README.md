# OKX Underdog Value Bot

Paper trading bot for OKX event contracts (BTC/ETH 5-min up/down).
Tracks REAL market data from OKX public API — no API keys needed for dry run.

## Strategy: Underdog Value
Every cycle, buy the underdog (cheaper side) when priced ≤ 40¢.
Track win/loss at settlement to measure real win rate.

## Deploy on Railway
1. New Project → Deploy from GitHub → select this repo
2. Railway auto-detects Node.js
3. Start command: `node src/bot.js`
4. No env vars needed for dry run mode

## Config
Edit `src/config.js` for markets, thresholds, trade size.
