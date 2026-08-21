/**
 * bot.js — OKX BTC 5-min Momentum Follow Bot
 *
 * Strategy: PREVIOUS CYCLE MOMENTUM FOLLOW
 *
 * 1. Watch BTC-UPDOWN-5MIN contracts
 * 2. When a cycle expires, check how it settled:
 *    - Closed ABOVE strike → previous result = UP
 *    - Closed BELOW strike → previous result = DOWN
 * 3. At the start of the NEXT cycle (first 3-5 seconds after open):
 *    - Enter the SAME direction as the previous result
 * 4. Max 0.1 contracts per trade (~$0.04-$0.06 cost)
 * 5. Let the contract settle naturally at $1 (win) or $0 (loss)
 */

const http      = require('http');
const OKXClient = require('./okxClient');
const config    = require('./config');
const logger    = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Keep-alive HTTP server
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
}).listen(PORT, () => logger.info(`Keep-alive HTTP server listening on :${PORT}`));

// Stats
const stats = {
  cycles: 0, trades: 0, wins: 0, losses: 0, skipped: 0,
  totalCost: 0.0, totalPnl: 0.0,
};

function logStats() {
  const filled = stats.wins + stats.losses;
  const wr = filled > 0 ? ((stats.wins / filled) * 100).toFixed(1) : '0.0';
  logger.info(
    `📊 [STATS] Cycles:${stats.cycles} Trades:${stats.trades} ` +
    `✅${stats.wins} ❌${stats.losses} ⏭️${stats.skipped} ` +
    `WR:${wr}% Spent:$${stats.totalCost.toFixed(4)} PnL:${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(4)}`
  );
}

