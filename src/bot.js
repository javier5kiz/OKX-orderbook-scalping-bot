/**
 * bot.js — OKX Pairs Divergence Bot (Dry Run)
 * 
 * Strategy: Pairs Divergence
 * Scan BTC + ETH 5-min event contracts simultaneously.
 * Buy opposite sides when combined ≤ 80¢.
 * Profit in 3/4 scenarios.
 * 
 * Heartbeat: prints PnL + win rate every 30 seconds.
 */

const OKXClient = require('./okxClient');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Instrument ID (Beijing time UTC+8) ─────────────────────────
function getInstId(underlying, interval) {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMin = Math.floor(totalMin / interval) * interval;
  const endMin = startMin + interval;
  const s = `${String(Math.floor(startMin / 60)).padStart(2, '0')}${String(startMin % 60).padStart(2, '0')}`;
  const e = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}`;
  return `${underlying}-UPDOWN-${interval}MIN-${yy}${mm}${dd}-${s}-${e}`;
}

function getSecondsIntoCycle(interval) {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const totalSec = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  return totalSec - Math.floor(totalSec / (interval * 60)) * (interval * 60);
}

function getSecondsRemaining(interval) {
  return interval * 60 - getSecondsIntoCycle(interval);
}

// ── Global Stats ──────────────────────────────────────────────
const stats = {
  cycles: 0,
  pairsTrades: 0,
  bothHit: 0,
  oneHit: 0,
  totalMiss: 0,
  totalInvested: 0,
  totalReturned: 0,
  bestTrade: null,
  worstTrade: null,
  tradeHistory: [],
  btcLegs: { trades: 0, wins: 0, losses: 0 },
  ethLegs: { trades: 0, wins: 0, losses: 0 },
  startTime: Date.now(),
};

// ── Live price snapshot (updated every poll) ──────────────────
const livePrices = {
  btcUp: 0, btcDown: 0, ethUp: 0, ethDown: 0,
  btcSpot: 0, ethSpot: 0,
  lastUpdate: 0,
};

// ── Heartbeat: print PnL + win rate every 30s ──────────────────
function startHeartbeat() {
  setInterval(() => {
    const t = stats.pairsTrades;
    const settled = stats.bothHit + stats.oneHit + stats.totalMiss;
    const wins = stats.bothHit + stats.oneHit;
    const wr = settled > 0 ? ((wins / settled) * 100).toFixed(1) : '0.0';
    const netPnl = stats.totalReturned - stats.totalInvested;
    const roi = stats.totalInvested > 0 ? ((netPnl / stats.totalInvested) * 100).toFixed(1) : '0.0';
    const sign = netPnl >= 0 ? '+' : '';
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const upMin = Math.floor(uptime / 60);
    const upSec = uptime % 60;

    // Count open (unsettled) positions
    const openCount = t - settled;

    // Live price line with per-side check for entry signal
    let priceLine = '';
    if (livePrices.lastUpdate > 0) {
      const combo1 = livePrices.btcUp + livePrices.ethDown;
      const combo2 = livePrices.btcDown + livePrices.ethUp;
      const bestCombo = Math.min(combo1, combo2);
      const comboStr = bestCombo > 0 ? (bestCombo * 100).toFixed(1) : '—';
      
      // Check if best combo would actually pass per-side filter
      const maxPerSide = config.strategy.maxPerSide;
      let bestValid = false;
      let bestSide = '';
      const minP = config.strategy.minPrice || 0.10;
      if (combo1 <= config.strategy.maxCombinedPrice) {
        const btcOk = livePrices.btcUp <= maxPerSide && livePrices.btcUp >= minP;
        const ethOk = livePrices.ethDown <= maxPerSide && livePrices.ethDown >= minP;
        if (btcOk && ethOk) { bestValid = true; bestSide = 'BTC↑+ETH↓'; }
      }
      if (!bestValid && combo2 <= config.strategy.maxCombinedPrice) {
        const btcOk = livePrices.btcDown <= maxPerSide && livePrices.btcDown >= minP;
        const ethOk = livePrices.ethUp <= maxPerSide && livePrices.ethUp >= minP;
        if (btcOk && ethOk) { bestValid = true; bestSide = 'BTC↓+ETH↑'; }
      }
      
      const entryFlag = bestValid ? ` ← ENTRY! (${bestSide})` : '';
      priceLine = ` | BTC ↑${(livePrices.btcUp * 100).toFixed(0)}¢ ↓${(livePrices.btcDown * 100).toFixed(0)}¢ | ETH ↑${(livePrices.ethUp * 100).toFixed(0)}¢ ↓${(livePrices.ethDown * 100).toFixed(0)}¢ | Best: ${comboStr}¢${entryFlag}`;
    }

    const openStr = openCount > 0 ? ` | 🔴 OPEN: ${openCount}` : '';
    
    console.log(
      `${logger.COLORS.gray}[${new Date().toLocaleTimeString('en-US', { hour12: false })}]${logger.COLORS.reset} ` +
      `${logger.COLORS.bold}📊 [${upMin}m${upSec}s] ` +
      `Trades: ${t} | W:${wins} L:${stats.totalMiss} | WR: ${wr}% | ` +
      `PnL: ${sign}$${netPnl.toFixed(2)} | ROI: ${sign}${roi}%${openStr}` +
      `${priceLine}${logger.COLORS.reset}`
    );
  }, 30000); // every 30 seconds
}

// ── Print running stats after each trade ──────────────────────
function printRunningStats() {
  const t = stats.pairsTrades;
  const wins = stats.bothHit + stats.oneHit;
  const wr = t > 0 ? ((wins / t) * 100).toFixed(1) : '0.0';
  const netPnl = stats.totalReturned - stats.totalInvested;
  const roi = stats.totalInvested > 0 ? ((netPnl / stats.totalInvested) * 100).toFixed(1) : '0.0';
  const sign = netPnl >= 0 ? '+' : '';

  logger.info(
    `${logger.COLORS.bold}📦 RESULT: ${t} pairs | Both: ${stats.bothHit} | One: ${stats.oneHit} | Miss: ${stats.totalMiss} | ` +
    `WR: ${wr}% | PnL: ${sign}$${netPnl.toFixed(2)} | ROI: ${sign}${roi}%${logger.COLORS.reset}`
  );

  const btcWR = stats.btcLegs.trades > 0 ? ((stats.btcLegs.wins / stats.btcLegs.trades) * 100).toFixed(0) : '—';
  const ethWR = stats.ethLegs.trades > 0 ? ((stats.ethLegs.wins / stats.ethLegs.trades) * 100).toFixed(0) : '—';
  logger.info(
    `   BTC legs: ${stats.btcLegs.trades} (${btcWR}% win) | ` +
    `ETH legs: ${stats.ethLegs.trades} (${ethWR}% win)`
  );
}

// ── Full summary every 5 cycles ───────────────────────────────
function printSummary() {
  const t = stats.pairsTrades;
  const wins = stats.bothHit + stats.oneHit;
  const wr = t > 0 ? ((wins / t) * 100).toFixed(1) : '0.0';
  const netPnl = stats.totalReturned - stats.totalInvested;
  const roi = stats.totalInvested > 0 ? ((netPnl / stats.totalInvested) * 100).toFixed(1) : '0.0';
  const sign = netPnl >= 0 ? '+' : '';

  logger.banner('📊 PAIRS DIVERGENCE — CUMULATIVE STATS');
  logger.line(`Cycles watched: ${stats.cycles}`);
  logger.line(`Pairs trades: ${t}`);
  logger.line(`Both hit: ${stats.bothHit} | One hit: ${stats.oneHit} | Miss: ${stats.totalMiss}`);
  logger.line(`Win rate: ${wr}% (profit in ${wins}/${t} trades)`);
  logger.line('');
  logger.line(`Invested:  $${stats.totalInvested.toFixed(2)}`);
  logger.line(`Returned:  $${stats.totalReturned.toFixed(2)}`);
  logger.line(`Net PnL:   ${sign}$${netPnl.toFixed(2)}`);
  logger.line(`ROI:       ${sign}${roi}%`);

  if (stats.bestTrade) {
    logger.line('');
    logger.line(`🏆 Best:  ${stats.bestTrade.btcSide}/${stats.bestTrade.ethSide} → ${stats.bestTrade.result} → +$${stats.bestTrade.pnl.toFixed(2)}`);
  }
  if (stats.worstTrade) {
    logger.line(`💀 Worst: ${stats.worstTrade.btcSide}/${stats.worstTrade.ethSide} → ${stats.worstTrade.result} → -$${Math.abs(stats.worstTrade.pnl).toFixed(2)}`);
  }

  if (stats.tradeHistory.length > 0) {
    logger.line('');
    logger.line('Recent pairs trades (last 10):');
    stats.tradeHistory.slice(-10).forEach((t, i) => {
      const emoji = t.result === 'BOTH HIT' ? '💰' : t.result === 'ONE HIT' ? '✅' : '❌';
      const s = t.pnl >= 0 ? '+' : '';
      logger.line(
        `  ${i + 1}. ${emoji} BTC ${t.btcSide.padEnd(4)} @ ${(t.btcEntry * 100).toFixed(0)}¢ + ` +
        `ETH ${t.ethSide.padEnd(4)} @ ${(t.ethEntry * 100).toFixed(0)}¢ = ${(t.combinedCost * 100).toFixed(0)}¢ → ` +
        `${t.result} ${s}$${t.pnl.toFixed(2)}`
      );
    });
  }

  logger.divider();
}

// ── Run one cycle ──────────────────────────────────────────────
async function runCycle(client) {
  const interval = 5;
  const intervalSec = interval * 60;

  let secsRemaining = getSecondsRemaining(interval);
  if (secsRemaining < intervalSec - 2) {
    const wait = secsRemaining + 2;
    if (wait > 5) {
      logger.info(`⏳ ${wait}s to next cycle...`);
      await sleep(wait * 1000);
    }
  }

  stats.cycles++;

  const btcInstId = getInstId('BTC', interval);
  const ethInstId = getInstId('ETH', interval);
  const secIn = getSecondsIntoCycle(interval);
  const secLeft = getSecondsRemaining(interval);

  logger.divider();
  logger.info(`CYCLE ${stats.cycles} | BTC: ${btcInstId.slice(-15)} | ETH: ${ethInstId.slice(-15)}`);
  logger.info(`${secIn}s in, ${secLeft}s left | ${new Date().toUTCString()}`);

  // 1. Opening prices
  const [btcOpen, ethOpen] = await Promise.all([
    client.getSpotPrice('BTC-USDT'),
    client.getSpotPrice('ETH-USDT'),
  ]);

  if (!btcOpen || !ethOpen) {
    logger.warn('Could not get opening prices, skipping cycle');
    await sleep(secLeft * 1000);
    return;
  }

  logger.info(`📏 Opening: BTC $${btcOpen} | ETH $${ethOpen}`);

  if (getSecondsIntoCycle(interval) < 5) await sleep(5000);

  // 2. Poll both, look for pairs opportunity
  let entered = false;
  let btcEntry = 0, ethEntry = 0;
  let btcSide = '', ethSide = '';
  let entryTime = 0;
  let pollCount = 0;

  while (getSecondsRemaining(interval) > config.strategy.noEntryBeforeEnd) {
    const [btcTicker, ethTicker] = await Promise.all([
      client.getEventTicker(btcInstId),
      client.getEventTicker(ethInstId),
    ]);

    if (!btcTicker?.last || !ethTicker?.last) {
      if (pollCount === 0) logger.warn('No ticker data yet...');
      pollCount++;
      await sleep(config.strategy.pollIntervalMs);
      continue;
    }

    const btcUp = btcTicker.last;
    const btcDown = 1 - btcUp;
    const ethUp = ethTicker.last;
    const ethDown = 1 - ethUp;

    // Update live prices for heartbeat
    livePrices.btcUp = btcUp;
    livePrices.btcDown = btcDown;
    livePrices.ethUp = ethUp;
    livePrices.ethDown = ethDown;
    livePrices.lastUpdate = Date.now();

    if (!entered) {
      const combos = [
        { btcSide: 'UP', ethSide: 'DOWN', btcPrice: btcUp, ethPrice: ethDown },
        { btcSide: 'DOWN', ethSide: 'UP', btcPrice: btcDown, ethPrice: ethUp },
      ];

      let bestCombo = null;
      let bestCombined = 1;

      const minPrice = config.strategy.minPrice || 0.10;
      for (const c of combos) {
        const combined = c.btcPrice + c.ethPrice;
        if (combined <= config.strategy.maxCombinedPrice &&
            c.btcPrice <= config.strategy.maxPerSide &&
            c.ethPrice <= config.strategy.maxPerSide &&
            c.btcPrice >= minPrice &&
            c.ethPrice >= minPrice) {
          if (combined < bestCombined) {
            bestCombined = combined;
            bestCombo = c;
          }
        }
      }

      if (bestCombo) {
        entered = true;
        btcEntry = bestCombo.btcPrice;
        ethEntry = bestCombo.ethPrice;
        btcSide = bestCombo.btcSide;
        ethSide = bestCombo.ethSide;
        entryTime = getSecondsIntoCycle(interval);

        const combinedCost = btcEntry + ethEntry;
        const costUsd = config.strategy.tradeSizeUsdt * 2;
        const btcContracts = config.strategy.tradeSizeUsdt / btcEntry;
        const ethContracts = config.strategy.tradeSizeUsdt / ethEntry;
        const maxPayout = btcContracts + ethContracts;
        const oneWinPayout = Math.max(btcContracts, ethContracts);

        stats.pairsTrades++;
        stats.totalInvested += costUsd;
        stats.btcLegs.trades++;
        stats.ethLegs.trades++;

        logger.enter(
          `${logger.COLORS.bold}🎯 PAIRS ENTRY: BTC ${btcSide} @ ${(btcEntry * 100).toFixed(1)}¢ + ` +
          `ETH ${ethSide} @ ${(ethEntry * 100).toFixed(1)}¢ = ${(combinedCost * 100).toFixed(1)}¢ combined${logger.COLORS.reset}`
        );
        logger.info(
          `   BTC ${btcSide}: $${config.strategy.tradeSizeUsdt} → ${btcContracts.toFixed(1)} contracts | ` +
          `ETH ${ethSide}: $${config.strategy.tradeSizeUsdt} → ${ethContracts.toFixed(1)} contracts`
        );
        logger.info(
          `   Cost: $${costUsd} | Both win: +$${(maxPayout - costUsd).toFixed(2)} | ` +
          `One win: +$${(oneWinPayout - costUsd).toFixed(2)} | Both lose: -$${costUsd} | ` +
          `Entry: ${entryTime}s`
        );
      } else if (pollCount === 0 || pollCount % 5 === 0) {
        const bestOpp = Math.min(btcUp + ethDown, btcDown + ethUp);
        // Check per-side limits for display
        let entryFlag = ' (>80¢)';
        if (bestOpp <= config.strategy.maxCombinedPrice) {
          const minP = config.strategy.minPrice || 0.10;
          const c1ok = btcUp <= config.strategy.maxPerSide && btcUp >= minP && ethDown <= config.strategy.maxPerSide && ethDown >= minP;
          const c2ok = btcDown <= config.strategy.maxPerSide && btcDown >= minP && ethUp <= config.strategy.maxPerSide && ethUp >= minP;
          if (c1ok || c2ok) entryFlag = ' ← ENTRY!';
          else entryFlag = ` (combo ok but side out of range ${minP*100}-${config.strategy.maxPerSide*100}¢)`;
        }
        logger.info(
          `📊 BTC ↑${(btcUp * 100).toFixed(1)}¢ ↓${(btcDown * 100).toFixed(1)}¢ | ` +
          `ETH ↑${(ethUp * 100).toFixed(1)}¢ ↓${(ethDown * 100).toFixed(1)}¢ | ` +
          `Best combo: ${(bestOpp * 100).toFixed(1)}¢${entryFlag}`
        );
      }
    }

    pollCount++;
    await sleep(config.strategy.pollIntervalMs);
  }

  // 3. Wait for cycle end
  const remaining = getSecondsRemaining(interval);
  if (remaining > 0) await sleep(remaining * 1000);

  // 4. Settlement prices
  await sleep(2000);
  const [btcSettle, ethSettle] = await Promise.all([
    client.getSpotPrice('BTC-USDT'),
    client.getSpotPrice('ETH-USDT'),
  ]);

  if (!btcSettle || !ethSettle) {
    logger.warn('Could not get settlement prices');
    if (entered) printRunningStats();
    return;
  }

  // 5. Determine winners
  const btcChange = btcSettle - btcOpen;
  const ethChange = ethSettle - ethOpen;
  const btcWinner = btcChange > 0 ? 'UP' : btcChange < 0 ? 'DOWN' : 'TIE';
  const ethWinner = ethChange > 0 ? 'UP' : ethChange < 0 ? 'DOWN' : 'TIE';

  logger.info(
    `📏 Settlement: BTC $${btcSettle} (${btcChange >= 0 ? '+' : ''}$${btcChange.toFixed(2)} → ${btcWinner}) | ` +
    `ETH $${ethSettle} (${ethChange >= 0 ? '+' : ''}$${ethChange.toFixed(2)} → ${ethWinner})`
  );

  // 6. Track result
  if (entered) {
    const costUsd = config.strategy.tradeSizeUsdt * 2;
    const btcContracts = config.strategy.tradeSizeUsdt / btcEntry;
    const ethContracts = config.strategy.tradeSizeUsdt / ethEntry;

    let btcPayout = 0, ethPayout = 0;
    let btcResult = 'LOSS', ethResult = 'LOSS';

    if (btcWinner === btcSide) {
      btcPayout = btcContracts;
      btcResult = 'WIN';
      stats.btcLegs.wins++;
    }
    if (ethWinner === ethSide) {
      ethPayout = ethContracts;
      ethResult = 'WIN';
      stats.ethLegs.wins++;
    }

    const totalPayout = btcPayout + ethPayout;
    const pnl = totalPayout - costUsd;
    const combinedCost = btcEntry + ethEntry;

    let result, emoji;
    if (btcResult === 'WIN' && ethResult === 'WIN') {
      result = 'BOTH HIT';
      emoji = '💰';
      stats.bothHit++;
      logger.win(
        `${emoji} BTC ${btcSide} ✅ + ETH ${ethSide} ✅ → BOTH HIT | ` +
        `+$${pnl.toFixed(2)} (paid $${costUsd}, got $${totalPayout.toFixed(2)})`
      );
    } else if (btcResult === 'WIN' || ethResult === 'WIN') {
      result = 'ONE HIT';
      emoji = '✅';
      stats.oneHit++;
      const winSide = btcResult === 'WIN' ? `BTC ${btcSide}` : `ETH ${ethSide}`;
      const loseSide = btcResult === 'LOSS' ? `BTC ${btcSide}` : `ETH ${ethSide}`;
      logger.info(
        `${emoji} ${winSide} won, ${loseSide} lost → ONE HIT | ` +
        `+${pnl.toFixed(2)} (paid $${costUsd}, got $${totalPayout.toFixed(2)})`
      );
    } else {
      result = 'MISS';
      emoji = '❌';
      stats.totalMiss++;
      logger.loss(
        `${emoji} BTC ${btcSide} ❌ + ETH ${ethSide} ❌ → BOTH MISSED | ` +
        `-$${costUsd} (winners were BTC ${btcWinner}, ETH ${ethWinner})`
      );
    }

    stats.totalReturned += totalPayout;

    const record = {
      time: new Date().toISOString(),
      cycle: stats.cycles,
      btcSide, ethSide, btcEntry, ethEntry, combinedCost,
      btcOpen, ethOpen, btcSettle, ethSettle,
      btcWinner, ethWinner, btcResult, ethResult,
      result, pnl, cost: costUsd, payout: totalPayout,
    };
    stats.tradeHistory.push(record);
    if (stats.tradeHistory.length > 200) stats.tradeHistory.shift();

    if (!stats.bestTrade || pnl > stats.bestTrade.pnl) stats.bestTrade = record;
    if (!stats.worstTrade || pnl < stats.worstTrade.pnl) stats.worstTrade = record;

    printRunningStats();
  } else {
    logger.info('No pairs entry this cycle (no combo under 80¢)');
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const mode = config.strategy.dryRun ? 'DRY RUN (paper trading)' : 'LIVE (real money)';

  logger.banner('OKX PAIRS DIVERGENCE BOT');
  logger.info(`Mode: ${mode}`);
  logger.info(`Strategy: BTC side + ETH opposite side ≤ ${(config.strategy.maxCombinedPrice * 100).toFixed(0)}¢ combined`);
  logger.info(`Markets: BTC 5min + ETH 5min (polled simultaneously)`);
  logger.info(`Trade size: $${config.strategy.tradeSizeUsdt} per side ($${config.strategy.tradeSizeUsdt * 2} per pair)`);
  logger.info(`Max per side: ${(config.strategy.maxPerSide * 100).toFixed(0)}¢`);
  logger.info(`Profit in 3/4 scenarios — only lose when BTC & ETH move same direction`);
  logger.info(`Heartbeat: PnL + win rate every 30 seconds`);
  logger.divider();

  const client = new OKXClient(config.okx);

  // Keep-alive HTTP server
  const http = require('http');
  const port = parseInt(process.env.PORT || '8080');
  http.createServer((req, res) => {
    const t = stats.pairsTrades;
    const wr = t > 0 ? (((stats.bothHit + stats.oneHit) / t) * 100).toFixed(1) : '0';
    const pnl = stats.totalReturned - stats.totalInvested;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(
      `Pairs Divergence Bot | Cycles: ${stats.cycles} | Pairs: ${t} | ` +
      `Both: ${stats.bothHit} | One: ${stats.oneHit} | Miss: ${stats.totalMiss} | ` +
      `WR: ${wr}% | PnL: $${pnl.toFixed(2)}`
    );
  }).listen(port, () => logger.info(`Keep-alive on :${port}`));

  logger.info('🚀 Bot started. Scanning BTC + ETH event contracts...\n');

  // Start 30-second heartbeat
  startHeartbeat();

  while (true) {
    try {
      await runCycle(client);

      if (stats.cycles % 5 === 0) {
        printSummary();
      }
    } catch (err) {
      logger.error(`Cycle error: ${err.message}`);
      await sleep(5000);
    }
  }
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
