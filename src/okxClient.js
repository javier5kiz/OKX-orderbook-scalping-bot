/**
 * okxClient.js — OKX API Client (public market data + private trading)
 * 
 * Event contract outcomes: UP = "yes", DOWN = "no"
 * Liquidity check uses ticker bid/ask sizes (already polled every 3s)
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
  // Returns ticker with bid/ask for liquidity check
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

  // ── PUBLIC: Check liquidity using ticker data ──────────────
  // Uses the ticker's bid/ask sizes to check if there are sellers
  //
  // For event contracts:
  // - Ticker shows UP (yes) market: askPx = sell UP price, bidPx = buy UP price
  // - To buy UP (yes): need askSz > 0 (sellers of UP at askPx)
  // - To buy DOWN (no): need bidSz > 0 (buyers of UP at bidPx; DOWN price = 1 - bidPx)
  //
  // ticker = the ticker we already polled (no extra API call needed)
  // outcome = 'UP' or 'DOWN'
  // minSize = contract size we need (e.g., 0.1)
  // maxPrice = max price per side (e.g., 0.45)
  checkLiquidityFromTicker(ticker, outcome, minSize, maxPrice) {
    if (!ticker || !ticker.last) {
      return { fillable: false, reason: 'no ticker', bestPrice: 0, size: 0 };
    }

    if (outcome === 'UP') {
      // Buying UP: need askSz (sellers of UP) at askPx <= maxPrice
      const askPx = ticker.askPx;
      const askSz = ticker.askSz;
      if (askPx > 0 && askSz >= minSize && askPx <= maxPrice) {
        return { fillable: true, bestPrice: askPx, size: askSz, reason: '' };
      }
      return {
        fillable: false,
        bestPrice: askPx,
        size: askSz,
        reason: askPx === 0 ? 'no asks' : askPx > maxPrice ? `ask ${askPx*100}¢ > max ${maxPrice*100}¢` : `askSz ${askSz} < ${minSize}`
      };
    } else {
      // Buying DOWN: need bidSz (buyers of UP) at bidPx, DOWN price = 1 - bidPx
      const bidPx = ticker.bidPx;
      const bidSz = ticker.bidSz;
      const downPrice = 1 - bidPx;
      if (bidPx > 0 && bidSz >= minSize && downPrice <= maxPrice) {
        return { fillable: true, bestPrice: downPrice, size: bidSz, reason: '' };
      }
      return {
        fillable: false,
        bestPrice: downPrice,
        size: bidSz,
        reason: bidPx === 0 ? 'no bids' : downPrice > maxPrice ? `down ${downPrice*100}¢ > max ${maxPrice*100}¢` : `bidSz ${bidSz} < ${minSize}`
      };
    }
  }

  // ── PUBLIC: Get order book (for debugging) ──────────────────
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
  // Try multiple times with longer waits — event contracts may take longer to settle
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
          instId: d.instId,
          side: d.side,
          sz: d.sz ? +d.sz : 0,
        };
      }
      
      // Log raw response on first attempt for debugging
      if (attempt === 1) {
        logger.info(`   Order check attempt ${attempt}: raw response code=${res.code} msg=${res.msg} dataLen=${res.data?.length || 0}`);
      }
      
      if (attempt < 3) await sleep(1000); // Wait 1s between retries
    }
    
    logger.warn(`   Order ${ordId}: could not get details after 3 attempts`);
    return null;
  }

  // ── PRIVATE: Place market order ────────────────────────────
  async placeMarketOrder(instId, side, size, outcome) {
    const okxOutcome = outcome === 'UP' ? 'yes' : outcome === 'DOWN' ? 'no' : outcome;
    
    const szStr = String(size);
    const body = {
      instId,
      tdMode: 'isolated',
      side,
      ordType: 'market',
      sz: szStr,
      outcome: okxOutcome,
    };
    
    logger.info(`📤 Order body: instId=${instId} sz=${szStr} outcome=${okxOutcome} side=${side} tdMode=isolated ordType=market`);
    
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
    
    // Order accepted — verify it actually filled (wait 2s, then check with retries)
    logger.info(`OKX order accepted: ${ordId}, verifying fill (2s wait)...`);
    await sleep(2000);
    
    const details = await this.getOrderDetails(ordId, instId);
    if (details) {
      const state = details.state;
      // Accept any state that means the order executed
      const isFilled = ['filled', 'partially_filled', 'effective'].includes(state);
      
      if (isFilled) {
        logger.info(
          `✅ FILLED: ${instId} outcome=${okxOutcome} | ordId=${ordId} | ` +
          `state=${state} fillPx=${details.fillPx} fillSz=${details.fillSz}`
        );
        return { ordId, errorCode: '', errorMsg: '', filled: true, fillPx: details.fillPx, fillSz: details.fillSz, raw: d };
      } else {
        logger.warn(
          `⚠️ NOT FILLED: ${instId} outcome=${okxOutcome} | ordId=${ordId} | ` +
          `state=${state} fillSz=${details.fillSz}`
        );
        return { ordId, errorCode: 'not_filled', errorMsg: `Order state: ${state}`, filled: false, fillPx: details.fillPx, fillSz: details.fillSz, raw: d };
      }
    } else {
      logger.warn(
        `⚠️ UNVERIFIABLE: ${instId} outcome=${okxOutcome} | ordId=${ordId} | ` +
        `could not retrieve order details after 3 attempts`
      );
      return { ordId, errorCode: 'unverifiable', errorMsg: 'Could not verify fill', filled: false, fillPx: 0, fillSz: 0, raw: d };
    }
  }
}

module.exports = OKXClient;
