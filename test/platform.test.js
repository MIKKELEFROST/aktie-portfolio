// Platformen: profiler, tilmelding med invitationskode, og hvem der må se hvad.
// Adgangskontrollen er det vigtigste her – en portefølje må aldrig kunne ses
// af nogen, ejeren ikke har sagt ja til.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

async function startPlatform() {
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-platform-')));
  const config = { envPassword: '', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK', platform: true, storageMode: 'file' };
  const app = createApp({ store, yahoo: createMockYahooClient({ now: () => new Date('2026-09-09T10:00:00Z') }), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Hver "browser" har sin egen cookie-krukke.
  const browser = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        redirect: 'manual',
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
    };
  };
  return { base, server, browser, store };
}

// Opretter en profil og returnerer dens kald-funktion og id.
async function signup(call, { email, password = 'en-lang-nok-kode', name, inviteCode }) {
  const res = await call('POST', '/api/auth/signup', { email, password, name, inviteCode });
  return { res, id: res.json?.user?.id };
}

test('platform: første profil er fri, resten kræver invitationskode', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    assert.equal((await far('GET', '/api/auth/status')).json.firstProfile, true);

    const første = await signup(far, { email: 'far@eksempel.dk', name: 'Far' });
    assert.equal(første.res.status, 201);
    assert.equal(første.res.json.user.isOwner, true, 'den første er ejeren');

    const status = await far('GET', '/api/auth/status');
    assert.equal(status.json.firstProfile, false);
    assert.equal(status.json.authenticated, true);

    // Ejeren har en invitationskode at dele ud af.
    const mig = await far('GET', '/api/me');
    const kode = mig.json.inviteCode;
    assert.match(kode, /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);

    const fremmed = browser();
    const uden = await signup(fremmed, { email: 'fremmed@eksempel.dk', name: 'Fremmed' });
    assert.equal(uden.res.status, 403, 'ingen kode, ingen profil');
    const forkert = await signup(fremmed, { email: 'fremmed@eksempel.dk', name: 'Fremmed', inviteCode: 'AAA-BBB-CCC' });
    assert.equal(forkert.res.status, 403);

    const søn = browser();
    const med = await signup(søn, { email: 'søn@eksempel.dk', name: 'Søn', inviteCode: kode });
    assert.equal(med.res.status, 201);
    assert.equal(med.res.json.user.isOwner, false);

    // Samme e-mail kan ikke bruges to gange.
    const igen = await signup(browser(), { email: 'søn@eksempel.dk', name: 'Kopi', inviteCode: kode });
    assert.equal(igen.res.status, 409);
  } finally {
    server.close();
  }
});

test('platform: hver profil har sin egen portefølje', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    await signup(far, { email: 'far@eksempel.dk', name: 'Far' });
    const kode = (await far('GET', '/api/me')).json.inviteCode;
    const søn = browser();
    await signup(søn, { email: 'søn@eksempel.dk', name: 'Søn', inviteCode: kode });

    assert.equal((await far('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200 })).status, 201);
    assert.equal((await søn('POST', '/api/holdings', { symbol: 'AAPL', quantity: 3, avgPrice: 150 })).status, 201);

    const farsAktier = (await far('GET', '/api/holdings')).json.holdings.map((h) => h.symbol);
    const sønsAktier = (await søn('GET', '/api/holdings')).json.holdings.map((h) => h.symbol);
    assert.deepEqual(farsAktier, ['NOVO-B.CO']);
    assert.deepEqual(sønsAktier, ['AAPL'], 'sønnen ser ikke farens aktier');
  } finally {
    server.close();
  }
});

test('platform: alle med en profil kan se hinandens porteføljer', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    const farId = (await signup(far, { email: 'far@eksempel.dk', name: 'Far' })).id;
    const kode = (await far('GET', '/api/me')).json.inviteCode;
    const søn = browser();
    const sønId = (await signup(søn, { email: 'søn@eksempel.dk', name: 'Søn', inviteCode: kode })).id;
    await far('POST', '/api/holdings', { symbol: 'NOVO-B.CO', quantity: 10, avgPrice: 200 });

    // Sønnen finder faren på listen – uden at skulle søge først.
    const alle = await søn('GET', '/api/people');
    assert.equal(alle.json.people.length, 1, 'man er ikke selv med på listen');
    assert.equal(alle.json.people[0].id, farId);
    assert.equal(alle.json.people[0].email, undefined, 'e-mail deles ikke med andre');

    // Og kan se porteføljen med det samme. Ingen anmodning, ingen godkendelse.
    const set = await søn('GET', `/api/users/${farId}/portfolio`);
    assert.equal(set.status, 200);
    assert.equal(set.json.person.name, 'Far');
    assert.equal(set.json.positions.length, 1);
    assert.equal(set.json.positions[0].symbol, 'NOVO-B.CO');
    assert.ok(set.json.totals.valueBase > 0, 'beløb er med');
    assert.equal((await søn('GET', `/api/users/${farId}/holdings`)).json.holdings[0].quantity, 10);
    assert.equal((await søn('GET', `/api/users/${farId}/portfolio/history?range=1mo`)).status, 200);

    // Begge veje: faren kan lige så godt se sønnens.
    assert.equal((await far('GET', `/api/users/${sønId}/portfolio`)).status, 200);

    // Men ingen kan ændre en andens portefølje: ruterne findes kun som GET.
    assert.equal((await søn('POST', `/api/users/${farId}/holdings`, { symbol: 'AAPL', quantity: 1 })).status, 405);
    assert.equal((await søn('DELETE', `/api/users/${farId}/holdings`)).status, 405);
    assert.equal((await søn('PUT', `/api/users/${farId}/portfolio`, {})).status, 405);

    // Og egne skrivninger rammer kun ens egen.
    await søn('POST', '/api/holdings', { symbol: 'AAPL', quantity: 3, avgPrice: 150 });
    assert.deepEqual((await far('GET', '/api/holdings')).json.holdings.map((h) => h.symbol), ['NOVO-B.CO']);
  } finally {
    server.close();
  }
});

