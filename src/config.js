/**
 * config.js — OKX Underdog Value Bot Configuration
 * 
 * Dry-run mode: tracks REAL OKX event contract prices
 * No API keys needed for public market data (tickers, order book)
 */



module.exports = {
  okx: {
    baseURL: 'https://www.okx.com',
    // API keys only needed for live trading (placing orders)
    // For dry-run mode (tracking prices), public endpoints work without keys
    apiKey:     process.env.OKX_API_KEY     || '',
    secretKey:  process.env.OKX_SECRET_KEY  || '',
    passphrase: process.env.OKX_PASSPHRASE  || '',
    isDemo:     process.env.IS_DEMO === 'true',
  },

  // ── Markets to track ───────────────────────────────────────
  // Each market: { underlying, interval (minutes), label }
  markets: [
    { underlying: 'BTC', interval: 5,  label: 'BTC 5min'  },
    { underlying: 'ETH', interval: 5,  label: 'ETH 5min'  },
  ],

  // ── Underdog Strategy ──────────────────────────────────────
  strategy: {
    // Buy the underdog (cheaper side) when price is at or below this threshold
    maxUnderdogPrice: 0.40,     // 40¢ — only enter if underdog ≤ 40¢
    
    // Paper trade size (in USDT) — what we WOULD have spent
    tradeSizeUsdt: 10,
    
    // How often to poll prices during each cycle (ms)
    pollIntervalMs: 3000,
    
    // Seconds before cycle end to stop entering new trades
    noEntryBeforeEnd: 15,
  },

  // ── Mode ───────────────────────────────────────────────────
  dryRun: true,   // true = paper trading (no real orders)
  
  // ── Logging ────────────────────────────────────────────────
  log: {
    showAllPolls: false,      // Log every price poll (verbose)
    showHeartbeat: true,      // Log periodic status
    showOrderbook: true,     // Log orderbook depth on entry
    showSummary: true,        // Log per-cycle summary
  },
};
