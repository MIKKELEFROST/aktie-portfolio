// Køb for køb: samme aktie købt ad flere omgange, hver med sin egen dato,
// sit eget antal og sin egen kurs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';
import { reduceLots, summarizeLots } from '../server/portfolio-math.js';

async function start() {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-lots-')));
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

// ---------- regnestykket ----------

test('summarizeLots: antal lægges sammen, kursen vægtes efter antal', () => {
  const sum = summarizeLots([
    { date: '2024-01-10', quantity: 10, price: 100 },
    { date: '2024-07-10', quantity: 30, price: 200 },
  ]);
  assert.equal(sum.count, 2);
  assert.equal(sum.quantity, 40);
  assert.equal(sum.avgPrice, 175); // (10*100 + 30*200) / 40
  assert.equal(sum.purchasedAt, '2024-01-10');
});

test('summarizeLots: den vægtede dato følger pengene, ikke antallet af køb', () => {
  // 1.000 kr. i januar og 9.000 kr. i november: tyngden ligger tæt på november.
  const sum = summarizeLots([
    { date: '2024-01-01', quantity: 10, price: 100 },
    { date: '2024-11-01', quantity: 90, price: 100 },
  ]);
  assert.equal(sum.purchasedAt, '2024-01-01');
  assert.ok(sum.weightedAt > '2024-09-30', `forventede sent på året, fik ${sum.weightedAt}`);
  assert.ok(sum.weightedAt < '2024-11-02');
});

test('summarizeLots: et køb uden kurs tæller med i antallet, men ikke i gennemsnittet', () => {
  // Number(null) er 0 og består Number.isFinite – uden null-tjek ville
  // gennemsnittet blive trukket ned mod nul af det kursløse køb.
  const sum = summarizeLots([
    { date: '2024-01-10', quantity: 10, price: 100 },
    { date: '2024-02-10', quantity: 10, price: null },
  ]);
  assert.equal(sum.quantity, 20);
  assert.equal(sum.avgPrice, 100);
});

test('summarizeLots: mangler der dato på ét køb, er købsdatoen ukendt', () => {
  const sum = summarizeLots([
    { date: '2024-01-10', quantity: 10, price: 100 },
    { date: null, quantity: 10, price: 120 },
  ]);
  assert.equal(sum.missingDates, 1);
  assert.equal(sum.purchasedAt, null, 'må ikke påstå at beholdningen er fra januar');
  assert.equal(sum.weightedAt, null);
  assert.equal(sum.quantity, 20);
});

test('summarizeLots: uden gyldige køb er der ingenting at regne på', () => {
  assert.equal(summarizeLots([]), null);
  assert.equal(summarizeLots(null), null);
  assert.equal(summarizeLots([{ quantity: 0, date: '2024-01-01' }]), null);
});

test('reduceLots: salg skrumper alle køb forholdsmæssigt', () => {
  const lots = [
    { date: '2020-01-01', quantity: 10, price: 100 },
    { date: '2024-01-01', quantity: 30, price: 200 },
  ];
  const rest = reduceLots(lots, 20); // halvdelen solgt
  assert.equal(rest.length, 2);
  assert.equal(rest[0].quantity, 5);
  assert.equal(rest[1].quantity, 15);
  // Gennemsnitskurs og datoer skal stå helt stille efter et salg.
  assert.equal(summarizeLots(rest).avgPrice, summarizeLots(lots).avgPrice);
  assert.equal(summarizeLots(rest).weightedAt, summarizeLots(lots).weightedAt);
});

test('reduceLots: sælger man det hele, er der ingen køb tilbage', () => {
  assert.deepEqual(reduceLots([{ date: '2024-01-01', quantity: 5 }], 5), []);
  assert.deepEqual(reduceLots([{ date: '2024-01-01', quantity: 5 }], 9), []);
});

// ---------- gennem API'et ----------

test('køb for køb: antal og gennemsnitskurs regnes ud af købene', async () => {
  const { call, server } = await start();
  try {
    const tilføjet = await call('POST', '/api/holdings', {
      symbol: 'NOVO-B.CO',
      quantity: 1, // bliver overskrevet af købene
      avgPrice: 999,
      lots: [
        { date: '2024-07-10', quantity: 30, price: 200 },
        { date: '2024-01-10', quantity: 10, price: 100 },
      ],
    });
    assert.equal(tilføjet.status, 201);
    const h = tilføjet.json.holding;
    assert.equal(h.quantity, 40);
    assert.equal(h.avgPrice, 175);
    assert.equal(h.purchasedAt, '2024-01-10');
    assert.equal(h.lots.length, 2);
    assert.equal(h.lots[0].date, '2024-01-10', 'ældste køb først');
    assert.ok(h.lots[0].id, 'hvert køb får sit eget id');
  } finally {
    server.close();
  }
});

test('køb for køb: kan skrives ind og fjernes igen på en eksisterende aktie', async () => {
  const { call, server } = await start();
  try {
    const id = (await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 100, purchasedAt: '2024-01-10' })).json.holding.id;

    const med = await call('PUT', `/api/holdings/${id}`, {
      lots: [
        { date: '2024-01-10', quantity: 10, price: 100 },
        { date: '2024-06-10', quantity: 10, price: 300 },
      ],
    });
    assert.equal(med.json.holding.quantity, 20);
    assert.equal(med.json.holding.avgPrice, 200);

    // Tom liste slår det fra igen – så gælder det, man taster.
    const uden = await call('PUT', `/api/holdings/${id}`, { lots: [], quantity: 20, avgPrice: 200, purchasedAt: '2024-01-10' });
    assert.equal(uden.json.holding.lots, null);
    assert.equal(uden.json.holding.weightedAt, null);
    assert.equal(uden.json.holding.quantity, 20);
    assert.equal(uden.json.holding.avgPrice, 200);
  } finally {
    server.close();
  }
});

