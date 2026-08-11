/**
 * bot.js — OKX Underdog Value Bot (Dry Run)
 * 
 * Strategy: Underdog Value (Favorite-Longshot Bias)
 * Every cycle, buy the underdog (cheaper side) when priced ≤ 40¢.
 * Track win/loss at settlement to measure real win rate.
 * 
 * MODE: Dry run (paper trading) — no real orders placed.
 * DATA: REAL OKX market data (tickers, order book, spot prices).
 * 
 * What it does per cycle:
 * 1. Record BTC/ETH spot price at cycle start (opening price)
 * 2. Poll UP/DOWN prices every 3 seconds
 * 3. If underdog ≤ 40¢ → log a paper trade entry
 * 4. At cycle end → compare final price to opening → determine winner
 * 5. Track cumulative stats: trades, wins, losses, win rate, ROI
 */

const OKXClient = require('./okxClient');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Event Contract Instrument ID ──────────────────────────────
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
  trades: 0,
  wins: 0,
  losses: 0,
  pushes: 0,  // price didn't move (tie)
  totalInvested: 0,
  totalReturned: 0,
  totalFees: 0,
  bestTrade: null,
  worstTrade: null,
  tradeHistory: [],
  perMarket: {},  // stats per market label
};

// ── Initialize per-market stats ───────────────────────────────
for (const m of config.markets) {
  stats.perMarket[m.label] = {
    cycles: 0, trades: 0, wins: 0, losses: 0, pushes: 0,
    totalInvested: 0, totalReturned: 0,
    avgBuyPrice: 0, allBuyPrices: [],
    pricePoints: [],  // UP/DOWN prices observed each cycle
  };
}

