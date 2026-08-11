/**
 * config.js — OKX Pairs Divergence Bot Configuration
 * 
 * Dry-run mode: tracks REAL OKX event contract prices
 * No API keys needed for public market data (tickers, order book)
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
  // Both BTC and ETH must be same interval so they settle at the same time
  markets: [
    { underlying: 'BTC', interval: 5, label: 'BTC 5min' },
    { underlying: 'ETH', interval: 5, label: 'ETH 5min' },
  ],

  // ── Pairs Divergence Strategy ──────────────────────────────
  strategy: {
    dryRun: true,

    // Combined price threshold — enter if BTC_side + ETH_opposite ≤ this
    maxCombinedPrice: 0.80,     // 80¢ combined (e.g., 40¢ + 40¢, or 35¢ + 45¢)

    // Per-side max (don't buy if either side is above this even if combined is under 80¢)
    maxPerSide: 0.50,           // 50¢ max per side

    // Paper trade size per side (USDT)
    tradeSizeUsdt: 10,          // $10 per side = $20 total per pairs trade

    // Poll interval during cycle
    pollIntervalMs: 3000,

    // Stop entering new trades X seconds before cycle end
    noEntryBeforeEnd: 15,
  },

  // ── Logging ────────────────────────────────────────────────
  log: {
    showOrderbook: true,
    showAllPolls: false,
  },
};
