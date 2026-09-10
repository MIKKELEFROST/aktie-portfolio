import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePortfolio, computeValueHistory, round } from '../server/portfolio-math.js';

const quote = (symbol, currency, price, change, extra = {}) => ({
  ok: true,
  stale: false,
  quote: { symbol, name: symbol, currency, price, change, changePercent: (change / (price - change)) * 100, marketOpen: true, ...extra },
});

test('computePortfolio: to aktier i forskellige valutaer', () => {
  const result = computePortfolio({
    baseCurrency: 'DKK',
    holdings: [
      { id: '1', symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250 },
      { id: '2', symbol: 'AAPL', quantity: 2, avgPrice: 150 },
    ],
    quotes: {
      'NOVO-B.CO': quote('NOVO-B.CO', 'DKK', 300, -3),
      AAPL: quote('AAPL', 'USD', 200, 4),
    },
    fxRates: { DKK: { ok: true, rate: 1 }, USD: { ok: true, rate: 7 } },
  });

  const [novo, aapl] = result.positions;
  assert.equal(novo.value, 3000);
  assert.equal(novo.valueBase, 3000);
  assert.equal(novo.gain, 500);
  assert.equal(novo.gainPercent, 20);
  assert.equal(novo.dayChangeBase, -30);
  assert.equal(novo.status, 'ok');

  assert.equal(aapl.value, 400);
  assert.equal(aapl.valueBase, 2800);
  assert.equal(aapl.costBase, 2100);
  assert.equal(aapl.gainBase, 700);
  assert.equal(aapl.dayChangeBase, 56);
  assert.equal(aapl.fxRate, 7);

  const t = result.totals;
  assert.equal(t.valueBase, 5800);
  assert.equal(t.costBase, 4600);
  assert.equal(t.gainBase, 1200);
  assert.ok(Math.abs(t.gainPercent - (1200 / 4600) * 100) < 1e-9);
  assert.equal(t.dayChangeBase, 26);
  // Gårsdagens værdi: 5800 - 26 = 5774
  assert.ok(Math.abs(t.dayChangePercent - (26 / 5774) * 100) < 1e-9);
  assert.ok(Math.abs(novo.weight - (3000 / 5800) * 100) < 1e-9);
  assert.ok(Math.abs(aapl.weight - (2800 / 5800) * 100) < 1e-9);
  assert.equal(t.incomplete, false);
  assert.equal(t.okCount, 2);
  assert.equal(t.errorCount, 0);
});

test('computePortfolio: position uden kurs markeres og udelades fra totaler', () => {
  const result = computePortfolio({
    baseCurrency: 'DKK',
    holdings: [
      { id: '1', symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250 },
      { id: '2', symbol: 'UKENDT', quantity: 5, avgPrice: 10 },
    ],
    quotes: {
      'NOVO-B.CO': quote('NOVO-B.CO', 'DKK', 300, 0),
      UKENDT: { ok: false, error: { code: 'NOT_FOUND', message: 'Ukendt symbol' } },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  const bad = result.positions[1];
  assert.equal(bad.status, 'error');
  assert.equal(bad.error.code, 'NOT_FOUND');
  assert.equal(bad.valueBase, null);
  assert.equal(bad.weight, null);
  assert.equal(result.totals.valueBase, 3000);
  assert.equal(result.totals.incomplete, true);
  assert.equal(result.totals.errorCount, 1);
  assert.equal(result.positions[0].weight, 100);
});

test('computePortfolio: forældet kurs (stale) og manglende valutakurs', () => {
  const result = computePortfolio({
    baseCurrency: 'DKK',
    holdings: [
      { id: '1', symbol: 'AAPL', quantity: 1, avgPrice: 100 },
      { id: '2', symbol: 'SAP.DE', quantity: 1, avgPrice: 100 },
    ],
    quotes: {
      AAPL: { ...quote('AAPL', 'USD', 200, 1), stale: true },
      'SAP.DE': quote('SAP.DE', 'EUR', 150, 1),
    },
    fxRates: { USD: { ok: true, rate: 7 }, EUR: { ok: false, error: { code: 'TIMEOUT', message: 'timeout' } } },
  });
  assert.equal(result.positions[0].status, 'stale');
  assert.equal(result.positions[0].valueBase, 1400);
  assert.equal(result.positions[1].status, 'fx_error');
  assert.equal(result.positions[1].value, 150, 'værdi i egen valuta kendes stadig');
  assert.equal(result.positions[1].valueBase, null);
  assert.equal(result.totals.hasStale, true);
  assert.equal(result.totals.incomplete, true);
});

test('computePortfolio: uden købskurs gives ingen afkast, men værdi', () => {
  const result = computePortfolio({
    baseCurrency: 'DKK',
    holdings: [{ id: '1', symbol: 'NOVO-B.CO', quantity: 10, avgPrice: null }],
    quotes: { 'NOVO-B.CO': quote('NOVO-B.CO', 'DKK', 300, 0) },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.equal(result.positions[0].valueBase, 3000);
  assert.equal(result.positions[0].gain, null);
  assert.equal(result.totals.gainBase, null);
  assert.equal(result.totals.gainPercent, null);
  assert.equal(result.totals.incomplete, true);
});

test('computePortfolio: tom portefølje', () => {
  const result = computePortfolio({ baseCurrency: 'DKK', holdings: [], quotes: {}, fxRates: {} });
  assert.equal(result.totals.valueBase, 0);
  assert.equal(result.totals.gainBase, null);
  assert.equal(result.totals.dayChangeBase, null);
  assert.equal(result.totals.positionCount, 0);
});

test('computeValueHistory: summerer på tværs af serier med forward fill', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [
      { symbol: 'A', quantity: 2 },
      { symbol: 'B', quantity: 1 },
    ],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(2), close: 11 }, { t: day(3), close: 12 }] },
      B: { currency: 'USD', points: [{ t: day(1), close: 100 }, { t: day(3), close: 110 }] }, // dag 2 mangler (helligdag)
    },
    fxRates: { DKK: { ok: true, rate: 1 }, USD: { ok: true, rate: 7 } },
  });
  assert.deepEqual(history, [
    { date: '2026-01-01', value: 2 * 10 + 100 * 7 },
    { date: '2026-01-02', value: 2 * 11 + 100 * 7 },
    { date: '2026-01-03', value: 2 * 12 + 110 * 7 },
  ]);
});