test('platform: uden login er alt lukket', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    const farId = (await signup(far, { email: 'far@eksempel.dk', name: 'Far' })).id;

    const gæst = browser();
    for (const p of ['/api/portfolio', '/api/holdings', '/api/me', '/api/people', `/api/users/${farId}/portfolio`]) {
      assert.equal((await gæst('GET', p)).status, 401, p);
    }

    // En profil, der ikke findes, er en 404 – der er ikke længere noget at skjule.
    const kode = (await far('GET', '/api/me')).json.inviteCode;
    const søn = browser();
    await signup(søn, { email: 'søn@eksempel.dk', name: 'Søn', inviteCode: kode });
    assert.equal((await søn('GET', '/api/users/00000000-0000-4000-8000-000000000000/portfolio')).status, 404);
  } finally {
    server.close();
  }
});

test('platform: login, forkert kode og skift af adgangskode', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    await signup(far, { email: 'Far@Eksempel.dk', name: 'Far', password: 'den-rigtige-kode' });

    const ny = browser();
    const forkertKode = await ny('POST', '/api/auth/login', { email: 'far@eksempel.dk', password: 'noget-forkert' });
    const ukendtMail = await ny('POST', '/api/auth/login', { email: 'findes-ikke@eksempel.dk', password: 'noget-forkert' });
    assert.equal(forkertKode.status, 401);
    assert.equal(ukendtMail.status, 401);
    assert.equal(forkertKode.json.error, ukendtMail.json.error, 'samme svar, så e-mails ikke kan afsøges');

    // E-mail er ikke versalfølsom.
    assert.equal((await ny('POST', '/api/auth/login', { email: 'FAR@eksempel.dk', password: 'den-rigtige-kode' })).status, 200);
    assert.equal((await ny('GET', '/api/portfolio')).status, 200);

    // Skift af adgangskode: denne browser bliver, den anden ryger ud.
    assert.equal((await far('POST', '/api/auth/change-password', { currentPassword: 'forkert', newPassword: 'en-helt-ny-kode' })).status, 401);
    assert.equal((await far('POST', '/api/auth/change-password', { currentPassword: 'den-rigtige-kode', newPassword: 'en-helt-ny-kode' })).status, 200);
    assert.equal((await far('GET', '/api/portfolio')).status, 200, 'den browser man skiftede fra, forbliver inde');
    assert.equal((await ny('GET', '/api/portfolio')).status, 401, 'andre enheder logges ud');
  } finally {
    server.close();
  }
});

test('platform: kun ejeren kan lave en ny invitationskode', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    await signup(far, { email: 'far@eksempel.dk', name: 'Far' });
    const kode = (await far('GET', '/api/me')).json.inviteCode;
    const søn = browser();
    await signup(søn, { email: 'søn@eksempel.dk', name: 'Søn', inviteCode: kode });

    assert.equal((await søn('GET', '/api/me')).json.inviteCode, null, 'andre får ikke koden at se');
    assert.equal((await søn('POST', '/api/invite/rotate')).status, 403);

    const roteret = await far('POST', '/api/invite/rotate');
    assert.equal(roteret.status, 200);
    assert.notEqual(roteret.json.inviteCode, kode);

    // Den gamle kode virker ikke længere.
    assert.equal((await signup(browser(), { email: 'ny@eksempel.dk', name: 'Ny', inviteCode: kode })).res.status, 403);
    assert.equal((await signup(browser(), { email: 'ny@eksempel.dk', name: 'Ny', inviteCode: roteret.json.inviteCode })).res.status, 201);
  } finally {
    server.close();
  }
});

test('platform: listen viser alle og kan filtreres på navn eller hel e-mail', async () => {
  const { server, browser } = await startPlatform();
  try {
    const far = browser();
    await signup(far, { email: 'far@eksempel.dk', name: 'Far Frost' });
    const kode = (await far('GET', '/api/me')).json.inviteCode;
    for (const [navn, mail] of [['Søn Frost', 'søn@eksempel.dk'], ['Anna Berg', 'anna@eksempel.dk']]) {
      await signup(browser(), { email: mail, name: navn, inviteCode: kode });
    }

    const alle = (await far('GET', '/api/people')).json.people;
    assert.deepEqual(alle.map((p) => p.name), ['Anna Berg', 'Søn Frost'], 'alle andre, sorteret efter navn');

    assert.deepEqual((await far('GET', '/api/people?q=frost')).json.people.map((p) => p.name), ['Søn Frost']);
    assert.deepEqual((await far('GET', '/api/people?q=anna@eksempel.dk')).json.people.map((p) => p.name), ['Anna Berg'], 'hel e-mail virker');
    assert.deepEqual((await far('GET', '/api/people?q=findes-ikke')).json.people, []);
  } finally {
    server.close();
  }
});
