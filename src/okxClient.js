/**
 * okxClient.js — OKX API Client (public market data + private trading)
 * 
 * Public: no API keys needed (tickers, order book)
 * Private: needs API keys for order placement
 * 
 * Event contract outcomes: UP = "yes", DOWN = "no"
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
    this._minGap = 120; // ms between requests
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

  // ── PRIVATE: Place market order ────────────────────────────
  // For event contracts: outcome "UP" → "yes", "DOWN" → "no"
  // OKX API requires outcome as "yes" or "no" per their docs
  async placeMarketOrder(instId, side, size, outcome) {
    // Map UP/DOWN to OKX's yes/no format
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
    } else {
      logger.info(
        `OKX order OK: instId=${instId} side=${side} sz=${size} outcome=${okxOutcome} | ordId=${ordId}`
      );
    }
    
    return { ordId, errorCode, errorMsg, raw: d };
  }
}

module.exports = OKXClient;
