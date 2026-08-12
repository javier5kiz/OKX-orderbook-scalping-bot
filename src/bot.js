/**
 * bot.js — OKX Pairs Divergence Bot (Live + Dry Run)
 * 
 * Strategy: Pairs Divergence
 * Scan BTC + ETH 5-min event contracts simultaneously.
 * Buy opposite sides when combined ≤ 80¢.
 * Profit in 3/4 scenarios.
 * 
 * LIVE MODE: places real market orders via OKX API.
 * DRY RUN: paper trades using last price.
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
  liveOrders: 0,       // Count of real orders placed
  orderErrors: 0,      // Count of order failures
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

    const openCount = t - settled;

    let priceLine = '';
    if (livePrices.lastUpdate > 0) {
      const combo1 = livePrices.btcUp + livePrices.ethDown;
      const combo2 = livePrices.btcDown + livePrices.ethUp;
      const bestCombo = Math.min(combo1, combo2);
      const comboStr = bestCombo > 0 ? (bestCombo * 100).toFixed(1) : '—';
      
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
    const orderStr = !config.strategy.dryRun ? ` | Orders: ${stats.liveOrders} (errors: ${stats.orderErrors})` : '';
    
    console.log(
      `${logger.COLORS.gray}[${new Date().toLocaleTimeString('en-US', { hour12: false })}]${logger.COLORS.reset} ` +
      `${logger.COLORS.bold}📊 [${upMin}m${upSec}s] ` +
      `Trades: ${t} | W:${wins} L:${stats.totalMiss} | WR: ${wr}% | ` +
      `PnL: ${sign}$${netPnl.toFixed(2)} | ROI: ${sign}${roi}%${openStr}${orderStr}` +
      `${priceLine}${logger.COLORS.reset}`
    );
  }, 30000);
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
  if (!config.strategy.dryRun) {
    logger.line(`Live orders: ${stats.liveOrders} | Order errors: ${stats.orderErrors}`);
  }
  logger.line('');
  logger.line(`Invested:  $${stats.totalInvested.toFixed(4)}`);
  logger.line(`Returned:  $${stats.totalReturned.toFixed(4)}`);
  logger.line(`Net PnL:   ${sign}$${netPnl.toFixed(4)}`);
  logger.line(`ROI:       ${sign}${roi}%`);

  if (stats.bestTrade) {
    logger.line('');
    logger.line(`🏆 Best:  ${stats.bestTrade.btcSide}/${stats.bestTrade.ethSide} → ${stats.bestTrade.result} → +$${stats.bestTrade.pnl.toFixed(4)}`);
  }
  if (stats.worstTrade) {
    logger.line(`💀 Worst: ${stats.worstTrade.btcSide}/${stats.bestTrade.ethSide} → ${stats.worstTrade.result} → -$${Math.abs(stats.worstTrade.pnl).toFixed(4)}`);
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
        `${t.result} ${s}$${t.pnl.toFixed(4)}`
      );
    });
  }

  logger.divider();
}

// ── Place live orders for both sides ──────────────────────────
async function placePairOrders(client, btcInstId, ethInstId, btcSide, ethSide, contractSize) {
  const results = { btc: null, eth: null, btcError: null, ethError: null };

  // Place BTC order
  try {
    const btcRes = await client.placeMarketOrder(btcInstId, 'buy', contractSize, btcSide);
    if (btcRes.ordId) {
      results.btc = btcRes.ordId;
      stats.liveOrders++;
      logger.info(`   ✅ BTC ${btcSide} order filled: ${btcRes.ordId} (${contractSize} contracts)`);
    } else {
      results.btcError = btcRes.errorMsg || 'No order ID returned';
      stats.orderErrors++;
      logger.warn(`   ⚠️ BTC ${btcSide} order failed: ${btcRes.errorMsg} (code: ${btcRes.errorCode})`);
    }
  } catch (err) {
    results.btcError = err.message;
    stats.orderErrors++;
    logger.error(`   ❌ BTC ${btcSide} order failed: ${err.message}`);
  }

  // Place ETH order
  try {
    const ethRes = await client.placeMarketOrder(ethInstId, 'buy', contractSize, ethSide);
    if (ethRes.ordId) {
      results.eth = ethRes.ordId;
      stats.liveOrders++;
      logger.info(`   ✅ ETH ${ethSide} order filled: ${ethRes.ordId} (${contractSize} contracts)`);
    } else {
      results.ethError = ethRes.errorMsg || 'No order ID returned';
      stats.orderErrors++;
      logger.warn(`   ⚠️ ETH ${ethSide} order failed: ${ethRes.errorMsg} (code: ${ethRes.errorCode})`);
    }
  } catch (err) {
    results.ethError = err.message;
    stats.orderErrors++;
    logger.error(`   ❌ ETH ${ethSide} order failed: ${err.message}`);
  }

  return results;
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
  let orderResults = null;

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

        const contractSize = config.strategy.contractSize;
        const combinedCost = btcEntry + ethEntry;
        // Cost = contractSize × price per side, total = both sides
        const btcCost = contractSize * btcEntry;
        const ethCost = contractSize * ethEntry;
        const costTotal = btcCost + ethCost;
        // Payout if side wins = contractSize × $1 per contract
        const btcPayout = contractSize;   // if BTC wins: contractSize × $1
        const ethPayout = contractSize;   // if ETH wins: contractSize × $1
        const maxPayout = btcPayout + ethPayout;     // both win
        const oneWinPayout = Math.max(btcPayout, ethPayout); // one wins

        stats.pairsTrades++;
        stats.totalInvested += costTotal;
        stats.btcLegs.trades++;
        stats.ethLegs.trades++;

        const modeLabel = config.strategy.dryRun ? '[DRY]' : '[LIVE]';
        logger.enter(
          `${logger.COLORS.bold}${modeLabel} 🎯 PAIRS ENTRY: BTC ${btcSide} @ ${(btcEntry * 100).toFixed(1)}¢ + ` +
          `ETH ${ethSide} @ ${(ethEntry * 100).toFixed(1)}¢ = ${(combinedCost * 100).toFixed(1)}¢ combined${logger.COLORS.reset}`
        );
        logger.info(
          `   BTC ${btcSide}: ${contractSize} contracts @ $${btcEntry.toFixed(2)} = $${btcCost.toFixed(4)} | ` +
          `ETH ${ethSide}: ${contractSize} contracts @ $${ethEntry.toFixed(2)} = $${ethCost.toFixed(4)}`
        );
        logger.info(
          `   Cost: $${costTotal.toFixed(4)} | Both win: +$${(maxPayout - costTotal).toFixed(4)} | ` +
          `One win: +$${(oneWinPayout - costTotal).toFixed(4)} | Both lose: -$${costTotal.toFixed(4)} | ` +
          `Entry: ${entryTime}s`
        );

        // ── PLACE LIVE ORDERS ──────────────────────────────
        if (!config.strategy.dryRun) {
          logger.info(`   📤 Placing live orders...`);
          orderResults = await placePairOrders(client, btcInstId, ethInstId, btcSide, ethSide, contractSize);
          
          if (orderResults.btcError && orderResults.ethError) {
            // Both orders failed — don't count as a real trade
            logger.error(`   💀 Both orders failed! Reverting trade.`);
            stats.pairsTrades--;
            stats.totalInvested -= costTotal;
            stats.btcLegs.trades--;
            stats.ethLegs.trades--;
            entered = false; // Allow trying again this cycle
            await sleep(config.strategy.pollIntervalMs);
            continue;
          }
        } else {
          logger.info(`   📝 [DRY RUN] No real orders placed`);
        }
      } else if (pollCount === 0 || pollCount % 5 === 0) {
        const bestOpp = Math.min(btcUp + ethDown, btcDown + ethUp);
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
    const contractSize = config.strategy.contractSize;
    const btcCost = contractSize * btcEntry;
    const ethCost = contractSize * ethEntry;
    const costTotal = btcCost + ethCost;

    let btcPayout = 0, ethPayout = 0;
    let btcResult = 'LOSS', ethResult = 'LOSS';

    if (btcWinner === btcSide) {
      btcPayout = contractSize; // contractSize × $1
      btcResult = 'WIN';
      stats.btcLegs.wins++;
    }
    if (ethWinner === ethSide) {
      ethPayout = contractSize;
      ethResult = 'WIN';
      stats.ethLegs.wins++;
    }

    const totalPayout = btcPayout + ethPayout;
    const pnl = totalPayout - costTotal;
    const combinedCost = btcEntry + ethEntry;

    let result, emoji;
    if (btcResult === 'WIN' && ethResult === 'WIN') {
      result = 'BOTH HIT';
      emoji = '💰';
      stats.bothHit++;
      logger.win(
        `${emoji} BTC ${btcSide} ✅ + ETH ${ethSide} ✅ → BOTH HIT | ` +
        `+$${pnl.toFixed(4)} (paid $${costTotal.toFixed(4)}, got $${totalPayout.toFixed(4)})`
      );
    } else if (btcResult === 'WIN' || ethResult === 'WIN') {
      result = 'ONE HIT';
      emoji = '✅';
      stats.oneHit++;
      const winSide = btcResult === 'WIN' ? `BTC ${btcSide}` : `ETH ${ethSide}`;
      const loseSide = btcResult === 'LOSS' ? `BTC ${btcSide}` : `ETH ${ethSide}`;
      logger.info(
        `${emoji} ${winSide} won, ${loseSide} lost → ONE HIT | ` +
        `+${pnl.toFixed(4)} (paid $${costTotal.toFixed(4)}, got $${totalPayout.toFixed(4)})`
      );
    } else {
      result = 'MISS';
      emoji = '❌';
      stats.totalMiss++;
      logger.loss(
        `${emoji} BTC ${btcSide} ❌ + ETH ${ethSide} ❌ → BOTH MISSED | ` +
        `-$${costTotal.toFixed(4)} (winners were BTC ${btcWinner}, ETH ${ethWinner})`
      );
    }

    stats.totalReturned += totalPayout;

    const record = {
      time: new Date().toISOString(),
      cycle: stats.cycles,
      btcSide, ethSide, btcEntry, ethEntry, combinedCost,
      btcOpen, ethOpen, btcSettle, ethSettle,
      btcWinner, ethWinner, btcResult, ethResult,
      result, pnl, cost: costTotal, payout: totalPayout,
      contractSize,
      liveOrders: orderResults,
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
  const dryRun = config.strategy.dryRun;
  const mode = dryRun ? 'DRY RUN (paper trading)' : '🔴 LIVE (real money)';
  const contractSize = config.strategy.contractSize;

  logger.banner('OKX PAIRS DIVERGENCE BOT');
  logger.info(`Mode: ${mode}`);
  logger.info(`Contract size: ${contractSize} per side (${contractSize * 2} total per pair)`);
  logger.info(`Strategy: BTC side + ETH opposite side ≤ ${(config.strategy.maxCombinedPrice * 100).toFixed(0)}¢ combined`);
  logger.info(`Markets: BTC 5min + ETH 5min (polled simultaneously)`);
  logger.info(`Filters: ${config.strategy.minPrice * 100}¢-${config.strategy.maxPerSide * 100}¢ per side | ≤ ${(config.strategy.maxCombinedPrice * 100).toFixed(0)}¢ combined`);
  logger.info(`Profit in 3/4 scenarios — only lose when BTC & ETH move same direction`);
  logger.info(`Heartbeat: PnL + win rate every 30 seconds`);
  logger.divider();

  const client = new OKXClient(config.okx);

  // ── Live mode: verify API keys and check balance ──────────
  if (!dryRun) {
    if (!config.okx.apiKey || !config.okx.secretKey || !config.okx.passphrase) {
      logger.error('❌ API keys not configured! Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE env vars.');
      logger.error('   Cannot start in LIVE mode without API keys.');
      process.exit(1);
    }
    logger.info('🔑 API keys detected. Checking balance...');
    try {
      const balance = await client.getUSDTBalance();
      logger.info(`💰 Account USDT balance: $${balance.toFixed(2)}`);
      if (balance <= 0) {
        logger.error('❌ Account balance is $0. Fund your OKX account to start trading.');
        logger.error('   Minimum recommended: $10 USDT for 0.1 contract testing.');
        process.exit(1);
      }
      const maxLossPerTrade = contractSize * config.strategy.maxCombinedPrice;
      const tradesPossible = balance / maxLossPerTrade;
      logger.info(`   Max loss per trade: $${maxLossPerTrade.toFixed(4)} | Trades possible: ~${Math.floor(tradesPossible)}`);
      if (tradesPossible < 10) {
        logger.warn(`⚠️ Low balance — only ~${Math.floor(tradesPossible)} trades possible. Consider funding more.`);
      }
    } catch (err) {
      logger.error(`❌ Could not check balance: ${err.message}`);
      logger.error('   Check that API keys are valid and have trading permissions.');
      process.exit(1);
    }
    logger.divider();
  }

  // Keep-alive HTTP server
  const http = require('http');
  const port = parseInt(process.env.PORT || '8080');
  http.createServer((req, res) => {
    const t = stats.pairsTrades;
    const wr = t > 0 ? (((stats.bothHit + stats.oneHit) / t) * 100).toFixed(1) : '0';
    const pnl = stats.totalReturned - stats.totalInvested;
    const mode = config.strategy.dryRun ? 'DRY' : 'LIVE';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(
      `Pairs Divergence Bot [${mode}] | Cycles: ${stats.cycles} | Pairs: ${t} | ` +
      `Both: ${stats.bothHit} | One: ${stats.oneHit} | Miss: ${stats.totalMiss} | ` +
      `WR: ${wr}% | PnL: $${pnl.toFixed(4)}` +
      (!config.strategy.dryRun ? ` | Orders: ${stats.liveOrders} | Errors: ${stats.orderErrors}` : '')
    );
  }).listen(port, () => logger.info(`Keep-alive on :${port}`));

  logger.info('🚀 Bot started. Scanning BTC + ETH event contracts...\n');

  startHeartbeat();

  while (true) {
    try {
      await runCycle(client);
      if (stats.cycles % 5 === 0) printSummary();
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