async function main() {
  const client = new OKXClient(config.okx);
  const s      = config.strategy;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  OKX BTC 5-MIN MOMENTUM FOLLOW BOT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Mode:    ${s.dryRun ? '🟢 DRY RUN (paper)' : '🔴 LIVE (real money)'}`);
  console.log(`  Series:  ${s.seriesId}`);
  console.log(`  Size:    ${s.contractSize} contracts`);
  console.log(`  Entry:   First ${s.entryWindowSecMin}-${s.entryWindowSecMax}s of each new cycle`);
  console.log(`  Logic:   Prev cycle UP → enter UP | Prev DOWN → enter DOWN`);
  console.log('───────────────────────────────────────────────────────\n');

  if (!s.dryRun) {
    const balance = await client.getUSDTBalance();
    logger.info(`💰 USDT balance: $${balance.toFixed(4)}`);
    if (balance < s.minBalance) {
      logger.warn(`⚠️  Low balance: $${balance.toFixed(4)}`);
    }
  }

  logger.info('🚀 Starting momentum loop...\n');

  let previousResult   = null;  // 'UP' | 'DOWN' | null
  let previousStrike   = null;  // strike of the cycle we last saw expire
  let currentInstId    = null;
  let cycleStartTime   = null;
  let enteredThisCycle = false;
  let tradeEntry       = null;
  let lastHeartbeat    = 0;

  while (true) {
    try {
      const now = Date.now();

      // 1. Fetch current active contract
      const contract = await client.getActiveContract(s.seriesId);

      if (!contract) {
        if (now - lastHeartbeat > 10000) {
          logger.info(`⏳ No active ${s.seriesId} contract — waiting...`);
          lastHeartbeat = now;
        }
        await sleep(s.pollIntervalMs);
        continue;
      }

      const secsLeft = Math.round((contract.expTime - now) / 1000);

      // 2. Detect new cycle (instId changed = new contract opened)
      if (contract.instId !== currentInstId) {
        stats.cycles++;
        currentInstId    = contract.instId;
        cycleStartTime   = now;
        enteredThisCycle = false;
        tradeEntry       = null;

        logger.info(`\n${'─'.repeat(55)}`);
        logger.info(`📋 NEW CYCLE #${stats.cycles}: ${contract.instId}`);
        logger.info(`   Strike: $${contract.stk} | ${secsLeft}s remaining`);

        // At cycle open, read BTC spot to determine how the PREVIOUS cycle settled
        if (previousStrike !== null) {
          const btcSpot = await client.getSpotPrice(s.spotTicker);
          if (btcSpot !== null) {
            // Previous cycle settled: if current spot >= prev strike → prev closed UP
            previousResult = btcSpot >= previousStrike ? 'UP' : 'DOWN';
            const icon = previousResult === 'UP' ? '🟢' : '🔴';
            logger.info(`   ✅ Prev cycle result: ${icon} ${previousResult}`);
            logger.info(`      (BTC $${btcSpot} vs prev strike $${previousStrike})`);
          } else {
            logger.warn('   ⚠️  Couldnt get BTC spot — skipping this cycle');
            previousResult = null;
          }
        } else {
          logger.info('   👁️  First cycle seen — watching, no trade yet');
        }

        // Save this cycle's strike for next cycle comparison
        previousStrike = contract.stk;
        logStats();
      }

      // 3. Entry: fire in first N seconds of cycle
      const secsIntoCurrentCycle = cycleStartTime ? Math.round((now - cycleStartTime) / 1000) : 0;

      if (!enteredThisCycle && previousResult !== null) {
        if (secsIntoCurrentCycle >= s.entryWindowSecMin && secsIntoCurrentCycle <= s.entryWindowSecMax) {

          const direction  = previousResult;
          const outcome    = direction === 'UP' ? 'yes' : 'no';
          const icon       = direction === 'UP' ? '🟢' : '🔴';

          // Get live ticker for entry price estimate
          const ticker     = await client.getEventTicker(contract.instId);
          const entryPrice = direction === 'UP'
            ? (ticker?.askPx > 0 ? ticker.askPx : 0.50)
            : (ticker?.bidPx > 0 ? (1 - ticker.bidPx) : 0.50);

          const estimatedCost = s.contractSize * entryPrice;

          logger.info(`\n🎯 ENTRY — Cycle #${stats.cycles} | Trade #${stats.trades + 1}`);
          logger.info(`   ${icon} Direction: ${direction} (following prev result)`);
          logger.info(`   Contract:  ${contract.instId}`);
          logger.info(`   Price:     ~${(entryPrice * 100).toFixed(1)}¢ × ${s.contractSize} = $${estimatedCost.toFixed(4)}`);
          logger.info(`   Entered:   ${secsIntoCurrentCycle}s into cycle`);

          enteredThisCycle = true;
          stats.trades++;
          stats.totalCost += estimatedCost;

          if (s.dryRun) {
            logger.info(`   🟢 [DRY RUN] Simulated — no real order sent`);
            tradeEntry = { instId: contract.instId, direction, entryPrice, sz: s.contractSize, stk: contract.stk };
          } else {
            const result = await client.placeMarketOrder(contract.instId, 'buy', s.contractSize, direction);
            if (result?.filled) {
              const actualCost = s.contractSize * (result.fillPx || entryPrice);
              stats.totalCost  = stats.totalCost - estimatedCost + actualCost;
              tradeEntry = {
                instId:     contract.instId,
                direction,
                entryPrice: result.fillPx || entryPrice,
                sz:         result.fillSz || s.contractSize,
                stk:        contract.stk,
              };
              logger.info(`✅ FILLED @ ${(tradeEntry.entryPrice * 100).toFixed(1)}¢ | ordId=${result.ordId}`);
            } else {
              logger.error(`❌ Order FAILED: ${result?.errorMsg || 'unknown'} — will retry next window`);
              stats.trades--;
              stats.totalCost -= estimatedCost;
              enteredThisCycle = false;
            }
          }

        } else if (secsIntoCurrentCycle < s.entryWindowSecMin) {
          // Too early — wait
        } else if (!enteredThisCycle) {
          // Window passed without entry
          stats.skipped++;
          enteredThisCycle = true;
          logger.warn(`⏭️  Entry window passed (${secsIntoCurrentCycle}s into cycle) — skipping`);
          logStats();
        }
      }

      // 4. Settlement check (last 2s of contract life)
      if (enteredThisCycle && tradeEntry && secsLeft <= 2 && secsLeft >= 0) {
        const waitMs = Math.max(500, secsLeft * 1000 + 3000);
        logger.info(`⏳ Waiting ${Math.round(waitMs / 1000)}s for settlement...`);
        await sleep(waitMs);

        const finalSpot = await client.getSpotPrice(s.spotTicker);
        const won = finalSpot !== null
          ? (tradeEntry.direction === 'UP' ? finalSpot >= tradeEntry.stk : finalSpot < tradeEntry.stk)
          : null;

        if (won !== null) {
          const pnl = won
            ? s.contractSize * (1 - tradeEntry.entryPrice)
            : -(s.contractSize * tradeEntry.entryPrice);
          stats.totalPnl += pnl;
          if (won) { stats.wins++; } else { stats.losses++; }

          logger.info(`\n${'═'.repeat(55)}`);
          logger.info(won ? `✅ WIN` : `❌ LOSS`);
          logger.info(`   Bet:   ${tradeEntry.direction}`);
          logger.info(`   Final: BTC $${finalSpot} vs strike $${tradeEntry.stk}`);
          logger.info(`   PnL:   ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`);
          logger.info(`${'═'.repeat(55)}\n`);
        } else {
          logger.warn('⚠️  Settlement check failed — BTC spot unavailable');
        }

        tradeEntry = null;
        logStats();
      }

      // 5. Heartbeat every 30s
      if (now - lastHeartbeat > 30000) {
        lastHeartbeat = now;
        const btcSpot = await client.getSpotPrice(s.spotTicker);
        const pi = previousResult ? (previousResult === 'UP' ? '🟢' : '🔴') : '❓';
        logger.info(
          `💓 [${secsLeft}s left | ${secsIntoCurrentCycle}s in] ` +
          `BTC $${btcSpot ?? '?'} | strike $${contract.stk} | ` +
          `prevResult=${pi}${previousResult ?? 'none'} | entered=${enteredThisCycle}`
        );
      }

      await sleep(s.pollIntervalMs);

    } catch (err) {
      logger.error(`💥 Loop error: ${err.message}`);
      await sleep(2000);
    }
  }
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
