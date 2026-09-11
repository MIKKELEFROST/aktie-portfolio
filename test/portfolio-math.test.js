import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePortfolio, computeValueHistory, firstPurchaseDate, narrowRange, rangeDays, round } from '../server/portfolio-math.js';

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
  assert.deepEqual(history.points, [
    { date: '2026-01-01', value: 2 * 10 + 100 * 7, invested: 0 },
    { date: '2026-01-02', value: 2 * 11 + 100 * 7, invested: 0 },
    { date: '2026-01-03', value: 2 * 12 + 110 * 7, invested: 0 },
  ]);
  assert.deepEqual(history.backfilled, [], 'begge serier starter samme dag');
});

test('computeValueHistory: en kortere serie regnes med til sin første kurs', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 1 }, { symbol: 'B', quantity: 1 }],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(2), close: 11 }] },
      B: { currency: 'DKK', points: [{ t: day(2), close: 5 }] },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  // B begynder først dag 2. Dag 1 regnes med B's første kurs (5), så hele
  // perioden kan tegnes i stedet for at blive skåret af.
  assert.deepEqual(history.points, [
    { date: '2026-01-01', value: 10 + 5, invested: 0 },
    { date: '2026-01-02', value: 11 + 5, invested: 0 },
  ]);
  assert.deepEqual(history.backfilled, [{ symbol: 'B', from: '2026-01-02' }], 'det fortælles hvem der blev fyldt bagud');
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
  assert.deepEqual(ab.points, [
    { date: '2026-01-01', value: 10 + 5, invested: 0 }, // A fyldt bagud med sin første kurs
    { date: '2026-01-02', value: 10 + 5, invested: 0 },
    { date: '2026-01-03', value: 11 + 6, invested: 0 },
  ]);
});

test('computeValueHistory: hver dag omregnes med sin egen valutakurs', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const fælles = {
    holdings: [{ symbol: 'A', quantity: 10 }],
    histories: { A: { currency: 'USD', points: [{ t: day(1), close: 100 }, { t: day(2), close: 100 }, { t: day(3), close: 100 }] } },
    fxRates: { USD: { ok: true, rate: 7 } },
  };

  // Uden historik bruges dagens kurs hele vejen: kursen står stille, så værdien gør også.
  const fast = computeValueHistory(fælles);
  assert.deepEqual(fast.points.map((p) => p.value), [7000, 7000, 7000]);

  // Med historik følger værdien valutaen, selv om aktiekursen står stille.
  const historisk = computeValueHistory({
    ...fælles,
    fxHistories: { USD: { ok: true, points: [{ t: day(1), rate: 6 }, { t: day(2), rate: 7 }, { t: day(3), rate: 8 }] } },
  });
  assert.deepEqual(historisk.points.map((p) => p.value), [6000, 7000, 8000]);

  // Mangler en dag i valutaserien, bruges seneste kendte kurs.
  const huller = computeValueHistory({
    ...fælles,
    fxHistories: { USD: { ok: true, points: [{ t: day(1), rate: 6 }, { t: day(3), rate: 8 }] } },
  });
  assert.deepEqual(huller.points.map((p) => p.value), [6000, 6000, 8000]);

  // Fejler valutaserien, falder den tilbage til dagens kurs i stedet for at fejle.
  const fejlet = computeValueHistory({ ...fælles, fxHistories: { USD: { ok: false, error: { message: 'nede' } } } });
  assert.deepEqual(fejlet.points.map((p) => p.value), [7000, 7000, 7000]);
});

test('computeValueHistory: kurven starter ved første køb, ikke ved periodens start', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 2, purchasedAt: '2026-01-03' }],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(2), close: 11 }, { t: day(3), close: 12 }, { t: day(4), close: 13 }] },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.deepEqual(history.points, [
    { date: '2026-01-03', value: 24, invested: 0 },
    { date: '2026-01-04', value: 26, invested: 0 },
  ], 'de to dage før købet hører ikke til');
  assert.equal(history.ownedFrom, '2026-01-03');
});

