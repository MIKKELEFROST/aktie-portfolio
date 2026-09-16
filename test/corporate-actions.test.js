// Splits og udbytte: det, der sker med en aktie, uden at man selv handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';
import { adjustHolding, adjustLot, dividendCash, dividendFactorSince, splitFactorSince } from '../server/corporate-actions.js';
import { computeValueHistory, round } from '../server/portfolio-math.js';

async function start() {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-events-')));
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

const SPLITS = [{ date: '2020-08-31', ratio: 4, label: '4:1' }];
// close/adjclose: 1,10 i 2019 betyder, at udbyttet siden har købt 10 % flere stk.
const FACTORS = [
  { date: '2019-01-01', close: 110, adjclose: 100 },
  { date: '2020-01-01', close: 105, adjclose: 100 },
  { date: '2022-01-01', close: 104, adjclose: 100 },
  { date: '2024-01-01', close: 102, adjclose: 100 },
  { date: '2030-01-01', close: 100, adjclose: 100 },
];

// ---------- splits ----------

test('splitFactorSince: kun splits efter købsdatoen tæller med', () => {
  assert.equal(splitFactorSince(SPLITS, '2019-06-01'), 4, 'købt før splittet');
  assert.equal(splitFactorSince(SPLITS, '2021-06-01'), 1, 'købt efter splittet');
  assert.equal(splitFactorSince(SPLITS, '2020-08-31'), 1, 'selve splitdagen regnes som efter');
});

test('splitFactorSince: uden dato ganges der ikke op', () => {
  // Tal uden dato er næsten altid skrevet af fra banken i dag – altså allerede
  // efter splittet. At gange dem op ville firedoble en beholdning, der passer.
  assert.equal(splitFactorSince(SPLITS, null), 1);
  assert.equal(splitFactorSince(SPLITS, ''), 1);
});

test('splitFactorSince: flere splits ganges sammen', () => {
  const to = [{ date: '2015-01-01', ratio: 2 }, { date: '2020-01-01', ratio: 3 }];
  assert.equal(splitFactorSince(to, '2014-01-01'), 6);
  assert.equal(splitFactorSince(to, '2016-01-01'), 3);
});

test('adjustLot: antallet ganges op, kursen deles – det investerede er uændret', () => {
  const l = adjustLot({ date: '2019-06-01', quantity: 10, price: 400 }, { splits: SPLITS, factors: [] });
  assert.equal(l.quantity, 40);
  assert.equal(l.price, 100);
  assert.equal(l.quantity * l.price, 4000, '10 × 400 er stadig 4.000');
});

test('adjustLot: et køb uden kurs beholder sin manglende kurs', () => {
  const l = adjustLot({ date: '2019-06-01', quantity: 10, price: null }, { splits: SPLITS, factors: [] });
  assert.equal(l.quantity, 40);
  assert.equal(l.price, null);
});

// ---------- udbytte ----------

test('dividendFactorSince: faktoren læses af den dato, der ligger nærmest', () => {
  assert.equal(dividendFactorSince(FACTORS, '2019-06-01'), 1.1);
  assert.equal(dividendFactorSince(FACTORS, '2024-02-01'), 1.02);
  assert.equal(dividendFactorSince(FACTORS, '2030-01-01'), 1, 'i dag er der intet udbytte til gode');
});

test('dividendFactorSince: uden serie er faktoren 1', () => {
  assert.equal(dividendFactorSince([], '2019-06-01'), 1);
  assert.equal(dividendFactorSince(null, '2019-06-01'), 1);
});

test('adjustLot: udbyttet køber flere stk., men koster ikke noget', () => {
  const l = adjustLot({ date: '2019-06-01', quantity: 10, price: 400 }, { splits: SPLITS, factors: FACTORS });
  assert.equal(l.quantity, 40, 'splittet alene');
  assert.equal(l.dividendShares, 4, '10 stk. × 4 (split) × 10 % udbytte');
  assert.equal(l.quantity * l.price, 4000, 'det investerede er stadig det, man betalte');
});

test('dividendCash: et køb efter en udbetaling får ikke del i den', () => {
  const events = {
    splits: [],
    factors: [{ date: '2024-01-01', close: 100, adjclose: 100 }],
    dividends: [{ date: '2024-03-01', amount: 5 }, { date: '2025-03-01', amount: 6 }],
  };
  const sent = dividendCash([{ date: '2024-06-01', quantity: 100, price: 10 }], events);
  assert.equal(sent.count, 1, 'kun udbetalingen i 2025');
  assert.equal(sent.total, 600);

  const tidligt = dividendCash([{ date: '2023-06-01', quantity: 100, price: 10 }], events);
  assert.equal(tidligt.count, 2);
  assert.equal(tidligt.total, 1100);
});

test('dividendCash: et køb uden dato får ikke udbytte', () => {
  // Uden dato ved vi ikke, om aktien var ejet på udbetalingsdagen, og så er
  // det bedre at lade være end at digte et beløb.
  const events = { splits: [], factors: [], dividends: [{ date: '2024-03-01', amount: 5 }] };
  assert.equal(dividendCash([{ date: null, quantity: 100 }], events).total, 0);
});

// ---------- hele beholdningen ----------

test('adjustHolding: splittet og udbyttet lægges sammen til det, man sidder med', () => {
  const h = { quantity: 10, avgPrice: 400, lots: [{ date: '2019-06-01', quantity: 10, price: 400 }] };
  const a = adjustHolding(h, { ok: true, splits: SPLITS, factors: FACTORS, dividends: [], currency: 'USD' });
  assert.equal(a.quantity, 40, 'stk. man ejer i dag');
  assert.equal(a.dividendShares, 4, 'stk. udbyttet har købt');
  assert.equal(a.effectiveQuantity, 44);
  assert.equal(a.splitAdjusted, true);
  assert.equal(a.addedBySplits, 30);
});

test('adjustHolding: splittet kan slås fra, når tallene allerede er efter det', () => {
  const h = { quantity: 40, avgPrice: 100, lots: [{ date: '2019-06-01', quantity: 40, price: 100 }] };
  const a = adjustHolding(h, { ok: true, splits: SPLITS, factors: FACTORS, dividends: [] }, { splits: false });
  assert.equal(a.quantity, 40, 'antallet står som skrevet');
  assert.equal(a.splitAdjusted, false);
  assert.equal(a.dividendShares, 4, 'udbyttet tæller stadig med');
});

test('adjustHolding: udbyttet kan slås fra for sig', () => {
  const h = { quantity: 10, avgPrice: 400, lots: [{ date: '2019-06-01', quantity: 10, price: 400 }] };
  const a = adjustHolding(h, { ok: true, splits: SPLITS, factors: FACTORS, dividends: [] }, { dividends: false });
  assert.equal(a.quantity, 40);
  assert.equal(a.dividendShares, 0);
  assert.equal(a.effectiveQuantity, 40);
});

test('adjustHolding: uden splits og udbytte er der intet at rette', () => {
  const h = { quantity: 10, avgPrice: 400, purchasedAt: '2019-06-01' };
  assert.equal(adjustHolding(h, { ok: true, splits: [], factors: [], dividends: [] }), null);
  assert.equal(adjustHolding(h, { ok: false }), null);
  assert.equal(adjustHolding(h, null), null);
});

test('adjustHolding: virker også uden en liste af køb', () => {
  const h = { quantity: 10, avgPrice: 400, purchasedAt: '2019-06-01' };
  const a = adjustHolding(h, { ok: true, splits: SPLITS, factors: FACTORS, dividends: [] });
  assert.equal(a.quantity, 40);
  assert.equal(a.dividendShares, 4);
});

// ---------- hele vejen igennem API'et ----------

test('portefølje: et køb fra før splittet ganges op, så værdien passer med kursen', async () => {
  const { call, server } = await start();
  try {
    // AAPL i mock'en: 4:1-split 2020-08-31, kurs nu 316,30 USD.
    await call('POST', '/api/holdings', { symbol: 'AAPL', quantity: 10, avgPrice: 400, purchasedAt: '2019-06-01' });
    const p = (await call('GET', '/api/portfolio')).json;
    const pos = p.positions[0];
    assert.equal(pos.enteredQuantity, 10, 'det brugeren skrev står stadig');
    assert.equal(pos.quantity, 40, 'ganget op for splittet');
    assert.equal(pos.dividendShares, 4, 'udbyttet har købt 4 stk. mere');
    assert.equal(pos.effectiveQuantity, 44);
    assert.equal(pos.splitAdjusted, true);
    assert.equal(pos.avgPrice, 100, 'kursen fulgte med splittet ned');
    assert.equal(pos.cost, 4000, 'det investerede er uændret');
    assert.equal(pos.value, 44 * 316.3);
    assert.equal(pos.splits.length, 1);
    assert.equal(pos.splits[0].label, '4:1');
  } finally {
    server.close();
  }
});

test('portefølje: en aktie uden splits og udbytte rører vi ikke', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'MSFT', quantity: 10, avgPrice: 400, purchasedAt: '2019-06-01' });
    const pos = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.equal(pos.quantity, 10);
    assert.equal(pos.dividendShares, 0);
    assert.equal(pos.splitAdjusted, false);
    assert.equal(pos.splits, null);
    assert.equal(pos.dividend, null);
  } finally {
    server.close();
  }
});

