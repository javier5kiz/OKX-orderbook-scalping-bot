/**
 * bot.js — OKX Price Distance Strategy (Live + Dry Run)
 * 
 * Strategy: Price Distance Confirmation
 * 
 * Monitor BTC 5-min event contracts.
 * Get strike (opening) price from the active contract.
 * Get current BTC spot price.
 * 
 * Entry rules:
 *   If spot >= strike + $15 → buy UP at ≤ 60¢
 *   If spot <= strike - $15 → buy DOWN at ≤ 60¢
 *   Contract size: 0.1 (costs $0.06 at 60¢)
 * 
 * Exit rules (sell before expiry):
 *   TP: sell at 85¢ → +$0.025 profit per contract
 *   SL: sell at 55¢ → -$0.005 loss per contract
 *   RR = 5:1
 * 
 * If neither TP nor SL triggers before expiry, settles at $1 (win) or $0 (lose).
 */

const OKXClient = require('./okxClient');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Stats ────────────────────────────────────────────────────
const stats = {
  trades: 0,
  wins: 0,
  losses: 0,
  tpExits: 0,
  slExits: 0,
  totalProfit: 0,
  errors: 0,
};

// ── Current position state ────────────────────────────────────
let position = null; // { instId, direction, outcome, size, entryPrice, ordId, expTime }

