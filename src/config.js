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

  markets: [
    { underlying: 'BTC', interval: 5, label: 'BTC 5min' },
    { underlying: 'ETH', interval: 5, label: 'ETH 5min' },
  ],

  strategy: {
    dryRun: false,

    // ════════════════════════════════════════════════════════
    // CONTRACT SIZE — change this to scale up:
    //   0.1 = minimum OKX size (~$0.05/trade at 50¢ avg)
    //   1   = small (~$0.50/trade)
    //   10  = medium (~$5/trade)
    //   100 = large (~$50/trade)
    // ════════════════════════════════════════════════════════
    contractSize: 0.1,

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