test('portefølje: udbytte alene giver flere stk. og et beløb, man kan se', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 100, avgPrice: 100, purchasedAt: '2023-06-01' });
    const pos = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.equal(pos.quantity, 100, 'ingen splits – antallet står som skrevet');
    assert.equal(pos.dividendShares, 5, '5 % flere stk. for det geninvesterede udbytte');
    assert.equal(pos.splitAdjusted, false);
    assert.ok(pos.dividend.total > 0, 'der står et beløb');
    assert.equal(pos.dividend.count, 2, 'to udbetalinger siden købet');
  } finally {
    server.close();
  }
});

test('portefølje: splittet kan slås fra pr. aktie', async () => {
  const { call, server } = await start();
  try {
    const id = (await call('POST', '/api/holdings', { symbol: 'AAPL', quantity: 40, avgPrice: 100, purchasedAt: '2019-06-01' })).json.holding.id;
    const gemt = await call('PUT', `/api/holdings/${id}`, { skipSplitAdjust: true });
    assert.equal(gemt.json.holding.skipSplitAdjust, true);
    const pos = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.equal(pos.quantity, 40, 'antallet står, som det blev skrevet');
    assert.equal(pos.splitAdjusted, false);
    assert.equal(pos.cost, 4000);
  } finally {
    server.close();
  }
});