// ── Run one cycle for one market ──────────────────────────────
async function runCycle(client, market) {
  const { underlying, interval, label } = market;
  const intervalSec = interval * 60;
  
  // Wait for cycle to start (align to interval boundary)
  let secsRemaining = getSecondsRemaining(interval);
  if (secsRemaining < intervalSec - 2) {
    // We're in the middle of a cycle — wait for next one
    const wait = secsRemaining + 2;
    if (wait > 5) {
      logger.info(`[${label}] ⏳ ${wait}s to next cycle...`);
      await sleep(wait * 1000);
    }
  }
  
  stats.cycles++;
  stats.perMarket[label].cycles++;
  
  const instId = getInstId(underlying, interval);
  const spotInst = `${underlying}-USDT`;
  const secIn = getSecondsIntoCycle(interval);
  const secLeft = getSecondsRemaining(interval);
  
  logger.divider();
  logger.info(`[${label}] CYCLE ${stats.perMarket[label].cycles} | ${instId}`);
  logger.info(`[${label}] ${secIn}s in, ${secLeft}s left | ${new Date().toUTCString()}`);
  
  // ── 1. Get opening price (spot price at cycle start) ────────
  let openingPrice = await client.getSpotPrice(spotInst);
  if (!openingPrice) {
    logger.warn(`[${label}] Could not get opening price, skipping cycle`);
    await sleep(secLeft * 1000);
    return;
  }
  logger.info(`[${label}] 📏 Opening ${underlying} price: $${openingPrice}`);
  
  // ── 2. Wait a few seconds for contract to be active ─────────
  if (getSecondsIntoCycle(interval) < 5) {
    await sleep(5000);
  }
  
  // ── 3. Poll UP/DOWN prices ──────────────────────────────────
  let entered = false;
  let entryPrice = 0;
  let entrySide = '';  // 'UP' or 'DOWN'
  let entryTime = 0;
  let bestUpPrice = 1;
  let bestDownPrice = 1;
  let pollCount = 0;
  let lastPollPrice = 0;
  
  while (getSecondsRemaining(interval) > config.strategy.noEntryBeforeEnd) {
    const ticker = await client.getEventTicker(instId);
    
    if (!ticker || ticker.last == null) {
      if (pollCount === 0) logger.warn(`[${label}] No ticker data for ${instId}`);
      pollCount++;
      await sleep(config.strategy.pollIntervalMs);
      continue;
    }
    
    const upPrice = ticker.last;
    const downPrice = 1 - upPrice;
    lastPollPrice = upPrice;
    
    // Track best (cheapest) prices seen
    if (upPrice < bestUpPrice) bestUpPrice = upPrice;
    if (downPrice < bestDownPrice) bestDownPrice = downPrice;
    
    // ── Entry logic: buy the underdog if ≤ 40¢ ──────────────
    if (!entered) {
      const underdogSide = upPrice <= downPrice ? 'UP' : 'DOWN';
      const underdogPrice = upPrice <= downPrice ? upPrice : downPrice;
      
      if (underdogPrice <= config.strategy.maxUnderdogPrice) {
        // Get order book for more detail
        let orderbook = null;
        try {
          orderbook = await client.getOrderBook(instId);
        } catch (e) { /* ignore */ }
        
        const spread = orderbook ? 
          (orderbook.asks[0]?.price - orderbook.bids[0]?.price).toFixed(4) : 'N/A';
        const askSz = orderbook?.asks[0]?.size || 0;
        const bidSz = orderbook?.bids[0]?.size || 0;
        
        entered = true;
        entryPrice = underdogPrice;
        entrySide = underdogSide;
        entryTime = getSecondsIntoCycle(interval);
        
        const costUsd = config.strategy.tradeSizeUsdt;
        // Contract size = cost / price (e.g., $10 / 0.35 = 28.57 contracts)
        // If win: payout = contracts × $1 = $28.57, profit = $18.57
        // If loss: payout = $0, loss = $10
        const contracts = costUsd / underdogPrice;
        const potentialPayout = contracts; // $1 per contract if win
        const potentialProfit = potentialPayout - costUsd;
        
        stats.trades++;
        stats.perMarket[label].trades++;
        stats.totalInvested += costUsd;
        stats.perMarket[label].totalInvested += costUsd;
        stats.perMarket[label].allBuyPrices.push(underdogPrice);
        
        logger.enter(
          `[${label}] 🐕 UNDERDOG ${underdogSide} @ ${(underdogPrice * 100).toFixed(1)}¢ | ` +
          `Cost: $${costUsd} | Contracts: ${contracts.toFixed(2)} | ` +
          `If win: +$${potentialProfit.toFixed(2)} | If lose: -$${costUsd} | ` +
          `Entry: ${entryTime}s into cycle`
        );
        
        if (config.log.showOrderbook && orderbook) {
          logger.info(
            `   📖 Orderbook: Best ask ${(orderbook.asks[0]?.price * 100).toFixed(1)}¢ × ${askSz} | ` +
            `Best bid ${(orderbook.bids[0]?.price * 100).toFixed(1)}¢ × ${bidSz} | ` +
            `Spread: ${spread}`
          );
        }
      } else {
        // Underdog too expensive, don't enter
        if (pollCount === 0 || pollCount % 5 === 0) {
          logger.info(
            `[${label}] 📊 UP=${(upPrice * 100).toFixed(1)}¢ DOWN=${(downPrice * 100).toFixed(1)}¢ | ` +
            `Underdog at ${Math.min(upPrice, downPrice) > 0 ? Math.min(upPrice, downPrice) * 100 : 0}¢ > 40¢ — skipping`
          );
        }
      }
    }
    
    pollCount++;
    await sleep(config.strategy.pollIntervalMs);
  }
  
  // ── 4. Wait for cycle end ───────────────────────────────────
  const remaining = getSecondsRemaining(interval);
  if (remaining > 0) {
    await sleep(remaining * 1000);
  }
  
  // ── 5. Get settlement price ──────────────────────────────────
  await sleep(2000); // Small delay to ensure settlement
  const settlementPrice = await client.getSpotPrice(spotInst);
  
  if (!settlementPrice) {
    logger.warn(`[${label}] Could not get settlement price`);
    if (entered) {
      stats.pushes++;
      stats.perMarket[label].pushes++;
    }
    return;
  }
  
  // ── 6. Determine winner ─────────────────────────────────────
  const priceChange = settlementPrice - openingPrice;
  const winnerSide = priceChange > 0 ? 'UP' : priceChange < 0 ? 'DOWN' : 'TIE';
  
  logger.info(
    `[${label}] 📏 Settlement: $${settlementPrice} (${priceChange >= 0 ? '+' : ''}$${priceChange.toFixed(2)}) | ` +
    `Winner: ${winnerSide}`
  );
  
  // ── 7. Track trade result ────────────────────────────────────
  if (entered) {
    const costUsd = config.strategy.tradeSizeUsdt;
    const contracts = costUsd / entryPrice;
    
    let result, payout, pnl;
    
    if (winnerSide === 'TIE') {
      result = 'PUSH';
      payout = costUsd; // refund
      pnl = 0;
      stats.pushes++;
      stats.perMarket[label].pushes++;
    } else if (winnerSide === entrySide) {
      result = 'WIN';
      payout = contracts; // $1 per contract
      pnl = payout - costUsd;
      stats.wins++;
      stats.perMarket[label].wins++;
      stats.totalReturned += payout;
      stats.perMarket[label].totalReturned += payout;
      logger.win(
        `[${label}] 🏆 ${entrySide} @ ${(entryPrice * 100).toFixed(1)}¢ → WON | ` +
        `+$${pnl.toFixed(2)} (paid $${costUsd}, got $${payout.toFixed(2)})`
      );
    } else {
      result = 'LOSS';
      payout = 0;
      pnl = -costUsd;
      stats.losses++;
      stats.perMarket[label].losses++;
      logger.loss(
        `[${label}] 💀 ${entrySide} @ ${(entryPrice * 100).toFixed(1)}¢ → LOST | ` +
        `-$${costUsd} (winner was ${winnerSide})`
      );
    }
    
    stats.totalReturned += result === 'LOSS' ? 0 : payout;
    
    // Track best/worst
    const tradeRecord = {
      time: new Date().toISOString(),
      market: label,
      instId,
      side: entrySide,
      entryPrice,
      openingPrice,
      settlementPrice,
      winner: winnerSide,
      result,
      pnl,
      cost: costUsd,
      contracts,
    };
    
    stats.tradeHistory.push(tradeRecord);
    if (stats.tradeHistory.length > 500) stats.tradeHistory.shift();
    
    if (!stats.bestTrade || pnl > stats.bestTrade.pnl) stats.bestTrade = tradeRecord;
    if (!stats.worstTrade || pnl < stats.worstTrade.pnl) stats.worstTrade = tradeRecord;
  } else {
    logger.info(`[${label}] No entry this cycle (underdog > 40¢ or no data)`);
  }
  
  // Record price points for this cycle
  if (lastPollPrice > 0) {
    stats.perMarket[label].pricePoints.push({
      upPrice: lastPollPrice,
      downPrice: 1 - lastPollPrice,
      bestUp: bestUpPrice,
      bestDown: bestDownPrice,
    });
  }
}

