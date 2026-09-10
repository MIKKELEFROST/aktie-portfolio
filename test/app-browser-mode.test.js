import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

// Browser-tilstand: intet lager, intet login. Serveren beregner ud fra beholdninger sendt af klienten.
test('browser-tilstand: ingen login, compute-endpoints virker, lager-ruter er slået fra', async () => {
  const config = { envPassword: '', sessionSecret: '', storageMode: 'browser', baseCurrency: 'DKK', setupToken: 'x' };
  const yahoo = createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') });
  const app = createApp({ store: null, yahoo, config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), redirect: 'manual' });
  try {
    const page = await call('GET', '/');
    assert.equal(page.status, 200, 'forsiden kræver ikke login');
    assert.match(page.headers.get('content-type'), /text\/html/);
    const login = await call('GET', '/login');
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');

    const status = await (await call('GET', '/api/auth/status')).json();
    assert.deepEqual(status, { setupRequired: false, setupTokenRequired: false, usesEnvPassword: false, authenticated: true, storage: 'browser' });

    const computed = await call('POST', '/api/compute', {
      holdings: [{ symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200 }, { symbol: 'SHEL.L', quantity: 100, avgPrice: '27,50' }],
      settings: { baseCurrency: 'DKK', cash: 1000 },
    });
    assert.equal(computed.status, 200);
    const c = await computed.json();
    assert.equal(c.positions.length, 2);
    assert.equal(c.positions[0].valueBase, 2910);
    assert.equal(c.positions[1].currency, 'GBP');
    assert.equal(c.totals.cashBase, 1000);
    assert.equal(c.totals.totalValueBase, c.totals.valueBase + 1000);
    assert.equal(c.baseCurrency, 'DKK');
    assert.equal(c.quotes, undefined, 'rå kurser sendes ikke med');

    const bad = await call('POST', '/api/compute', { holdings: [{ symbol: 'NOVO-B.CO', quantity: 0 }] });
    assert.equal(bad.status, 400);
    const tooMany = await call('POST', '/api/compute', { holdings: Array.from({ length: 101 }, (_, i) => ({ symbol: `S${i}`, quantity: 1 })) });
    assert.equal(tooMany.status, 400);

    const hist = await (await call('POST', '/api/compute/history', { holdings: [{ symbol: 'NOVO-B.CO', quantity: 10 }], settings: { baseCurrency: 'DKK' }, range: '1mo' })).json();
    assert.ok(hist.points.length > 5);
    assert.equal(hist.range, '1mo');

    const search = await (await call('GET', '/api/search?q=novo')).json();
    assert.equal(search.results[0].symbol, 'NOVO-B.CO');
    assert.equal((await call('GET', '/api/quote/AAPL')).status, 200);

    for (const [m, p] of [['GET', '/api/portfolio'], ['GET', '/api/holdings'], ['POST', '/api/holdings'], ['PUT', '/api/settings'], ['GET', '/api/backup'], ['POST', '/api/restore'], ['POST', '/api/auth/login'], ['POST', '/api/auth/setup']]) {
      const r = await call(m, p, {});
      assert.equal(r.status, 404, `${m} ${p} er slået fra`);
      assert.equal((await r.json()).code, 'BROWSER_MODE');
    }
  } finally {
    server.close();
  }
});

test('browser-tilstand: kald-grænse pr. IP', async () => {
  const config = { envPassword: '', sessionSecret: '', storageMode: 'browser', baseCurrency: 'DKK' };
  const app = createApp({ store: null, yahoo: createMockYahooClient(), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let last;
    for (let i = 0; i < 241; i++) last = await fetch(base + '/api/health');
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally {
    server.close();
  }
});

test('fil-tilstand: compute kræver login', async () => {
  const { createStore } = await import('../server/store.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-compute-')));
  const app = createApp({ store, yahoo: createMockYahooClient(), config: { envPassword: 'pw-123456', sessionSecret: '', setupToken: 'x' }, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/compute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"holdings":[]}' });
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});