test('computeValueHistory: uden købsdato klippes der ikke – vi ved ikke hvornår det begyndte', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 1, purchasedAt: '2026-01-03' }, { symbol: 'B', quantity: 1 }],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(3), close: 12 }] },
      B: { currency: 'DKK', points: [{ t: day(1), close: 5 }, { t: day(3), close: 6 }] },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.equal(history.points.length, 2);
  assert.equal(history.points[0].date, '2026-01-01');
  assert.equal(history.ownedFrom, null);
});

test('computeValueHistory: ældste køb bestemmer starten, ikke det nyeste', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 1, purchasedAt: '2026-01-02' }, { symbol: 'B', quantity: 1, purchasedAt: '2026-01-04' }],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(2), close: 11 }, { t: day(4), close: 12 }] },
      B: { currency: 'DKK', points: [{ t: day(1), close: 5 }, { t: day(2), close: 5 }, { t: day(4), close: 6 }] },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.equal(history.points[0].date, '2026-01-02');
  assert.equal(history.ownedFrom, '2026-01-02');
});

test('computeValueHistory: er alt købt i dag, står grafen ikke tom', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 1, purchasedAt: '2030-01-01' }],
    histories: { A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(2), close: 11 }, { t: day(3), close: 12 }] } },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.equal(history.points.length, 2, 'de sidste to dage beholdes');
  assert.equal(history.points[1].date, '2026-01-03');
});

test('computeValueHistory: bagudfyldning måles mod kurvens start, ikke periodens', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 1, purchasedAt: '2026-01-03' }, { symbol: 'B', quantity: 1, purchasedAt: '2026-01-03' }],
    histories: {
      A: { currency: 'DKK', points: [{ t: day(1), close: 10 }, { t: day(3), close: 12 }, { t: day(4), close: 13 }] },
      // B's kurser begynder dag 2 – men kurven begynder dag 3, så gættet ses ikke.
      B: { currency: 'DKK', points: [{ t: day(2), close: 5 }, { t: day(3), close: 6 }, { t: day(4), close: 7 }] },
    },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.deepEqual(history.backfilled, [], 'B dækker hele den viste periode');
});

test('narrowRange: en kort ejertid henter ikke ugebarer', () => {
  const nu = Date.parse('2026-09-11T10:00:00Z');
  // Købt for en måned siden: alle længere perioder snævres ind til 1mo, så
  // Yahoo svarer med dagsbarer i stedet for uger.
  for (const r of ['3mo', '6mo', 'ytd', '1y', '5y', 'max']) {
    assert.equal(narrowRange(r, '2026-08-13', nu), '1mo', `${r} skulle blive til 1mo`);
  }
  // 1M er allerede kortest – den skal stå.
  assert.equal(narrowRange('1mo', '2026-08-13', nu), '1mo');
});

test('narrowRange: en lang ejertid henter som der blev bedt om', () => {
  const nu = Date.parse('2026-09-11T10:00:00Z');
  for (const r of ['1mo', '3mo', '6mo', 'ytd', '1y', '5y', 'max']) {
    assert.equal(narrowRange(r, '2021-01-01', nu), r);
  }
});

test('narrowRange: uden købsdato røres perioden ikke', () => {
  const nu = Date.parse('2026-09-11T10:00:00Z');
  assert.equal(narrowRange('max', null, nu), 'max');
  assert.equal(narrowRange('1y', '', nu), '1y');
});

test('narrowRange: ejet i over fem år henter stadig hele historikken', () => {
  const nu = Date.parse('2026-09-11T10:00:00Z');
  assert.equal(narrowRange('max', '2010-01-01', nu), 'max');
  assert.equal(narrowRange('5y', '2010-01-01', nu), '5y');
});

test('rangeDays: ÅTD måles fra nytår, max er uendelig', () => {
  const nu = Date.parse('2026-09-11T10:00:00Z');
  assert.equal(rangeDays('ytd', nu), 254);
  assert.equal(rangeDays('max', nu), Infinity);
  assert.equal(rangeDays('6mo', nu), 186);
});

