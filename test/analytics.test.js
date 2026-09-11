// Analyse: tallene om porteføljen som helhed, og fremskrivningen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';
import { computeAnalytics, projectValue } from '../server/portfolio-math.js';

const NU = Date.parse('2026-09-11T12:00:00Z');
const dageSiden = (n) => new Date(NU - n * 86_400_000).toISOString().slice(0, 10);

const post = (o) => ({
  symbol: o.symbol, name: o.name || o.symbol, currency: o.currency || 'DKK',
  accountId: o.accountId ?? null, purchasedAt: o.purchasedAt ?? null,
  heldDays: o.heldDays ?? null, costBase: o.costBase ?? null, valueBase: o.valueBase ?? null,
  gainBase: o.gainBase ?? null, gainPercent: o.gainPercent ?? null, weight: o.weight ?? null,
});

test('analyse: gennemsnit pr. måned regnes fra det første køb', () => {
  const a = computeAnalytics({
    now: NU,
    positions: [
      post({ symbol: 'A', purchasedAt: dageSiden(730), heldDays: 730, costBase: 120000, valueBase: 150000, gainBase: 30000, gainPercent: 25 }),
      post({ symbol: 'B', purchasedAt: dageSiden(365), heldDays: 365, costBase: 60000, valueBase: 60000, gainBase: 0, gainPercent: 0 }),
    ],
    totals: { valueBase: 210000 },
  });
  assert.equal(a.since, dageSiden(730));
  assert.equal(a.days, 730);
  assert.ok(Math.abs(a.months - 24) < 0.1, `måneder ${a.months}`);
  assert.equal(a.invested, 180000);
  // 180.000 kr. fordelt på 24 måneder = 7.500 kr. om måneden.
  assert.ok(Math.abs(a.perMonth - 7500) < 30, `pr. måned ${a.perMonth}`);
  assert.equal(a.gain, 30000);
  assert.ok(Math.abs(a.perDay - 30000 / 730) < 0.1);
});

test('analyse: afkast pr. år vægtes efter hvor længe pengene har været inde', () => {
  // Samme samlede afkast, men næsten alle pengene har kun været inde kort.
  const a = computeAnalytics({
    now: NU,
    positions: [
      post({ symbol: 'GAMMEL', purchasedAt: dageSiden(1095), heldDays: 1095, costBase: 10000, valueBase: 11000, gainBase: 1000, gainPercent: 10 }),
      post({ symbol: 'NY', purchasedAt: dageSiden(120), heldDays: 120, costBase: 190000, valueBase: 209000, gainBase: 19000, gainPercent: 10 }),
    ],
    totals: { valueBase: 220000 },
  });
  // Vægtet ejertid ligger tæt på de 120 dage, ikke midt imellem.
  assert.ok(a.avgHeldDays > 120 && a.avgHeldDays < 200, `vægtet ejertid ${a.avgHeldDays}`);
  // 10 % på knap et halvt år svarer til godt 20 % om året – ikke de 10 %,
  // man ville få, hvis man bare så på det samlede afkast.
  assert.ok(a.annualizedPercent > 20 && a.annualizedPercent < 26, `pr. år ${a.annualizedPercent}`);
  assert.equal(a.annualizedReliable, false, 'under et år: tallet er ikke pålideligt');
});

test('analyse: over et år markeres tallet som pålideligt', () => {
  const a = computeAnalytics({
    now: NU,
    positions: [post({ symbol: 'A', purchasedAt: dageSiden(1200), heldDays: 1200, costBase: 100000, valueBase: 150000, gainBase: 50000, gainPercent: 50 })],
    totals: { valueBase: 150000 },
  });
  assert.equal(a.annualizedReliable, true);
  assert.ok(a.annualizedPercent > 12 && a.annualizedPercent < 14, `pr. år ${a.annualizedPercent}`);
  // Ved den vækst fordobles pengene på godt fem år.
  assert.ok(a.doublingYears > 5 && a.doublingYears < 6.5, `fordobling ${a.doublingYears}`);
});

