/**
 * bot.js — OKX Pairs Divergence Bot (Dry Run)
 * 
 * Strategy: Pairs Divergence
 * 
 * Scans BTC and ETH 5-min event contracts simultaneously.
 * Looks for opposite-side underdogs that are both cheap:
 *   - BTC UP cheap + ETH DOWN cheap → buy both (bet BTC up, ETH down)
 *   - BTC DOWN cheap + ETH UP cheap → buy both (bet BTC down, ETH up)
 * 
 * Enter when combined price ≤ 80¢ (e.g., BTC UP @ 35¢ + ETH DOWN @ 35¢ = 70¢)
 * 
 * Why it works — 4 scenarios at settlement:
 *   1. BTC UP wins + ETH DOWN wins → BOTH HIT → +$2 on $0.70 cost = +$1.30
 *   2. BTC UP wins + ETH DOWN loses → ONE HIT → +$1 on $0.70 cost = +$0.30
 *   3. BTC UP loses + ETH DOWN wins → ONE HIT → +$1 on $0.70 cost = +$0.30
 *   4. BTC UP loses + ETH DOWN loses → MISS → $0 on $0.70 cost = -$0.70
 * 
 * Profit in 3/4 scenarios. Only lose when BTC and ETH move together 
 * in the SAME direction (both up or both down), which is the one 
 * scenario your bet is against.
 * 
 * MODE: Dry run (paper trading) — no real orders.
 * DATA: REAL OKX market data.
 */

const OKXClient = require('./okxClient');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Instrument ID helper ──────────────────────────────────────
// Format: BTC-UPDOWN-5MIN-YYMMDD-HHMM-HHMM (Beijing time UTC+8)
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
  pairsTrades: 0,       // Total pairs trades entered
  bothHit: 0,           // Both sides won (big win)
  oneHit: 0,            // One side won (small profit)
  totalMiss: 0,         // Both sides lost
  totalInvested: 0,     // Total USDT "spent" on both sides
  totalReturned: 0,      // Total USDT "received" from winners
  bestTrade: null,
  worstTrade: null,
  tradeHistory: [],
  // Track individual legs too
  btcLegs: { trades: 0, wins: 0, losses: 0 },
  ethLegs: { trades: 0, wins: 0, losses: 0 },
};

// ── Running stats line ────────────────────────────────────────
function printRunningStats() {
  const t = stats.pairsTrades;
  const wr = t > 0 ? (((stats.bothHit + stats.oneHit) / t) * 100).toFixed(1) : '0.0';
  const netPnl = stats.totalReturned - stats.totalInvested;
  const roi = stats.totalInvested > 0
    ? ((netPnl / stats.totalInvested) * 100).toFixed(1)
    : '0.0';
  const sign = netPnl >= 0 ? '+' : '';

  logger.info(
    `${logger.COLORS.bold}📦 RUNNING: ${t} pairs trades | ` +
    `Both: ${stats.bothHit} | One: ${stats.oneHit} | Miss: ${stats.totalMiss} | ` +
    `Win rate: ${wr}% | PnL: ${sign}$${netPnl.toFixed(2)} | ROI: ${sign}${roi}%${logger.COLORS.reset}`
  );

  // Per-leg stats
  const btcWR = stats.btcLegs.trades > 0 ? ((stats.btcLegs.wins / stats.btcLegs.trades) * 100).toFixed(0) : '—';
  const ethWR = stats.ethLegs.trades > 0 ? ((stats.ethLegs.wins / stats.ethLegs.trades) * 100).toFixed(0) : '—';
  logger.info(
    `   BTC legs: ${stats.btcLegs.trades} (${btcWR}% win) | ` +
    `ETH legs: ${stats.ethLegs.trades} (${ethWR}% win)`
  );
}

