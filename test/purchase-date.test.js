// Købsdato på en beholdning, og det den bruges til: ejertid og afkast pr. år.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';
import { annualized, heldDays } from '../server/portfolio-math.js';

async function start() {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-dato-')));
  const config = { envPassword: '', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK', publicAccess: true, storageMode: 'file' };
  const app = createApp({ store, yahoo: createMockYahooClient(), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, server };
}

const forDageSiden = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test('købsdato: gemmes, kan ændres og kan fjernes igen', async () => {
  const { call, server } = await start();
  try {
    const tilføjet = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200, purchasedAt: '2024-03-15' });
    assert.equal(tilføjet.status, 201);
    assert.equal(tilføjet.json.holding.purchasedAt, '2024-03-15');
    const id = tilføjet.json.holding.id;

    assert.equal((await call('GET', '/api/holdings')).json.holdings[0].purchasedAt, '2024-03-15');

    assert.equal((await call('PUT', `/api/holdings/${id}`, { purchasedAt: '2023-01-02' })).json.holding.purchasedAt, '2023-01-02');
    assert.equal((await call('PUT', `/api/holdings/${id}`, { purchasedAt: null })).json.holding.purchasedAt, null);
    assert.equal((await call('PUT', `/api/holdings/${id}`, { purchasedAt: '' })).json.holding.purchasedAt, null);

    // Uden datoen rører man ikke ved den, når man retter noget andet.
    await call('PUT', `/api/holdings/${id}`, { purchasedAt: '2024-03-15' });
    assert.equal((await call('PUT', `/api/holdings/${id}`, { quantity: 12 })).json.holding.purchasedAt, '2024-03-15');
  } finally {
    server.close();
  }
});

test('købsdato: en dato der ikke giver mening, afvises', async () => {
  const { call, server } = await start();
  try {
    const iMorgen = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    for (const [dato, hvorfor] of [
      ['15-03-2024', 'dansk datoformat'],
      ['2024-13-01', 'måned 13'],
      ['i går', 'tekst'],
      [iMorgen, 'i fremtiden'],
      ['1960-01-01', 'urimeligt langt tilbage'],
    ]) {
      const res = await call('POST', '/api/holdings', { symbol: 'AAPL', quantity: 1, purchasedAt: dato });
      assert.equal(res.status, 400, `${hvorfor}: ${dato}`);
    }
    // Og porteføljen er stadig tom.
    assert.equal((await call('GET', '/api/holdings')).json.holdings.length, 0);
  } finally {
    server.close();
  }
});

test('købsdato: giver ejertid og afkast pr. år på positionen', async () => {
  const { call, server } = await start();
  try {
    // Købt for to år siden til 100; kursen er 291 → cirka +70 % om året.
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 100, purchasedAt: forDageSiden(730) });
    const p = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.ok(p.heldDays >= 729 && p.heldDays <= 731, `ejertid ${p.heldDays}`);
    assert.ok(p.gainPercent > 100, 'samlet afkast over 100 %');
    assert.ok(p.annualizedPercent > 50 && p.annualizedPercent < p.gainPercent, `pr. år ${p.annualizedPercent} skal ligge under ${p.gainPercent}`);
  } finally {
    server.close();
  }
});

test('købsdato: uden dato er der ingen ejertid og intet årligt afkast', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 100 });
    const p = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.equal(p.purchasedAt, null);
    assert.equal(p.heldDays, null);
    assert.equal(p.annualizedPercent, null);
    assert.ok(p.gainPercent > 0, 'det almindelige afkast vises stadig');
  } finally {
    server.close();
  }
});

test('købsdato: følger med i sikkerhedskopien', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200, purchasedAt: '2024-03-15' });
    const kopi = (await call('GET', '/api/backup')).json;
    assert.equal(kopi.holdings[0].purchasedAt, '2024-03-15');

    await call('PUT', `/api/holdings/${kopi.holdings[0].id}`, { purchasedAt: null });
    assert.equal((await call('GET', '/api/holdings')).json.holdings[0].purchasedAt, null);

    assert.equal((await call('POST', '/api/restore', kopi)).status, 200);
    assert.equal((await call('GET', '/api/holdings')).json.holdings[0].purchasedAt, '2024-03-15');
  } finally {
    server.close();
  }
});

test('afkast pr. år: regnestykket', () => {
  // Fordobling på præcis et år = +100 % om året.
  assert.equal(annualized(100, 365), 100);
  // Fordobling på to år er cirka +41 % om året, ikke +50 %.
  assert.ok(Math.abs(annualized(100, 730) - 41.42) < 0.05);
  // Et halvt år med +10 % svarer til +21 % på et helt.
  assert.ok(Math.abs(annualized(10, 182.5) - 21) < 0.1);
  // Under en måned siger tallet intet fornuftigt, så det udelades.
  assert.equal(annualized(8, 3), null);
  assert.equal(annualized(8, 29), null);
  assert.ok(annualized(8, 31) !== null);
  // Et tab bliver også omregnet.
  assert.ok(annualized(-50, 730) < -25);
  // Manglende tal giver ingenting i stedet for NaN.
  assert.equal(annualized(null, 365), null);
  assert.equal(annualized(10, null), null);
  assert.equal(annualized(-100, 365), null, 'alt tabt: kan ikke regnes om');

  const nu = Date.parse('2026-09-11T12:00:00Z');
  assert.equal(heldDays('2026-09-01', nu), 10);
  assert.equal(heldDays(null, nu), null);
  assert.equal(heldDays('ikke en dato', nu), null);
  assert.equal(heldDays('2027-01-01', nu), null, 'fremtidig dato giver ingen ejertid');
});