// ── Print Summary ─────────────────────────────────────────────
function printSummary() {
  const totalTrades = stats.trades;
  const winRate = totalTrades > 0 ? ((stats.wins / totalTrades) * 100).toFixed(1) : '0.0';
  const roi = stats.totalInvested > 0
    ? (((stats.totalReturned - stats.totalInvested) / stats.totalInvested) * 100).toFixed(1)
    : '0.0';
  const netPnl = stats.totalReturned - stats.totalInvested;
  
  logger.banner('📊 UNDERDOG VALUE — CUMULATIVE STATS');
  logger.line(`Cycles watched: ${stats.cycles}`);
  logger.line(`Trades entered: ${totalTrades}`);
  logger.line(`Wins: ${stats.wins} | Losses: ${stats.losses} | Pushes: ${stats.pushes}`);
  logger.line(`Win rate: ${winRate}%`);
  logger.line('');
  logger.line(`Invested:    $${stats.totalInvested.toFixed(2)}`);
  logger.line(`Returned:    $${stats.totalReturned.toFixed(2)}`);
  logger.line(`Net PnL:     ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`);
  logger.line(`ROI:         ${roi >= 0 ? '+' : ''}${roi}%`);
  
  if (stats.bestTrade) {
    logger.line('');
    logger.line(`🏆 Best:  ${stats.bestTrade.market} ${stats.bestTrade.side} @ ${(stats.bestTrade.entryPrice * 100).toFixed(1)}¢ → +$${stats.bestTrade.pnl.toFixed(2)}`);
  }
  if (stats.worstTrade) {
    logger.line(`💀 Worst: ${stats.worstTrade.market} ${stats.worstTrade.side} @ ${(stats.worstTrade.entryPrice * 100).toFixed(1)}¢ → -$${Math.abs(stats.worstTrade.pnl).toFixed(2)}`);
  }
  
  // Per-market breakdown
  logger.line('');
  logger.line('Per market:');
  for (const [label, m] of Object.entries(stats.perMarket)) {
    const mWinRate = m.trades > 0 ? ((m.wins / m.trades) * 100).toFixed(1) : '—';
    const avgBuy = m.allBuyPrices.length > 0
      ? (m.allBuyPrices.reduce((a, b) => a + b, 0) / m.allBuyPrices.length * 100).toFixed(1)
      : '—';
    const mPnl = m.totalReturned - m.totalInvested;
    logger.line(
      `  ${label.padEnd(10)}: ${m.trades} trades | WR: ${mWinRate}% | ` +
      `Avg buy: ${avgBuy}¢ | PnL: ${mPnl >= 0 ? '+' : ''}$${mPnl.toFixed(2)}`
    );
  }
  
  // Recent trades
  if (stats.tradeHistory.length > 0) {
    logger.line('');
    logger.line('Recent trades (last 8):');
    stats.tradeHistory.slice(-8).forEach((t, i) => {
      const emoji = t.result === 'WIN' ? '✅' : t.result === 'LOSS' ? '❌' : '➖';
      const s = t.pnl >= 0 ? '+' : '';
      logger.line(
        `  ${i + 1}. ${emoji} ${t.market} ${t.side} @ ${(t.entryPrice * 100).toFixed(1)}¢ → ` +
        `${t.result} ${s}$${t.pnl.toFixed(2)}`
      );
    });
  }
  
  logger.divider();
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const mode = config.dryRun ? 'DRY RUN (paper trading)' : 'LIVE (real money)';
  
  logger.banner('OKX UNDERDOG VALUE BOT');
  logger.info(`Mode: ${mode}`);
  logger.info(`Strategy: Buy underdog (cheaper side) when ≤ ${(config.strategy.maxUnderdogPrice * 100).toFixed(0)}¢`);
  logger.info(`Markets: ${config.markets.map(m => m.label).join(', ')}`);
  logger.info(`Trade size: $${config.strategy.tradeSizeUsdt} per trade (paper)`);
  logger.info(`Poll interval: ${config.strategy.pollIntervalMs / 1000}s`);
  logger.info(`Data: REAL OKX market data (public endpoints, no API keys needed)`);
  logger.divider();
  
  const client = new OKXClient(config.okx);
  
  // ── Keep-alive HTTP server ───────────────────────────────────
  const http = require('http');
  const port = parseInt(process.env.PORT || '8080');
  http.createServer((req, res) => {
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
    const pnl = stats.totalReturned - stats.totalInvested;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Underdog Bot | Cycles: ${stats.cycles} | Trades: ${stats.trades} | WR: ${wr}% | PnL: $${pnl.toFixed(2)}`);
  }).listen(port, () => logger.info(`Keep-alive on :${port}`));
  
  logger.info('🚀 Bot started. Watching OKX event contracts...\n');
  
  // ── Run cycles ───────────────────────────────────────────────
  // Alternate between markets each cycle
  let cycleCount = 0;
  
  while (true) {
    try {
      // Run a cycle for each market
      for (const market of config.markets) {
        await runCycle(client, market);
      }
      
      cycleCount++;
      
      // Print summary every 10 cycles
      if (cycleCount % 10 === 0) {
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
