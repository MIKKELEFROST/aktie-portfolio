// Falsk Yahoo-klient til udvikling og test (YAHOO_MOCK=1).
// Samme interface som createYahooClient(), men med faste, deterministiske data.

import { YahooError, describeError } from './yahoo.js';

const FIXTURES = {
  'NOVO-B.CO': { name: 'Novo Nordisk A/S', shortName: 'Novo Nordisk B A/S', currency: 'DKK', price: 291.0, previousClose: 292.0, exchange: 'Copenhagen', tz: 'Europe/Copenhagen', open: [9, 17] },
  'MAERSK-B.CO': { name: 'A.P. Møller - Mærsk A/S', shortName: 'Mærsk B', currency: 'DKK', price: 12140, previousClose: 12010, exchange: 'Copenhagen', tz: 'Europe/Copenhagen', open: [9, 17] },
  'DSV.CO': { name: 'DSV A/S', shortName: 'DSV', currency: 'DKK', price: 1512.5, previousClose: 1498, exchange: 'Copenhagen', tz: 'Europe/Copenhagen', open: [9, 17] },
  AAPL: { name: 'Apple Inc.', shortName: 'Apple', currency: 'USD', price: 316.3, previousClose: 316.22, exchange: 'NasdaqGS', tz: 'America/New_York', open: [9.5, 16] },
  MSFT: { name: 'Microsoft Corporation', shortName: 'Microsoft', currency: 'USD', price: 512.1, previousClose: 520.4, exchange: 'NasdaqGS', tz: 'America/New_York', open: [9.5, 16] },
  'ASML.AS': { name: 'ASML Holding N.V.', shortName: 'ASML', currency: 'EUR', price: 842.2, previousClose: 830.0, exchange: 'Amsterdam', tz: 'Europe/Amsterdam', open: [9, 17.5] },
  'SHEL.L': { name: 'Shell plc', shortName: 'Shell', currency: 'GBp', price: 3536, previousClose: 3500.5, exchange: 'LSE', tz: 'Europe/London', open: [8, 16.5] },
  'EUNL.DE': { name: 'iShares Core MSCI World UCITS ETF USD (Acc)', shortName: 'iShares Core MSCI World', currency: 'EUR', price: 126.16, previousClose: 125.4, exchange: 'XETRA', tz: 'Europe/Berlin', open: [9, 17.5], type: 'ETF' },
  'DOWN.CO': { name: 'Altid Nede A/S', currency: 'DKK', price: 100, previousClose: 100, exchange: 'Copenhagen', tz: 'Europe/Copenhagen', open: [9, 17], fail: 'always' },
  'STALE.CO': { name: 'Første Gang OK A/S', currency: 'DKK', price: 50, previousClose: 49, exchange: 'Copenhagen', tz: 'Europe/Copenhagen', open: [9, 17], fail: 'after-first' },
};

const FX = { USDDKK: 6.42, EURDKK: 7.46, GBPDKK: 8.7, SEKDKK: 0.68, NOKDKK: 0.63, CHFDKK: 8.1, USDEUR: 0.86, GBPEUR: 1.17, DKKEUR: 0.134, EURUSD: 1.16, DKKUSD: 0.156, GBPUSD: 1.36 };

const MINOR = { GBp: 'GBP', GBX: 'GBP' };

function hourInZone(tz, now) {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false, timeZone: tz }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekend = ['Sat', 'Sun'].includes(get('weekday'));
  return { hour: Number(get('hour')) + Number(get('minute')) / 60, weekend };
}

