import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisStore } from '../server/store-redis.js';

// Falsk Upstash REST-server i hukommelsen: POST med ["CMD", ...args] → { result }
function fakeUpstash() {
  const db = new Map();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const [cmd, ...a] = JSON.parse(opts.body);
    calls.push(cmd);
    let result = null;
    switch (cmd) {
      case 'GET': result = db.has(a[0]) ? db.get(a[0]) : null; break;
      case 'SET': db.set(a[0], a[1]); result = 'OK'; break;
      case 'LPUSH': { const list = db.get(a[0]) || []; list.unshift(a[1]); db.set(a[0], list); result = list.length; break; }
      case 'LTRIM': { const list = db.get(a[0]) || []; db.set(a[0], list.slice(a[1], a[2] + 1)); result = 'OK'; break; }
      case 'EVAL': {
        // CAS-scriptet: KEYS=[key, revKey], ARGV=[value, expectedRev, newRev]
        const [, , key, revKey, value, expectedRev, newRev] = a;
        const rev = db.has(revKey) ? db.get(revKey) : null;
        if (rev !== null && rev !== expectedRev) { result = 0; break; }
        db.set(key, value); db.set(revKey, newRev); result = 1; break;
      }
      default: return { ok: false, status: 400, json: async () => ({ error: `ukendt ${cmd}` }) };
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { db, calls, fetchImpl };
}

test('redis-lager: standarddata, opdateringer, backups og session-nøgle', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://example.upstash.io', token: 't', fetchImpl: fake.fetchImpl, backups: 2 });

  const initial = await store.getPortfolio('DKK');
  assert.deepEqual(initial.holdings, []);
  assert.equal(initial.settings.baseCurrency, 'DKK');

  await Promise.all([
    store.updatePortfolio((p) => { p.holdings.push({ id: 'a', symbol: 'A' }); }),
    store.updatePortfolio((p) => { p.holdings.push({ id: 'b', symbol: 'B' }); }),
    store.updatePortfolio((p) => { p.holdings.push({ id: 'c', symbol: 'C' }); }),
  ]);
  const after = await store.getPortfolio('DKK');
  assert.deepEqual(after.holdings.map((h) => h.id), ['a', 'b', 'c']);
  assert.equal(fake.db.get('aktie:portfolio:backups').length, 2, 'højst 2 backups');
  assert.ok(fake.db.get('aktie:portfolio:rev'));

  const s1 = await store.getSessionSecret();
  const s2 = await store.getSessionSecret();
  assert.equal(s1, s2);
  assert.equal(s1.length, 64);
  assert.equal(await store.getSessionSecret('env'), 'env');

  await store.updateAuth((a) => { a.passwordHash = 'h'; });
  assert.equal((await store.getAuth()).passwordHash, 'h');
});

test('redis-lager: samtidig ændring fra anden proces giver nyt forsøg (CAS)', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://example.upstash.io', token: 't', fetchImpl: fake.fetchImpl });
  await store.updatePortfolio((p) => { p.holdings.push({ id: 'a', symbol: 'A' }); });
  // Simulér en anden proces, der skriver mellem vores GET og EVAL
  let injected = false;
  const original = fake.fetchImpl;
  const wrapped = async (url, opts) => {
    const [cmd] = JSON.parse(opts.body);
    if (cmd === 'EVAL' && !injected) {
      injected = true;
      const other = JSON.parse(fake.db.get('aktie:portfolio'));
      other.holdings.push({ id: 'x', symbol: 'X' });
      fake.db.set('aktie:portfolio', JSON.stringify(other));
      fake.db.set('aktie:portfolio:rev', 'anden-proces');
    }
    return original(url, opts);
  };
  const store2 = createRedisStore({ url: 'https://example.upstash.io', token: 't', fetchImpl: wrapped });
  await store2.updatePortfolio((p) => { p.holdings.push({ id: 'b', symbol: 'B' }); });
  const final = await store2.getPortfolio('DKK');
  assert.deepEqual(final.holdings.map((h) => h.id).sort(), ['a', 'b', 'x'], 'ingen ændring går tabt');
});

test('redis-lager: fejl fra databasen bliver til læselige fejl', async () => {
  const store = createRedisStore({ url: 'https://example.upstash.io', token: 't', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(store.getPortfolio('DKK'), /HTTP 401/);
  const store2 = createRedisStore({ url: 'https://example.upstash.io', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(store2.getAuth(), /Kunne ikke kontakte databasen/);
});

test('storage: vælger Redis når miljøvariabler findes, ellers fil', async () => {
  const { createStoreFromConfig, redisConfigFromEnv } = await import('../server/storage.js');
  assert.equal(redisConfigFromEnv({}), null);
  assert.deepEqual(redisConfigFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }), { url: 'https://x', token: 't', prefix: 'aktie' });
  assert.equal(redisConfigFromEnv({ UPSTASH_REDIS_REST_URL: 'https://y', UPSTASH_REDIS_REST_TOKEN: 'u' }).url, 'https://y');
  const redisStore = createStoreFromConfig({ baseCurrency: 'EUR', dataDir: '/tmp/x' }, { KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' });
  assert.equal(redisStore.kind, 'redis');
  const fileStore = createStoreFromConfig({ baseCurrency: 'EUR', dataDir: '/tmp/x' }, {});
  assert.equal(fileStore.kind, undefined);
});

test('storage: genkender Upstash-variabler med brugerdefineret præfiks og ignorerer redis://', async () => {
  const { redisConfigFromEnv, describeStorageEnv } = await import('../server/storage.js');
  assert.equal(redisConfigFromEnv({ MINDB_KV_REST_API_URL: 'https://x.upstash.io', MINDB_KV_REST_API_TOKEN: 'tok' })?.url, 'https://x.upstash.io');
  assert.equal(redisConfigFromEnv({ KV_URL: 'redis://:pw@host:6379', REDIS_URL: 'redis://x' }), null, 'kun REST-adresser bruges');
  assert.equal(redisConfigFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: '' }), null, 'token mangler');
  assert.deepEqual(describeStorageEnv({ KV_URL: 'a', PATH: 'b', UPSTASH_REDIS_REST_TOKEN: 'c' }), ['KV_URL', 'UPSTASH_REDIS_REST_TOKEN']);
});
