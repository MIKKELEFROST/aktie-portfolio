import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { createStoreFromConfig } from '../server/storage.js';

// Minimal falsk Upstash (GET/SET/EVAL/LPUSH/LTRIM) delt af hele testen
const db = new Map();
globalThis.__fakeFetch = async (url, opts) => {
  const [cmd, ...a] = JSON.parse(opts.body);
  let result = null;
  if (cmd === 'GET') result = db.has(a[0]) ? db.get(a[0]) : null;
  else if (cmd === 'SET') { db.set(a[0], a[1]); result = 'OK'; }
  else if (cmd === 'LPUSH') { const l = db.get(a[0]) || []; l.unshift(a[1]); db.set(a[0], l); result = l.length; }
  else if (cmd === 'LTRIM') { const l = db.get(a[0]) || []; db.set(a[0], l.slice(a[1], a[2] + 1)); result = 'OK'; }
  else if (cmd === 'EVAL') { const [, , key, revKey, value, expected, newRev] = a; const rev = db.has(revKey) ? db.get(revKey) : null; if (rev !== null && rev !== expected) result = 0; else { db.set(key, value); db.set(revKey, newRev); result = 1; } }
  return { ok: true, status: 200, json: async () => ({ result }) };
};

test('hele API-flowet virker med Redis-lager og fast adgangskode (som på Vercel)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = globalThis.__fakeFetch; // store-redis bruger globalThis.fetch som standard
  const config = { envPassword: 'vercel-pass-123', sessionSecret: '', secureCookies: true, trustProxy: true, alwaysRequireSetupToken: true, setupToken: 'x', baseCurrency: 'DKK', storageMode: 'redis' };
  const store = createStoreFromConfig(config, { KV_REST_API_URL: 'https://fake', KV_REST_API_TOKEN: 't' });
  globalThis.fetch = realFetch;
  const yahoo = {
    async getQuotes(symbols) { return Object.fromEntries(symbols.map((s) => [s, { ok: true, stale: false, quote: { symbol: s, name: s, shortName: s, type: 'EQUITY', currency: 'DKK', price: 100, previousClose: 99, change: 1, changePercent: 1.01, marketOpen: true } }])); },
    async getFxRates(c, base) { return Object.fromEntries(c.map((x) => [x, { ok: true, rate: 1 }])); },
    async getFxRate() { return 1; },
    async search() { return []; },
    async getHistory() { return { points: [] }; },
  };
  const app = createApp({ store, yahoo, config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '203.0.113.7' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), redirect: 'manual' });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  try {
    const status = await call('GET', '/api/auth/status');
    assert.deepEqual(status.json, { setupRequired: false, setupTokenRequired: false, usesEnvPassword: true, access: 'login', authenticated: false, storage: 'redis' });
    assert.equal((await call('POST', '/api/auth/login', { password: 'forkert' })).status, 401);
    const login = await call('POST', '/api/auth/login', { password: 'vercel-pass-123' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /Secure/);
    const add = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 5, avgPrice: 90 });
    assert.equal(add.status, 201);
    const portfolio = await call('GET', '/api/portfolio');
    assert.equal(portfolio.json.totals.valueBase, 500);
    assert.ok(db.get('aktie:portfolio').includes('NOVO-B.CO'), 'gemt i Redis');
    await call('PUT', '/api/settings', { cash: 100 });
    assert.equal((await call('GET', '/api/portfolio')).json.totals.totalValueBase, 600);
    assert.ok(db.get('aktie:portfolio:backups').length >= 1, 'backup-liste vedligeholdes');
  } finally {
    server.close();
  }
});
