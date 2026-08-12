# OKX Pairs Divergence Strategy — Complete Outline

## Strategy Summary

**Name:** Pairs Divergence
**Markets:** OKX BTC 5-min + ETH 5-min event contracts (simultaneous settlement)
**Mode:** Live trading (0.1 contracts per side, configurable)

---

## How It Works

The bot monitors BTC and ETH 5-minute event contracts simultaneously. Each contract has two sides: UP (price goes up) and DOWN (price goes down). Each side is priced between 0¢-100¢, where 100¢ = certainty.

The bot looks for moments when **opposite sides are both cheap**:
- BTC UP cheap + ETH DOWN cheap → buy both (bet BTC up, ETH down)
- BTC DOWN cheap + ETH UP cheap → buy both (bet BTC down, ETH up)

**Entry condition:** Combined price of both sides ≤ 80¢ (e.g., 35¢ + 33¢ = 68¢)

### Entry Filters
1. **Combined price ≤ 80¢** — total cost of both sides must be under 80¢
2. **Per-side max 45¢** — no side above 45¢ (50¢ = zero edge, break-even if win)
3. **Per-side min 10¢** — no side below 10¢ (order book is empty/unfillable at extreme prices)

---

## Why The 10¢ Floor Was Added

During dry-run testing, the bot bought ETH DOWN at 0.1¢ ($10 → 10,000 contracts). When it won, payout was $10,000 — showing +$10,186 fake profit. But in real trading:

- The `last` traded price was 0.1¢, but the **order book at that price was empty**
- Nobody is selling 10,000 contracts at a tenth of a cent
- You cannot actually fill an order at 0.1¢

Without the 10¢ floor, the dry-run PnL was **fake** (+$10,186). With the 10¢ floor, the PnL was **real** (+$422 over 96 trades, 74% win rate).

The 10¢ floor ensures the bot only enters at prices where real fills are possible.

---

## The 4 Scenarios At Settlement

Each pair trade buys BTC on one side + ETH on the opposite side. At settlement (5 minutes later):

| BTC Result | ETH Result | Outcome | PnL (on 68¢ combined) |
|-----------|-----------|--------|----------------------|
| Your side WINS | Your side WINS | 💰 BOTH HIT | +$0.32 per 0.1 contract |
| Your side WINS | Your side LOSES | ✅ ONE HIT | +$0.02 per 0.1 contract |
| Your side LOSES | Your side WINS | ✅ ONE HIT | +$0.02 per 0.1 contract |
| Your side LOSES | Your side LOSES | ❌ MISS | -$0.068 per 0.1 contract |

**Profit in 3 out of 4 scenarios.** Only lose when BTC and ETH move in the **same direction** — which is the one scenario your bet is against. Since BTC and ETH are ~85% correlated, the "both lose" scenario is relatively rare.

---

## Dry-Run Performance (Before Going Live)

- **96 trades** over ~23 hours
- **74% win rate** (71 wins, 25 losses)
- **+$422.11 PnL** on $1,920 invested (22% ROI)
- **Break-even win rate:** ~44%
- **Actual win rate:** 74% — well above break-even

---

## Configuration Variables

All settings are in `src/config.js` and can be changed without touching the bot logic:

| Variable | Default | Description |
|----------|---------|-------------|
| `dryRun` | `false` | `true` = paper trading, `false` = live orders |
| `contractSize` | `0.1` | Contracts per side (change to scale up) |
| `maxCombinedPrice` | `0.80` | Max combined price for both sides (80¢) |
| `maxPerSide` | `0.45` | Max price per individual side (45¢) |
| `minPrice` | `0.10` | Min price per side (10¢ floor) |
| `pollIntervalMs` | `3000` | How often to poll prices (3 seconds) |
| `noEntryBeforeEnd` | `15` | Stop entering 15s before cycle end |

### Scaling Up
To increase position size, change `contractSize` in config:
- `0.1` = test money (~$0.068 per trade)
- `1.0` = small size (~$0.68 per trade)
- `10.0` = medium size (~$6.80 per trade)
- `100.0` = large size (~$68 per trade)

---

## OKX API Setup

Required environment variables (set in Railway):
- `OKX_API_KEY` — your API key
- `OKX_SECRET_KEY` — your secret key
- `OKX_PASSPHRASE` — your passphrase
- `IS_DEMO` — set to `true` for demo trading, `false` for production

---

## Deployment

1. Repo: `javier5kiz/mexc-prediction-bot`
2. Railway auto-deploys on git push
3. Keep-alive HTTP server on port 8080
4. Heartbeat logs PnL + win rate every 30 seconds

---

## Risk Notes

- Event contracts are zero-sum: your win = someone else's loss
- 74% win rate is from 96 trades — may regress with more data
- At 0.1 contracts, max loss per trade is ~$0.07 (negligible)
- Strategy depends on BTC-ETH correlation holding — if they decouple, "both lose" rate increases
- Always monitor the first 10-20 live trades to verify fills match expected prices