// ── Full summary ──────────────────────────────────────────────
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
  logger.line(`Both hit (2x win): ${stats.bothHit} | One hit (1x win): ${stats.oneHit} | Miss (both lose): ${stats.totalMiss}`);
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
  const interval = 5; // 5 min
  const intervalSec = interval * 60;

  // Wait for cycle to align
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

  // 1. Get opening prices for both
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

  // Wait for contracts to be active
  if (getSecondsIntoCycle(interval) < 5) await sleep(5000);

  // 2. Poll both simultaneously, look for pairs opportunity
  let entered = false;
  let btcEntry = 0, ethEntry = 0;
  let btcSide = '', ethSide = '';
  let entryTime = 0;
  let pollCount = 0;

  while (getSecondsRemaining(interval) > config.strategy.noEntryBeforeEnd) {
    // Fetch both tickers at the same time
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

    if (!entered) {
      // ── Check all 4 combos for pairs opportunity ────────────
      // We want opposite sides: BTC UP + ETH DOWN, or BTC DOWN + ETH UP
      const combos = [
        { btcSide: 'UP', ethSide: 'DOWN', btcPrice: btcUp,   ethPrice: ethDown },
        { btcSide: 'DOWN', ethSide: 'UP', btcPrice: btcDown, ethPrice: ethUp   },
      ];

      let bestCombo = null;
      let bestCombined = 1;

      for (const c of combos) {
        const combined = c.btcPrice + c.ethPrice;
        if (combined <= config.strategy.maxCombinedPrice &&
            c.btcPrice <= config.strategy.maxPerSide &&
            c.ethPrice <= config.strategy.maxPerSide) {
          if (combined < bestCombined) {
            bestCombined = combined;
            bestCombo = c;
          }
        }
      }

      if (bestCombo) {
        // Found a pairs opportunity!
        entered = true;
        btcEntry = bestCombo.btcPrice;
        ethEntry = bestCombo.ethPrice;
        btcSide = bestCombo.btcSide;
        ethSide = bestCombo.ethSide;
        entryTime = getSecondsIntoCycle(interval);

        const combinedCost = btcEntry + ethEntry;
        const costUsd = config.strategy.tradeSizeUsdt * 2; // both sides
        const btcContracts = config.strategy.tradeSizeUsdt / btcEntry;
        const ethContracts = config.strategy.tradeSizeUsdt / ethEntry;
        const maxPayout = btcContracts + ethContracts; // both win
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
          `   Cost: $${costUsd} | ` +
          `Both win: +$${(maxPayout - costUsd).toFixed(2)} | ` +
          `One win: +$${(oneWinPayout - costUsd).toFixed(2)} | ` +
          `Both lose: -$${costUsd} | ` +
          `Entry: ${entryTime}s`
        );

        if (config.log.showOrderbook) {
          logger.info(
            `   📊 BTC UP=${(btcUp * 100).toFixed(1)}¢ DOWN=${(btcDown * 100).toFixed(1)}¢ | ` +
            `ETH UP=${(ethUp * 100).toFixed(1)}¢ DOWN=${(ethDown * 100).toFixed(1)}¢`
          );
        }
      } else if (pollCount === 0 || pollCount % 5 === 0) {
        // Log status periodically when no entry
        const bestOpp = Math.min(
          btcUp + ethDown,
          btcDown + ethUp
        );
        logger.info(
          `📊 BTC UP=${(btcUp * 100).toFixed(1)}¢ DOWN=${(btcDown * 100).toFixed(1)}¢ | ` +
          `ETH UP=${(ethUp * 100).toFixed(1)}¢ DOWN=${(ethDown * 100).toFixed(1)}¢ | ` +
          `Best combo: ${(bestOpp * 100).toFixed(1)}¢${bestOpp <= 0.80 ? ' ← ENTRY!' : ' (>80¢ no entry)'}`
        );
      }
    }

    pollCount++;
    await sleep(config.strategy.pollIntervalMs);
  }

  // 3. Wait for cycle end
  const remaining = getSecondsRemaining(interval);
  if (remaining > 0) await sleep(remaining * 1000);

  // 4. Get settlement prices
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

  // 6. Track trade result
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
      btcSide, ethSide,
      btcEntry, ethEntry,
      combinedCost,
      btcOpen, ethOpen,
      btcSettle, ethSettle,
      btcWinner, ethWinner,
      btcResult, ethResult,
      result, pnl,
      cost: costUsd,
      payout: totalPayout,
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

  while (true) {
    try {
      await runCycle(client);

      // Full summary every 5 cycles
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