export function createMockYahooClient({ now = () => new Date() } = {}) {
  const calls = new Map();

  function quoteFor(symbol) {
    const f = FIXTURES[symbol];
    if (!f) throw new YahooError(`Ukendt symbol: ${symbol}`, { status: 404, symbol, code: 'NOT_FOUND' });
    const n = (calls.get(symbol) || 0) + 1;
    calls.set(symbol, n);
    if (f.fail === 'always' || (f.fail === 'after-first' && n > 1)) {
      throw new YahooError('Kunne ikke kontakte Yahoo Finance: mock-fejl', { symbol, code: 'NETWORK' });
    }
    const currency = MINOR[f.currency] || f.currency;
    const div = MINOR[f.currency] ? 100 : 1;
    const price = f.price / div;
    const prev = f.previousClose / div;
    const { hour, weekend } = hourInZone(f.tz, now());
    return {
      symbol,
      name: f.name,
      shortName: f.shortName || f.name,
      currency,
      rawCurrency: f.currency,
      price,
      previousClose: prev,
      change: price - prev,
      changePercent: ((price - prev) / prev) * 100,
      dayHigh: price * 1.01,
      dayLow: price * 0.99,
      fiftyTwoWeekHigh: price * 1.4,
      fiftyTwoWeekLow: price * 0.75,
      exchange: f.exchange,
      exchangeCode: f.exchange.slice(0, 3).toUpperCase(),
      type: f.type || 'EQUITY',
      timezone: f.tz,
      marketTime: now().toISOString(),
      marketOpen: !weekend && hour >= f.open[0] && hour < f.open[1],
      fetchedAt: now().toISOString(),
    };
  }

  const lastGood = new Map();

  return {
    async getQuote(symbol) {
      const q = quoteFor(symbol.toUpperCase());
      lastGood.set(q.symbol, q);
      return q;
    },
    async getQuotes(symbols) {
      const out = {};
      for (const s of new Set(symbols.map((x) => x.toUpperCase()))) {
        try {
          out[s] = { ok: true, quote: await this.getQuote(s), stale: false };
        } catch (err) {
          out[s] = lastGood.has(s) ? { ok: true, quote: { ...lastGood.get(s), marketOpen: null }, stale: true, error: describeError(err) } : { ok: false, error: describeError(err) };
        }
      }
      return out;
    },
    async getFxRate(from, to) {
      const f = from.toUpperCase();
      const t = to.toUpperCase();
      if (f === t) return 1;
      if (FX[`${f}${t}`]) return FX[`${f}${t}`];
      if (FX[`${t}${f}`]) return 1 / FX[`${t}${f}`];
      throw new YahooError(`Ingen valutakurs for ${f}/${t}`, { code: 'NOT_FOUND', status: 404 });
    },
    async getFxRates(currencies, base) {
      const out = {};
      for (const c of new Set(currencies.map((x) => x.toUpperCase()))) {
        try {
          out[c] = { ok: true, rate: await this.getFxRate(c, base) };
        } catch (err) {
          out[c] = { ok: false, error: describeError(err) };
        }
      }
      return out;
    },
    async search(query) {
      const q = query.trim().toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'aa');
      if (!q) return [];
      return Object.entries(FIXTURES)
        .filter(([sym, f]) => !f.fail && (sym.toLowerCase().includes(q) || f.name.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'aa').includes(q)))
        .map(([symbol, f]) => ({ symbol, name: f.name, exchange: f.exchange, type: f.type || 'EQUITY' }));
    },
    async getHistory(symbol, range = '1y') {
      const s = symbol.toUpperCase();
      const f = FIXTURES[s];
      if (!f || f.fail === 'always') throw new YahooError(`Ukendt symbol: ${s}`, { status: 404, symbol: s, code: 'NOT_FOUND' });
      const days = { '5d': 5, '1mo': 22, '3mo': 65, '6mo': 130, ytd: 180, '1y': 252, '2y': 504, '5y': 260, max: 520 }[range] || 252;
      const step = range === '5y' || range === 'max' ? 7 : 1;
      const div = MINOR[f.currency] ? 100 : 1;
      let end = now().getTime();
      if (step === 7) {
        const d = new Date(end);
        d.setUTCHours(8, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // seneste mandag
        end = d.getTime();
      }
      const points = [];
      let seed = s.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
      let value = (f.price / div) * 0.8;
      for (let i = days - 1; i >= 0; i--) {
        seed = (seed * 9301 + 49297) % 233280;
        const drift = ((seed / 233280) - 0.48) * 0.03;
        value = Math.max(0.01, value * (1 + drift));
        const t = end - i * step * 86_400_000;
        const day = new Date(t).getUTCDay();
        if (step === 1 && (day === 0 || day === 6)) continue;
        points.push({ t, close: i === 0 ? f.price / div : value });
      }
      return { symbol: s, currency: MINOR[f.currency] || f.currency, range, points };
    },
  };
}
