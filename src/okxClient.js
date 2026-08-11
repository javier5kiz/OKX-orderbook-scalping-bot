/**
 * okxClient.js — OKX API Client (public market data + optional private)
 * 
 * For dry-run mode: only uses public endpoints (no API keys needed)
 * For live mode: needs API keys for order placement
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
    
    // Rate limit
    const gap = Date.now() - this._lastReq;
    if (gap < this._minGap) await sleep(this._minGap - gap);
    this._lastReq = Date.now();
    
    try {
      const headers = this._headers(method, path, bodyStr, isPrivate);
      const res = await fetch(url, { method, headers, body: bodyStr || undefined });
      const json = await res.json();
      if (json.code && json.code !== '0') {
        logger.debug(`OKX: ${method} ${endpoint} → code=${json.code} msg=${json.msg}`);
      }
      return json;
    } catch (err) {
      logger.debug(`OKX error: ${method} ${endpoint} → ${err.message}`);
      return { code: '-1', msg: err.message, data: [] };
    }
  }

  // ── PUBLIC: Get event contract ticker ──────────────────────
  // Returns { last, bidPx, askPx, bidSz, askSz } for the UP outcome
  // UP price = last, DOWN price = 1 - last
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

  // ── PUBLIC: Get spot price (BTC-USDT, ETH-USDT) ─────────────
  async getSpotPrice(instId) {
    const res = await this._request('GET', '/api/v5/market/ticker', { instId });
    const d = res.data?.[0];
    return d?.last ? +d.last : null;
  }

  // ── PUBLIC: Get candle data ─────────────────────────────────
  async getCandles(instId, bar = '1m', limit = 10) {
    const res = await this._request('GET', '/api/v5/market/candles', { instId, bar, limit: String(limit) });
    if (!res.data || res.data.length === 0) return [];
    return res.data.reverse().map(c => ({
      ts: parseInt(c[0]), open: +c[1], high: +c[2], low: +c[3], close: +c[4], vol: +c[5],
    }));
  }

  // ── PRIVATE: Get balance (needs API keys) ──────────────────
  async getUSDTBalance() {
    const res = await this._request('GET', '/api/v5/account/balance', { ccy: 'USDT' }, null, true);
    const det = res.data?.[0]?.details?.find(d => d.ccy === 'USDT');
    return det ? +det.availBal : 0;
  }

  // ── PRIVATE: Place market order (needs API keys) ────────────
  async placeMarketOrder(instId, side, size, outcome) {
    const body = { instId, tdMode: 'isolated', side, ordType: 'market', sz: String(size), outcome };
    const res = await this._request('POST', '/api/v5/trade/order', null, body, true);
    return res?.data?.[0]?.ordId || null;
  }
}

module.exports = OKXClient;
