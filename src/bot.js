/**
 * bot.js — OKX Near-Strike Dual Confirmation Bot
 *
 * Strategy: Near-Strike Dual Confirmation
 *
 * Every 5-minute cycle, in the LAST 20 SECONDS before expiry:
 * - BTC spot within $2 of BTC contract strike  → BTC near-strike
 * - ETH spot within $0.08 of ETH contract strike → ETH near-strike
 * - If BOTH near-strike: buy UNDERDOG side on each (price <= 8¢)
 * - 0.1 contracts each side. Cost ~$0.008. Win pays $0.10 (12x+).
 * - Contracts settle at $1 or $0 at expiry — no TP/SL needed.
 */

const http = require('http');
const OKXClient = require('./okxClient');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Keep-alive HTTP server
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
}).listen(PORT, () => logger.info(`Keep-alive HTTP server listening on :${PORT}`));

// Stats
const stats = {
  cycles:    0,
  trades:    0,
  btcWins:   0,
  ethWins:   0,
  bothWins:  0,
  totalPnl:  0.0,
  totalCost: 0.0,
};

async function main() {
  const client = new OKXClient(config.okx);
  const s = config.strategy;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  OKX NEAR-STRIKE DUAL CONFIRMATION BOT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Mode:        ${s.dryRun ? '🟢 DRY RUN (paper)' : '🔴 LIVE (real money)'}`);
  console.log(`  BTC Series:  ${s.btcSeriesId} | Threshold: ±$${s.btcNearStrikeThreshold}`);
  console.log(`  ETH Series:  ${s.ethSeriesId} | Threshold: ±$${s.ethNearStrikeThreshold}`);
  console.log(`  Size:        ${s.contractSize} contracts/side`);
  console.log(`  Max price:   ${(s.maxUnderdogPrice * 100).toFixed(0)}¢ per underdog side`);
  console.log(`  Entry:       Last ${s.entryWindowSecs}s of each 5-min cycle`);
  console.log('───────────────────────────────────────────────────────\n');

  if (!s.dryRun) {
    const balance = await client.getUSDTBalance();
    logger.info(`💰 USDT balance: $${balance.toFixed(4)}`);
    if (balance < s.minBalance) {
      logger.error(`Balance below minimum ($${s.minBalance}). Stopping.`);
      return;
    }
  }

  logger.info('🚀 Monitoring BTC + ETH 5-min cycles...\n');

  let currentCycleId = null;
  let enteredCurrentCycle = false;
  let lastHeartbeat = 0;

  while (true) {
    try {
      const now = Date.now();

      // 1. Get both active contracts
      const [btcContract, ethContract] = await Promise.all([
        client.getActiveContract(s.btcSeriesId),
        client.getActiveContract(s.ethSeriesId),
      ]);

      if (!btcContract || !ethContract) {
        if (now - lastHeartbeat > 10000) {
          logger.info(`⏳ Waiting for contracts (BTC:${btcContract ? 'OK' : 'missing'}, ETH:${ethContract ? 'OK' : 'missing'})...`);
          lastHeartbeat = now;
        }
        await sleep(s.pollIntervalMs);
        continue;
      }

      const btcSecsLeft = Math.round((btcContract.expTime - now) / 1000);
      const ethSecsLeft = Math.round((ethContract.expTime - now) / 1000);
      const minSecsLeft = Math.min(btcSecsLeft, ethSecsLeft);

      // Detect new cycle
      const cycleId = `${btcContract.instId}_${ethContract.instId}`;
      if (cycleId !== currentCycleId) {
        currentCycleId = cycleId;
        enteredCurrentCycle = false;
        stats.cycles++;
        logger.info(`\n📋 NEW CYCLE #${stats.cycles}`);
        logger.info(`   BTC: ${btcContract.instId} | Strike: $${btcContract.stk} | ${btcSecsLeft}s left`);
        logger.info(`   ETH: ${ethContract.instId} | Strike: $${ethContract.stk} | ${ethSecsLeft}s left`);
      }

      // 2. Heartbeat every 30s
      if (now - lastHeartbeat > 30000) {
        lastHeartbeat = now;
        const [btcSpot, ethSpot] = await Promise.all([
          client.getSpotPrice(s.btcSpotTicker),
          client.getSpotPrice(s.ethSpotTicker),
        ]);
        const btcDiff = btcSpot !== null ? Math.abs(btcSpot - btcContract.stk) : null;
        const ethDiff = ethSpot !== null ? Math.abs(ethSpot - ethContract.stk) : null;
        const btcNear = btcDiff !== null && btcDiff <= s.btcNearStrikeThreshold;
        const ethNear = ethDiff !== null && ethDiff <= s.ethNearStrikeThreshold;
        const totalWins = stats.btcWins + stats.ethWins;
        const totalSides = stats.trades * 2;
        const wr = totalSides > 0 ? ((totalWins / totalSides) * 100).toFixed(1) : '0.0';
        logger.info(
          `📊 [${minSecsLeft}s] BTC $${btcSpot ?? '?'} vs stk $${btcContract.stk} diff=$${btcDiff !== null ? btcDiff.toFixed(2) : '?'} near=${btcNear} | ` +
          `ETH $${ethSpot ?? '?'} vs stk $${ethContract.stk} diff=$${ethDiff !== null ? ethDiff.toFixed(3) : '?'} near=${ethNear} | ` +
          `Trades:${stats.trades} BTC✅:${stats.btcWins} ETH✅:${stats.ethWins} Both:${stats.bothWins} WR:${wr}% | ` +
          `Spent:$${stats.totalCost.toFixed(4)} PnL:${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(4)}`
        );
      }

      // 3. Entry check: last 20 seconds
      if (!enteredCurrentCycle && minSecsLeft <= s.entryWindowSecs && minSecsLeft >= 1) {
        const [btcSpot, ethSpot] = await Promise.all([
          client.getSpotPrice(s.btcSpotTicker),
          client.getSpotPrice(s.ethSpotTicker),
        ]);

        if (btcSpot !== null && ethSpot !== null) {
          const btcDiff = Math.abs(btcSpot - btcContract.stk);
          const ethDiff = Math.abs(ethSpot - ethContract.stk);
          const btcNear = btcDiff <= s.btcNearStrikeThreshold;
          const ethNear = ethDiff <= s.ethNearStrikeThreshold;

          logger.info(
            `🔍 [${minSecsLeft}s] BTC diff=$${btcDiff.toFixed(2)} near=${btcNear} | ETH diff=$${ethDiff.toFixed(3)} near=${ethNear}`
          );

          if (btcNear && ethNear) {
            // Get tickers to find underdog prices
            const [btcTicker, ethTicker] = await Promise.all([
              client.getEventTicker(btcContract.instId),
              client.getEventTicker(ethContract.instId),
            ]);

            if (btcTicker && ethTicker) {
              // BTC underdog
              const btcUpPx = btcTicker.askPx > 0 ? btcTicker.askPx : 1.0;
              const btcDnPx = btcTicker.bidPx > 0 ? (1 - btcTicker.bidPx) : 1.0;
              const btcUnderdogSide  = btcUpPx <= btcDnPx ? 'UP' : 'DOWN';
              const btcUnderdogPrice = Math.min(btcUpPx, btcDnPx);

              // ETH underdog
              const ethUpPx = ethTicker.askPx > 0 ? ethTicker.askPx : 1.0;
              const ethDnPx = ethTicker.bidPx > 0 ? (1 - ethTicker.bidPx) : 1.0;
              const ethUnderdogSide  = ethUpPx <= ethDnPx ? 'UP' : 'DOWN';
              const ethUnderdogPrice = Math.min(ethUpPx, ethDnPx);

              logger.info(
                `   BTC: UP=${(btcUpPx*100).toFixed(1)}¢ DOWN=${(btcDnPx*100).toFixed(1)}¢ → underdog=${btcUnderdogSide} @ ${(btcUnderdogPrice*100).toFixed(1)}¢`
              );
              logger.info(
                `   ETH: UP=${(ethUpPx*100).toFixed(1)}¢ DOWN=${(ethDnPx*100).toFixed(1)}¢ → underdog=${ethUnderdogSide} @ ${(ethUnderdogPrice*100).toFixed(1)}¢`
              );

              if (btcUnderdogPrice <= s.maxUnderdogPrice && ethUnderdogPrice <= s.maxUnderdogPrice) {
                enteredCurrentCycle = true;
                stats.trades++;

                const btcCost   = s.contractSize * btcUnderdogPrice;
                const ethCost   = s.contractSize * ethUnderdogPrice;
                const cycleCost = btcCost + ethCost;
                stats.totalCost += cycleCost;

                logger.info(`\n🎯 ENTRY! Cycle #${stats.cycles} — Trade #${stats.trades}`);
                logger.info(`   BTC ${btcUnderdogSide} @ ${(btcUnderdogPrice*100).toFixed(1)}¢ | cost $${btcCost.toFixed(4)}`);
                logger.info(`   ETH ${ethUnderdogSide} @ ${(ethUnderdogPrice*100).toFixed(1)}¢ | cost $${ethCost.toFixed(4)}`);
                logger.info(`   Total cost: $${cycleCost.toFixed(4)}`);

                let btcOrd = null;
                let ethOrd = null;

                if (s.dryRun) {
                  logger.info(`   🟢 [DRY RUN] Simulated: BTC ${btcUnderdogSide} + ETH ${ethUnderdogSide}`);
                } else {
                  [btcOrd, ethOrd] = await Promise.all([
                    client.placeMarketOrder(btcContract.instId, 'buy', s.contractSize, btcUnderdogSide),
                    client.placeMarketOrder(ethContract.instId, 'buy', s.contractSize, ethUnderdogSide),
                  ]);
                }

                // Wait for expiry + 2s buffer
                const maxExpTime = Math.max(btcContract.expTime, ethContract.expTime);
                const waitMs = Math.max(1000, maxExpTime - Date.now() + 2000);
                logger.info(`⏳ Waiting ${Math.round(waitMs / 1000)}s for settlement...`);
                await sleep(waitMs);

                // Settlement check
                const [finalBtcTicker, finalEthTicker, finalBtcSpot, finalEthSpot] = await Promise.all([
                  client.getEventTicker(btcContract.instId),
                  client.getEventTicker(ethContract.instId),
                  client.getSpotPrice(s.btcSpotTicker),
                  client.getSpotPrice(s.ethSpotTicker),
                ]);

                // Determine wins (final ticker price >= 0.95 = settled $1, <= 0.05 = settled $0)
                let btcWin = false;
                if (btcUnderdogSide === 'UP') {
                  btcWin = finalBtcTicker?.last != null
                    ? finalBtcTicker.last >= 0.95
                    : (finalBtcSpot !== null && finalBtcSpot >= btcContract.stk);
                } else {
                  btcWin = finalBtcTicker?.last != null
                    ? finalBtcTicker.last <= 0.05
                    : (finalBtcSpot !== null && finalBtcSpot < btcContract.stk);
                }

                let ethWin = false;
                if (ethUnderdogSide === 'UP') {
                  ethWin = finalEthTicker?.last != null
                    ? finalEthTicker.last >= 0.95
                    : (finalEthSpot !== null && finalEthSpot >= ethContract.stk);
                } else {
                  ethWin = finalEthTicker?.last != null
                    ? finalEthTicker.last <= 0.05
                    : (finalEthSpot !== null && finalEthSpot < ethContract.stk);
                }

                const cyclePayout = (btcWin ? s.contractSize : 0) + (ethWin ? s.contractSize : 0);
                const cyclePnl    = cyclePayout - cycleCost;

                if (btcWin) stats.btcWins++;
                if (ethWin) stats.ethWins++;
                if (btcWin && ethWin) stats.bothWins++;
                stats.totalPnl += cyclePnl;

                const totalWins  = stats.btcWins + stats.ethWins;
                const totalSides = stats.trades * 2;
                const wr = totalSides > 0 ? ((totalWins / totalSides) * 100).toFixed(1) : '0.0';

                logger.info(`\n🏁 SETTLEMENT — Cycle #${stats.cycles} Trade #${stats.trades}`);
                logger.info(`   BTC ${btcUnderdogSide}: ${btcWin ? '✅ WIN  +$' + s.contractSize.toFixed(4) : '❌ LOSS  $0'}`);
                logger.info(`   ETH ${ethUnderdogSide}: ${ethWin ? '✅ WIN  +$' + s.contractSize.toFixed(4) : '❌ LOSS  $0'}`);
                logger.info(
                  `   Cost: $${cycleCost.toFixed(4)} | Payout: $${cyclePayout.toFixed(4)} | ` +
                  `Cycle PnL: ${cyclePnl >= 0 ? '+' : ''}$${cyclePnl.toFixed(4)}`
                );
                logger.info(
                  `📈 RUNNING STATS — Trades:${stats.trades} | BTC✅:${stats.btcWins} ETH✅:${stats.ethWins} Both:${stats.bothWins} | ` +
                  `WR:${wr}% | Spent:$${stats.totalCost.toFixed(4)} | Net PnL:${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(4)}\n`
                );
              } else {
                logger.info(
                  `   ⏭ Skip — underdog prices too high (BTC:${(btcUnderdogPrice*100).toFixed(1)}¢ ETH:${(ethUnderdogPrice*100).toFixed(1)}¢ max:${(s.maxUnderdogPrice*100).toFixed(0)}¢)`
                );
              }
            }
          }
        }
      }

      await sleep(s.pollIntervalMs);
    } catch (err) {
      logger.error(`Loop error: ${err.message}`);
      await sleep(5000);
    }
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
