import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockYahooClient } from '../server/yahoo-mock.js';

test('mock: kurser, GBp, fejl og stale', async () => {
  const y = createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') }); // tirsdag 12:00 i København
  const q = await y.getQuotes(['NOVO-B.CO', 'SHEL.L', 'DOWN.CO', 'STALE.CO', 'NIX']);
  assert.equal(q['NOVO-B.CO'].ok, true);
  assert.equal(q['NOVO-B.CO'].quote.marketOpen, true);
  assert.equal(q['SHEL.L'].quote.currency, 'GBP');
  assert.equal(q['SHEL.L'].quote.price, 35.36);
  assert.equal(q['DOWN.CO'].ok, false);
  assert.equal(q['DOWN.CO'].error.code, 'NETWORK');
  assert.equal(q['STALE.CO'].ok, true);
  assert.equal(q.NIX.error.code, 'NOT_FOUND');

  const again = await y.getQuotes(['STALE.CO']);
  assert.equal(again['STALE.CO'].ok, true);
  assert.equal(again['STALE.CO'].stale, true, 'anden gang fejler og falder tilbage på seneste kurs');
});

test('mock: weekend = lukket', async () => {
  const y = createMockYahooClient({ now: () => new Date('2026-09-12T10:00:00Z') }); // lørdag
  assert.equal((await y.getQuote('NOVO-B.CO')).marketOpen, false);
});

test('mock: fx, søgning og historik', async () => {
  const y = createMockYahooClient();
  assert.equal(await y.getFxRate('USD', 'DKK'), 6.42);
  assert.ok(Math.abs((await y.getFxRate('DKK', 'GBP')) - 1 / 8.7) < 1e-9, 'inverteret kurs');
  const fx = await y.getFxRates(['USD', 'XXX'], 'DKK');
  assert.equal(fx.USD.ok, true);
  assert.equal(fx.XXX.ok, false);
  const s = await y.search('mærsk');
  assert.equal(s[0].symbol, 'MAERSK-B.CO');
  const h = await y.getHistory('NOVO-B.CO', '1mo');
  assert.ok(h.points.length > 10);
  assert.equal(h.points.at(-1).close, 291);
  assert.equal((await y.getHistory('SHEL.L', '1mo')).currency, 'GBP');
});
