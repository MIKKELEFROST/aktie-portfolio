import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecurity, resolveSecurities, cleanSecurityName, nameVariants, isinCountry } from '../server/resolve.js';

// Falsk Yahoo: kender ISIN for nogle papirer, navn for andre, og flere børser pr. papir.
const LISTINGS = {
  META: { symbol: 'META', name: 'Meta Platforms, Inc.', exchange: 'NASDAQ', currency: 'USD' },
  'META.SW': { symbol: 'META.SW', name: 'Meta Platforms, Inc.', exchange: 'Swiss', currency: 'CHF' },
  TSM: { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Company Limited', exchange: 'NYSE', currency: 'USD' },
  '2330.TW': { symbol: '2330.TW', name: 'TSMC', exchange: 'Taiwan', currency: 'TWD' },
  'NOVO-B.CO': { symbol: 'NOVO-B.CO', name: 'Novo Nordisk A/S', exchange: 'Copenhagen', currency: 'DKK' },
  'NOVC.DE': { symbol: 'NOVC.DE', name: 'Novo Nordisk', exchange: 'XETRA', currency: 'EUR' },
  'SHEL.L': { symbol: 'SHEL.L', name: 'Shell plc', exchange: 'LSE', currency: 'GBP' },
};
const BY_ISIN = { US30303M1027: ['META.SW', 'META'], DK0060534915: ['NOVC.DE', 'NOVO-B.CO'], GB00BP6MXD84: ['SHEL.L'] };
const BY_NAME = { 'meta platforms': ['META.SW'], 'taiwan semiconductor manufacturing': ['TSM', '2330.TW'], 'novo nordisk b': ['NOVO-B.CO'] };

function fakeYahoo({ failQuote = [] } = {}) {
  const calls = [];
  return {
    calls,
    async search(q) {
      calls.push(`search:${q}`);
      const key = q.trim().toLowerCase();
      const symbols = BY_ISIN[q.trim().toUpperCase()] || BY_NAME[key] || [];
      return symbols.map((s) => ({ symbol: s, name: LISTINGS[s].name, exchange: LISTINGS[s].exchange, type: 'EQUITY' }));
    },
    async getQuote(symbol) {
      calls.push(`quote:${symbol}`);
      if (failQuote.includes(symbol)) throw new Error('ingen kurs');
      return LISTINGS[symbol];
    },
  };
}

test('ISIN vinder over navn, og valutaen afgør hvilken børs der vælges', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurity(y, { isin: 'US30303M1027', name: 'Meta Platforms A', currency: 'USD' });
  assert.equal(r.symbol, 'META', 'den amerikanske notering, ikke den schweiziske');
  assert.equal(r.currency, 'USD');
  assert.equal(r.matchedBy, 'isin');
  assert.equal(r.currencyMismatch, false);
  assert.ok(y.calls.includes('search:US30303M1027'));
  assert.ok(y.calls.some((c) => c.startsWith('search:Meta')), 'navnet slås også op for at finde andre børser');
});

test('uden ISIN-match bruges navnet, og "ADR" fjernes', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurity(y, { isin: 'US8740391003', name: 'Taiwan Semiconductor Manufacturing ADR', currency: 'USD' });
  assert.equal(r.symbol, 'TSM');
  assert.equal(r.matchedBy, 'navn');
});

test('ISIN-landet rangerer børserne: dansk ISIN giver København', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurity(y, { isin: 'DK0060534915', name: 'Novo Nordisk B', currency: 'DKK' });
  assert.equal(r.symbol, 'NOVO-B.CO');
  assert.equal(r.exchange, 'Copenhagen');
});

test('pence noteres som GBP og tæller som samme valuta', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurity(y, { isin: 'GB00BP6MXD84', name: 'Shell', currency: 'GBX' });
  assert.equal(r.symbol, 'SHEL.L');
  assert.equal(r.currencyMismatch, false);
});

test('kun forkert valuta til rådighed: symbolet gives med, men markeres', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurity(y, { isin: '', name: 'Meta Platforms', currency: 'USD' });
  assert.equal(r.symbol, 'META.SW');
  assert.equal(r.currencyMismatch, true);
});

test('ukendt papir giver intet symbol i stedet for at fejle', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurity(y, { isin: 'XX0000000000', name: 'Findes Ikke A/S', currency: 'DKK' });
  assert.equal(r.symbol, null);
  assert.equal(r.name, 'Findes Ikke A/S');
});