test('computeValueHistory: dage før alle serier har data udelades', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 1 }, { symbol: 'B', quantity: 1 }],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(2), close: 11 }] },
      B: { currency: 'DKK', points: [{ t: day(2), close: 5 }] },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.deepEqual(history, [{ date: '2026-01-02', value: 16 }]);
});

test('round', () => {
  assert.equal(round(1.005), 1.01);
  assert.equal(round(1234.5678, 1), 1234.6);
  assert.equal(round(null), null);
  assert.equal(round(NaN), null);
});

test('parseDanishNumber: danske og engelske formater', async () => {
  const { parseDanishNumber } = await import('../server/portfolio-math.js');
  assert.equal(parseDanishNumber('1.234,50'), 1234.5);
  assert.equal(parseDanishNumber('1234,5'), 1234.5);
  assert.equal(parseDanishNumber('1234.56'), 1234.56);
  assert.equal(parseDanishNumber('1.234'), 1234);
  assert.equal(parseDanishNumber('1.234.567'), 1234567);
  assert.equal(parseDanishNumber('0.4321'), 0.4321);
  assert.equal(parseDanishNumber('0,4321'), 0.4321);
  assert.equal(parseDanishNumber(' 612,50 '), 612.5);
  assert.equal(parseDanishNumber(42), 42);
  assert.equal(parseDanishNumber(''), null);
  assert.equal(parseDanishNumber(null), null);
  assert.ok(Number.isNaN(parseDanishNumber('abc')));
  assert.ok(Number.isNaN(parseDanishNumber('1e5')));
  assert.ok(Number.isNaN(parseDanishNumber('1,234,567')));
});

test('computePortfolio: afkast tæller kun positioner med kendt købskurs', () => {
  const result = computePortfolio({
    baseCurrency: 'DKK',
    holdings: [
      { id: 'a', symbol: 'A', quantity: 10, avgPrice: 800 },
      { id: 'b', symbol: 'B', quantity: 10, avgPrice: null },
    ],
    quotes: { A: quote('A', 'DKK', 1000, 0), B: quote('B', 'DKK', 500, 0) },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.equal(result.totals.valueBase, 15000);
  assert.equal(result.totals.costBase, 8000);
  assert.equal(result.totals.gainBase, 2000, 'B uden købskurs må ikke tælle som ren gevinst');
  assert.equal(result.totals.gainPercent, 25);
  assert.equal(result.totals.incomplete, true);
});

test('computeValueHistory: rækkefølge af beholdninger påvirker ikke resultatet', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const histories = {
    A: { currency: 'DKK', points: [{ t: day(2), close: 10 }, { t: day(3), close: 11 }] },
    B: { currency: 'DKK', points: [{ t: day(1), close: 5 }, { t: day(3), close: 6 }] },
  };
  const fx = { DKK: { ok: true, rate: 1 } };
  const ab = computeValueHistory({ holdings: [{ symbol: 'A', quantity: 1 }, { symbol: 'B', quantity: 1 }], histories, fxRates: fx });
  const ba = computeValueHistory({ holdings: [{ symbol: 'B', quantity: 1 }, { symbol: 'A', quantity: 1 }], histories, fxRates: fx });
  assert.deepEqual(ab, ba);
  assert.deepEqual(ab, [{ date: '2026-01-02', value: 15 }, { date: '2026-01-03', value: 17 }]);
});
