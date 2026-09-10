import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

async function startOpen(extra = {}) {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-open-')));
  const config = { envPassword: '', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK', publicAccess: true, storageMode: 'file', ...extra };
  const app = createApp({ store, yahoo: createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') }), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), redirect: 'manual' });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  return { call, server, store };
}

test('åben adgang: ingen login, data deles, og alle kan redigere', async () => {
  const { call, server } = await startOpen();
  try {
    const status = await call('GET', '/api/auth/status');
    assert.equal(status.json.access, 'open');
    assert.equal(status.json.authenticated, true);
    assert.equal(status.json.setupRequired, false);

    // Ingen cookie sendes med: alligevel adgang til alt.
    assert.equal((await call('GET', '/api/portfolio')).status, 200);
    const add = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200 });
    assert.equal(add.status, 201);
    const list = await call('GET', '/api/holdings');
    assert.equal(list.json.holdings.length, 1);
    assert.equal((await call('PUT', '/api/settings', { accounts: [{ name: 'Pension' }] })).status, 200);
    assert.equal((await call('GET', '/api/backup')).status, 200);

    // Login-siden giver ingen mening og sender videre til dashboardet.
    const login = await call('GET', '/login');
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
    assert.equal((await call('GET', '/')).status, 200);

    // Auth-endpoints er slået fra, så ingen kan sætte en adgangskode udefra.
    for (const p of ['/api/auth/login', '/api/auth/setup', '/api/auth/change-password', '/api/auth/logout-all']) {
      const r = await call('POST', p, { password: 'noget-langt-nok' });
      assert.equal(r.status, 404, p);
      assert.equal(r.json.code, 'OPEN_ACCESS');
    }
  } finally {
    server.close();
  }
});

test('åben adgang kræver et lager: slået fra i browser-tilstand', async () => {
  const app = createApp({ store: null, yahoo: createMockYahooClient(), config: { publicAccess: true, storageMode: 'browser', envPassword: '', sessionSecret: '' }, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/status`);
    assert.equal((await res.json()).access, 'browser', 'browser-tilstand vinder, for der er intet delt lager');
  } finally {
    server.close();
  }
});

test('uden PUBLIC_ACCESS kræves login stadig', async () => {
  const { call, server } = await startOpen({ publicAccess: false, envPassword: 'pw-123456' });
  try {
    assert.equal((await call('GET', '/api/auth/status')).json.access, 'login');
    assert.equal((await call('GET', '/api/portfolio')).status, 401);
  } finally {
    server.close();
  }
});

test('åben adgang: kald-grænse pr. IP', async () => {
  const { call, server } = await startOpen();
  try {
    let last;
    for (let i = 0; i < 241; i++) last = await call('GET', '/api/health');
    assert.equal(last.status, 429);
  } finally {
    server.close();
  }
});
