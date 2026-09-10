// Vercel-indgangen (api/index.js) vælger lager og adgangsform ud fra miljøet.
// Den kode kører kun på Vercel, så den prøves her med et rigtigt HTTP-kald.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Falsk PostgREST, så Supabase-stien kan prøves uden netværk.
function fakeDatabase({ fejl } = {}) {
  const rows = new Map();
  return async (url, opts) => {
    if (fejl) throw new Error(fejl);
    const fn = String(url).split('/').pop();
    const a = JSON.parse(opts.body);
    const ok = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
    if (fn === 'kv_get') {
      const r = rows.get(a.p_key);
      return ok(r ? [{ value: r.value, rev: r.rev }] : []);
    }
    if (fn === 'kv_cas') {
      const r = rows.get(a.p_key);
      if (r && r.rev !== a.p_rev) return ok(false);
      if (!r && a.p_rev) return ok(false);
      rows.set(a.p_key, { value: a.p_value, rev: a.p_new_rev });
      return ok(true);
    }
    return { ok: false, status: 404, text: async () => '{"message":"ukendt"}' };
  };
}

let sag = 0;

// Modulet læser miljøet ved indlæsning, så hvert tilfælde får sin egen kopi.
async function start(env, fetchImpl) {
  const DB = ['SUPABASE_URL', 'SUPABASE_KEY', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'DASHBOARD_PASSWORD', 'PUBLIC_ACCESS', 'PLATFORM'];
  const gemt = Object.fromEntries(DB.map((k) => [k, process.env[k]]));
  const rigtigFetch = globalThis.fetch;
  for (const k of DB) delete process.env[k];
  Object.assign(process.env, env);
  process.env.YAHOO_MOCK = '1';
  if (fetchImpl) globalThis.fetch = fetchImpl;

  const { default: handler } = await import(`../api/index.js?sag=${++sag}`);
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const k of DB) if (gemt[k] === undefined) delete process.env[k]; else process.env[k] = gemt[k];
  globalThis.fetch = rigtigFetch;

  let cookie = '';
  const call = async (method, path, body) => {
    const res = await rigtigFetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* siden er HTML eller ren tekst */
    }
    return { status: res.status, text, json, headers: res.headers };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('vercel uden database: browser-tilstand, siden svarer', async () => {
  const app = await start({});
  try {
    const status = await app.call('GET', '/api/auth/status');
    assert.equal(status.json.storage, 'browser');
    assert.equal(status.json.access, 'browser');
    const side = await app.call('GET', '/');
    assert.equal(side.status, 200, 'forsiden må ikke fejle, når der ingen database er');
    assert.match(side.headers.get('content-type'), /text\/html/);
  } finally {
    await app.close();
  }
});

test('vercel med database: platform med profiler, intet uden login', async () => {
  const app = await start({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_KEY: 'sb_publishable_x' }, fakeDatabase());
  try {
    const status = await app.call('GET', '/api/auth/status');
    assert.equal(status.json.storage, 'supabase');
    assert.equal(status.json.access, 'platform');
    assert.equal(status.json.authenticated, false);
    assert.equal(status.json.firstProfile, true, 'den første profil kræver ingen invitationskode');

    // Uden login er der ingen data og ingen forside.
    assert.equal((await app.call('GET', '/api/portfolio')).status, 401);
    assert.equal((await app.call('GET', '/')).headers.get('location'), '/login');
    assert.equal((await app.call('GET', '/login')).status, 200, 'log ind / tilmeld vises');

    const oprettet = await app.call('POST', '/api/auth/signup', { email: 'mig@eksempel.dk', password: 'min-lange-kode', name: 'Mig' });
    assert.equal(oprettet.status, 201);
    assert.equal(oprettet.json.user.name, 'Mig');
    assert.equal((await app.call('GET', '/api/auth/status')).json.authenticated, true);
    assert.equal((await app.call('GET', '/api/portfolio')).status, 200);
    assert.equal((await app.call('GET', '/')).status, 200);
  } finally {
    await app.close();
  }
});

test('vercel med PLATFORM=0 og adgangskode: ét dashboard med ét login', async () => {
  const app = await start(
    { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_KEY: 'sb_publishable_x', DASHBOARD_PASSWORD: 'hemmelig-kode-1', PLATFORM: '0' },
    fakeDatabase(),
  );
  try {
    const status = await app.call('GET', '/api/auth/status');
    assert.equal(status.json.access, 'login');
    assert.equal(status.json.usesEnvPassword, true);
    assert.equal((await app.call('GET', '/api/portfolio')).status, 401);
    assert.equal((await app.call('POST', '/api/auth/login', { password: 'hemmelig-kode-1' })).status, 200);
    assert.equal((await app.call('GET', '/api/portfolio')).status, 200);
  } finally {
    await app.close();
  }
});

test('vercel med database der ikke svarer: forklaring i stedet for stakspor', async () => {
  const app = await start(
    { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_KEY: 'sb_publishable_x' },
    fakeDatabase({ fejl: 'getaddrinfo ENOTFOUND' }),
  );
  try {
    const res = await app.call('GET', '/');
    assert.equal(res.status, 503);
    assert.match(res.text, /Databasen \(supabase\) svarer ikke/);
    assert.match(res.text, /SUPABASE_URL/);
    assert.doesNotMatch(res.text, /sb_publishable_x/, 'nøglen må ikke vises');
  } finally {
    await app.close();
  }
});