test('køb til med dato: købet lægges i listen sammen med det, man havde i forvejen', async () => {
  const { call, server } = await start();
  try {
    const id = (await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 100, purchasedAt: '2024-01-10' })).json.holding.id;
    const efter = await call('POST', `/api/holdings/${id}/trade`, { type: 'buy', quantity: 10, price: 300, date: '2024-06-10' });
    assert.equal(efter.status, 200);
    assert.equal(efter.json.holding.lots.length, 2);
    assert.equal(efter.json.holding.quantity, 20);
    assert.equal(efter.json.holding.avgPrice, 200);
    assert.equal(efter.json.holding.purchasedAt, '2024-01-10', 'det gamle køb beholder sin dato');
  } finally {
    server.close();
  }
});

test('køb til uden dato: opfører sig præcis som før – ingen købsliste', async () => {
  const { call, server } = await start();
  try {
    const id = (await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 100 })).json.holding.id;
    const efter = await call('POST', `/api/holdings/${id}/trade`, { type: 'buy', quantity: 10, price: 300 });
    assert.equal(efter.json.holding.lots, null);
    assert.equal(efter.json.holding.quantity, 20);
    assert.equal(efter.json.holding.avgPrice, 200);
  } finally {
    server.close();
  }
});

test('salg: købene skrumper, men gennemsnitskursen og datoen står stille', async () => {
  const { call, server } = await start();
  try {
    const id = (await call('POST', '/api/holdings', {
      symbol: 'NOVO-B.CO',
      quantity: 40,
      lots: [
        { date: '2024-01-10', quantity: 10, price: 100 },
        { date: '2024-07-10', quantity: 30, price: 200 },
      ],
    })).json.holding.id;

    const efter = await call('POST', `/api/holdings/${id}/trade`, { type: 'sell', quantity: 20 });
    assert.equal(efter.json.holding.quantity, 20);
    assert.equal(efter.json.holding.avgPrice, 175, 'gennemsnitsmetoden: et salg flytter ikke kursen');
    assert.equal(efter.json.holding.purchasedAt, '2024-01-10');
    assert.deepEqual(efter.json.holding.lots.map((l) => l.quantity), [5, 15]);
  } finally {
    server.close();
  }
});

