module.exports = {
  okx: {
    baseURL: 'https://www.okx.com',
    apiKey:     process.env.OKX_API_KEY     || '',
    secretKey:  process.env.OKX_SECRET_KEY  || '',
    passphrase: process.env.OKX_PASSPHRASE  || '',
    isDemo:     process.env.IS_DEMO === 'true',
  },
  strategy: {
    dryRun: (process.env.DRY_RUN || 'false') === 'true',
    // BTC settings
    btcSeriesId: 'BTC-UPDOWN-5MIN',
    btcSpotTicker: 'BTC-USDT',
    btcNearStrikeThreshold: 2.0,
    // ETH settings
    ethSeriesId: 'ETH-UPDOWN-5MIN',
    ethSpotTicker: 'ETH-USDT',
    ethNearStrikeThreshold: 0.08,
    // Order settings
    contractSize: 0.1,
    maxUnderdogPrice: 0.08,
    // Timing
    entryWindowSecs: 20,
    pollIntervalMs: 1000,
    minBalance: 0.01,
  },
};
