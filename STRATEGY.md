# Near-Strike Dual Confirmation Strategy

## Summary

**Name:** Near-Strike Dual Confirmation  
**Markets:** OKX BTC 5-min (`BTC-UPDOWN-5MIN`) + ETH 5-min (`ETH-UPDOWN-5MIN`)  
**Mode:** Live or Paper (set `DRY_RUN=true` env var)

---

## How It Works

Every 5-min cycle, in the **last 20 seconds** before expiry:

1. **BTC near-strike check:** `|BTC spot - BTC strike| <= $2.00`
2. **ETH near-strike check:** `|ETH spot - ETH strike| <= $0.08`
3. If **both** conditions met → market is stuck, undecided
4. Find the **underdog side** on each (lower priced side = market thinks it's less likely)
5. Only enter if underdog price **≤ 8¢** on both
6. Place **0.1 contracts** on each underdog side
7. Let contracts settle naturally at $1 (win) or $0 (loss) at expiry

---

## Risk / Reward

| Item | Value |
|------|-------|
| Max cost per trade side | $0.008 (0.1 × 8¢) |
| Total cost per dual entry | $0.016 |
| Win payout per side | $0.10 |
| Return on risk (per winning side) | 12.5× |
| Max loss per cycle | $0.016 |

---

## Why This Works

When BTC is within $2 of its strike with 20 seconds left, the last-second tick determines
the winner. The underdog side (priced at 8¢ or less) reflects the market's low-confidence
view. A single tick in the "wrong" direction sends that contract to $1. It's a last-second
volatility lottery with capped downside.

---

## PnL Tracking

Every trade logs:
- Entry cost (BTC + ETH combined)
- Settlement result per side (WIN/LOSS)
- Cycle PnL
- Running totals: trades, btcWins, ethWins, bothWins, winRate%, totalSpent, netPnL

---

## Configuration (`src/config.js`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` env | `false` | `true` = paper trade |
| `btcNearStrikeThreshold` | `2.0` | Max BTC distance from strike ($) |
| `ethNearStrikeThreshold` | `0.08` | Max ETH distance from strike ($) |
| `contractSize` | `0.1` | Contracts per side |
| `maxUnderdogPrice` | `0.08` | Max underdog price (8¢) |
| `entryWindowSecs` | `20` | Seconds before expiry to evaluate |
| `pollIntervalMs` | `1000` | Poll interval |

---

## Environment Variables

- `OKX_API_KEY`
- `OKX_SECRET_KEY`
- `OKX_PASSPHRASE`
- `IS_DEMO` — `true` for demo account, `false` for live
- `DRY_RUN` — `true` for paper trading (no real orders placed)
