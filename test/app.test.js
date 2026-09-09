import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { YahooError } from '../server/yahoo.js';

// Falsk Yahoo-klient med deterministiske kurser.
const PRICES = {
  'NOVO-B.CO': { currency: 'DKK', price: 300, change: -3 },
  AAPL: { currency: 'USD', price: 200, change: 4 },
  'SHEL.L': { currency: 'GBP', price: 35, change: 0.5 },
  '^OMXC25': { currency: 'DKK', price: 1889, change: 2, type: 'INDEX' },
};
const FX = { USD: 7, GBP: 8.7, EUR: 7.46 };

const fakeYahoo = {
  async getQuotes(symbols) {
    const out = {};
    for (const s of symbols) {
      const p = PRICES[s];
      out[s] = p
        ? { ok: true, stale: false, quote: { symbol: s, name: `${s} Navn`, shortName: s, type: p.type || 'EQUITY', currency: p.currency, price: p.price, previousClose: p.price - p.change, change: p.change, changePercent: (p.change / (p.price - p.change)) * 100, marketOpen: true, fetchedAt: '2026-09-09T12:00:00.000Z' } }
        : { ok: false, error: { code: 'NOT_FOUND', message: `Ukendt symbol: ${s}`, status: 404 } };
    }
    return out;
  },
  async getFxRate(from, to) {
    if (from === to) return 1;
    if (to === 'DKK' && FX[from]) return FX[from];
    throw new YahooError('nope', { code: 'NOT_FOUND', status: 404 });
  },
  async getFxRates(currencies, base) {
    const out = {};
    for (const c of currencies) {
      try { out[c] = { ok: true, rate: await this.getFxRate(c, base) }; } catch (err) { out[c] = { ok: false, error: { code: err.code, message: err.message } }; }
    }
    return out;
  },
  async search(q) {
    return [
      { symbol: 'NVO', name: 'Novo Nordisk A/S', exchange: 'NYSE', type: 'EQUITY' },
      { symbol: 'NOVO-B.CO', name: 'Novo Nordisk A/S', exchange: 'Copenhagen', type: 'EQUITY' },
    ].filter((r) => r.name.toLowerCase().includes(q.toLowerCase()) || r.symbol.toLowerCase().includes(q.toLowerCase()));
  },
  async getHistory(symbol, range) {
    const p = PRICES[symbol];
    if (!p) throw new YahooError('nope', { code: 'NOT_FOUND', status: 404 });
    const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
    return { symbol, currency: p.currency, range, points: [{ t: day(1), close: p.price - 10 }, { t: day(2), close: p.price }] };
  },
};

let server;
let base;
let cookie = '';

function request(method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  const mutating = method !== 'GET';
  if (mutating) headers['content-type'] = 'application/json';
  const payload = mutating ? JSON.stringify(body ?? {}) : undefined;
  return fetch(base + url, { method, headers, body: payload, redirect: 'manual' }).then(async (res) => {
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  });
}

