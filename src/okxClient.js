/**
 * okxClient.js — OKX API Client (public market data + private trading)
 * 
 * Event contract outcomes: UP = "yes", DOWN = "no"
 * Order book liquidity check before placing orders
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

  _headers(method, path, body = '', isPrivate) {
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

  // ── PUBLIC: Get event contract ticker ──────────────────────
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

  // ── PUBLIC: Get order book ──────────────────────────────────
  async getOrderBook(instId) {
    const res = await this._request('GET', '/api/v5/market/books', { instId, sz: '10' });
    const d = res.data?.[0];
    if (!d) return null;
    return {
      asks: (d.asks || []).map(a => ({ price: +a[0], size: +a[1] })),
      bids: (d.bids || []).map(b => ({ price: +b[0], size: +b[1] })),
      ts: d.ts,
    };
  }

  // ── PUBLIC: Check liquidity for a specific outcome ─────────
  // Returns { fillable, bestPrice, totalSize, depth } for the outcome
  // 
  // Event contract order book logic:
  // - asks = sellers of UP (yes) → to buy UP, we hit the asks
  // - bids = buyers of UP (yes) → to buy DOWN (no), we hit the bids (sell UP = buy DOWN)
  // - DOWN price = 1 - UP price, so buying DOWN at P means selling UP at (1-P)
  async checkLiquidity(instId, outcome, minSize, maxPrice) {
    const book = await this.getOrderBook(instId);
    if (!book) return { fillable: false, reason: 'no order book', bestPrice: 0, totalSize: 0 };

    let totalSize = 0;
    let bestPrice = 0;
    let levels = [];

    if (outcome === 'UP') {
      // Buying UP: need asks (sellers of UP)
      // Best ask = lowest ask price
      for (const ask of book.asks) {
        if (ask.price <= maxPrice) {
          totalSize += ask.size;
          if (bestPrice === 0) bestPrice = ask.price;
          levels.push({ price: ask.price, size: ask.size, side: 'ask' });
        }
      }
    } else {
      // Buying DOWN: need bids (buyers of UP = we sell UP to them = buy DOWN)
      // DOWN price = 1 - UP bid price
      // We need UP bid price >= (1 - maxPrice) so DOWN price <= maxPrice
      const minBidPrice = 1 - maxPrice;
      for (const bid of book.bids) {
        if (bid.price >= minBidPrice) {
          totalSize += bid.size;
          const downPrice = 1 - bid.price;
          if (bestPrice === 0) bestPrice = downPrice;
          levels.push({ price: downPrice, upBidPrice: bid.price, size: bid.size, side: 'bid' });
        }
      }
    }

    const fillable = totalSize >= minSize;
    return {
      fillable,
      bestPrice,
      totalSize,
      levels: levels.slice(0, 5), // top 5 levels for logging
      reason: fillable ? '' : `only ${totalSize} available, need ${minSize}`,
    };
  }

  // ── PUBLIC: Get spot price ─────────────────────────────────
  async getSpotPrice(instId) {
    const res = await this._request('GET', '/api/v5/market/ticker', { instId });
    const d = res.data?.[0];
    return d?.last ? +d.last : null;
  }

  // ── PRIVATE: Get balance ───────────────────────────────────
  async getUSDTBalance() {
    const res = await this._request('GET', '/api/v5/account/balance', { ccy: 'USDT' }, null, true);
    const det = res.data?.[0]?.details?.find(d => d.ccy === 'USDT');
    return det ? +det.availBal : 0;
  }

  // ── PRIVATE: Get order details (verify fill) ──────────────
  async getOrderDetails(ordId) {
    const res = await this._request('GET', '/api/v5/trade/order', { ordId }, null, true);
    const d = res.data?.[0];
    if (!d) return null;
    return {
      ordId: d.ordId,
      state: d.state,
      fillPx: d.fillPx ? +d.fillPx : 0,
      fillSz: d.fillSz ? +d.fillSz : 0,
      avgPx: d.avgPx ? +d.avgPx : 0,
      instId: d.instId,
      side: d.side,
      sz: d.sz ? +d.sz : 0,
    };
  }

  // ── PRIVATE: Place market order ────────────────────────────
  async placeMarketOrder(instId, side, size, outcome) {
    const okxOutcome = outcome === 'UP' ? 'yes' : outcome === 'DOWN' ? 'no' : outcome;
    
    const body = {
      instId,
      tdMode: 'isolated',
      side,
      ordType: 'market',
      sz: String(size),
      outcome: okxOutcome,
    };
    
    const res = await this._request('POST', '/api/v5/trade/order', null, body, true);
    
    const d = res?.data?.[0] || {};
    const ordId = d.ordId || null;
    const errorCode = d.sCode || res.code || '';
    const errorMsg = d.sMsg || res.msg || '';
    
    if (!ordId) {
      logger.error(
        `OKX order FAILED: instId=${instId} side=${side} sz=${size} outcome=${okxOutcome} | ` +
        `code=${errorCode} msg=${errorMsg} | full=${JSON.stringify(d)}`
      );
      return { ordId: null, errorCode, errorMsg, filled: false, fillPx: 0, fillSz: 0, raw: d };
    }
    
    // Order accepted — verify it actually filled
    logger.info(`OKX order accepted: ${ordId}, verifying fill...`);
    await sleep(500);
    
    const details = await this.getOrderDetails(ordId);
    if (details && details.state === 'filled') {
      logger.info(
        `✅ FILLED: ${instId} outcome=${okxOutcome} | ordId=${ordId} | ` +
        `fillPx=${details.fillPx} fillSz=${details.fillSz} state=${details.state}`
      );
      return { ordId, errorCode: '', errorMsg: '', filled: true, fillPx: details.fillPx, fillSz: details.fillSz, raw: d };
    } else {
      const state = details?.state || 'unknown';
      logger.warn(
        `⚠️ NOT FILLED: ${instId} outcome=${okxOutcome} | ordId=${ordId} | ` +
        `state=${state} fillSz=${details?.fillSz || 0}`
      );
      return { ordId, errorCode: 'not_filled', errorMsg: `Order state: ${state}`, filled: false, fillPx: details?.fillPx || 0, fillSz: details?.fillSz || 0, raw: d };
    }
  }
}

module.exports = OKXClient;
