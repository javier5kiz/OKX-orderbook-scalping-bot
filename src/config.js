module.exports = {
  okx: {
    baseURL:    'https://www.okx.com',
    apiKey:     process.env.OKX_API_KEY     || '',
    secretKey:  process.env.OKX_SECRET_KEY  || '',
    passphrase: process.env.OKX_PASSPHRASE  || '',
    isDemo:     process.env.IS_DEMO === 'true',
  },
  strategy: {
    dryRun: (process.env.DRY_RUN || 'false') === 'true',

    // Market
    seriesId:   'BTC-UPDOWN-5MIN',
    spotTicker: 'BTC-USDT',

    // Order sizing
    // 0.1 contracts × ~50¢ entry price = ~$0.05 cost per trade
    contractSize: parseFloat(process.env.CONTRACT_SIZE || '0.1'),

    // Entry timing: enter N-M seconds after cycle opens
    // First 3s = API response delay, 5s max so we're in early
    entryWindowSecMin: parseInt(process.env.ENTRY_WIN_MIN || '3'),
    entryWindowSecMax: parseInt(process.env.ENTRY_WIN_MAX || '5'),

    // Safety
    minBalance:    parseFloat(process.env.MIN_BALANCE || '0.01'),
    pollIntervalMs: 1000,
  },
};