test('kurs-fejl på den bedste kandidat springer videre til den næste', async () => {
  const y = fakeYahoo({ failQuote: ['NOVO-B.CO'] });
  const r = await resolveSecurity(y, { isin: 'DK0060534915', name: 'Novo Nordisk B', currency: 'DKK' });
  assert.equal(r.symbol, 'NOVC.DE');
  assert.equal(r.currencyMismatch, true, 'EUR passer ikke til DKK');
});

test('flere papirer ad gangen', async () => {
  const y = fakeYahoo();
  const r = await resolveSecurities(y, [
    { isin: 'US30303M1027', name: 'Meta Platforms A', currency: 'USD' },
    { isin: '', name: 'Taiwan Semiconductor Manufacturing ADR', currency: 'USD' },
  ]);
  assert.deepEqual(r.map((x) => x.symbol), ['META', 'TSM']);
});

test('hjælpefunktioner', () => {
  assert.equal(cleanSecurityName('Taiwan Semiconductor Manufacturing ADR'), 'Taiwan Semiconductor Manufacturing');
  assert.deepEqual(nameVariants('Meta Platforms A'), ['Meta Platforms A', 'Meta Platforms']);
  assert.deepEqual(nameVariants('NVIDIA'), ['NVIDIA']);
  assert.equal(isinCountry('US30303M1027'), 'US');
  assert.equal(isinCountry('ikke en isin'), null);
});

test('handlens valuta vælger hovedmarkedet, fx XETRA frem for Stuttgart', async () => {
  const listings = {
    'ETF.DE': { symbol: 'ETF.DE', name: 'iShares AI ETF', exchange: 'XETRA', currency: 'EUR' },
    'ETF.SG': { symbol: 'ETF.SG', name: 'iShares AI ETF', exchange: 'Stuttgart', currency: 'EUR' },
    'ETF.L': { symbol: 'ETF.L', name: 'iShares AI ETF', exchange: 'LSE', currency: 'USD' },
  };
  const y = {
    async search() {
      // Yahoo returnerer Stuttgart først; rangeringen skal rette op på det.
      return [listings['ETF.SG'], listings['ETF.L'], listings['ETF.DE']].map((l) => ({ symbol: l.symbol, name: l.name, exchange: l.exchange, type: 'ETF' }));
    },
    async getQuote(s) { return listings[s]; },
  };
  const r = await resolveSecurity(y, { isin: 'IE000X59ZHE2', name: 'iShares AI Infrastructure UCITS ETF', currency: 'EUR' });
  assert.equal(r.symbol, 'ETF.DE');
  assert.equal(r.exchange, 'XETRA');
});

test('ISIN-pladsholdere rangeres sidst, og navnet slås op for at finde en rigtig ticker', async () => {
  const listings = {
    'IE000I8KRLL9.SG': { symbol: 'IE000I8KRLL9.SG', name: 'VUV/USD', exchange: 'Stuttgart', currency: 'EUR' },
    'SEMI.AS': { symbol: 'SEMI.AS', name: 'iShares MSCI Global Semiconductors UCITS ETF', exchange: 'Amsterdam', currency: 'EUR' },
  };
  const searched = [];
  const y = {
    async search(q) {
      searched.push(q);
      if (q === 'IE000I8KRLL9') return [{ symbol: 'IE000I8KRLL9.SG', name: 'VUV/USD', exchange: 'Stuttgart', type: 'ETF' }];
      return [{ symbol: 'SEMI.AS', name: listings['SEMI.AS'].name, exchange: 'Amsterdam', type: 'ETF' }];
    },
    async getQuote(s) { return listings[s]; },
  };
  const r = await resolveSecurity(y, { isin: 'IE000I8KRLL9', name: 'iShares MSCI Global Semiconductors UCITS ETF USD (Acc)', currency: 'EUR' });
  assert.equal(r.symbol, 'SEMI.AS');
  assert.ok(searched.length > 1, 'navnet blev også slået op');
});

test('namesDisagree markerer noteringer med åbenlyst forkert navn', async () => {
  const { namesDisagree } = await import('../server/resolve.js');
  assert.equal(namesDisagree('Xtrackers NASDAQ 100 ETF 1C', 'VUV/USD'), true);
  assert.equal(namesDisagree('Micron Technology', 'Micron Technology, Inc.'), false);
  assert.equal(namesDisagree('iShares AI Infrastructure UCITS ETF USD (Acc)', 'iShares AI Infrastructure UCITS ETF USD (Acc)'), false);
  assert.equal(namesDisagree('Meta Platforms A', 'Meta Platforms, Inc.'), false);
  assert.equal(namesDisagree('', 'hvad som helst'), false);
});