test('afkast pr. år regnes fra den vægtede dato, ejertid fra det første køb', async () => {
  const { call, server } = await start();
  try {
    const forDageSiden = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    // Et lille køb for fire år siden og et stort for et halvt år siden.
    await call('POST', '/api/holdings', {
      symbol: 'NOVO-B.CO',
      quantity: 100,
      lots: [
        { date: forDageSiden(1460), quantity: 1, price: 100 },
        { date: forDageSiden(180), quantity: 99, price: 100 },
      ],
    });
    const p = (await call('GET', '/api/portfolio')).json.positions[0];
    assert.ok(p.heldDays >= 1459, `ejertid skal tælle fra første køb, fik ${p.heldDays}`);
    assert.ok(p.moneyDays < 250, `pengene har kun været inde ca. et halvt år, fik ${p.moneyDays}`);
    assert.ok(p.moneyDays > 150);
  } finally {
    server.close();
  }
});

test('sikkerhedskopi: købene følger med ud og ind igen', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', {
      symbol: 'NOVO-B.CO',
      quantity: 40,
      lots: [
        { date: '2024-01-10', quantity: 10, price: 100 },
        { date: '2024-07-10', quantity: 30, price: 200 },
      ],
    });
    const kopi = (await call('GET', '/api/backup')).json;
    assert.equal(kopi.holdings[0].lots.length, 2);

    await call('POST', '/api/restore', kopi);
    const h = (await call('GET', '/api/holdings')).json.holdings[0];
    assert.equal(h.lots.length, 2);
    assert.equal(h.quantity, 40);
    assert.equal(h.avgPrice, 175);
    assert.equal(h.purchasedAt, '2024-01-10');
  } finally {
    server.close();
  }
});

test('køb afvises pænt, hvis antallet mangler eller listen er for lang', async () => {
  const { call, server } = await start();
  try {
    const uden = await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 5, lots: [{ date: '2024-01-10', price: 100 }] });
    assert.equal(uden.status, 400);
    assert.match(uden.json.error, /Antal i køb nr\. 1/);

    const mange = await call('POST', '/api/holdings', {
      symbol: 'MAERSK-B.CO',
      quantity: 5,
      lots: Array.from({ length: 101 }, () => ({ date: '2024-01-10', quantity: 1, price: 100 })),
    });
    assert.equal(mange.status, 400);
    assert.match(mange.json.error, /højst registreres 100 køb/i);
  } finally {
    server.close();
  }
});

test('browser-tilstand: compute regner også ud fra de enkelte køb', async () => {
  const config = { envPassword: '', sessionSecret: '', storageMode: 'browser', baseCurrency: 'DKK', setupToken: 'x' };
  const app = createApp({ store: null, yahoo: createMockYahooClient(), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        holdings: [{
          symbol: 'NOVO-B.CO',
          quantity: 1,
          avgPrice: 999,
          lots: [
            { date: '2024-01-10', quantity: 10, price: 100 },
            { date: '2024-07-10', quantity: 30, price: 200 },
          ],
        }],
        settings: { baseCurrency: 'DKK' },
      }),
    });
    assert.equal(res.status, 200);
    const p = (await res.json()).positions[0];
    assert.equal(p.quantity, 40);
    assert.equal(p.avgPrice, 175);
    assert.equal(p.purchasedAt, '2024-01-10');
  } finally {
    server.close();
  }
});

test('graf: perioden starter ved første køb, uanset hvilken knap der vælges', async () => {
  const { call, server } = await start();
  try {
    const forDageSiden = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const købt = forDageSiden(30);
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250, purchasedAt: købt });

    for (const range of ['6mo', '1y', 'max']) {
      const h = (await call('GET', `/api/portfolio/history?range=${range}`)).json;
      assert.ok(h.points[0].date >= købt, `${range}: kurven starter ${h.points[0].date}, men købet var ${købt}`);
      assert.equal(h.ownedFrom, købt, `${range}: skal fortælle klienten hvorfor perioden er kortere`);
      assert.equal(h.range, range, 'den valgte periode meldes tilbage uændret');
      // De lange perioder leveres i ugebarer. Hentes de uændret og klippes
      // bagefter, bliver en måneds ejertid til en håndfuld punkter – derfor
      // skal perioden snævres ind, så der kommer dagsbarer.
      assert.ok(h.points.length >= 10, `${range}: kun ${h.points.length} punkter – det ligner ugebarer`);
    }
  } finally {
    server.close();
  }
});

