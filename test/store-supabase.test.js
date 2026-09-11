import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore } from '../server/store-supabase.js';

// Falsk PostgREST i hukommelsen med samme opførsel som kv_get/kv_cas i databasen.
function fakeSupabase() {
  const rows = new Map(); // nøgle -> { value, rev }
  const backups = new Map(); // nøgle -> [værdier, nyeste først]
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const fn = url.split('/').pop();
    const a = JSON.parse(opts.body);
    calls.push(fn);
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (fn === 'kv_get') {
      const row = rows.get(a.p_key);
      return ok(row ? [{ value: row.value, rev: row.rev }] : []); // "returns table" giver en liste
    }
    if (fn === 'kv_cas') {
      const row = rows.get(a.p_key);
      if (!row) {
        if (a.p_rev) return ok(false);
        rows.set(a.p_key, { value: a.p_value, rev: a.p_new_rev });
        return ok(true);
      }
      if (row.rev !== a.p_rev) return ok(false);
      if (a.p_backups > 0) {
        const list = backups.get(a.p_key) || [];
        list.unshift(row.value);
        backups.set(a.p_key, list.slice(0, a.p_backups));
      }
      rows.set(a.p_key, { value: a.p_value, rev: a.p_new_rev });
      return ok(true);
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: `ukendt funktion ${fn}` }) };
  };
  return { rows, backups, calls, fetchImpl };
}

const opts = (fake, extra = {}) => ({ url: 'https://projekt.supabase.co', key: 'sb_publishable_x', fetchImpl: fake.fetchImpl, ...extra });

test('supabase-lager: standarddata, opdateringer, backups og session-nøgle', async () => {
  const fake = fakeSupabase();
  const store = createSupabaseStore(opts(fake, { backups: 2 }));
  assert.equal(store.kind, 'supabase');

  const initial = await store.getPortfolio('DKK');
  assert.deepEqual(initial.holdings, []);
  assert.equal(initial.settings.baseCurrency, 'DKK');
  assert.equal(fake.rows.size, 0, 'en ren læsning skriver ikke');

  await Promise.all([
    store.updatePortfolio((p) => { p.holdings.push({ id: 'a', symbol: 'A' }); }),
    store.updatePortfolio((p) => { p.holdings.push({ id: 'b', symbol: 'B' }); }),
    store.updatePortfolio((p) => { p.holdings.push({ id: 'c', symbol: 'C' }); }),
  ]);
  const after = await store.getPortfolio('DKK');
  assert.deepEqual(after.holdings.map((h) => h.id), ['a', 'b', 'c'], 'samtidige skrivninger går ikke tabt');
  assert.equal(fake.backups.get('aktie:portfolio').length, 2, 'højst 2 sikkerhedskopier');

  const s1 = await store.getSessionSecret();
  assert.equal(s1, await store.getSessionSecret());
  assert.equal(s1.length, 64);
  assert.equal(await store.getSessionSecret('env'), 'env');

  await store.updateAuth((a) => { a.passwordHash = 'h'; });
  assert.equal((await store.getAuth()).passwordHash, 'h');
});

test('supabase-lager: ændring fra en anden enhed giver nyt forsøg (CAS)', async () => {
  const fake = fakeSupabase();
  const store = createSupabaseStore(opts(fake));

  await store.updatePortfolio((p) => { p.settings.cash = 1; });
  let indblanding = 0;
  await store.updatePortfolio((p) => {
    // Første gennemløb: en anden enhed når at gemme, før vi selv gør.
    if (indblanding++ === 0) fake.rows.set('aktie:portfolio', { value: { ...fake.rows.get('aktie:portfolio').value, cashFraAnden: true }, rev: 'anden-enhed' });
    p.settings.cash = 2;
  });
  assert.equal(indblanding, 2, 'skrivningen blev prøvet igen');
  const final = await store.getPortfolio('DKK');
  assert.equal(final.settings.cash, 2);
  assert.equal(final.cashFraAnden, true, 'den anden enheds ændring blev ikke overskrevet');
});

test('supabase-lager: fejl fra databasen forklares på dansk', async () => {
  const nede = createSupabaseStore(opts({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }));
  await assert.rejects(nede.getAuth(), /Kunne ikke kontakte databasen/);

  const spærret = createSupabaseStore(opts({
    fetchImpl: async () => ({ ok: false, status: 402, text: async () => JSON.stringify({ message: 'exceed_egress_quota' }) }),
  }));
  await assert.rejects(spærret.getAuth(), /HTTP 402: exceed_egress_quota/);

  assert.throws(() => createSupabaseStore({ url: '', key: '' }), /kræver URL og API-nøgle/);
});

test('storage: Supabase vælges før Redis, Redis før fil', async () => {
  const { createStoreFromConfig, supabaseConfigFromEnv, databaseModeFromEnv } = await import('../server/storage.js');
  const cfg = { baseCurrency: 'DKK', dataDir: '/tmp/x' };
  const supabaseEnv = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_KEY: 'sb_publishable_x' };

  assert.equal(supabaseConfigFromEnv({}), null);
  assert.equal(supabaseConfigFromEnv({ SUPABASE_URL: 'https://p.supabase.co' }), null, 'nøgle mangler');
  assert.deepEqual(supabaseConfigFromEnv(supabaseEnv), { url: 'https://p.supabase.co', key: 'sb_publishable_x', prefix: 'aktie' });
  assert.equal(supabaseConfigFromEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://p.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a' })?.key, 'a', 'Supabase-integrationens egne navne');

  assert.equal(databaseModeFromEnv({}), null);
  assert.equal(databaseModeFromEnv(supabaseEnv), 'supabase');
  assert.equal(databaseModeFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }), 'redis');
  assert.equal(databaseModeFromEnv({ ...supabaseEnv, KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }), 'supabase');

  assert.equal(createStoreFromConfig(cfg, supabaseEnv).kind, 'supabase');
  assert.equal(createStoreFromConfig(cfg, { KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }).kind, 'redis');
  assert.equal(createStoreFromConfig(cfg, {}).kind, undefined, 'ingen database: fil-lager');
});
