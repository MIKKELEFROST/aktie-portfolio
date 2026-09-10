// Ønskelisten: aktier man følger med i uden at eje dem, med en valgfri ønskekurs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

async function start() {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-wl-')));
  const config = { envPassword: '', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK', publicAccess: true, storageMode: 'file' };
  const app = createApp({ store, yahoo: createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') }), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, server, store };
}

test('ønskeliste: tilføj, hent med kurs, ret og fjern', async () => {
  const { call, server } = await start();
  try {
    assert.deepEqual((await call('GET', '/api/watchlist')).json.items, []);

    const tilføjet = await call('POST', '/api/watchlist', { symbol: 'novo-b.co', target: '250,50', note: 'Køb ved dyk' });
    assert.equal(tilføjet.status, 201);
    assert.equal(tilføjet.json.item.symbol, 'NOVO-B.CO', 'symbolet gemmes med store bogstaver');
    assert.equal(tilføjet.json.item.target, 250.5, 'dansk kommatal forstås');

    const liste = (await call('GET', '/api/watchlist')).json.items;
    assert.equal(liste.length, 1);
    assert.equal(liste[0].name, 'Novo Nordisk A/S', 'navnet hentes fra kursen');
    assert.ok(liste[0].price > 0);
    assert.equal(liste[0].note, 'Køb ved dyk');
    // Kursen er 291, ønskekursen 250,50 → der er ~16 % ned.
    assert.ok(liste[0].toTarget > 15 && liste[0].toTarget < 17, `afstand ${liste[0].toTarget}`);
    assert.equal(liste[0].atTarget, false);

    // Sætter man ønskekursen over kursen, er den nået.
    assert.equal((await call('PUT', '/api/watchlist/NOVO-B.CO', { target: 400 })).status, 200);
    const nået = (await call('GET', '/api/watchlist')).json.items[0];
    assert.equal(nået.atTarget, true);
    assert.ok(nået.toTarget < 0, 'negativ afstand = kursen er under ønsket');

    // Ønskekursen kan fjernes igen.
    await call('PUT', '/api/watchlist/NOVO-B.CO', { target: null });
    const uden = (await call('GET', '/api/watchlist')).json.items[0];
    assert.equal(uden.target, null);
    assert.equal(uden.toTarget, null);
    assert.equal(uden.atTarget, false);

    assert.equal((await call('DELETE', '/api/watchlist/NOVO-B.CO')).status, 200);
    assert.deepEqual((await call('GET', '/api/watchlist')).json.items, []);
  } finally {
    server.close();
  }
});

test('ønskeliste: afviser dubletter, ukendte symboler og retter på noget der ikke findes', async () => {
  const { call, server } = await start();
  try {
    assert.equal((await call('POST', '/api/watchlist', { symbol: 'NOVO-B.CO' })).status, 201);
    const igen = await call('POST', '/api/watchlist', { symbol: 'NOVO-B.CO' });
    assert.equal(igen.status, 409);
    assert.match(igen.json.error, /allerede/);

    assert.equal((await call('POST', '/api/watchlist', { symbol: 'FINDESIKKE' })).status, 404);
    assert.equal((await call('POST', '/api/watchlist', { symbol: 'ugyldigt symbol!' })).status, 400);
    assert.equal((await call('PUT', '/api/watchlist/AAPL', { target: 100 })).status, 404);
    assert.equal((await call('DELETE', '/api/watchlist/AAPL')).status, 404);
  } finally {
    server.close();
  }
});

test('ønskeliste: den er med i sikkerhedskopien og kan gendannes', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 5, avgPrice: 200 });
    await call('POST', '/api/watchlist', { symbol: 'AAPL', target: 300, note: 'venter' });

    const kopi = (await call('GET', '/api/backup')).json;
    assert.equal(kopi.watchlist.length, 1);
    assert.equal(kopi.watchlist[0].symbol, 'AAPL');

    await call('DELETE', '/api/watchlist/AAPL');
    assert.deepEqual((await call('GET', '/api/watchlist')).json.items, []);

    assert.equal((await call('POST', '/api/restore', kopi)).status, 200);
    const efter = (await call('GET', '/api/watchlist')).json.items;
    assert.equal(efter.length, 1);
    assert.equal(efter[0].symbol, 'AAPL');
    assert.equal(efter[0].target, 300);
    assert.equal(efter[0].note, 'venter');
  } finally {
    server.close();
  }
});

test('ønskeliste: en aktie uden kurs vises stadig med sin fejl', async () => {
  const { call, server, store } = await start();
  try {
    // Lagt ind uden om API'et, som hvis symbolet er blevet afnoteret siden.
    await store.updatePortfolio((d) => { d.watchlist = [{ symbol: 'FEJL-ALTID', name: 'Væk', addedAt: new Date().toISOString() }]; });
    const liste = (await call('GET', '/api/watchlist')).json.items;
    assert.equal(liste.length, 1, 'den forsvinder ikke fra listen');
    assert.equal(liste[0].price, null);
    assert.ok(liste[0].error, 'fejlen står ved posten');
  } finally {
    server.close();
  }
});
