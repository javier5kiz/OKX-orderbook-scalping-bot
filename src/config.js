/**
 * config.js — OKX Price Distance Strategy Configuration
 * 
 * Strategy: Price Distance Confirmation
 * Enter UP when spot is +$15 above strike, DOWN when -$15 below.
 * Exit via TP/SL sell orders before expiry for 5:1 RR.
 */

module.exports = {
  okx: {
    baseURL: 'https://www.okx.com',
    apiKey:     process.env.OKX_API_KEY     || '',
    secretKey:  process.env.OKX_SECRET_KEY  || '',
    passphrase: process.env.OKX_PASSPHRASE  || '',
    isDemo:     process.env.IS_DEMO === 'true',
  },

  strategy: {
    dryRun: false,

    // ════════════════════════════════════════════════════════
    // MARKET — which event contract series to trade
    // ════════════════════════════════════════════════════════
    seriesId: 'BTC-UPDOWN-5MIN',
    spotTicker: 'BTC-USDT',

    // ════════════════════════════════════════════════════════
    // ENTRY CONDITIONS
    //   Enter UP when spot >= strike + distanceThreshold
    //   Enter DOWN when spot <= strike - distanceThreshold
    //   Only enter if contract price <= maxEntryPrice (60¢)
    // ════════════════════════════════════════════════════════
    distanceThreshold: 15,    // $15 from strike for BTC (use 0.5 for ETH)
    maxEntryPrice: 0.60,      // buy at 60¢ or less
    contractSize: 0.1,        // 0.1 contracts per trade ($0.06 at 60¢)

    // ════════════════════════════════════════════════════════
    // EXIT CONDITIONS (sell before expiry)
    //   TP: sell when contract price reaches takeProfitPrice
    //   SL: sell when contract price drops to stopLossPrice
    //   At 60¢ entry: TP=85¢ (+$0.025), SL=55¢ (-$0.005) = 5:1 RR
    // ════════════════════════════════════════════════════════
    takeProfitPrice: 0.85,    // sell at 85¢ → +25¢ per contract
    stopLossPrice: 0.55,      // sell at 55¢ → -5¢ per contract
    // RR = 25/5 = 5:1

    // ════════════════════════════════════════════════════════
    // TIMING
    // ════════════════════════════════════════════════════════
    pollIntervalMs: 2000,    // poll every 2s
    noEntryBeforeEnd: 30,     // don't enter in last 30s of contract
    minBalance: 0.05,         // stop if balance below $0.05
  },

  log: {
    showAllPolls: false,
  },
};
