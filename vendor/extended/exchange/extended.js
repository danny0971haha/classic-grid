// ExtendedExchange: LIVE adapter for Extended (https://extended.exchange),
// a perpetuals DEX on Starknet. Zero external dependencies:
//   - REST via built-in fetch (X-Api-Key header for reads)
//   - order signing via ./starkcrypto.js (SNIP-12 + Stark ECDSA, verified
//     against the official python SDK test vectors; selfTest() runs on init)
//
// Markets on Extended are addressed by NAME ("BTC-USD"). The bot uses numeric
// marketIds, so this adapter assigns stable per-process ids (sorted by daily
// volume) and keeps the name in `market.name`.
//
// Fills are detected by polling open orders: an order we placed that is no
// longer resting is checked via GET /user/orders/{id}; if it has filledQty it
// is reported as a fill, otherwise it was cancelled externally.
import { EventEmitter } from 'node:events';
import {
  selfTest, orderMsgHash, starkSign, settlementAmounts, alignToStep, parseDec, toHex,
  publicKeyFromPrivate,
} from './starkcrypto.js';

export const TESTNET_NETWORK_WRITE_AUTHORIZED = false;
export const EXTENDED_VENDOR_NETWORK_PROFILES = Object.freeze({
  mainnet: Object.freeze({
    network: 'mainnet',
    restOrigin: 'https://api.starknet.extended.exchange',
    restApiPrefix: '/api/v1',
    websocketBase: 'wss://api.starknet.extended.exchange/stream.extended.exchange/v1',
    signingDomain: 'extended.exchange',
    chainId: 'SN_MAIN',
    snip12Name: 'Perpetuals',
    snip12Version: 'v0',
    snip12Revision: 1,
  }),
  sepolia: Object.freeze({
    network: 'sepolia',
    restOrigin: 'https://api.starknet.sepolia.extended.exchange',
    restApiPrefix: '/api/v1',
    websocketBase: 'wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1',
    signingDomain: 'starknet.sepolia.extended.exchange',
    chainId: 'SN_SEPOLIA',
    snip12Name: 'Perpetuals',
    snip12Version: 'v0',
    snip12Revision: 1,
  }),
});

function resolveVendorProfile(opts) {
  const profile = EXTENDED_VENDOR_NETWORK_PROFILES[opts?.network];
  if (!profile) throw new Error('EXTENDED_NETWORK_PROFILE_REQUIRED');
  const apiUrl = String(opts.apiUrl || '').replace(/\/$/, '');
  if (
    apiUrl !== profile.restOrigin ||
    opts.chainId !== profile.chainId ||
    opts.signingDomain !== profile.signingDomain ||
    (opts.websocketBase != null && opts.websocketBase !== profile.websocketBase)
  ) {
    throw new Error('EXTENDED_PROFILE_MIXED');
  }
  return profile;
}

const INTERVALS = { 60: 'PT1M', 300: 'PT5M', 900: 'PT15M', 1800: 'PT30M', 3600: 'PT1H', 7200: 'PT2H', 14400: 'PT4H', 86400: 'P1D' };
const ORDER_EXPIRY_DAYS = 28;          // resting grid orders live this long
const SETTLEMENT_BUFFER_DAYS = 14;     // same buffer as the official SDK
const USER_AGENT = 'ExtendedGridBot/1.0';

