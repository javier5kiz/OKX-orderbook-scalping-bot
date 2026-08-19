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
    // Real BTC 5-min moves are $10-$100. Use $50 so we catch "close" cycles.
    btcNearStrikeThreshold: parseFloat(process.env.BTC_THRESHOLD || '50'),

    // ETH settings
    ethSeriesId: 'ETH-UPDOWN-5MIN',
    ethSpotTicker: 'ETH-USDT',
    // Real ETH 5-min moves are $1-$5. Use $2 so we catch "close" cycles.
    ethNearStrikeThreshold: parseFloat(process.env.ETH_THRESHOLD || '2'),

    // Order settings — underdog means the cheaper side
    contractSize: 0.1,

    // In the last 20s, underdog side is typically 1-40 cents.
    // Set to 0.40 (40¢) so we actually trade. At 40¢, 0.1 contracts = $0.04 cost,
    // win pays $0.10 = 2.5x. Lower this if you want only bigger underdogs.
    maxUnderdogPrice: parseFloat(process.env.MAX_UNDERDOG_PRICE || '0.40'),

    // Timing
    entryWindowSecs: parseInt(process.env.ENTRY_WINDOW_SECS || '20'),
    pollIntervalMs: 1000,
    minBalance: 0.01,
  },
};
