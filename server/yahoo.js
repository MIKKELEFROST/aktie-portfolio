// Yahoo Finance-klient (uofficielle endpoints) med cache, timeout og
// samtidigheds-begrænsning. Ingen eksterne afhængigheder.
//
// Bemærk: Yahoo har ikke et officielt, offentligt API. Endpoints herunder er
// dem Yahoo Finance-hjemmesiden selv bruger. De kræver en browser-lignende
// User-Agent, ellers svarer Yahoo 429.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SEARCH_URL = 'https://query2.finance.yahoo.com/v1/finance/search';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 4;

// Valutaer Yahoo noterer i "under-enheder" (pence, cents, agorot).
// Kursen deles med 100 og valutaen normaliseres til hovedenheden.
const MINOR_UNIT_CURRENCIES = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };

export class YahooError extends Error {
  constructor(message, { status = 0, symbol = null, code = 'YAHOO_ERROR' } = {}) {
    super(message);
    this.name = 'YahooError';
    this.status = status;
    this.symbol = symbol;
    this.code = code;
  }
}

// ---------- lille cache med TTL + dedup af igangværende kald ----------

class TtlCache {
  constructor({ maxEntries = 500 } = {}) {
    this.map = new Map();
    this.inflight = new Map();
    this.maxEntries = maxEntries;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    return { value: hit.value, fresh: Date.now() < hit.expires, fetchedAt: hit.fetchedAt };
  }

  set(key, value, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs, fetchedAt: Date.now() });
    // Begrænset størrelse: smid de ældste ud, så cachen ikke vokser uendeligt.
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
  }

  // Kør `fn` højst én gang ad gangen pr. nøgle; genbrug friskt cache-hit (medmindre `refresh`).
  async through(key, ttlMs, fn, { refresh = false } = {}) {
    const hit = this.get(key);
    if (hit && hit.fresh && !refresh) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

// ---------- samtidigheds-begrænsning ----------

let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryStart = () => {
      if (active < MAX_CONCURRENT) {
        active++;
        resolve();
      } else {
        queue.push(tryStart);
      }
    };
    tryStart();
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) next();
}

async function fetchJson(url, { symbol = null } = {}) {
  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      throw new YahooError(timedOut ? 'Yahoo Finance svarede ikke i tide' : `Kunne ikke kontakte Yahoo Finance: ${err.message}`, {
        symbol,
        code: timedOut ? 'TIMEOUT' : 'NETWORK',
      });
    }
    if (res.status === 404) {
      throw new YahooError(`Ukendt symbol: ${symbol ?? url}`, { status: 404, symbol, code: 'NOT_FOUND' });
    }
    if (res.status === 429) {
      throw new YahooError('Yahoo Finance afviser midlertidigt forespørgsler (for mange kald)', {
        status: 429,
        symbol,
        code: 'RATE_LIMITED',
      });
    }
    if (!res.ok) {
      throw new YahooError(`Yahoo Finance svarede HTTP ${res.status}`, { status: res.status, symbol, code: 'HTTP' });
    }
    try {
      return await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw new YahooError('Yahoo Finance svarede ikke i tide', { symbol, code: 'TIMEOUT' });
      throw new YahooError('Uventet svar fra Yahoo Finance', { symbol, code: 'BAD_RESPONSE' });
    }
  } finally {
    clearTimeout(timer);
    release();
  }
}

// ---------- normalisering ----------

function normalizeMinorUnit(currency, values) {
  const major = MINOR_UNIT_CURRENCIES[currency];
  if (!major) return { currency, values };
  const scaled = {};
  for (const [k, v] of Object.entries(values)) scaled[k] = typeof v === 'number' ? v / 100 : v;
  return { currency: major, values: scaled };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function normalizeChartMeta(meta, nowSeconds = Math.floor(Date.now() / 1000)) {
  const raw = {
    price: num(meta.regularMarketPrice),
    previousClose: num(meta.chartPreviousClose ?? meta.previousClose),
    dayHigh: num(meta.regularMarketDayHigh),
    dayLow: num(meta.regularMarketDayLow),
    fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(meta.fiftyTwoWeekLow),
  };
  const { currency, values } = normalizeMinorUnit(meta.currency, raw);
  const price = values.price;
  const prev = values.previousClose;
  const change = price != null && prev != null ? price - prev : null;
  const changePercent =
    change != null && prev ? (change / prev) * 100 : num(meta.regularMarketChangePercent);

  const regular = meta.currentTradingPeriod?.regular;
  const marketOpen =
    regular && typeof regular.start === 'number' && typeof regular.end === 'number'
      ? nowSeconds >= regular.start && nowSeconds < regular.end
      : null;

  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    shortName: meta.shortName || meta.longName || meta.symbol,
    currency,
    rawCurrency: meta.currency,
    price,
    previousClose: prev,
    change,
    changePercent,
    dayHigh: values.dayHigh,
    dayLow: values.dayLow,
    fiftyTwoWeekHigh: values.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: values.fiftyTwoWeekLow,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    exchangeCode: meta.exchangeName || null,
    type: meta.instrumentType || null,
    timezone: meta.exchangeTimezoneName || meta.timezone || null,
    marketTime: typeof meta.regularMarketTime === 'number' ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    marketOpen,
  };
}