export class ExtendedExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    const profile = resolveVendorProfile(opts);
    this.mode = 'live';
    this.apiKey = opts.apiKey;
    this.vault = Number(opts.vault);
    this.privateKey = BigInt(opts.privateKey);
    this.publicKey = opts.publicKey ? BigInt(opts.publicKey) : null;
    this.apiUrl = profile.restOrigin;
    this.network = profile.network;
    this.signingDomain = profile.signingDomain;
    this.websocketBase = profile.websocketBase;
    this.feeRate = opts.feeRate || '0.0005'; // max fee signed into orders (taker is 0.00025)
    this.pollMs = opts.pollMs ?? 10_000;
    this.domain = {
      name: profile.snip12Name,
      version: profile.snip12Version,
      chainId: profile.chainId,
      revision: profile.snip12Revision,
    };
    this.markets = new Map();   // marketId -> market
    this.balance = null;
    this.equity = null;
    this.unrealisedPnl = null;
    this.availableForTrade = null;
    this.availableForWithdrawal = null;
    this.initialMargin = null;
    this.spotEquity = null;
    this._balanceRefreshError = null;
    this._balanceRefreshAt = null;
    this._statsCache = null; // official stats cache
    this.pnlSinceDate = null; // YYYY-MM-DD，官网盈亏只汇总该日及以后（与本轮基准对齐）
    this.statsMarketNames = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
    this._tracked = new Map();  // orderId(str) -> {marketId, levelIndex, side, price, sizeBase, seen}
    this._watch = new Set();    // marketIds to poll
    this._pos = new Map();      // marketId -> position
    this._allPositions = [];    // 全账户持仓（与官网 positions 同步）
    this._allOpenOrders = [];     // 全账户挂单（与官网 orders 同步）
    this._lastAccountPollAt = 0;
    this._lastAllPositionsPollAt = 0;
    this._lastAllOrdersPollAt = 0;
    this._ordersSnapshotAt = null;
    this._ordersSnapshotError = null;
    this._positionsSnapshotAt = null;
    this._positionsSnapshotError = null;
    this._accountId = null;
    this._prices = new Map();
    this._timer = null;
    this._busy = false;
    this._getFlights = new Map();
  }

  async init() {
    if (!this.apiKey || !this.vault || !this.privateKey) {
      throw new Error('LIVE 模式需要 EXTENDED_API_KEY / EXTENDED_VAULT / EXTENDED_STARK_PRIVATE_KEY（在 app.extended.exchange 的 API Management 页面获取）。');
    }
    if (this.network === 'sepolia' && !TESTNET_NETWORK_WRITE_AUTHORIZED) {
      throw new Error('TESTNET_NETWORK_WRITE_UNAUTHORIZED');
    }
    // Refuse to trade if the signing implementation doesn't reproduce the
    // official SDK test vector (protects against env/runtime quirks).
    selfTest();
    if (this.publicKey == null) this.publicKey = publicKeyFromPrivate(this.privateKey);

    const data = await this._get('/api/v1/info/markets');
    const list = (data || [])
      .filter((m) => m.active && (m.type ?? 'PERPETUAL') === 'PERPETUAL' && m.l2Config)
      .sort((a, b) => Number(b.marketStats?.dailyVolume || 0) - Number(a.marketStats?.dailyVolume || 0));
    let id = 1;
    for (const m of list) {
      const t = m.tradingConfig || {};
      const px = Number(m.marketStats?.lastPrice || m.marketStats?.markPrice || 0);
      this.markets.set(id, {
        marketId: id, name: m.name, displayName: m.name, symbol: m.assetName,
        lastPrice: px,
        stepSize: Number(t.minOrderSizeChange || t.minOrderSize), stepPrice: Number(t.minPriceChange),
        maxLeverage: Number(t.maxLeverage || 50), minOrderSize: Number(t.minOrderSize),
        qtyStep: String(t.minOrderSizeChange || t.minOrderSize), priceStep: String(t.minPriceChange),
        l2: { // keep as strings: market objects are JSON-serialized for the dashboard
          syntheticId: String(m.l2Config.syntheticId), collateralId: String(m.l2Config.collateralId),
          synRes: Number(m.l2Config.syntheticResolution), colRes: Number(m.l2Config.collateralResolution),
        },
      });
      this._prices.set(id, px);
      id++;
    }
    if (!this.markets.size) throw new Error('Extended 未返回可交易市场。');
    this.dataSource = 'real';
    await this._refreshAccount(); // also validates the API key
    await this._refreshAllPositions().catch(() => {});
    await this._refreshAllOpenOrders().catch(() => {});
    this._lastAccountPollAt = this._lastAllPositionsPollAt =
      this._lastAllOrdersPollAt = Date.now();
    this.start();
    return true;
  }

  // ---------- HTTP ----------
  _headers() {
    return { 'X-Api-Key': this.apiKey, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async _req(method, path, body, { full = false, _retried = false, _rateAttempt = 0 } = {}) {
    try {
      return await this._reqOnce(method, path, body, { full });
    } catch (e) {
      if (e?.status === 429 && _rateAttempt < 4) {
        const waitMs = Math.min(8000, 500 * (2 ** _rateAttempt)) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, waitMs));
        return this._req(method, path, body, { full, _retried, _rateAttempt: _rateAttempt + 1 });
      }
      throw e;
    }
  }

  async _reqOnce(method, path, body, { full = false } = {}) {
    if (this.network === 'sepolia' && !TESTNET_NETWORK_WRITE_AUTHORIZED) {
      throw new Error('TESTNET_NETWORK_WRITE_UNAUTHORIZED');
    }
    const useProxy = /^(1|true|yes)$/i.test(String(process.env.EXTENDED_USE_PROXY || ''));
    const proxyUrl = useProxy ? (process.env.EXTENDED_PROXY || '').trim() : '';
    const init = {
      method,
      headers: this._headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    };
    let res;
    if (proxyUrl) {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      res = await undiciFetch(this.apiUrl + path, { ...init, dispatcher: new ProxyAgent(proxyUrl) });
    } else {
      res = await fetch(this.apiUrl + path, init);
    }
    let j = null;
    try { j = await res.json(); } catch { /* some endpoints return empty bodies */ }
    if (res.status === 401) throw new Error('API key 无效或已过期 (401)。');
    if (res.status === 429) {
      const e = new Error('触发限流 (429)，请稍后重试。');
      e.status = 429;
      throw e;
    }
    if (j && j.status === 'ERROR') {
      const detail = j.error || {};
      const e = new Error(
        `Extended 接口错误 ${detail.code || res.status}: ${detail.message || JSON.stringify(j)}`
      );
      e.status = res.status;
      e.code = detail.code || null;
      e.response = j;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`Extended 接口错误 HTTP ${res.status}: ${path}`);
      e.status = res.status;
      e.response = j;
      throw e;
    }
    if (full) return j;
    return j ? j.data : null;
  }

  _get(path) {
    if (this._getFlights.has(path)) return this._getFlights.get(path);
    const flight = this._req('GET', path).finally(() => this._getFlights.delete(path));
    this._getFlights.set(path, flight);
    return flight;
  }

  // Strict read-plane wrappers. These deliberately return only the response
  // from the current request and never consult or mutate dashboard caches.
  strictReadAccountDetails() {
    return this._req('GET', '/api/v1/user/account/info');
  }

  strictReadBalance() {
    return this._req('GET', '/api/v1/user/balance');
  }

  strictReadPositions(market) {
    return this._req('GET', `/api/v1/user/positions?market=${encodeURIComponent(market)}`);
  }

  strictReadOpenOrders(market) {
    return this._req('GET', `/api/v1/user/orders?market=${encodeURIComponent(market)}`);
  }

  strictReadLeverage(market) {
    return this._req('GET', `/api/v1/user/leverage?market=${encodeURIComponent(market)}`);
  }

  strictReadMarkPrice(market) {
    return this._req('GET', `/api/v1/info/markets/${encodeURIComponent(market)}/stats`)
      .then((stats) => ({ market, markPrice: stats?.markPrice }));
  }

  /** 分页拉取账户成交（单市场，避免多 market 一次请求 403） */
  async getTradesPage(marketName, { cursor, limit = 500 } = {}) {
    const qs = new URLSearchParams();
    qs.append('market', marketName);
    if (cursor != null) qs.set('cursor', String(cursor));
    if (limit) qs.set('limit', String(limit));
    const j = await this._req('GET', `/api/v1/user/trades?${qs}`, undefined, { full: true });
    return { data: j?.data || [], pagination: j?.pagination || null };
  }

  /** 按市场名分页拉取历史成交（Extended 单 market 常仅返回最近 ~300 笔） */
  async fetchAllTrades(marketNames) {
    const out = [];
    for (const name of marketNames) {
      let cursor;
      for (let page = 0; page < 50; page++) {
        const { data, pagination } = await this.getTradesPage(name, { cursor, limit: 500 });
        if (data?.length) out.push(...data);
        const next = pagination?.cursor;
        if (!data?.length || next == null || String(next) === String(cursor)) break;
        cursor = next;
      }
    }
    return out;
  }

  marketIdForName(name) {
    for (const [id, m] of this.markets) {
      if (m.name === name) return id;
    }
    return null;
  }

  /** 分页拉取已平仓位（Extended 官网同源） */
  async getPositionsHistoryPage(marketName, { cursor, limit = 50 } = {}) {
    const qs = new URLSearchParams();
    if (marketName) qs.append('market', marketName);
    if (cursor != null) qs.set('cursor', String(cursor));
    if (limit) qs.set('limit', String(limit));
    const j = await this._req('GET', `/api/v1/user/positions/history?${qs}`, undefined, { full: true });
    return { data: j?.data || [], pagination: j?.pagination || null };
  }

  /** 全账户已平仓位（不传 market，与官网 positions/history 一致） */
  async fetchAllClosedPositions() {
    const out = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const { data, pagination } = await this.getPositionsHistoryPage(null, { cursor, limit: 100 });
      for (const p of data || []) {
        if (!Number(p.closedTime || 0)) continue;
        out.push(this._mapClosedPosition(p, p.market));
      }
      const next = pagination?.cursor;
      if (!data?.length || next == null || String(next) === String(cursor)) break;
      cursor = next;
    }
    out.sort((a, b) => b.closedTime - a.closedTime);
    return out;
  }

  _mapClosedPosition(p, marketName) {
    const bd = p.realisedPnlBreakdown || p.realizedPnlBreakdown || {};
    const openFees = Number(bd.openFees || 0);
    const closeFees = Number(bd.closeFees || 0);
    const market = String(p.market || marketName);
    return {
      id: String(p.id),
      market,
      marketId: this.marketIdForName(market),
      side: String(p.side || '').toUpperCase() === 'SHORT' ? 'short' : 'long',
      size: Number(p.size || p.maxPositionSize || 0),
      openPrice: Number(p.openPrice || 0),
      exitPrice: Number(p.exitPrice || 0),
      realizedPnl: Number(p.realisedPnl ?? p.realizedPnl ?? 0),
      fees: openFees + closeFees,
      fundingFees: Number(bd.fundingFees || 0),
      closedTime: Number(p.closedTime || 0),
      exitType: p.exitType || null,
    };
  }

  /** 拉取已平仓位并汇总（与 Extended 官网 positions/history 一致） */
  async fetchClosedPositions(marketNames) {
    const out = [];
    for (const name of marketNames) {
      let cursor;
      for (let page = 0; page < 50; page++) {
        const { data, pagination } = await this.getPositionsHistoryPage(name, { cursor, limit: 100 });
        for (const p of data || []) {
          if (!Number(p.closedTime || 0)) continue;
          out.push(this._mapClosedPosition(p, name));
        }
        const next = pagination?.cursor;
        if (!data?.length || next == null || String(next) === String(cursor)) break;
        cursor = next;
      }
    }
    out.sort((a, b) => b.closedTime - a.closedTime);
    return out;
  }

  // ---------- market data ----------
  async getMarkets() { return [...this.markets.values()]; }

  _market(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) throw new Error('未知市场 marketId=' + marketId);
    return m;
  }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const m = this._market(marketId);
    const interval = INTERVALS[intervalSec] || 'PT1H';
    const data = await this._get(`/api/v1/info/candles/${encodeURIComponent(m.name)}/trades?interval=${interval}&limit=${Math.min(n, 1000)}`);
    return (data || [])
      .map((c) => ({ time: Number(c.T), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +(c.v ?? 0) }))
      .filter((c) => Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  }

  async getPrice(marketId) {
    const mId = Number(marketId);
    this._watch.add(mId);
    const m = this._market(mId);
    try {
      const book = await this._get(`/api/v1/info/markets/${encodeURIComponent(m.name)}/orderbook`);
      const bid = Number(book?.bid?.[0]?.price), ask = Number(book?.ask?.[0]?.price);
      if (bid && ask) { const mid = (bid + ask) / 2; this._prices.set(mId, mid); return mid; }
      if (bid || ask) { const px = bid || ask; this._prices.set(mId, px); return px; }
    } catch { /* fall back */ }
    return this._prices.get(mId) ?? m.lastPrice;
  }

  // ---------- trading ----------
  async setLeverage(marketId, x) {
    const m = this._market(marketId);
    await this._req('PATCH', '/api/v1/user/leverage', { market: m.name, leverage: String(x) });
    const actual = await this.getLeverage(marketId);
    if (actual == null || Math.abs(actual - Number(x)) > 1e-9) {
      throw new Error(`杠杆校验失败：期望 ${x}x，官方返回 ${actual ?? '未知'}`);
    }
    return true;
  }

  async getLeverage(marketId) {
    const m = this._market(marketId);
    const data = await this._get(`/api/v1/user/leverage?market=${encodeURIComponent(m.name)}`);
    const row = Array.isArray(data) ? data.find((x) => String(x.market) === m.name) : data;
    const value = Number(row?.leverage ?? row?.value ?? row);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** Build, sign and submit an order. Returns { orderId }. */
  async _submitOrder(m, {
    side, qtyStr, priceStr, type, timeInForce, postOnly, reduceOnly,
    externalId = null, beforeSubmit = null,
  }) {
    const isBuy = side === 'buy';
    const amounts = settlementAmounts({
      qty: qtyStr, price: priceStr, feeRate: this.feeRate,
      synRes: m.l2.synRes, colRes: m.l2.colRes, isBuy,
    });
    // Official API requires 1 <= nonce <= 2^31.
    const nonce = 1 + Math.floor(Math.random() * 0x7FFFFFFF);
    const expiryEpochMillis = Date.now() + ORDER_EXPIRY_DAYS * 86400_000;
    const expirationSec = Math.ceil(expiryEpochMillis / 1000) + SETTLEMENT_BUFFER_DAYS * 86400;
    const synId = BigInt(m.l2.syntheticId), colId = BigInt(m.l2.collateralId);
    const hash = orderMsgHash({
      positionId: this.vault,
      baseAssetId: synId, baseAmount: amounts.syntheticAmount,
      quoteAssetId: colId, quoteAmount: amounts.collateralAmount,
      feeAssetId: colId, feeAmount: amounts.feeAmount,
      expirationSec, salt: nonce, publicKey: this.publicKey, domain: this.domain,
    });
    const { r, s } = starkSign(hash, this.privateKey);
    const payload = {
      id: externalId == null ? hash.toString(10) : String(externalId),
      market: m.name,
      type,
      side: isBuy ? 'BUY' : 'SELL',
      qty: qtyStr,
      price: priceStr,
      reduceOnly: !!reduceOnly,
      postOnly: !!postOnly,
      timeInForce,
      expiryEpochMillis,
      fee: this.feeRate,
      nonce: String(nonce),
      selfTradeProtectionLevel: 'ACCOUNT',
      settlement: {
        signature: { r: toHex(r), s: toHex(s) },
        starkKey: toHex(this.publicKey),
        collateralPosition: String(this.vault),
      },
    };
    if (typeof beforeSubmit === 'function') beforeSubmit(payload);
    const data = await this._req('POST', '/api/v1/user/order', payload);
    // 数字 exchange id 超过 JS 安全整数会丢精度；撤单主键用 externalId（payload.id）
    const submittedExternalId = String(payload.id);
    return {
      orderId: submittedExternalId,
      externalId: submittedExternalId,
      exchangeId: data?.id != null ? String(data.id) : '',
    };
  }

  async placeLimitOrder(o) {
    const m = this._market(o.marketId);
    const qtyStr = alignToStep(o.sizeBase, m.qtyStep, 'down');
    const priceStr = alignToStep(o.price, m.priceStep, 'nearest');
    if (parseDec(qtyStr).i <= 0n) throw new Error('数量过小，低于市场最小下单单位。');
    const { orderId, externalId, exchangeId } = await this._submitOrder(m, {
      side: o.side, qtyStr, priceStr, type: 'LIMIT', timeInForce: 'GTT',
      postOnly: o.postOnly ?? true, reduceOnly: !!o.reduceOnly,
      externalId: o.externalId ?? null,
    });
    this._watch.add(m.marketId);
    this._tracked.set(orderId, {
      marketId: m.marketId, levelIndex: o.levelIndex, side: o.side,
      price: Number(priceStr), sizeBase: Number(qtyStr), seen: false,
      placedAt: Date.now(), reduceOnly: !!o.reduceOnly,
      externalId, exchangeId,
    });
    return { orderId, externalId, exchangeId };
  }

  async cancelOrder(marketId, orderId) {
    // 文档官方有效：DELETE ?externalId= 或 massCancel.externalOrderIds
    return this._req('DELETE', `/api/v1/user/order?externalId=${encodeURIComponent(String(orderId))}`);
  }

  async cancelAll(marketId) {
    const m = this._market(marketId);
    return this._req('POST', '/api/v1/user/order/massCancel', { markets: [m.name] });
  }

  async confirmNoOpenOrders(marketId, { retries = 8, waitMs = 750 } = {}) {
    for (let i = 0; i < retries; i++) {
      const refreshed = await this._refreshAllOpenOrders();
      if (!refreshed.ok) throw new Error(`无法确认撤单结果：${refreshed.error}`);
      const left = this.getAllOpenOrders().filter((o) => o.marketId === Number(marketId));
      if (left.length === 0) {
        for (const [id, o] of this._tracked) {
          if (o.marketId === Number(marketId)) this._tracked.delete(id);
        }
        return { ok: true, remaining: 0, confirmedAt: this._ordersSnapshotAt };
      }
      if (i + 1 < retries) await new Promise((r) => setTimeout(r, waitMs));
    }
    const remaining = this.getAllOpenOrders().filter((o) => o.marketId === Number(marketId)).length;
    throw new Error(`官方仍有 ${remaining} 笔挂单，禁止重铺`);
  }

  async confirmOrderGone(orderId, { retries = 6, waitMs = 500 } = {}) {
    for (let i = 0; i < retries; i++) {
      const refreshed = await this._refreshAllOpenOrders();
      if (!refreshed.ok) throw new Error(`无法确认订单撤销：${refreshed.error}`);
      const key = String(orderId);
      const exists = this.getAllOpenOrders().some((o) =>
        String(o.orderId) === key ||
        String(o.externalId || '') === key ||
        String(o.internalId || '') === key ||
        String(o.exchangeId || '') === key
      );
      if (!exists) {
        this._tracked.delete(key);
        return { ok: true, confirmedAt: this._ordersSnapshotAt };
      }
      if (i + 1 < retries) await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new Error(`官方仍显示订单 ${orderId}`);
  }

  getOpenOrders(marketId) {
    return this.getOpenOrdersForMarket(marketId);
  }

  getPosition(marketId) {
    const p = this._pos.get(Number(marketId));
    return p && p.sizeBase !== 0 ? p : null;
  }

  _parsePosition(p) {
    const name = p.market || p.marketName || p.symbol;
    if (!name) return null;
    const short = String(p.side || '').toUpperCase() === 'SHORT';
    const qty = Math.abs(Number(p.size || p.qty || 0));
    if (!(qty > 0)) return null;
    const mark = Number(p.markPrice ?? p.indexPrice ?? p.marketPrice ?? 0);
    const entry = Number(p.openPrice ?? p.entryPrice ?? 0);
    const value = Number(p.value ?? p.notional ?? 0) || (mark > 0 ? qty * mark : entry * qty);
    let pct = Number(p.unrealisedPnlRatio ?? p.unrealizedPnlRatio ?? p.unrealisedPnlPercent ?? 0);
    if (pct !== 0 && Math.abs(pct) <= 1) pct *= 100;
    return {
      market: name,
      marketId: this.marketIdForName(name),
      side: short ? 'short' : 'long',
      size: qty,
      sizeBase: qty * (short ? -1 : 1),
      entryPrice: entry,
      markPrice: mark,
      valueUsd: Math.round(value * 100) / 100,
      unrealizedPnl: Number(p.unrealisedPnl ?? p.unrealizedPnl ?? 0),
      realizedPnl: Number(p.realisedPnl ?? p.realizedPnl ?? 0),
      unrealizedPct: Math.round(pct * 100) / 100,
      leverage: p.leverage != null ? Number(p.leverage) : null,
      margin: p.margin != null ? Number(p.margin) : (p.initialMargin != null ? Number(p.initialMargin) : null),
      liquidationPrice: p.liquidationPrice != null ? Number(p.liquidationPrice) : null,
    };
  }

  /** 拉取账户全部持仓（不限于当前网格 watch 列表） */
  async _refreshAllPositions() {
    try {
      const ps = await this._get('/api/v1/user/positions');
      const list = Array.isArray(ps) ? ps : (ps ? [ps] : []);
      const parsed = [];
      for (const p of list) {
        const row = this._parsePosition(p);
        if (!row) continue;
        parsed.push(row);
        if (row.marketId) {
          this._pos.set(row.marketId, {
            sizeBase: row.sizeBase,
            entryPrice: row.entryPrice,
            unrealizedPnl: row.unrealizedPnl,
            leverage: row.leverage,
          });
        }
      }
      parsed.sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd));
      this._allPositions = parsed;
      this._positionsSnapshotAt = Date.now();
      this._positionsSnapshotError = null;
      return { ok: true, at: this._positionsSnapshotAt };
    } catch (e) {
      this._positionsSnapshotError = e.message;
      return { ok: false, error: e.message, at: this._positionsSnapshotAt };
    }
  }

  getAllPositions() {
    return (this._allPositions || []).map((p) => ({ ...p }));
  }

  _parseOpenOrder(o) {
    const market = String(o.market || o.marketName || '');
    const externalId = o.externalId != null ? String(o.externalId) : '';
    // 主键用 externalId；exchange 数字 id 仅作参考（可能已丢精度）
    const id = externalId || String(o.id);
    const tracked = this._tracked.get(id) || (externalId ? this._tracked.get(externalId) : null);
    const sideRaw = String(o.side || '').toUpperCase();
    const side = sideRaw === 'SELL' ? 'sell' : 'buy';
    const price = Number(o.price ?? o.averagePrice ?? 0);
    const qty = Number(o.qty ?? o.size ?? 0);
    const filled = Number(o.filledQty ?? 0);
    return {
      orderId: id,
      // externalId 缺失时不得把 official internal id 伪装成 CID。
      externalId,
      internalId: o.internalId != null ? String(o.internalId) : (o.id != null ? String(o.id) : ''),
      exchangeId: o.id != null ? String(o.id) : '',
      market,
      marketId: this.marketIdForName(market),
      side,
      price,
      sizeBase: qty > 0 ? Math.max(0, qty - filled) : 0,
      reduceOnly: tracked?.reduceOnly ?? !!o.reduceOnly,
      type: String(o.type || 'LIMIT').toUpperCase(),
      status: String(o.status || 'NEW').toUpperCase(),
      levelIndex: tracked?.levelIndex ?? null,
    };
  }

  /** 拉取账户全部未成交挂单（与 Extended 官网 orders 一致） */
  async _refreshAllOpenOrders() {
    try {
      const raw = await this._get('/api/v1/user/orders');
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const open = [];
      for (const o of list) {
        const st = String(o.status || 'NEW').toUpperCase();
        if (/^(FILLED|CANCELLED|REJECTED|EXPIRED)$/.test(st)) continue;
        const row = this._parseOpenOrder(o);
        if (row.market) open.push(row);
      }
      open.sort((a, b) => b.price - a.price);
      this._allOpenOrders = open;
      const openIds = new Set(
        open.flatMap((row) =>
          [row.orderId, row.externalId, row.internalId, row.exchangeId]
            .map((value) => String(value || ''))
            .filter(Boolean)
        )
      );
      const now = Date.now();
      for (const row of open) {
        const t = this._tracked.get(row.orderId);
        if (t) t.seen = true;
      }
      // 交易所快照是最终真相：清除已成交/已撤但本地漏掉事件的 tracked 假活单。
      // 新下单给 30 秒可见性缓冲，避免 API 最终一致性造成误删。
      for (const [orderId, tracked] of this._tracked) {
        if (openIds.has(String(orderId))) continue;
        const staleUnseen = !tracked.placedAt || now - tracked.placedAt > 30_000;
        if (tracked.seen || staleUnseen) {
          const resolved = await this._resolveGone(String(orderId), tracked);
          if (resolved) this._tracked.delete(String(orderId));
        }
      }
      this._ordersSnapshotAt = Date.now();
      this._ordersSnapshotError = null;
      return { ok: true, at: this._ordersSnapshotAt };
    } catch (e) {
      this._ordersSnapshotError = e.message;
      return { ok: false, error: e.message, at: this._ordersSnapshotAt };
    }
  }

  getAllOpenOrders() {
    return (this._allOpenOrders || []).map((o) => ({ ...o }));
  }

  getOpenOrdersForMarket(marketId) {
    const id = Number(marketId);
    const out = this.getAllOpenOrders().filter((o) => o.marketId === id);
    const seen = new Set(out.map((o) => o.orderId));
    for (const [orderId, t] of this._tracked) {
      if (t.marketId !== id || seen.has(orderId)) continue;
      out.push({
        orderId,
        marketId: id,
        side: t.side,
        price: t.price,
        sizeBase: t.sizeBase,
        levelIndex: t.levelIndex ?? null,
        reduceOnly: !!t.reduceOnly,
        type: 'LIMIT',
      });
      seen.add(orderId);
    }
    out.sort((a, b) => b.price - a.price);
    return out;
  }

  /** Close all or a specified part of the position with a reduce-only IOC order. */
  async closePosition(marketId, sizeBase = null, externalId = null) {
    const m = this._market(marketId);
    const p = this._pos.get(m.marketId);
    if (!p || !p.sizeBase) return true;
    const isBuy = p.sizeBase < 0; // closing a short buys back
    const last = this._prices.get(m.marketId) || p.entryPrice;
    const worst = last * (isBuy ? 1.05 : 0.95); // worst accepted price
    const requested = sizeBase == null ? Math.abs(p.sizeBase) : Math.min(Math.abs(Number(sizeBase)), Math.abs(p.sizeBase));
    const qtyStr = alignToStep(requested, m.qtyStep, 'down');
    if (parseDec(qtyStr).i <= 0n) throw new Error('减仓数量低于最小单位');
    const priceStr = alignToStep(worst, m.priceStep, 'nearest');
    const requestedClientOrderId = externalId == null ? null : String(externalId);
    const submitted = await this._submitOrder(m, {
      side: isBuy ? 'buy' : 'sell', qtyStr, priceStr,
      type: 'MARKET', timeInForce: 'IOC', postOnly: false, reduceOnly: true,
      externalId: requestedClientOrderId,
    });
    return {
      requestedClientOrderId,
      submittedExternalId: submitted.externalId,
      exchangeId: submitted.exchangeId,
      exchangeOrderId: submitted.exchangeId,
    };
  }

  // ---------- polling ----------
  start() { if (!this._timer) { this._timer = setInterval(() => this._poll(), this.pollMs); this._timer.unref?.(); } }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _poll() {
    if (this._busy) return; this._busy = true;
    try {
      for (const mId of this._watch) {
        const m = this.markets.get(mId);
        if (!m) continue;
        // price (also emitted for the dashboard)
        this.getPrice(mId).then((px) => { if (px) this.emit('price', { marketId: mId, price: px }); }).catch(() => {});
        // open orders -> fill detection
        let open = null;
        try { open = await this._get(`/api/v1/user/orders?market=${encodeURIComponent(m.name)}`); } catch { /* keep */ }
        if (open) {
          const liveRows = open.filter((o) =>
            !/^(FILLED|CANCELLED|REJECTED|EXPIRED)$/i.test(String(o.status || 'NEW'))
          );
          // _tracked 始终以 caller externalId 为 key；Extended numeric id 仅用于
          // GET /orders/{id}，不得与 externalId 混作同一轮询主键。
          const liveExternalIds = new Set(
            liveRows.map((o) => String(o.externalId ?? '')).filter(Boolean)
          );
          for (const o of open) {
            const externalId = String(o.externalId ?? '');
            const t = externalId ? this._tracked.get(externalId) : null;
            if (!t) continue;
            t.seen = true;
            this._emitFillDelta(externalId, t, o);
          }
          for (const [externalId, t] of [...this._tracked]) {
            if (t.marketId !== mId) continue;
            if (t.seen && !liveExternalIds.has(externalId)) {
              const resolved = await this._resolveGone(externalId, t);
              if (resolved) this._tracked.delete(externalId);
            }
          }
        }
        // position
        try {
          const ps = await this._get(`/api/v1/user/positions?market=${encodeURIComponent(m.name)}`);
          const p = (ps || [])[0];
          if (p && Number(p.size)) {
            const short = String(p.side).toUpperCase() === 'SHORT';
            const size = Math.abs(Number(p.size)) * (short ? -1 : 1);
            this._pos.set(mId, {
              sizeBase: size, entryPrice: Number(p.openPrice),
              unrealizedPnl: Number(p.unrealisedPnl ?? 0),
              leverage: p.leverage != null ? Number(p.leverage) : null,
            });
          } else { this._pos.delete(mId); }
        } catch { /* keep last */ }
      }
      const now = Date.now();
      if (now - this._lastAccountPollAt >= 30_000) {
        this._lastAccountPollAt = now;
        await this._refreshAccount().catch(() => {});
      }
      if (now - this._lastAllPositionsPollAt >= 30_000) {
        this._lastAllPositionsPollAt = now;
        await this._refreshAllPositions().catch(() => {});
      }
      if (now - this._lastAllOrdersPollAt >= 30_000) {
        this._lastAllOrdersPollAt = now;
        await this._refreshAllOpenOrders().catch(() => {});
      }
      this._refreshOfficialStats().catch(() => {});
    } catch (e) { this.emit('error', e); }
    finally { this._busy = false; }
  }

  /** A tracked order disappeared from the book: filled or cancelled? */
  async _resolveGone(externalId, t) {
    try {
      let rows = await this._get(
        `/api/v1/user/orders/external/${encodeURIComponent(externalId)}`
      );
      rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
      if (!rows.length) {
        const qs = new URLSearchParams({ externalId, limit: '20' });
        const history = await this._req(
          'GET',
          `/api/v1/user/orders/history?${qs}`,
          undefined,
          { full: true }
        );
        rows = Array.isArray(history?.data) ? history.data : [];
      }
      const o = rows.find((row) => String(row?.externalId ?? '') === externalId);
      if (!o) return false;
      const emitted = this._emitFillDelta(externalId, t, o);
      const status = String(o?.status || '').toUpperCase();
      if (!emitted && /^(CANCELLED|REJECTED|EXPIRED)$/.test(status)) {
        this.emit('cancel', {
          orderId: externalId,
          externalId,
          exchangeId: o?.id != null ? String(o.id) : '',
          marketId: t.marketId,
        });
      } else if (!emitted && status !== 'FILLED') {
        this.emit('orderUnknown', {
          orderId: externalId,
          externalId,
          exchangeId: o?.id != null ? String(o.id) : '',
          marketId: t.marketId,
          status,
        });
      }
      return /^(FILLED|CANCELLED|REJECTED|EXPIRED)$/.test(status);
    } catch (e) {
      // 查询失败不是成交证据：保留为 unknown，禁止补反向单。
      this.emit('orderUnknown', {
        orderId: externalId,
        externalId,
        marketId: t.marketId,
        error: e.message,
      });
      return false;
    }
  }

  _emitFillDelta(id, tracked, official) {
    const totalFilled = Math.max(0, Number(official?.filledQty || 0));
    const previous = Math.max(0, Number(tracked.emittedFilledQty || 0));
    const delta = totalFilled - previous;
    if (!(delta > 1e-12)) return false;
    tracked.emittedFilledQty = totalFilled;
    this.emit('fill', {
      orderId: id,
      fillKey: `${id}:${totalFilled}`,
      marketId: tracked.marketId,
      side: tracked.side,
      price: Number(official?.averagePrice || tracked.price),
      sizeBase: delta,
      filledQty: totalFilled,
      levelIndex: tracked.levelIndex,
      partial: totalFilled + 1e-12 < Number(official?.qty || tracked.sizeBase),
    });
    return true;
  }

  getSourceFreshness(staleMs = 15_000) {
    const now = Date.now();
    return {
      orders: {
        updatedAt: this._ordersSnapshotAt,
        stale: !this._ordersSnapshotAt || now - this._ordersSnapshotAt > staleMs,
        error: this._ordersSnapshotError,
        source: 'official',
      },
      positions: {
        updatedAt: this._positionsSnapshotAt,
        stale: !this._positionsSnapshotAt || now - this._positionsSnapshotAt > staleMs,
        error: this._positionsSnapshotError,
        source: 'official',
      },
      account: {
        updatedAt: this._balanceRefreshAt,
        stale: !this._balanceRefreshAt || now - this._balanceRefreshAt > staleMs,
        error: this._balanceRefreshError,
        source: 'official',
      },
    };
  }

  _num(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  /** 官网「余额」页与 GET /user/spot/balances 对齐 */
  _mergeSpotBalances(spotRows) {
    if (!Array.isArray(spotRows) || !spotRows.length) return null;
    let wallet = null;
    let equitySum = 0;
    let equityAny = false;
    let withdraw = null;
    for (const row of spotRows) {
      const contrib = this._num(row.equityContribution);
      if (contrib != null) {
        equitySum += contrib;
        equityAny = true;
      }
      const asset = String(row.asset ?? row.collateralName ?? '').toUpperCase();
      const isCollateral = asset === 'USDC' || asset === 'USD' || asset === 'USDT';
      if (isCollateral) {
        wallet = this._num(row.balance) ?? wallet;
        withdraw = this._num(row.availableToWithdraw) ?? withdraw;
      }
    }
    return {
      wallet,
      equity: equityAny ? equitySum : null,
      availableForWithdrawal: withdraw,
    };
  }

  async _refreshAccount() {
    this._balanceRefreshError = null;
    try {
      const accountId = await this._ensureAccountId();
      const b = await this._get('/api/v1/user/balance');

      let spotMerged = null;
      try {
        const qs = accountId != null ? `?accountId=${accountId}` : '';
        const spotRows = await this._get(`/api/v1/user/spot/balances${qs}`);
        spotMerged = this._mergeSpotBalances(spotRows);
      } catch (e) {
        this._balanceRefreshError = `spot/balances: ${e.message}`;
      }

      if (b) {
        this.balance = this._num(b.balance);
        this.equity = this._num(b.equity);
        this.unrealisedPnl = this._num(b.unrealisedPnl ?? b.unrealizedPnl) ?? 0;
        this.availableForTrade = this._num(b.availableForTrade);
        this.availableForWithdrawal = this._num(b.availableForWithdrawal);
        this.initialMargin = this._num(b.initialMargin);
        this.spotEquity = this._num(b.spotEquity);
      }

      // 与 Extended 文档 + 官网余额页：spot/balances 的 equityContribution 之和、USDC balance 为钱包余额
      if (spotMerged?.wallet != null) this.balance = spotMerged.wallet;
      if (spotMerged?.equity != null && this.equity == null) this.equity = spotMerged.equity;
      if (spotMerged?.availableForWithdrawal != null) {
        this.availableForWithdrawal = spotMerged.availableForWithdrawal;
      }

      const apiEq = b ? this._num(b.equity) : null;
      if (apiEq != null) {
        if (this.equity == null || apiEq > this.equity) this.equity = apiEq;
      }
      if (this.availableForTrade == null && this.balance != null) {
        this.availableForTrade = this.balance;
      }
      this._balanceRefreshAt = Date.now();
    } catch (e) {
      if (/401/.test(e.message)) throw e;
      if (/404/.test(e.message)) {
        this.balance = 0;
        this.equity = 0;
      } else {
        this._balanceRefreshError = e.message;
      }
    }
  }

  /** Extended 官网「交易表现」累计 PnL（portfolio charts，与 app 一致） */
  async _ensureAccountId() {
    if (this._accountId != null) return this._accountId;
    try {
      const info = await this._get('/api/v1/user/account/info');
      if (info?.accountId != null) {
        this._accountId = Number(info.accountId);
        return this._accountId;
      }
    } catch { /* retry via accounts list */ }
    try {
      const list = await this._get('/api/v1/user/accounts');
      const accounts = Array.isArray(list) ? list : [];
      const byVault = accounts.find((a) => Number(a.l2Vault) === this.vault);
      const pick = byVault ?? accounts[0];
      if (pick?.accountId != null) {
        this._accountId = Number(pick.accountId);
        return this._accountId;
      }
    } catch { /* keep null */ }
    return null;
  }

  _parsePortfolioValue(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  _filterPortfolioRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    const since = this.pnlSinceDate;
    if (!since) return rows;
    return rows.filter((r) => r.date >= since);
  }

  _sumPortfolioSeries(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    let sum = 0;
    for (const r of rows) {
      const v = this._parsePortfolioValue(r?.value);
      if (v != null) sum += v;
    }
    return Math.round(sum * 1e6) / 1e6;
  }

  /** Extended portfolio 曲线：interval=ALL 时每行是当日盈亏，累计 = 各行求和（与官网交易表现一致） */
  async _fetchPortfolioPnlSeries(pnlType, interval = 'ALL') {
    const accountId = await this._ensureAccountId();
    if (accountId == null) return [];
    const qs = new URLSearchParams({
      accountId: String(accountId),
      interval,
      pnlType,
    });
    const j = await this._req('GET', `/api/v1/portfolio/charts/pnl?${qs}`, undefined, { full: true });
    return Array.isArray(j?.data) ? j.data : [];
  }

  async _fetchPortfolioPnlLatest(pnlType) {
    const rows = await this._fetchPortfolioPnlSeries(pnlType);
    if (!rows.length) return null;
    return this._sumPortfolioSeries(rows);
  }

  _statsMarketNamesExpanded(base = this.statsMarketNames) {
    const fromPos = (this._allPositions || []).map((p) => p.market);
    return [...new Set([...(base || []), ...fromPos])];
  }

  /** 总成交量：扫全所 listed 市场（与仅 BTC/ETH/SOL 的 bot 槽不同） */
  _volumeScanMarketNames() {
    const listed = [...(this.markets?.values() || [])].map((m) => m.name).filter(Boolean);
    const expanded = this._statsMarketNamesExpanded();
    return [...new Set([...listed, ...expanded])];
  }

  /** Extended 官网口径：交易表现 portfolio + positions/history 明细 */
  async _refreshOfficialStats(marketNames = this.statsMarketNames) {
    const curEquity = typeof this.equity === 'number' ? this.equity : null;
    const cache = this._statsCache;
    const equityJump = cache?.equity != null && curEquity != null && Math.abs(curEquity - cache.equity) >= 1;
    if (cache && Date.now() - cache.ts < 120_000 && !equityJump) return cache;
    await this._refreshAllPositions().catch(() => {});
    const scanMarkets = this._statsMarketNamesExpanded(marketNames);
    const volumeMarkets = this._volumeScanMarketNames();
    let feesPaid = 0;
    let volume = 0;
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const dayStartMs = new Date(`${dayKey}T00:00:00+08:00`).getTime();
    let todayVolume = 0;
    const byMarket = {};
    try {
      const trades = await this.fetchAllTrades(volumeMarkets);
      const officialFills = [];
      for (const t of trades) {
        feesPaid += Number(t.fee || 0);
        const val = Math.abs(Number(t.value || 0));
        volume += val;
        const f = this._parseOfficialTrade(t);
        if (f) {
          officialFills.push(f);
          if (f.t >= dayStartMs) todayVolume += f.value || val;
        }
      }
      officialFills.sort((a, b) => b.t - a.t);
      // 只保留当日明细，避免长跑把全历史成交堆在堆上（曾导致 ~4GB OOM）
      this._officialFills = officialFills.filter((f) => f.t >= dayStartMs).slice(0, 2500);
    } catch { /* keep */ }

    let historyRealized = 0;
    let openRealized = 0;
    let positionFees = 0;
    const closed = [];
    try {
      openRealized = (this._allPositions || []).reduce((s, p) => s + (p.realizedPnl || 0), 0);
    } catch { /* keep */ }
    try {
      const rows = await this.fetchAllClosedPositions();
      for (const p of rows) {
        historyRealized += p.realizedPnl;
        positionFees += p.fees;
        if (!byMarket[p.market]) byMarket[p.market] = { realizedPnl: 0, fees: 0, count: 0 };
        byMarket[p.market].realizedPnl += p.realizedPnl;
        byMarket[p.market].fees += p.fees;
        byMarket[p.market].count++;
      }
      closed.push(...rows);
    } catch { /* keep */ }
    const accountRealized = historyRealized + openRealized;

    let portfolioTotalSeries = [];
    let portfolioRealizedSeries = [];
    let portfolioTotalPnl = null;
    let portfolioRealizedPnl = null;
    try {
      portfolioTotalSeries = await this._fetchPortfolioPnlSeries('TOTAL_PNL');
      portfolioRealizedSeries = await this._fetchPortfolioPnlSeries('REALISED_PNL');
      portfolioTotalPnl = this._sumPortfolioSeries(this._filterPortfolioRows(portfolioTotalSeries));
      portfolioRealizedPnl = this._sumPortfolioSeries(this._filterPortfolioRows(portfolioRealizedSeries));
    } catch { /* keep */ }

    this._statsCache = {
      ts: Date.now(),
      equity: curEquity,
      realizedPnl: accountRealized,
      historyRealized,
      openRealized,
      // 序列只用于求和，缓存里不留大数组
      portfolioTotalSeries: [],
      portfolioRealizedSeries: [],
      portfolioTotalPnl,
      portfolioRealizedPnl,
      feesPaid,
      positionFees,
      volume,
      todayVolume: Math.round(todayVolume * 100) / 100,
      byMarket,
      allClosed: closed.slice(0, 50),
      recentClosed: closed.slice(0, 50),
      officialFills: this._officialFills || [],
    };
    portfolioTotalSeries.length = 0;
    portfolioRealizedSeries.length = 0;
    closed.length = 0;
    return this._statsCache;
  }

  _parseOfficialTrade(t) {
    if (!t || typeof t !== 'object') return null;
    const market = String(t.market ?? t.marketName ?? '');
    let tRaw = Number(t.createdAt ?? t.createdTime ?? t.timestamp ?? t.time ?? t.T ?? 0);
    if (tRaw > 0 && tRaw < 1e12) tRaw *= 1000;
    const price = Number(t.price ?? 0);
    const size = Math.abs(Number(t.size ?? t.qty ?? t.quantity ?? 0));
    const value = Math.abs(Number(t.value || 0)) || (price > 0 && size > 0 ? price * size : 0);
    if (!(tRaw > 0 && value > 0)) return null;
    const sideRaw = String(t.side ?? '').toLowerCase();
    const side = sideRaw.includes('sell') || sideRaw === '1' ? 'sell' : 'buy';
    return {
      id: String(t.id ?? t.tradeId ?? `${market}-${tRaw}-${value}`),
      market,
      marketId: this.marketIdForName(market),
      side,
      price,
      size,
      fee: Number(t.fee || 0),
      realizedPnl: Number(t.realisedPnl ?? t.realizedPnl ?? 0),
      t: tRaw,
      value,
    };
  }

  getOfficialFills(limit = 80, sinceMs = 0) {
    const filtered = this.getOfficialFillsSince(sinceMs);
    return filtered.slice(0, limit);
  }

  /** 当日/指定时刻起的全部成交流水（不截断，供成交量与平仓数同一口径） */
  getOfficialFillsSince(sinceMs = 0) {
    const fills = this._statsCache?.officialFills || this._officialFills || [];
    return sinceMs > 0 ? fills.filter((f) => f.t >= sinceMs) : fills;
  }

  /** 与官网成交流一致：先数带 realized 的成交，否则数当日全部成交（positions/history 条数过粗） */
  countTodayCloseTrades(sinceMs) {
    const today = this.getOfficialFillsSince(sinceMs);
    const withRealized = today.filter((f) => Math.abs(f.realizedPnl || 0) > 1e-9);
    if (withRealized.length > 0) return withRealized.length;
    const closedAll = this._statsCache?.allClosed || this._statsCache?.recentClosed || [];
    return closedAll.filter((p) => {
      let ct = Number(p.closedTime || 0);
      if (ct > 0 && ct < 1e12) ct *= 1000;
      return ct >= sinceMs;
    }).length;
  }

  getOfficialStats() {
    if (!this._statsCache) return null;
    const s = this._statsCache;
    const unrealizedPnl = typeof this.unrealisedPnl === 'number' ? this.unrealisedPnl : null;

    // 官网交易表现：portfolio 每日盈亏求和（勿取最后一天、勿用平仓历史加总）
    let totalPnl = s.portfolioTotalPnl;
    let realizedPnl = s.portfolioRealizedPnl;
    let pnlSource = 'portfolio';

    if (totalPnl == null && realizedPnl != null && unrealizedPnl != null) {
      totalPnl = Math.round((realizedPnl + unrealizedPnl) * 100) / 100;
    }
    if (totalPnl == null && realizedPnl != null) totalPnl = realizedPnl;
    if (realizedPnl == null && totalPnl != null && unrealizedPnl != null) {
      realizedPnl = Math.round((totalPnl - unrealizedPnl) * 100) / 100;
    } else if (totalPnl != null && unrealizedPnl != null) {
      realizedPnl = Math.round((totalPnl - unrealizedPnl) * 100) / 100;
    }

    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const dayStartMs = new Date(`${dayKey}T00:00:00+08:00`).getTime();
    const closedAll = s.allClosed || s.recentClosed || [];
    const todayCloseCount = this.countTodayCloseTrades(dayStartMs);

    return {
      realizedPnl,
      unrealizedPnl,
      totalPnl,
      portfolioTotalPnl: s.portfolioTotalPnl,
      portfolioRealizedPnl: s.portfolioRealizedPnl,
      pnlSource,
      feesPaid: s.feesPaid,
      positionFees: s.positionFees,
      volume: s.volume,
      statsWindow: '全账户成交名义(trades API·全市场，单市场约近300笔)',
      volumeSource: 'trades-all-markets',
      byMarket: s.byMarket,
      allClosed: closedAll,
      recentClosed: s.recentClosed,
      todayCloseCount,
      updatedAt: s.ts,
    };
  }

  /** @deprecated use getOfficialStats */
  getTradeStats() {
    const o = this.getOfficialStats();
    if (!o) return null;
    return { fees: o.feesPaid, volume: o.volume };
  }
}