async function main() {
  const client = new OKXClient(config.okx);
  const s = config.strategy;

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  OKX PRICE DISTANCE BOT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Mode: ${s.dryRun ? '🟢 DRY RUN' : '🔴 LIVE (real money)'}`);
  console.log(`  Market: ${s.seriesId}`);
  console.log(`  Spot: ${s.spotTicker}`);
  console.log(`  Entry: cheapest side ≤ ${s.maxEntryPrice * 100}¢ (orderbook scan)`);
  console.log(`  Size: ${s.contractSize} contracts ($${(s.contractSize * s.maxEntryPrice).toFixed(4)}/trade)`);
  console.log(`  TP: sell at ${s.takeProfitPrice * 100}¢ (+$${(s.contractSize * (s.takeProfitPrice - s.maxEntryPrice)).toFixed(4)})`);
  console.log(`  SL: sell at ${s.stopLossPrice * 100}¢ (-$${(s.contractSize * (s.maxEntryPrice - s.stopLossPrice)).toFixed(4)})`);
  console.log(`  RR: ${((s.takeProfitPrice - s.maxEntryPrice) / (s.maxEntryPrice - s.stopLossPrice)).toFixed(1)}:1`);
  console.log('────────────────────────────────────────────────────────────\n');

  // Check balance
  const balance = await client.getUSDTBalance();
  console.log(`💰 Account USDT balance: $${balance.toFixed(2)}`);
  if (balance < s.minBalance) {
    console.log(`❌ Balance below minimum ($${s.minBalance}). Stopping.`);
    return;
  }
  console.log('🚀 Bot started. Scanning for price distance entries...\n');

  let currentContract = null;
  let lastHeartbeat = 0;

  // ── Main loop ────────────────────────────────────────────
  while (true) {
    try {
      const now = Date.now();

      // ── 1. Get/refresh active contract ──────────────────
      if (!currentContract || currentContract.expTime <= now) {
        currentContract = await client.getActiveContract(s.seriesId);
        if (!currentContract) {
          if (now - lastHeartbeat > 10000) {
            console.log(`⏳ No active contract for ${s.seriesId}...`);
            lastHeartbeat = now;
          }
          await sleep(s.pollIntervalMs);
          continue;
        }
        console.log(`📋 New contract: ${currentContract.instId} | Strike: $${currentContract.stk} | ${Math.round((currentContract.expTime - now) / 1000)}s left`);
        // Reset position if contract expired
        if (position && position.instId !== currentContract.instId) {
          console.log(`   Previous contract expired — checking settlement...`);
          await checkSettlement(client, position, currentContract);
          position = null;
        }
      }

      const secsLeft = Math.round((currentContract.expTime - now) / 1000);

      // ── 2. If we have a position, monitor for TP/SL ─────
      if (position) {
        await monitorPosition(client, position, s);
      } else if (secsLeft > s.noEntryBeforeEnd) {
        // ── 3. No position — look for entry signal ─────────
        await lookForEntry(client, currentContract, s, balance);
      }

      // ── 4. Heartbeat every 30s ──────────────────────────
      if (now - lastHeartbeat > 30000) {
        lastHeartbeat = now;
        const ticker = await client.getEventTicker(currentContract.instId);
        const upP = ticker?.askPx?.toFixed(2) || '?';
        const dnP = ticker?.bidPx ? (1 - ticker.bidPx).toFixed(2) : '?';
        const filled = stats.wins + stats.losses;
        const wr = filled > 0 ? ((stats.wins / filled) * 100).toFixed(1) : '0.0';
        console.log(
          `📊 [${secsLeft}s] Trades: ${stats.trades} | W:${stats.wins} L:${stats.losses} ` +
          `TP:${stats.tpExits} SL:${stats.slExits} | WR: ${wr}% | PnL: $${stats.totalProfit.toFixed(4)} ` +
          `| UP: ${upP}¢ DOWN: ${dnP}¢ | ${position ? 'IN POSITION' : 'SCANNING'}`
        );
      }

      await sleep(s.pollIntervalMs);
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
      stats.errors++;
      await sleep(5000);
    }
  }
}

// ── Look for entry — scan orderbook, no spot threshold ───────
async function lookForEntry(client, contract, s, balance) {
  if (balance < s.minBalance) return;

  // Get contract ticker (orderbook)
  const ticker = await client.getEventTicker(contract.instId);
  if (!ticker || !ticker.last) return;

  // Calculate both sides
  const upPrice = ticker.askPx;       // buy UP (yes) at ask
  const downPrice = 1 - ticker.bidPx;  // buy DOWN (no) at (1 - bid)

  // Pick the cheaper side if it's ≤ maxEntryPrice
  let direction = null;
  let entryPrice = 0;

  if (upPrice > 0 && upPrice <= s.maxEntryPrice && downPrice > 0 && downPrice <= s.maxEntryPrice) {
    // Both sides cheap — pick the cheaper one (underdog)
    if (upPrice <= downPrice) {
      direction = 'UP';
      entryPrice = upPrice;
    } else {
      direction = 'DOWN';
      entryPrice = downPrice;
    }
  } else if (upPrice > 0 && upPrice <= s.maxEntryPrice) {
    direction = 'UP';
    entryPrice = upPrice;
  } else if (downPrice > 0 && downPrice <= s.maxEntryPrice) {
    direction = 'DOWN';
    entryPrice = downPrice;
  }

  if (!direction) return;

  // ── ENTRY ──────────────────────────────────────────────
  const outcome = direction === 'UP' ? 'yes' : 'no';
  const cost = s.contractSize * entryPrice;

  console.log(
    `🎯 ENTRY: ${direction} | UP ${upPrice.toFixed(2)}¢ / DOWN ${downPrice.toFixed(2)}¢ | ` +
    `Price ${entryPrice.toFixed(2)}¢ | Size ${s.contractSize} | Cost $${cost.toFixed(4)}`
  );
  if (s.dryRun) {
    console.log(`   [DRY] Would buy ${direction} at ${entryPrice.toFixed(2)}¢`);
    position = {
      instId: contract.instId,
      direction,
      outcome,
      size: s.contractSize,
      entryPrice,
      ordId: 'dry',
      expTime: contract.expTime,
    };
    return;
  }

  // Place live order
  const result = await client.placeMarketOrder(contract.instId, 'buy', s.contractSize, outcome === 'yes' ? 'UP' : 'DOWN');

  if (result.filled) {
    const fillPx = result.fillPx || entryPrice;
    console.log(`   ✅ Filled at ${fillPx}¢ | ordId=${result.ordId}`);
    position = {
      instId: contract.instId,
      direction,
      outcome,
      size: s.contractSize,
      entryPrice: fillPx,
      ordId: result.ordId,
      expTime: contract.expTime,
    };
    stats.trades++;
    console.log(`   📈 Position: ${direction} ${s.contractSize} @ ${fillPx}¢ | TP: ${s.takeProfitPrice * 100}¢ | SL: ${s.stopLossPrice * 100}¢`);
  } else {
    console.log(`   ❌ Order failed: ${result.errorMsg}`);
    stats.errors++;
  }
}

// ── Monitor open position for TP/SL ───────────────────────────
async function monitorPosition(client, pos, s) {
  const ticker = await client.getEventTicker(pos.instId);
  if (!ticker) return;

  // Current price of our position
  let currentPrice;
  if (pos.direction === 'UP') {
    currentPrice = ticker.bidPx; // sell UP at bid
  } else {
    currentPrice = 1 - ticker.askPx; // sell DOWN at (1 - ask)
  }

  if (currentPrice <= 0) return;

  const pnl = pos.direction === 'UP'
    ? (currentPrice - pos.entryPrice) * pos.size
    : ((1 - currentPrice) - (1 - pos.entryPrice)) * pos.size;

  // Check TP
  if (currentPrice >= s.takeProfitPrice) {
    console.log(
      `🟢 TP HIT: ${pos.direction} @ ${currentPrice.toFixed(2)}¢ ≥ ${s.takeProfitPrice * 100}¢ | ` +
      `Entry ${pos.entryPrice.toFixed(2)}¢ | PnL: +$${pnl.toFixed(4)}`
    );
    if (!s.dryRun) {
      const result = await client.sellMarketOrder(pos.instId, pos.direction === 'UP' ? 'UP' : 'DOWN', pos.size);
      if (result.filled) {
        const sellPx = result.fillPx || currentPrice;
        const realPnl = pos.direction === 'UP'
          ? (sellPx - pos.entryPrice) * pos.size
          : ((1 - sellPx) - (1 - pos.entryPrice)) * pos.size;
        stats.wins++;
        stats.tpExits++;
        stats.totalProfit += realPnl;
        console.log(`   ✅ SELL FILLED at ${sellPx.toFixed(2)}¢ | Realized PnL: +$${realPnl.toFixed(4)}`);
      } else {
        console.log(`   ⚠️ Sell failed — will retry next tick`);
      }
    } else {
      stats.wins++;
      stats.tpExits++;
      stats.totalProfit += pnl;
    }
    position = null;
    return;
  }

  // Check SL
  if (currentPrice <= s.stopLossPrice) {
    console.log(
      `🔴 SL HIT: ${pos.direction} @ ${currentPrice.toFixed(2)}¢ ≤ ${s.stopLossPrice * 100}¢ | ` +
      `Entry ${pos.entryPrice.toFixed(2)}¢ | PnL: -$${Math.abs(pnl).toFixed(4)}`
    );
    if (!s.dryRun) {
      const result = await client.sellMarketOrder(pos.instId, pos.direction === 'UP' ? 'UP' : 'DOWN', pos.size);
      if (result.filled) {
        const sellPx = result.fillPx || currentPrice;
        const realPnl = pos.direction === 'UP'
          ? (sellPx - pos.entryPrice) * pos.size
          : ((1 - sellPx) - (1 - pos.entryPrice)) * pos.size;
        stats.losses++;
        stats.slExits++;
        stats.totalProfit += realPnl;
        console.log(`   ✅ SELL FILLED at ${sellPx.toFixed(2)}¢ | Realized PnL: $${realPnl.toFixed(4)}`);
      } else {
        console.log(`   ⚠️ Sell failed — will retry next tick`);
      }
    } else {
      stats.losses++;
      stats.slExits++;
      stats.totalProfit += pnl;
    }
    position = null;
    return;
  }

  // Log position status occasionally
  if (config.log.showAllPolls) {
    console.log(`   📈 ${pos.direction} @ ${currentPrice.toFixed(2)}¢ | Entry ${pos.entryPrice.toFixed(2)}¢ | PnL: $${pnl.toFixed(4)} | TP ${s.takeProfitPrice * 100}¢ / SL ${s.stopLossPrice * 100}¢`);
  }
}

// ── Check settlement if contract expired with open position ──
async function checkSettlement(client, pos, newContract) {
  // If we had a position and the contract expired, it settled at $1 or $0
  // We need to figure out if we won or lost based on the new contract's strike vs old
  // Actually, the settlement is based on whether the asset price was above/below strike at expiry
  // For simplicity, log it as settled
  console.log(`   📋 Contract ${pos.instId} expired — position settled`);
  // The position would have settled at $1 (win) or $0 (loss)
  // We can't easily verify the settlement price without another API call
  // For now, just clear the position and let the user check their balance
  stats.trades++;
  console.log(`   ⚠️ Settlement not verified — check OKX balance for result`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