before(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'aktie-app-'));
  const store = createStore(dataDir, { baseCurrency: 'DKK' });
  const config = { envPassword: '', sessionSecret: '', secureCookies: false };
  const app = createApp({ store, yahoo: fakeYahoo, config, logger: { warn() {}, error() {} } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('første start: opsætning kræves, sider omdirigerer til /login', async () => {
  const status = await request('GET', '/api/auth/status');
  assert.deepEqual(status.json, { setupRequired: true, usesEnvPassword: false, authenticated: false });

  const page = await request('GET', '/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');

  const api = await request('GET', '/api/portfolio');
  assert.equal(api.status, 401);

  const login = await request('POST', '/api/auth/login', { password: 'x' });
  assert.equal(login.status, 409, 'login før opsætning afvises');
});

test('opsætning: for kort adgangskode afvises, gyldig logger ind', async () => {
  const short = await request('POST', '/api/auth/setup', { password: 'kort' });
  assert.equal(short.status, 400);
  const mismatch = await request('POST', '/api/auth/setup', { password: 'hemmelig123', confirm: 'hemmelig124' });
  assert.equal(mismatch.status, 400);

  const ok = await request('POST', '/api/auth/setup', { password: 'hemmelig123', confirm: 'hemmelig123' });
  assert.equal(ok.status, 201);
  assert.match(cookie, /^aktie_session=/);

  const again = await request('POST', '/api/auth/setup', { password: 'hemmelig123' });
  assert.equal(again.status, 409, 'opsætning kan ikke køres igen');

  const status = await request('GET', '/api/auth/status');
  assert.deepEqual(status.json, { setupRequired: false, usesEnvPassword: false, authenticated: true });

  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const loginPage = await request('GET', '/login');
  assert.equal(loginPage.status, 302, 'logget ind sendes væk fra /login');
});

test('logout og login', async () => {
  await request('POST', '/api/auth/logout');
  assert.equal((await request('GET', '/api/portfolio')).status, 401);

  const wrong = await request('POST', '/api/auth/login', { password: 'forkert' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'Forkert adgangskode');

  const form = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=hemmelig123' });
  assert.equal(form.status, 415, 'ikke-JSON afvises (CSRF-værn)');

  const ok = await request('POST', '/api/auth/login', { password: 'hemmelig123' });
  assert.equal(ok.status, 200);
  assert.equal((await request('GET', '/api/portfolio')).status, 200);
});

test('tom portefølje', async () => {
  const res = await request('GET', '/api/portfolio');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.positions, []);
  assert.equal(res.json.totals.valueBase, 0);
  assert.equal(res.json.baseCurrency, 'DKK');
});

let novoId;
let aaplId;

test('tilføj aktier med validering', async () => {
  const bad = await request('POST', '/api/holdings', { symbol: 'FINDESIKKE', quantity: 1, avgPrice: 1 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Ukendt symbol/);

  const noQty = await request('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 0, avgPrice: 250 });
  assert.equal(noQty.status, 400);

  const bogus = await request('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 'ti', avgPrice: 1 });
  assert.equal(bogus.status, 400);
  assert.match(bogus.json.error, /skal være et tal/);

  const novo = await request('POST', '/api/holdings', { symbol: 'novo-b.co', quantity: '10', avgPrice: '250,50', note: 'Langsigtet' });
  assert.equal(novo.status, 201, novo.text);
  assert.equal(novo.json.holding.symbol, 'NOVO-B.CO');
  assert.equal(novo.json.holding.avgPrice, 250.5, 'dansk decimalkomma accepteres');
  assert.equal(novo.json.holding.currency, 'DKK');
  novoId = novo.json.holding.id;

  const dup = await request('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.id, novoId);

  const aapl = await request('POST', '/api/holdings', { symbol: 'AAPL', quantity: 2, avgPrice: '150.25' });
  assert.equal(aapl.status, 201);
  assert.equal(aapl.json.holding.avgPrice, 150.25, 'engelsk decimalpunktum accepteres også');
  aaplId = aapl.json.holding.id;
  await request('PUT', `/api/holdings/${aaplId}`, { avgPrice: 150 });

  const shel = await request('POST', '/api/holdings', { symbol: 'SHEL.L', quantity: 5 });
  assert.equal(shel.status, 201);
  assert.equal(shel.json.holding.avgPrice, null, 'købskurs er valgfri');

  const index = await request('POST', '/api/holdings', { symbol: '^OMXC25', quantity: 1 });
  assert.equal(index.status, 400, 'indeks kan ikke tilføjes');
  assert.match(index.json.error, /Kun aktier/);
});

test('portefølje beregnes i DKK', async () => {
  const res = await request('GET', '/api/portfolio');
  const bySymbol = Object.fromEntries(res.json.positions.map((p) => [p.symbol, p]));
  assert.equal(bySymbol['NOVO-B.CO'].valueBase, 3000);
  assert.equal(bySymbol.AAPL.valueBase, 2800);
  assert.equal(bySymbol.AAPL.gainBase, 700);
  assert.equal(bySymbol['SHEL.L'].valueBase, 5 * 35 * 8.7);
  assert.equal(bySymbol['SHEL.L'].gain, null);
  assert.equal(res.json.totals.valueBase, 3000 + 2800 + 5 * 35 * 8.7);
  assert.equal(res.json.totals.incomplete, true, 'SHEL.L har ingen købskurs');
  assert.equal(res.json.fxRates.USD.rate, 7);
  assert.equal(bySymbol.AAPL.name, 'AAPL Navn', 'navn hentes fra Yahoo');
});

test('redigér, køb til, sælg', async () => {
  const edit = await request('PUT', `/api/holdings/${novoId}`, { quantity: 12, note: 'Ny note' });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.holding.quantity, 12);
  assert.equal(edit.json.holding.note, 'Ny note');
  assert.equal(edit.json.holding.avgPrice, 250.5, 'uændret felt bevares');

  // Køb 8 til á 400 → 20 stk., gns. = (12*250,5 + 8*400)/20 = 310,3
  const buy = await request('POST', `/api/holdings/${novoId}/trade`, { type: 'buy', quantity: 8, price: 400 });
  assert.equal(buy.status, 200);
  assert.equal(buy.json.holding.quantity, 20);
  assert.equal(buy.json.holding.avgPrice, 310.3);

  const tooMuch = await request('POST', `/api/holdings/${novoId}/trade`, { type: 'sell', quantity: 21 });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.error, /Du ejer kun 20 stk/);

  const sell = await request('POST', `/api/holdings/${novoId}/trade`, { type: 'sell', quantity: 5 });
  assert.equal(sell.json.holding.quantity, 15);
  assert.equal(sell.json.holding.avgPrice, 310.3, 'salg ændrer ikke gennemsnitskursen');

  const sellAll = await request('POST', `/api/holdings/${aaplId}/trade`, { type: 'sell', quantity: 2 });
  assert.equal(sellAll.json.removed, true);
  assert.equal((await request('GET', `/api/holdings`)).json.holdings.length, 2);

  const missing = await request('PUT', `/api/holdings/findes-ikke`, { quantity: 1 });
  assert.equal(missing.status, 404);
});

test('søgning rangerer København først, præcist symbol øverst', async () => {
  const res = await request('GET', '/api/search?q=novo');
  assert.equal(res.json.results[0].symbol, 'NOVO-B.CO');
  assert.equal(res.json.results[1].symbol, 'NVO');
  const exact = await request('GET', '/api/search?q=nvo');
  assert.equal(exact.json.results[0].symbol, 'NVO', 'præcist symbol-match først');
  assert.deepEqual((await request('GET', '/api/search?q=')).json.results, []);
});

test('kurs-opslag', async () => {
  const ok = await request('GET', '/api/quote/AAPL');
  assert.equal(ok.json.quote.price, 200);
  assert.equal((await request('GET', '/api/quote/NIX')).status, 404);
});

test('historik', async () => {
  const res = await request('GET', '/api/portfolio/history?range=1mo');
  assert.equal(res.status, 200);
  assert.equal(res.json.points.length, 2);
  // NOVO 15 stk. (290/300) + SHEL 5 stk. (25/35 GBP * 8.7)
  assert.equal(res.json.points[1].value, 15 * 300 + 5 * 35 * 8.7);
  assert.equal((await request('GET', '/api/portfolio/history?range=99y')).status, 400);
});

test('indstillinger: kontanter indgår i samlet værdi', async () => {
  const set = await request('PUT', '/api/settings', { cash: '12.500,50' });
  assert.equal(set.json.settings.cash, 12500.5);
  const res = await request('GET', '/api/portfolio');
  assert.equal(res.json.totals.cashBase, 12500.5);
  assert.equal(res.json.totals.totalValueBase, res.json.totals.valueBase + 12500.5);
  const neg = await request('PUT', '/api/settings', { cash: -5 });
  assert.equal(neg.status, 400);
  await request('PUT', '/api/settings', { cash: 0 });
});

test('indstillinger: basisvaluta', async () => {
  const bad = await request('PUT', '/api/settings', { baseCurrency: 'XXX' });
  assert.equal(bad.status, 400);
  const ok = await request('PUT', '/api/settings', { baseCurrency: 'usd', displayName: 'Mikkel' });
  assert.equal(ok.json.settings.baseCurrency, 'USD');
  assert.equal(ok.json.settings.displayName, 'Mikkel');
  await request('PUT', '/api/settings', { baseCurrency: 'DKK' });
});

test('backup og gendan', async () => {
  const backup = await request('GET', '/api/backup');
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get('content-disposition'), /attachment/);
  assert.equal(backup.json.holdings.length, 2);

  const badRestore = await request('POST', '/api/restore', { holdings: [{ symbol: 'A', quantity: 1 }, { symbol: 'A', quantity: 2 }] });
  assert.equal(badRestore.status, 400);

  const restore = await request('POST', '/api/restore', { holdings: [{ symbol: 'AAPL', quantity: 3, avgPrice: 100 }], settings: { baseCurrency: 'DKK' } });
  assert.equal(restore.status, 200);
  assert.equal(restore.json.count, 1);
  const list = await request('GET', '/api/holdings');
  assert.equal(list.json.holdings.length, 1);
  assert.equal(list.json.holdings[0].symbol, 'AAPL');
});

test('slet aktie', async () => {
  const id = (await request('GET', '/api/holdings')).json.holdings[0].id;
  assert.equal((await request('DELETE', `/api/holdings/${id}`)).status, 200);
  assert.equal((await request('DELETE', `/api/holdings/${id}`)).status, 404);
  assert.deepEqual((await request('GET', '/api/holdings')).json.holdings, []);
});

test('skift adgangskode og log ud overalt', async () => {
  const wrong = await request('POST', '/api/auth/change-password', { currentPassword: 'forkert', newPassword: 'nyhemmelig123' });
  assert.equal(wrong.status, 401);
  const ok = await request('POST', '/api/auth/change-password', { currentPassword: 'hemmelig123', newPassword: 'nyhemmelig123' });
  assert.equal(ok.status, 200);

  const all = await request('POST', '/api/auth/logout-all');
  assert.equal(all.status, 200);
  assert.equal((await request('GET', '/api/portfolio')).status, 401);
  const login = await request('POST', '/api/auth/login', { password: 'nyhemmelig123' });
  assert.equal(login.status, 200);
});

test('sikkerhedsheadere og ukendte ruter', async () => {
  const res = await request('GET', '/api/portfolio');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await request('GET', '/api/findes-ikke')).status, 404);
  assert.equal((await request('DELETE', '/api/portfolio')).status, 405);
  assert.equal((await request('GET', '/../package.json')).status, 404);
  assert.equal((await request('GET', '/findes-ikke')).status, 404);
});

test('login-bremse efter mange fejl – X-Forwarded-For omgår den ikke', async () => {
  await request('POST', '/api/auth/logout');
  let last;
  for (let i = 0; i < 9; i++) last = await request('POST', '/api/auth/login', { password: 'forkert' }, { 'x-forwarded-for': `10.0.0.${i}` });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});
