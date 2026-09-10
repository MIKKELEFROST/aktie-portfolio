// Redis-lager via Upstash' REST-API (bruges på Vercel, hvor der ingen disk er).
// Samme interface som store.js. Ingen afhængigheder – kun fetch.
//
// Nøgler: <prefix>:portfolio, <prefix>:auth (+ ":rev" til optimistisk låsning, ":backups" liste).

import { randomBytes } from 'node:crypto';
import { defaultPortfolio, migrate } from './store.js';

// Skriver kun hvis revisionen stadig er den, vi læste (compare-and-set).
const CAS_SCRIPT = `
local rev = redis.call('GET', KEYS[2])
if rev and rev ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[3])
return 1`;

export function createRedisStore({ url, token, prefix = 'aktie', fetchImpl = globalThis.fetch, backups = 5 }) {
  if (!url || !token) throw new Error('Redis-lager kræver URL og token');
  const base = url.replace(/\/+$/, '');

  async function cmd(...args) {
    let res;
    try {
      res = await fetchImpl(base, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (err) {
      throw new Error(`Kunne ikke kontakte databasen: ${err.message}`);
    }
    if (!res.ok) throw new Error(`Databasen svarede HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`Database-fejl: ${json.error}`);
    return json.result;
  }

  const chain = { p: Promise.resolve() };

  // Serialiserer opdateringer i denne proces og bruger CAS mod databasen på tværs af processer.
  function update(key, defaults, fn, { keepBackups = 0 } = {}) {
    const run = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const [raw, rev] = await Promise.all([cmd('GET', key), cmd('GET', `${key}:rev`)]);
        const current = raw ? JSON.parse(raw) : defaults();
        const draft = structuredClone(current);
        const result = await fn(draft);
        const next = result === undefined ? draft : result;
        const newRev = `${Date.now()}-${randomBytes(4).toString('hex')}`;
        const ok = await cmd('EVAL', CAS_SCRIPT, 2, key, `${key}:rev`, JSON.stringify(next), rev ?? '', newRev);
        if (ok === 1) {
          if (keepBackups && raw) {
            await cmd('LPUSH', `${key}:backups`, raw);
            await cmd('LTRIM', `${key}:backups`, 0, keepBackups - 1);
          }
          return next;
        }
      }
      throw new Error('Kunne ikke gemme – en anden enhed ændrede data samtidig. Prøv igen.');
    };
    const p = chain.p.then(run, run);
    chain.p = p.catch(() => {});
    return p;
  }

  const PORTFOLIO = `${prefix}:portfolio`;
  const AUTH = `${prefix}:auth`;
  const defaultAuth = () => ({ passwordHash: null, sessionSecret: null });

  return {
    kind: 'redis',

    async getPortfolio(baseCurrency = 'DKK') {
      const raw = await cmd('GET', PORTFOLIO);
      return migrate(raw ? JSON.parse(raw) : defaultPortfolio(baseCurrency), baseCurrency);
    },

    updatePortfolio(fn, baseCurrency = 'DKK') {
      return update(PORTFOLIO, () => defaultPortfolio(baseCurrency), async (draft) => {
        const migrated = migrate(draft, baseCurrency);
        const result = await fn(migrated);
        return result === undefined ? migrated : result;
      }, { keepBackups: backups });
    },

    async getAuth() {
      const raw = await cmd('GET', AUTH);
      return raw ? JSON.parse(raw) : defaultAuth();
    },

    updateAuth(fn) {
      return update(AUTH, defaultAuth, fn);
    },

    async getSessionSecret(envSecret) {
      if (envSecret) return envSecret;
      const auth = await this.getAuth();
      if (auth.sessionSecret) return auth.sessionSecret;
      const updated = await this.updateAuth((draft) => {
        if (!draft.sessionSecret) draft.sessionSecret = randomBytes(32).toString('hex');
      });
      return updated.sessionSecret;
    },
  };
}
