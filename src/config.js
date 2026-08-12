/**
 * config.js — OKX Pairs Divergence Bot Configuration
 * 
 * LIVE MODE: places real orders on OKX using API keys.
 * Position sizing: dynamic 5% of account balance per side.
 */

module.exports = {
  okx: {
    baseURL: 'https://www.okx.com',
    apiKey:     process.env.OKX_API_KEY     || '',
    secretKey:  process.env.OKX_SECRET_KEY  || '',
    passphrase: process.env.OKX_PASSPHRASE  || '',
    isDemo:     process.env.IS_DEMO === 'true',
  },

  markets: [
    { underlying: 'BTC', interval: 5, label: 'BTC 5min' },
    { underlying: 'ETH', interval: 5, label: 'ETH 5min' },
  ],

  strategy: {
    dryRun: false,

    // ════════════════════════════════════════════════════════
    // POSITION SIZING — dynamic based on account balance
    //   riskPerSide: 0.05 = 5% of balance per order (10% total per pair)
    //   Bot fetches balance each cycle and calculates:
    //   contractSize = (balance * riskPerSide) / entryPrice
    //   e.g. $0.89 balance, 40¢ entry → 0.0445/0.40 = 0.11 contracts
    //   e.g. $0.89 balance, 30¢ entry → 0.0445/0.30 = 0.15 contracts
    // ════════════════════════════════════════════════════════
    riskPerSide: 0.05,  // 5% of balance per side
    minContractSize: 0.01,  // minimum contract size (OKX minimum)

    maxCombinedPrice: 0.80,
    maxPerSide: 0.45,
    minPrice: 0.10,

    pollIntervalMs: 3000,
    noEntryBeforeEnd: 15,
  },

  log: {
    showOrderbook: true,
    showAllPolls: false,
  },
};
