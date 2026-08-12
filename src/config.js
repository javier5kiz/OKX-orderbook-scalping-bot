/**
 * config.js — OKX Pairs Divergence Bot Configuration
 * 
 * LIVE MODE: places real orders on OKX using API keys.
 * Change contractSize to scale position sizes.
 */

module.exports = {
  okx: {
    baseURL: 'https://www.okx.com',
    apiKey:     process.env.OKX_API_KEY     || '',
    secretKey:  process.env.OKX_SECRET_KEY  || '',
    passphrase: process.env.OKX_PASSPHRASE  || '',
    isDemo:     process.env.IS_DEMO === 'true',
  },

  // ── Markets ───────────────────────────────────────────────
  markets: [
    { underlying: 'BTC', interval: 5, label: 'BTC 5min' },
    { underlying: 'ETH', interval: 5, label: 'ETH 5min' },
  ],

  // ── Pairs Divergence Strategy ──────────────────────────────
  strategy: {
    // ════════════════════════════════════════════════════════
    // LIVE TRADING — set to false to trade with real money
    // Set to true for paper trading (no real orders)
    // ════════════════════════════════════════════════════════
    dryRun: false,

    // ── Position Sizing ───────────────────────────────────
    // Contracts per side. Change this to scale up:
    //   0.1  = test money (~$0.07/trade)
    //   1.0  = small (~$0.68/trade)  
    //   10.0 = medium (~$6.80/trade)
    //   100  = large (~$68/trade)
    contractSize: 0.1,       // ← CHANGE THIS to scale position size

    // ── Entry Filters ─────────────────────────────────────
    // Combined price threshold — enter if BTC_side + ETH_opposite ≤ this
    maxCombinedPrice: 0.80,   // 80¢ combined (e.g., 40¢ + 40¢, or 35¢ + 45¢)

    // Per-side limits
    maxPerSide: 0.45,         // 45¢ max — 50¢ has zero edge (break-even if win)
    minPrice: 0.10,           // 10¢ min — below this, order book is empty/unfillable

    // ── Timing ─────────────────────────────────────────────
    pollIntervalMs: 3000,    // Poll prices every 3s
    noEntryBeforeEnd: 15,     // Stop entering 15s before cycle end
  },

  // ── Logging ────────────────────────────────────────────────
  log: {
    showOrderbook: true,
    showAllPolls: false,
  },
};