test('totaler: det geninvesterede udbytte tælles med i værdien', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 100, avgPrice: 100, purchasedAt: '2023-06-01' });
    const t = (await call('GET', '/api/portfolio')).json.totals;
    // 105 stk. × 291 DKK, hvoraf de 5 stk. kom fra udbyttet.
    assert.equal(t.valueBase, 105 * 291);
    assert.equal(t.costBase, 10000);
    assert.equal(t.dividendValueBase, 5 * 291);
  } finally {
    server.close();
  }
});

// ---------- kurven ----------

test('kurven: et køb fra før splittet tæller med det ganget op', () => {
  // Yahoos historiske kurser er regnet om, som om splittet altid havde været
  // der. Så skal antallet være det samme – ellers viser kurven en fjerdedel.
  const holdings = [{ id: 'a', symbol: 'X', quantity: 10, avgPrice: 400, lots: [{ date: '2019-06-01', quantity: 10, price: 400 }] }];
  const histories = {
    X: { symbol: 'X', currency: 'DKK', points: [{ t: Date.parse('2021-01-04T12:00:00Z'), close: 100 }] },
  };
  const fxRates = { DKK: { ok: true, rate: 1 } };
  const uden = computeValueHistory({ holdings, histories, fxRates });
  assert.equal(uden.points[0].value, 1000, 'uden rettelse: 10 stk. × 100');

  const adj = adjustHolding(holdings[0], { ok: true, splits: SPLITS, factors: [], dividends: [] });
  const med = computeValueHistory({ holdings, histories, fxRates, adjustments: { a: adj } });
  assert.equal(med.points[0].value, 4000, 'med rettelse: 40 stk. × 100');
  assert.equal(med.points[0].invested, 4000, 'det investerede er uændret – man betalte det samme');
});

