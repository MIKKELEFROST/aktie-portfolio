import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

async function startApp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'aktie-depot-'));
  const store = createStore(dir);
  const app = createApp({ store, yahoo: createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') }), config: { envPassword: 'pw-123456', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK' }, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  await call('POST', '/api/auth/login', { password: 'pw-123456' });
  return { call, server };
}

test('depoter: oprettelse, samme aktie i flere depoter, filtreret overblik, sletning', async () => {
  const { call, server } = await startApp();
  try {
    const bad = await call('PUT', '/api/settings', { accounts: [{ name: 'Pension' }, { name: 'pension' }] });
    assert.equal(bad.status, 400, 'dubletnavne afvises');
    const set = await call('PUT', '/api/settings', { accounts: [{ name: 'Månedsopsparing' }, { name: 'Pension' }] });
    assert.equal(set.status, 200);
    const [mo, pe] = set.json.settings.accounts;
    assert.ok(mo.id && pe.id && mo.id !== pe.id);

    const a1 = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200, accountId: mo.id });
    assert.equal(a1.status, 201);
    assert.equal(a1.json.holding.accountId, mo.id);
    const dup = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 5, avgPrice: 300, accountId: mo.id });
    assert.equal(dup.status, 409, 'samme aktie i samme depot');
    assert.equal(dup.json.id, a1.json.holding.id);
    const a2 = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 5, avgPrice: 300, accountId: pe.id });
    assert.equal(a2.status, 201, 'samme aktie i et andet depot er ok');
    const a3 = await call('POST', '/api/holdings', { symbol: 'AAPL', quantity: 2, avgPrice: 100 });
    assert.equal(a3.status, 201, 'uden depot');
    const unknown = await call('POST', '/api/holdings', { symbol: 'MSFT', quantity: 1, accountId: 'findes-ikke' });
    assert.equal(unknown.status, 400);

    const all = await call('GET', '/api/portfolio');
    assert.equal(all.json.positions.length, 3);
    assert.equal(all.json.account, '');
    assert.equal(all.json.positions.find((p) => p.id === a1.json.holding.id).accountName, 'Månedsopsparing');
    const onlyMo = await call('GET', `/api/portfolio?account=${mo.id}`);
    assert.equal(onlyMo.json.positions.length, 1);
    assert.equal(onlyMo.json.totals.valueBase, 2910);
    assert.equal(onlyMo.json.account, mo.id);
    const none = await call('GET', '/api/portfolio?account=none');
    assert.equal(none.json.positions.length, 1);
    assert.equal(none.json.positions[0].symbol, 'AAPL');
    assert.equal((await call('GET', '/api/portfolio?account=a%24b')).status, 400, 'ugyldige tegn i filter');

    const hist = await call('GET', `/api/portfolio/history?range=1mo&account=${pe.id}`);
    assert.ok(hist.json.points.length > 5);

    // flyt AAPL til Pension, og afvis flytning der giver dublet
    const move = await call('PUT', `/api/holdings/${a3.json.holding.id}`, { accountId: pe.id });
    assert.equal(move.json.holding.accountId, pe.id);
    const clash = await call('PUT', `/api/holdings/${a2.json.holding.id}`, { accountId: mo.id });
    assert.equal(clash.status, 409);

    // slet Pension: beholdninger bevares uden depot
    const del = await call('PUT', '/api/settings', { accounts: [mo] });
    assert.equal(del.json.settings.accounts.length, 1);
    const after = await call('GET', '/api/holdings');
    assert.equal(after.json.holdings.filter((h) => h.accountId === null).length, 2);

    // backup/gendan bevarer depoter
    const backup = await call('GET', '/api/backup');
    const restore = await call('POST', '/api/restore', backup.json);
    assert.equal(restore.status, 200);
    assert.equal(restore.json.settings.accounts.length, 1);
  } finally {
    server.close();
  }
});

test('browser-tilstand: compute med depoter og filter', async () => {
  const app = createApp({ store: null, yahoo: createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') }), config: { envPassword: '', sessionSecret: '', storageMode: 'browser', baseCurrency: 'DKK' }, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => { const r = await fetch(base + '/api/compute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const settings = { baseCurrency: 'DKK', accounts: [{ id: 'mo', name: 'Månedsopsparing' }, { id: 'pe', name: 'Pension' }], cash: 100 };
    const holdings = [{ symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200, accountId: 'mo' }, { symbol: 'NOVO-B.CO', quantity: 5, avgPrice: 300, accountId: 'pe' }, { symbol: 'AAPL', quantity: 1 }];
    const all = await post({ holdings, settings });
    assert.equal(all.status, 200);
    assert.equal(all.json.positions.length, 3);
    assert.equal(all.json.totals.cashBase, 100);
    const pe = await post({ holdings, settings, account: 'pe' });
    assert.equal(pe.json.positions.length, 1);
    assert.equal(pe.json.positions[0].accountName, 'Pension');
    assert.equal(pe.json.totals.cashBase, 0, 'kontanter kun i det samlede overblik');
    const dup = await post({ holdings: [{ symbol: 'A', quantity: 1, accountId: 'mo' }, { symbol: 'A', quantity: 1, accountId: 'mo' }], settings });
    assert.equal(dup.status, 400);
    const unknown = await post({ holdings: [{ symbol: 'A', quantity: 1, accountId: 'nix' }], settings });
    assert.equal(unknown.status, 400);
  } finally {
    server.close();
  }
});