test('firstPurchaseDate: ældste dato, men kun når alle har en', () => {
  assert.equal(firstPurchaseDate([{ purchasedAt: '2024-05-01' }, { purchasedAt: '2023-01-09' }]), '2023-01-09');
  assert.equal(firstPurchaseDate([{ purchasedAt: '2024-05-01' }, { purchasedAt: null }]), null);
  assert.equal(firstPurchaseDate([]), null);
});

test('computeValueHistory: et køb midt i perioden giver et hop, ikke antal fra dag ét', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{
      symbol: 'A',
      quantity: 30,
      purchasedAt: '2026-01-02',
      lots: [
        { date: '2026-01-02', quantity: 10, price: 100 },
        { date: '2026-01-04', quantity: 20, price: 100 },
      ],
    }],
    histories: { A: { currency: 'DKK', points: [{ t: day(1), close: 100 }, { t: day(2), close: 100 }, { t: day(3), close: 100 }, { t: day(4), close: 100 }, { t: day(5), close: 100 }] } },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.deepEqual(history.points, [
    { date: '2026-01-02', value: 1000, invested: 1000 },
    { date: '2026-01-03', value: 1000, invested: 1000 },
    { date: '2026-01-04', value: 3000, invested: 3000 },
    { date: '2026-01-05', value: 3000, invested: 3000 },
  ], 'de 20 ekstra må først tælle med fra 4. januar');
});

test('computeValueHistory: kursændring før næste køb rammer kun det, man allerede ejede', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{
      symbol: 'A',
      quantity: 30,
      purchasedAt: '2026-01-01',
      lots: [
        { date: '2026-01-01', quantity: 10, price: 100 },
        { date: '2026-01-03', quantity: 20, price: 110 },
      ],
    }],
    histories: { A: { currency: 'DKK', points: [{ t: day(1), close: 100 }, { t: day(2), close: 110 }, { t: day(3), close: 110 }] } },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  // Dag 2: kun de 10 første er med, så +10 pr. stk. er 100 kr. – ikke 300.
  assert.deepEqual(history.points, [
    { date: '2026-01-01', value: 1000, invested: 1000 },
    { date: '2026-01-02', value: 1100, invested: 1000 },
    { date: '2026-01-03', value: 3300, invested: 1000 + 2200 },
  ]);
});

test('computeValueHistory: uden købsdato tæller hele beholdningen med hele vejen', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 10, avgPrice: 50 }],
    histories: { A: { currency: 'DKK', points: [{ t: day(1), close: 100 }, { t: day(2), close: 101 }] } },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.deepEqual(history.points, [
    { date: '2026-01-01', value: 1000, invested: 500 },
    { date: '2026-01-02', value: 1010, invested: 500 },
  ]);
});

test('computeValueHistory: et køb uden kurs tæller i antallet, men ikke i det investerede', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{
      symbol: 'A',
      quantity: 20,
      lots: [
        { date: '2026-01-01', quantity: 10, price: 100 },
        { date: '2026-01-01', quantity: 10, price: null },
      ],
    }],
    histories: { A: { currency: 'DKK', points: [{ t: day(1), close: 100 }] } },
    fxRates: { DKK: { ok: true, rate: 1 } },
  });
  assert.equal(history.points[0].value, 2000, 'begge portioner ejes');
  assert.equal(history.points[0].invested, 1000, 'kun det, vi kender kursen på');
});

test('computeValueHistory: det investerede følger med i en anden valuta', () => {
  const day = (d) => Date.parse(`2026-01-0${d}T08:00:00Z`);
  const history = computeValueHistory({
    holdings: [{ symbol: 'A', quantity: 10, avgPrice: 20, purchasedAt: '2026-01-01' }],
    histories: { A: { currency: 'USD', points: [{ t: day(1), close: 25 }] } },
    fxRates: { USD: { ok: true, rate: 7 } },
  });
  assert.equal(history.points[0].value, 10 * 25 * 7);
  assert.equal(history.points[0].invested, 10 * 20 * 7);
});
