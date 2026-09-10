// Supabase-lager (Postgres) via PostgREST. Bruges på Vercel, hvor der ingen disk er.
// Samme interface som store.js og store-redis.js. Ingen afhængigheder – kun fetch.
//
// Al adgang går gennem to database-funktioner, se docs/database.md:
//   kv_get(nøgle)                                  -> { value, rev }
//   kv_cas(nøgle, værdi, rev, ny rev, kopier)      -> true, eller false ved samtidig ændring
// Tabellerne er lukket for API-nøglen, så en lækket nøgle hverken kan slette data
// eller læse sikkerhedskopierne.

import { randomBytes } from 'node:crypto';
import { defaultPortfolio, migrate } from './store.js';

export function createSupabaseStore({ url, key, prefix = 'aktie', fetchImpl = globalThis.fetch, backups = 5 }) {
  if (!url || !key) throw new Error('Supabase-lager kræver URL og API-nøgle');
  const base = `${url.replace(/\/+$/, '')}/rest/v1/rpc`;

  async function rpc(fn, args) {
    let res;
    try {
      res = await fetchImpl(`${base}/${fn}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (err) {
      throw new Error(`Kunne ikke kontakte databasen: ${err.message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text).message || detail;
      } catch {
        /* svaret var ikke JSON – vis det rå */
      }
      throw new Error(`Databasen svarede HTTP ${res.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : null;
  }

  // kv_get returnerer en tabel, altså en liste med højst én række.
  async function read(key_) {
    const rows = await rpc('kv_get', { p_key: key_ });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row ? { value: row.value, rev: row.rev ?? '' } : { value: null, rev: '' };
  }

  const chain = { p: Promise.resolve() };

  // Serialiserer opdateringer i denne proces; på tværs af processer og enheder
  // sørger kv_cas for, at ingen skriver oven i en anden enheds ændring.
  function update(key_, defaults, fn, { keepBackups = 0 } = {}) {
    const run = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { value, rev } = await read(key_);
        const draft = structuredClone(value ?? defaults());
        const result = await fn(draft);
        const next = result === undefined ? draft : result;
        const newRev = `${Date.now()}-${randomBytes(4).toString('hex')}`;
        const ok = await rpc('kv_cas', { p_key: key_, p_value: next, p_rev: rev, p_new_rev: newRev, p_backups: keepBackups });
        if (ok === true) return next;
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
  const userKey = (userId) => `${prefix}:portfolio:${userId}`;
  const docKey = (name) => `${prefix}:${name}`;

  return {
    kind: 'supabase',

    async getUserPortfolio(userId, baseCurrency = 'DKK') {
      const { value } = await read(userKey(userId));
      return migrate(value ?? defaultPortfolio(baseCurrency), baseCurrency);
    },

    updateUserPortfolio(userId, fn, baseCurrency = 'DKK') {
      return update(userKey(userId), () => defaultPortfolio(baseCurrency), async (draft) => {
        const migrated = migrate(draft, baseCurrency);
        const result = await fn(migrated);
        return result === undefined ? migrated : result;
      }, { keepBackups: backups });
    },

    async deleteUserPortfolio(userId, baseCurrency = 'DKK') {
      await update(userKey(userId), () => defaultPortfolio(baseCurrency), () => defaultPortfolio(baseCurrency));
    },

    async getDoc(name, defaults) {
      const { value } = await read(docKey(name));
      return value ?? defaults();
    },

    updateDoc(name, defaults, fn) {
      return update(docKey(name), defaults, fn, { keepBackups: 3 });
    },

    async getPortfolio(baseCurrency = 'DKK') {
      const { value } = await read(PORTFOLIO);
      return migrate(value ?? defaultPortfolio(baseCurrency), baseCurrency);
    },

    updatePortfolio(fn, baseCurrency = 'DKK') {
      return update(PORTFOLIO, () => defaultPortfolio(baseCurrency), async (draft) => {
        const migrated = migrate(draft, baseCurrency);
        const result = await fn(migrated);
        return result === undefined ? migrated : result;
      }, { keepBackups: backups });
    },

    async getAuth() {
      const { value } = await read(AUTH);
      return value ?? defaultAuth();
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