// ---------- offentligt API ----------

const quoteCache = new TtlCache({ maxEntries: 500 });
const fxCache = new TtlCache({ maxEntries: 100 });
const searchCache = new TtlCache({ maxEntries: 300 });
const historyCache = new TtlCache({ maxEntries: 200 });

const FX_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 10 * 60_000;
const HISTORY_TTL_MS = 15 * 60_000;

export function createYahooClient({ quoteTtlMs = 60_000 } = {}) {
  async function fetchChart(symbol, range = '1d', interval = '1d') {
    const url = `${CHART_URL}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const json = await fetchJson(url, { symbol });
    const result = json?.chart?.result?.[0];
    if (!result) {
      const desc = json?.chart?.error?.description || 'Intet svar fra Yahoo Finance';
      throw new YahooError(`${symbol}: ${desc}`, { symbol, code: 'NOT_FOUND', status: 404 });
    }
    return result;
  }

  async function getQuote(symbol, { refresh = false } = {}) {
    const key = symbol.toUpperCase();
    return quoteCache.through(key, quoteTtlMs, async () => {
      const result = await fetchChart(symbol);
      return { ...normalizeChartMeta(result.meta), fetchedAt: new Date().toISOString() };
    }, { refresh });
  }

  // Henter flere kurser. Fejler aldrig som helhed: hver post er enten
  // { ok: true, quote, stale } eller { ok: false, error, quote? (sidst kendte) }.
  // En forældet kurs får marketOpen: null – vi ved ikke længere, om børsen er åben.
  async function getQuotes(symbols, { refresh = false } = {}) {
    const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
    const entries = await Promise.all(
      unique.map(async (symbol) => {
        try {
          const quote = await getQuote(symbol, { refresh });
          return [symbol, { ok: true, quote, stale: false }];
        } catch (err) {
          const cached = quoteCache.get(symbol);
          if (cached) {
            return [symbol, { ok: true, quote: { ...cached.value, marketOpen: null }, stale: true, error: describeError(err) }];
          }
          return [symbol, { ok: false, error: describeError(err) }];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  // Kurs på 1 enhed `from` i `to`. Prøver FROMTO=X, dernæst inverteret TOFROM=X.
  async function getFxRate(from, to) {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return 1;
    return fxCache.through(`${f}${t}`, FX_TTL_MS, async () => {
      try {
        const result = await fetchChart(`${f}${t}=X`);
        const rate = num(result.meta.regularMarketPrice);
        if (rate) return rate;
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err;
      }
      const inverse = await fetchChart(`${t}${f}=X`);
      const inv = num(inverse.meta.regularMarketPrice);
      if (!inv) throw new YahooError(`Ingen valutakurs for ${f}/${t}`, { code: 'NOT_FOUND', status: 404 });
      return 1 / inv;
    });
  }

  // Alle kurser til `base` for de givne valutaer. Fejl pr. valuta returneres i stedet for at kastes.
  async function getFxRates(currencies, base) {
    const unique = [...new Set(currencies.map((c) => c.toUpperCase()))];
    const entries = await Promise.all(
      unique.map(async (cur) => {
        try {
          return [cur, { ok: true, rate: await getFxRate(cur, base) }];
        } catch (err) {
          const cached = fxCache.get(`${cur}${base.toUpperCase()}`);
          if (cached) return [cur, { ok: true, rate: cached.value, stale: true }];
          return [cur, { ok: false, error: describeError(err) }];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  const ALLOWED_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);

  async function searchOnce(q) {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
    const json = await fetchJson(url);
    const quotes = Array.isArray(json?.quotes) ? json.quotes : [];
    return quotes
      .filter((x) => x.symbol && ALLOWED_TYPES.has(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || null,
        type: x.quoteType,
      }));
  }

  // Yahoo håndterer æ/ø/å dårligt ("mærsk" finder ikke Mærsk). Vi søger derfor
  // også på en translittereret udgave og fletter resultaterne (translittereret først).
  async function search(query) {
    const q = query.trim();
    if (!q) return [];
    return searchCache.through(q.toLowerCase(), SEARCH_TTL_MS, async () => {
      const ascii = transliterate(q);
      const variants = ascii !== q ? [ascii, q] : [q];
      let lastError = null;
      const lists = await Promise.all(variants.map((v) => searchOnce(v).catch((err) => { lastError = err; return null; })));
      if (lists.every((l) => l === null)) throw lastError; // fejl må ikke caches som "ingen resultater"
      const seen = new Set();
      const merged = [];
      for (const list of lists) {
        if (!list) continue;
        for (const item of list) {
          if (seen.has(item.symbol)) continue;
          seen.add(item.symbol);
          merged.push(item);
        }
      }
      // Yahoo finder ofte ikke et præcist symbol med børs-suffiks ("BP.L"), men finder det
      // på grunddelen ("BP"). Prøv det og sæt det præcise match øverst.
      const exact = q.toUpperCase();
      if (!seen.has(exact) && /^[A-Z0-9^-]+\.[A-Z]{1,4}$/i.test(q)) {
        const extra = await searchOnce(q.split('.')[0]).catch(() => []);
        const hit = extra.find((r) => r.symbol === exact);
        if (hit) merged.unshift(hit);
      }
      return merged.slice(0, 10);
    });
  }

  const VALID_RANGES = new Set(['5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', 'max']);

  // Daglige lukkekurser. null-lukkekurser (helligdage m.m.) springes over.
  async function getHistory(symbol, range = '1y') {
    if (!VALID_RANGES.has(range)) range = '1y';
    const key = `${symbol.toUpperCase()}:${range}`;
    return historyCache.through(key, HISTORY_TTL_MS, async () => {
      const interval = range === '5d' ? '1d' : range === '5y' || range === 'max' ? '1wk' : '1d';
      const result = await fetchChart(symbol, range, interval);
      const meta = normalizeChartMeta(result.meta);
      const divisor = MINOR_UNIT_CURRENCIES[result.meta.currency] ? 100 : 1;
      const ts = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const points = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === 'number' && Number.isFinite(c)) {
          points.push({ t: interval === '1wk' ? weekStart(ts[i] * 1000) : ts[i] * 1000, close: c / divisor });
        }
      }
      return { symbol: meta.symbol, currency: meta.currency, range, points };
    });
  }

  // Historiske valutakurser, så en gammel dags værdi omregnes med dagens egen kurs
  // og ikke med kursen i dag. Uden det viser grafen kursbevægelsen, ikke kroneværdien.
  async function getFxHistory(from, to, range = '1y') {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return { points: [], identity: true };
    if (!VALID_RANGES.has(range)) range = '1y';
    return historyCache.through(`fx:${f}${t}:${range}`, HISTORY_TTL_MS, async () => {
      const interval = range === '5d' ? '1d' : range === '5y' || range === 'max' ? '1wk' : '1d';
      const read = (result, invert) => {
        const ts = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const points = [];
        for (let i = 0; i < ts.length; i++) {
          const c = closes[i];
          if (typeof c === 'number' && Number.isFinite(c) && c !== 0) {
            points.push({ t: interval === '1wk' ? weekStart(ts[i] * 1000) : ts[i] * 1000, rate: invert ? 1 / c : c });
          }
        }
        return points;
      };
      try {
        const points = read(await fetchChart(`${f}${t}=X`, range, interval), false);
        if (points.length) return { points };
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err;
      }
      return { points: read(await fetchChart(`${t}${f}=X`, range, interval), true) };
    });
  }

  // Én serie pr. valuta. Fejler en enkelt, falder den tilbage til dagens faste kurs.
  async function getFxHistories(currencies, base, range) {
    const unique = [...new Set(currencies.map((c) => c.toUpperCase()))];
    const entries = await Promise.all(
      unique.map(async (cur) => {
        try {
          return [cur, { ok: true, ...(await getFxHistory(cur, base, range)) }];
        } catch (err) {
          return [cur, { ok: false, error: describeError(err) }];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  return { getQuote, getQuotes, getFxRate, getFxRates, search, getHistory, getFxHistory, getFxHistories };
}

// Ugentlige bars stemples forskelligt af Yahoo (søndag aften UTC for Europa, mandag for USA).
// Vi lægger alle på ugens mandag, så serier fra forskellige børser kan lægges sammen.
export function weekStart(ms) {
  const d = new Date(ms + 12 * 3600e3);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.getTime();
}

export function transliterate(text) {
  return text
    .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
    .replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .replace(/å/g, 'aa').replace(/Å/g, 'Aa')
    .replace(/ä/g, 'a').replace(/Ä/g, 'A')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/é/g, 'e');
}

export function describeError(err) {
  if (err instanceof YahooError) return { code: err.code, message: err.message, status: err.status };
  return { code: 'UNKNOWN', message: err?.message || String(err), status: 0 };
}