test('analyse: største, bedste, dårligste og længst ejede', () => {
  const a = computeAnalytics({
    now: NU,
    positions: [
      post({ symbol: 'STOR', name: 'Stor A/S', purchasedAt: dageSiden(400), heldDays: 400, costBase: 100000, valueBase: 160000, gainBase: 60000, gainPercent: 60, weight: 66.7 }),
      post({ symbol: 'TAB', name: 'Tab A/S', purchasedAt: dageSiden(200), heldDays: 200, costBase: 50000, valueBase: 40000, gainBase: -10000, gainPercent: -20, weight: 16.7 }),
      post({ symbol: 'GAMMEL', name: 'Gammel A/S', purchasedAt: dageSiden(2000), heldDays: 2000, costBase: 30000, valueBase: 40000, gainBase: 10000, gainPercent: 33.3, weight: 16.7 }),
    ],
    totals: { valueBase: 240000 },
  });
  assert.equal(a.biggest.symbol, 'STOR');
  assert.equal(a.best.symbol, 'STOR');
  assert.equal(a.worst.symbol, 'TAB');
  assert.equal(a.worst.gainPercent, -20);
  assert.equal(a.longestHeld.symbol, 'GAMMEL');
  assert.equal(a.longestHeld.heldDays, 2000);
  // Tre papirer er hele porteføljen.
  assert.equal(a.concentration, 100);
  // 60.000 af 240.000 er afkast.
  assert.equal(a.gainShare, 25);
});

test('analyse: papirer uden købsdato tælles, men ødelægger ikke tallene', () => {
  const a = computeAnalytics({
    now: NU,
    positions: [
      post({ symbol: 'MED', purchasedAt: dageSiden(365), heldDays: 365, costBase: 100000, valueBase: 110000, gainBase: 10000, gainPercent: 10 }),
      post({ symbol: 'UDEN', costBase: 50000, valueBase: 55000, gainBase: 5000, gainPercent: 10 }),
    ],
    totals: { valueBase: 165000 },
  });
  assert.equal(a.withDates, 1);
  assert.equal(a.withoutDates, 1);
  assert.equal(a.since, dageSiden(365), 'kun daterede papirer bestemmer starten');
  assert.equal(a.invested, 150000, 'begge tæller med i det investerede');
  assert.equal(a.avgHeldDays, 365, 'kun det daterede papir vejer i ejertiden');
});

test('analyse: en tom portefølje giver nuller og ikke NaN', () => {
  const a = computeAnalytics({ positions: [], totals: {}, now: NU });
  for (const felt of ['since', 'days', 'months', 'invested', 'perMonth', 'perDay', 'annualizedPercent', 'doublingYears', 'biggest', 'best']) {
    assert.equal(a[felt], null, felt);
  }
  assert.equal(a.value, 0);
  assert.equal(a.withDates, 0);
});

test('fremskrivning: renter tilskrives månedligt', () => {
  // Uden vækst er resultatet præcis det, man har lagt ind.
  const uden = projectValue({ start: 10000, perMonth: 1000, annualPercent: 0, years: 10 });
  assert.equal(uden.value, 130000);
  assert.equal(uden.contributed, 130000);
  assert.equal(uden.growth, 0);

  // 100.000 til 7 % i ti år uden indskud = 100.000 × 1,07^10.
  const kunRente = projectValue({ start: 100000, perMonth: 0, annualPercent: 7, years: 10 });
  assert.ok(Math.abs(kunRente.value - 100000 * 1.07 ** 10) < 1, `${kunRente.value}`);

  // 1.000 kr. om måneden i ét år til 7 %: lidt over de 12.000 der er lagt ind.
  const kunIndskud = projectValue({ start: 0, perMonth: 1000, annualPercent: 7, years: 1 });
  assert.equal(kunIndskud.contributed, 12000);
  assert.ok(kunIndskud.value > 12300 && kunIndskud.value < 12450, `${kunIndskud.value}`);
  assert.ok(Math.abs(kunIndskud.growth - (kunIndskud.value - 12000)) < 0.01, 'vækst = værdi minus indskud');

  // Et fald kan også fremskrives.
  const fald = projectValue({ start: 100000, perMonth: 0, annualPercent: -10, years: 5 });
  assert.ok(fald.value < 60000 && fald.value > 55000, `${fald.value}`);
});

test('analyse via API: hele vejen igennem', async () => {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-analyse-')));
  const config = { envPassword: '', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK', publicAccess: true, storageMode: 'file' };
  const app = createApp({ store, yahoo: createMockYahooClient(), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const tom = await call('GET', '/api/analytics');
    assert.equal(tom.status, 200);
    assert.equal(tom.json.value, 0);

    const toÅr = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 100, avgPrice: 200, purchasedAt: toÅr });
    await call('POST', '/api/holdings', { symbol: 'AAPL', quantity: 10, avgPrice: 100 });

    const a = (await call('GET', '/api/analytics')).json;
    assert.equal(a.baseCurrency, 'DKK');
    assert.equal(a.since, toÅr);
    assert.equal(a.withDates, 1);
    assert.equal(a.withoutDates, 1);
    assert.ok(a.invested > 0 && a.value > 0);
    assert.ok(a.perMonth > 0, 'gennemsnit pr. måned');
    assert.equal(a.annualizedReliable, true, 'to års ejertid er nok');
    assert.equal(a.biggest.symbol, 'NOVO-B.CO');
  } finally {
    server.close();
  }
});
