/**
 * okxClient.js — OKX API Client (public market data + private trading)
 */
const crypto = require('crypto');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class OKXClient {
  constructor(cfg) {
    this.apiKey = cfg.apiKey || '';
    this.secretKey = cfg.secretKey || '';
    this.passphrase = cfg.passphrase || '';
    this.isDemo = cfg.isDemo || false;
    this.baseURL = cfg.baseURL || 'https://www.okx.com';
    this._lastReq = 0;
    this._minGap = 120;
  }

  _sign(timestamp, method, path, body = '') {
    const msg = timestamp + method.toUpperCase() + path + body;
    return crypto.createHmac('sha256', this.secretKey).update(msg).digest('base64');
  }

  _headers(method, path, body = '', isPrivate = false) {
    if (!isPrivate) return { 'Content-Type': 'application/json' };
    if (!this.apiKey) throw new Error('API keys required for private endpoints');
    const ts = new Date().toISOString();
    const sign = this._sign(ts, method, path, body);
    const h = {
      'OK-ACCESS-KEY': this.apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
    };
    if (this.isDemo) h['x-simulated-trading'] = '1';
    return h;
  }

  async _request(method, endpoint, params = null, body = null, isPrivate = false) {
    let path = endpoint;
    if (params && method === 'GET') {
      path += '?' + new URLSearchParams(params).toString();
    }
    const url = this.baseURL + path;
    const bodyStr = body ? JSON.stringify(body) : '';
    const gap = Date.now() - this._lastReq;
    if (gap < this._minGap) await sleep(this._minGap - gap);
    this._lastReq = Date.now();
    try {
      const headers = this._headers(method, path, bodyStr, isPrivate);
      const res = await fetch(url, { method, headers, body: bodyStr || undefined });
      const json = await res.json();
      return json;
    } catch (err) {
      return { code: '-1', msg: err.message, data: [] };
    }
  }

  // PUBLIC: Get spot price
  async getSpotPrice(instId) {
    const res = await this._request('GET', '/api/v5/market/ticker', { instId });
    const d = res.data?.[0];
    return d ? +d.last : null;
  }

  // PUBLIC: Get event contract ticker
  async getEventTicker(instId) {
    const res = await this._request('GET', '/api/v5/market/ticker', { instId });
    const d = res.data?.[0];
    if (!d) return null;
    return {
      instId: d.instId,
      last:   d.last ? +d.last : null,
      bidPx:  d.bidPx ? +d.bidPx : 0,
      askPx:  d.askPx ? +d.askPx : 0,
      bidSz:  d.bidSz ? +d.bidSz : 0,
      askSz:  d.askSz ? +d.askSz : 0,
    };
  }

  // PUBLIC: Get active event contract with strike price
  async getActiveContract(seriesId) {
    const path = `/api/v5/public/instruments?instType=EVENTS&seriesId=${encodeURIComponent(seriesId)}`;
    const res = await this._request('GET', path);
    if (res && res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
      const now = Date.now();
      const active = res.data
        .map(item => ({
          instId: item.instId,
          stk: parseFloat(item.stk || '0'),
          expTime: parseInt(item.expTime || '0', 10),
          state: item.state,
          lotSz: parseFloat(item.lotSz || '0.1'),
        }))
        .filter(c => c.state === 'live' && c.expTime > now && c.stk > 0)
        .sort((a, b) => a.expTime - b.expTime);
      return active[0] || null;
    }
    return null;
  }

  // PRIVATE: Get USDT balance — checks BOTH trading + funding accounts
  // OKX event contracts are funded from the trading (unified) account.
  // But users may have funds in the funding account — we check both and log each.
  async getUSDTBalance() {
    let tradingBal = 0;
    let fundingBal = 0;

    try {
      // 1. Unified trading account
      const tradingRes = await this._request('GET', '/api/v5/account/balance', { ccy: 'USDT' }, null, true);
      logger.info(`  [balance] Trading account raw: code=${tradingRes.code} dataLen=${tradingRes.data?.length ?? 0}`);
      if (tradingRes.code === '0' && tradingRes.data?.[0]) {
        const det = tradingRes.data[0].details?.find(d => d.ccy === 'USDT');
        if (det) {
          tradingBal = +det.availBal || 0;
          logger.info(`  [balance] Trading USDT availBal=${det.availBal} eqUsd=${det.eqUsd || '?'}`);
        } else {
          // Log all currencies found so we can debug
          const ccys = (tradingRes.data[0].details || []).map(d => `${d.ccy}=${d.availBal}`).join(', ');
          logger.info(`  [balance] Trading account currencies: ${ccys || '(none)'}`);
        }
      } else {
        logger.warn(`  [balance] Trading account error: ${tradingRes.msg || JSON.stringify(tradingRes)}`);
      }
    } catch (e) {
      logger.warn(`  [balance] Trading account fetch error: ${e.message}`);
    }

    try {
      // 2. Funding account (asset balance)
      const fundingRes = await this._request('GET', '/api/v5/asset/balances', { ccy: 'USDT' }, null, true);
      logger.info(`  [balance] Funding account raw: code=${fundingRes.code} dataLen=${fundingRes.data?.length ?? 0}`);
      if (fundingRes.code === '0' && Array.isArray(fundingRes.data)) {
        const det = fundingRes.data.find(d => d.ccy === 'USDT');
        if (det) {
          fundingBal = +det.availBal || 0;
          logger.info(`  [balance] Funding USDT availBal=${det.availBal}`);
        } else {
          const ccys = fundingRes.data.map(d => `${d.ccy}=${d.availBal}`).join(', ');
          logger.info(`  [balance] Funding account currencies: ${ccys || '(none)'}`);
        }
      } else {
        logger.warn(`  [balance] Funding account error: ${fundingRes.msg || JSON.stringify(fundingRes)}`);
      }
    } catch (e) {
      logger.warn(`  [balance] Funding account fetch error: ${e.message}`);
    }

    const total = tradingBal + fundingBal;
    logger.info(`  [balance] Trading: $${tradingBal.toFixed(4)} | Funding: $${fundingBal.toFixed(4)} | Total: $${total.toFixed(4)}`);
    return total;
  }

  // PRIVATE: Get order details
  async getOrderDetails(ordId, instId) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const params = { ordId };
      if (instId) params.instId = instId;
      const res = await this._request('GET', '/api/v5/trade/order', params, null, true);
      const d = res.data?.[0];
      if (d) {
        return {
          ordId: d.ordId,
          state: d.state,
          fillPx: d.fillPx ? +d.fillPx : 0,
          fillSz: d.fillSz ? +d.fillSz : 0,
          avgPx: d.avgPx ? +d.avgPx : 0,
        };
      }
      if (attempt < 3) await sleep(1000);
    }
    return null;
  }

  // PRIVATE: Place market order
  async placeMarketOrder(instId, side, size, outcome) {
    const okxOutcome = outcome === 'UP' ? 'yes' : 'no';
    const body = {
      instId,
      tdMode: 'isolated',
      side,
      ordType: 'market',
      sz: String(size),
      outcome: okxOutcome,
    };
    logger.info(`📤 Order: ${instId} ${side} ${size} ${okxOutcome}`);
    const res = await this._request('POST', '/api/v5/trade/order', null, body, true);
    const d = res?.data?.[0] || {};
    const ordId = d.ordId || null;
    if (!ordId) {
      logger.error(`Order FAILED: ${instId} code=${d.sCode || res.code} msg=${d.sMsg || res.msg}`);
      return { ordId: null, filled: false, fillPx: 0, errorMsg: d.sMsg || res.msg };
    }
    logger.info(`Order accepted: ${ordId}, verifying fill...`);
    await sleep(2000);
    const details = await this.getOrderDetails(ordId, instId);
    if (details) {
      const isFilled = ['filled', 'partially_filled', 'effective'].includes(details.state);
      if (isFilled) {
        logger.info(`✅ FILLED: ${instId} ${okxOutcome} @ ${details.fillPx} | ordId=${ordId}`);
        return { ordId, filled: true, fillPx: details.fillPx, fillSz: details.fillSz };
      }
      logger.warn(`⚠️ NOT FILLED: ${instId} state=${details.state}`);
      return { ordId, filled: false, fillPx: 0, errorMsg: `state=${details.state}` };
    }
    return { ordId, filled: false, fillPx: 0, errorMsg: 'unverifiable' };
  }
}

module.exports = OKXClient;
