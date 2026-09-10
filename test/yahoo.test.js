import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChartMeta, transliterate } from '../server/yahoo.js';

const baseMeta = {
  currency: 'DKK',
  symbol: 'NOVO-B.CO',
  exchangeName: 'CPH',
  fullExchangeName: 'Copenhagen',
  instrumentType: 'EQUITY',
  regularMarketTime: 1788961878,
  regularMarketPrice: 290.45,
  regularMarketChangePercent: -0.531,
  chartPreviousClose: 292,
  regularMarketDayHigh: 291.35,
  regularMarketDayLow: 287.8,
  fiftyTwoWeekHigh: 409.95,
  fiftyTwoWeekLow: 224.25,
  longName: 'Novo Nordisk A/S',
  shortName: 'Novo Nordisk B A/S',
  exchangeTimezoneName: 'Europe/Copenhagen',
  currentTradingPeriod: { regular: { start: 1788937200, end: 1788966000 } },
};

test('normalizeChartMeta: almindelig aktie', () => {
  const q = normalizeChartMeta(baseMeta, 1788950000);
  assert.equal(q.symbol, 'NOVO-B.CO');
  assert.equal(q.name, 'Novo Nordisk A/S');
  assert.equal(q.currency, 'DKK');
  assert.equal(q.price, 290.45);
  assert.equal(q.previousClose, 292);
  assert.ok(Math.abs(q.change - -1.55) < 1e-9);
  assert.ok(Math.abs(q.changePercent - (-1.55 / 292) * 100) < 1e-9);
  assert.equal(q.marketOpen, true);
  assert.equal(q.exchange, 'Copenhagen');
  assert.equal(q.marketTime, '2026-09-09T13:51:18.000Z');
});

test('normalizeChartMeta: marked lukket uden for handelsperioden', () => {
  assert.equal(normalizeChartMeta(baseMeta, 1788966000).marketOpen, false);
  assert.equal(normalizeChartMeta(baseMeta, 1788937199).marketOpen, false);
  assert.equal(normalizeChartMeta({ ...baseMeta, currentTradingPeriod: undefined }, 1).marketOpen, null);
});

test('normalizeChartMeta: GBp (pence) omregnes til GBP', () => {
  const q = normalizeChartMeta({
    ...baseMeta,
    symbol: 'SHEL.L',
    currency: 'GBp',
    regularMarketPrice: 3536,
    chartPreviousClose: 3500.5,
    regularMarketDayHigh: 3550,
    regularMarketDayLow: 3500,
    fiftyTwoWeekHigh: 4000,
    fiftyTwoWeekLow: 2000,
  });
  assert.equal(q.currency, 'GBP');
  assert.equal(q.rawCurrency, 'GBp');
  assert.equal(q.price, 35.36);
  assert.equal(q.previousClose, 35.005);
  assert.equal(q.dayHigh, 35.5);
  assert.equal(q.fiftyTwoWeekLow, 20);
  assert.ok(Math.abs(q.change - 0.355) < 1e-9);
});

test('normalizeChartMeta: manglende felter giver null i stedet for NaN', () => {
  const q = normalizeChartMeta({ currency: 'USD', symbol: 'X', regularMarketPrice: 10 });
  assert.equal(q.previousClose, null);
  assert.equal(q.change, null);
  assert.equal(q.changePercent, null);
  assert.equal(q.name, 'X');
  assert.equal(q.marketTime, null);
});

test('transliterate: danske bogstaver', () => {
  assert.equal(transliterate('Mærsk Ørsted Ålborg'), 'Maersk Orsted Aalborg');
  assert.equal(transliterate('novo'), 'novo');
});

test('weekStart: ugentlige bars lægges på mandag uanset børs', async () => {
  const { weekStart } = await import('../server/yahoo.js');
  assert.equal(weekStart(Date.parse('2026-09-06T22:00:00Z')), Date.parse('2026-09-07T00:00:00Z'), 'europæisk søndags-bar');
  assert.equal(weekStart(Date.parse('2026-09-07T13:30:00Z')), Date.parse('2026-09-07T00:00:00Z'), 'amerikansk mandags-bar');
});
