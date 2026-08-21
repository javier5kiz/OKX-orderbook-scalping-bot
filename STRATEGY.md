# BTC 5-Min Momentum Follow Strategy

## Summary

**Name:** Previous Cycle Momentum Follow  
**Market:** OKX `BTC-UPDOWN-5MIN`  
**Mode:** Live or Paper (`DRY_RUN=true`)

---

## How It Works

Every 5-minute BTC contract cycle:

1. **Wait for previous cycle to expire**
2. **At cycle open, read BTC spot price vs previous strike:**
   - `BTC spot >= previous strike` → previous cycle = **UP**
   - `BTC spot < previous strike` → previous cycle = **DOWN**
3. **In seconds 3-5 of the new cycle:**
   - Previous was UP → buy **YES (UP)** on new cycle
   - Previous was DOWN → buy **NO (DOWN)** on new cycle
4. **Place market order, 0.1 contracts max**
5. **Let settle at expiry** — contract pays $1 (win) or $0 (loss)

---

## Why This Approach

- **No threshold required** — always enters, every cycle (after first)
- **Simple momentum logic** — follows the direction BTC just moved
- **Micro cost** — 0.1 contracts × ~50¢ entry ≈ $0.05 per trade
- **Capped loss** — worst case lose entry price ($0.04-$0.06)
- **Win pays** — $0.10 per contract on 0.1 size (2x on 50¢ entry)

---

## Cost / Risk Table

| Entry price | Cost (0.1 contracts) | Win pays | Multiplier |
|-------------|----------------------|----------|------------|
| 40¢         | $0.040               | $0.10    | 2.5×       |
| 50¢         | $0.050               | $0.10    | 2.0×       |
| 60¢         | $0.060               | $0.10    | 1.67×      |

---

## Config (env vars)

| Variable         | Default           | Description                        |
|------------------|-------------------|------------------------------------|
| `DRY_RUN`        | `false`           | Paper trade (no real orders)       |
| `CONTRACT_SIZE`  | `0.1`             | Contracts per trade (max 0.1)      |
| `ENTRY_WIN_MIN`  | `3`               | Seconds into cycle to start entry  |
| `ENTRY_WIN_MAX`  | `5`               | Seconds into cycle to stop entry   |
| `OKX_API_KEY`    | —                 | Your OKX API key                   |
| `OKX_SECRET_KEY` | —                 | Your OKX secret key                |
| `OKX_PASSPHRASE` | —                 | Your OKX passphrase                |

---

## PnL Tracking

Every trade logs: direction, entry price, settlement result, PnL.  
Running totals: trades, wins, losses, win rate, total spent, total PnL.