test('graf: købt i sidste uge – kurven begynder dér, ikke hvor hentningen begyndte', async () => {
  const { call, server } = await start();
  try {
    // Fem dage er kortere end selv den mindste periode, der kan hentes, så her
    // er det klipningen – ikke indsnævringen – der skal holde kurven på plads.
    const købt = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250, purchasedAt: købt });
    const h = (await call('GET', '/api/portfolio/history?range=1y')).json;
    assert.ok(h.points[0].date >= købt, `kurven starter ${h.points[0].date}, men købet var ${købt}`);
    assert.ok(h.points.length >= 2, 'grafen må ikke stå tom');
    assert.equal(h.ownedFrom, købt);
  } finally {
    server.close();
  }
});

test('graf: uden købsdato vises hele den valgte periode', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250 });
    const h = (await call('GET', '/api/portfolio/history?range=1y')).json;
    assert.equal(h.ownedFrom, null);
    // Uden købsdato hentes hele perioden. Hvor langt Yahoo (her: mock'en) rækker
    // tilbage, er ikke vores at love – men den må ikke være klippet til et par uger.
    const treMånederSiden = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    assert.ok(h.points[0].date < treMånederSiden, `forventede hele perioden, men kurven starter ${h.points[0].date}`);
  } finally {
    server.close();
  }
});

test('graf: mangler datoen på én af to, klippes der ikke', async () => {
  const { call, server } = await start();
  try {
    const købt = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250, purchasedAt: købt });
    await call('POST', '/api/holdings', { symbol: 'MAERSK-B.CO', quantity: 1, avgPrice: 12000 });
    const h = (await call('GET', '/api/portfolio/history?range=1y')).json;
    assert.equal(h.ownedFrom, null, 'vi ved ikke hvornår den uden dato blev købt');
    assert.ok(h.points[0].date < købt, `forventede hele perioden, men kurven starter ${h.points[0].date}`);
  } finally {
    server.close();
  }
});

test('graf: de enkelte køb giver et hop den dag, der blev købt til', async () => {
  const { call, server } = await start();
  try {
    const dag = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const gammelt = dag(60);
    const nyt = dag(10);
    await call('POST', '/api/holdings', {
      symbol: 'NOVO-B.CO',
      quantity: 100,
      lots: [
        { date: gammelt, quantity: 10, price: 250 },
        { date: nyt, quantity: 90, price: 280 },
      ],
    });

    const h = (await call('GET', '/api/portfolio/history?range=6mo')).json;
    const før = h.points.filter((p) => p.date < nyt);
    const efter = h.points.filter((p) => p.date >= nyt);
    assert.ok(før.length && efter.length, 'der skal være dage på begge sider af købet');

    // Før det store køb ejede man kun 10 stk. – værdien skal svare til det.
    const sidsteFør = før[før.length - 1];
    const førsteEfter = efter[0];
    assert.ok(førsteEfter.value > sidsteFør.value * 5, `intet hop: ${sidsteFør.value} → ${førsteEfter.value}`);
    assert.equal(sidsteFør.invested, 2500, 'kun det første køb var lagt ind endnu');
    assert.equal(førsteEfter.invested, 2500 + 90 * 280);
    assert.equal(h.points[0].invested, 2500);
  } finally {
    server.close();
  }
});

test('graf: uden købsdato tæller hele beholdningen med i hele perioden', async () => {
  const { call, server } = await start();
  try {
    await call('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 250 });
    const h = (await call('GET', '/api/portfolio/history?range=6mo')).json;
    const værdier = h.points.map((p) => p.invested);
    assert.deepEqual([...new Set(værdier)], [2500], 'det indsatte må ikke trappe, når vi ikke kender datoen');
  } finally {
    server.close();
  }
});

test('graf: et køb få dage før første kurs får stadig sin markør', async () => {
  const { call, server } = await start();
  try {
    // Købt for 70 dage siden. Perioden snævres ind til 3 måneder, men Yahoo
    // leverer ikke altid helt så mange dage – markøren skal med alligevel.
    const købt = new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10);
    const senere = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    await call('POST', '/api/holdings', {
      symbol: 'NOVO-B.CO',
      quantity: 50,
      lots: [
        { date: købt, quantity: 10, price: 250 },
        { date: senere, quantity: 40, price: 280 },
      ],
    });
    const h = (await call('GET', '/api/portfolio/history?range=6mo')).json;
    assert.deepEqual(h.events.map((e) => e.date), [købt, senere], 'begge køb skal kunne ses');
  } finally {
    server.close();
  }
});