test('kurven: udbyttet vokser ind, efterhånden som det bliver udbetalt', () => {
  // Faktoren falder mod 1 hen mod i dag, så antallet af stk. skal stige.
  // Ligger udbyttet der fra første dag, er den tidlige del af kurven for høj.
  const holdings = [{ id: 'a', symbol: 'X', quantity: 100, avgPrice: 10, lots: [{ date: '2019-01-01', quantity: 100, price: 10 }] }];
  const dag = (s) => Date.parse(`${s}T12:00:00Z`);
  const histories = {
    X: {
      symbol: 'X',
      currency: 'DKK',
      points: [
        { t: dag('2019-01-02'), close: 10 },
        { t: dag('2024-01-02'), close: 10 },
        { t: dag('2030-01-02'), close: 10 },
      ],
    },
  };
  const fxRates = { DKK: { ok: true, rate: 1 } };
  const adj = adjustHolding(holdings[0], { ok: true, splits: [], factors: FACTORS, dividends: [] });
  const { points } = computeValueHistory({ holdings, histories, fxRates, adjustments: { a: adj } });
  // Kursen står stille på 10, så al bevægelse kommer fra flere stk.
  assert.equal(points[0].value, 1000, 'i 2019 er der kun de 100 stk., man købte');
  assert.equal(points[1].value, round((100 * 1.1 / 1.02) * 10), '2024: faktoren er nede på 1,02');
  assert.equal(points[2].value, 1100, 'i dag: 10 % flere stk. for det geninvesterede udbytte');
  assert.ok(points[0].value < points[1].value && points[1].value < points[2].value, 'antallet vokser hen ad vejen');
});

// ---------- at gemme igen må ikke rette de samme tal to gange ----------

test('portefølje: de oprindelige tal sendes med, så Redigér kan vise dem', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', {
      symbol: 'AAPL',
      quantity: 10,
      lots: [{ date: '2019-06-01', quantity: 10, price: 400 }],
    });
    const pos = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.equal(pos.quantity, 40, 'det rettede tal vises');
    assert.equal(pos.enteredQuantity, 10, 'det skrevne tal følger med');
    assert.equal(pos.enteredLots.length, 1);
    assert.equal(pos.enteredLots[0].quantity, 10, 'købet står, som det blev skrevet');
    assert.equal(pos.enteredLots[0].price, 400);
    assert.equal(pos.lots[0].quantity, 40, 'mens det rettede køb er ganget op');
  } finally {
    server.close();
  }
});

test('Redigér: gemmes de oprindelige tal igen, ændrer tallene sig ikke', async () => {
  const { call, server } = await start();
  try {
    const id = (await call('POST', '/api/holdings', {
      symbol: 'AAPL',
      quantity: 10,
      lots: [{ date: '2019-06-01', quantity: 10, price: 400 }],
    })).json.holding.id;
    const før = (await call('GET', '/api/portfolio')).json.positions[0];

    // Præcis det dialogen sender: de skrevne køb, uændret.
    await call('PUT', `/api/holdings/${id}`, {
      lots: før.enteredLots.map((l) => ({ date: l.date, quantity: l.quantity, price: l.price })),
    });
    const efter = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.equal(efter.quantity, før.quantity, 'splittet er ikke talt med en gang til');
    assert.equal(efter.enteredQuantity, 10);
    assert.equal(efter.cost, før.cost);
  } finally {
    server.close();
  }
});
