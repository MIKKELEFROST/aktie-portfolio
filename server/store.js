// JSON-fil-lager med atomiske skrivninger (skriv til .tmp, omdøb).
// Alle mutationer serialiseres, så to samtidige kald aldrig overskriver hinanden.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export const DATA_VERSION = 1;

export function defaultPortfolio(baseCurrency = 'DKK') {
  return {
    version: DATA_VERSION,
    settings: { baseCurrency },
    holdings: [],
  };
}

class JsonFile {
  constructor(file, defaults, { backups = 0 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.backups = backups;
    this.cache = null;
    this.chain = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      this.cache = JSON.parse(text);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.cache = this.defaults();
    }
    return this.cache;
  }

  async write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    if (this.backups) await this.rotateBackups();
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    this.cache = data;
  }

  // Kopierer den nuværende fil til backups/<navn>-<tidsstempel>.json og beholder de nyeste `backups`.
  async rotateBackups() {
    const dir = path.join(path.dirname(this.file), 'backups');
    const base = path.basename(this.file, '.json');
    try {
      await fs.access(this.file);
    } catch {
      return; // intet at kopiere endnu
    }
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(this.file, path.join(dir, `${base}-${stamp}.json`));
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith(`${base}-`) && f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - this.backups))) {
      await fs.unlink(path.join(dir, old)).catch(() => {});
    }
  }

  // Kør en mutation serialiseret: fn(kopi) -> ny tilstand (eller undefined = uændret).
  update(fn) {
    const run = async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const result = await fn(draft);
      const next = result === undefined ? draft : result;
      await this.write(next);
      return next;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}

export function createStore(dataDir, { baseCurrency = 'DKK' } = {}) {
  const portfolioFile = new JsonFile(path.join(dataDir, 'portfolio.json'), () => defaultPortfolio(baseCurrency), { backups: 5 });
  const authFile = new JsonFile(path.join(dataDir, 'auth.json'), () => ({ passwordHash: null, sessionSecret: null }));

  return {
    dataDir,

    async getPortfolio() {
      const data = await portfolioFile.load();
      return migrate(data, baseCurrency);
    },

    updatePortfolio(fn) {
      return portfolioFile.update(async (draft) => {
        const migrated = migrate(draft, baseCurrency);
        const result = await fn(migrated);
        return result === undefined ? migrated : result;
      });
    },

    async getAuth() {
      return authFile.load();
    },

    updateAuth(fn) {
      return authFile.update(fn);
    },

    // Session-hemmelighed: fra miljø, ellers genereret én gang og gemt i auth.json.
    async getSessionSecret(envSecret) {
      if (envSecret) return envSecret;
      const auth = await authFile.load();
      if (auth.sessionSecret) return auth.sessionSecret;
      const updated = await authFile.update((draft) => {
        if (!draft.sessionSecret) draft.sessionSecret = randomBytes(32).toString('hex');
      });
      return updated.sessionSecret;
    },
  };
}

export function newId() {
  return randomUUID();
}

// Fremtidssikring: opgraderer ældre datafiler til nuværende form.
export function migrate(data, baseCurrency) {
  if (!data || typeof data !== 'object') return defaultPortfolio(baseCurrency);
  if (!data.settings || typeof data.settings !== 'object') data.settings = {};
  if (!data.settings.baseCurrency) data.settings.baseCurrency = baseCurrency;
  if (!Array.isArray(data.holdings)) data.holdings = [];
  if (!Array.isArray(data.settings.accounts)) data.settings.accounts = [];
  for (const h of data.holdings) if (h && h.accountId === undefined) h.accountId = null;
  data.version = DATA_VERSION;
  return data;
}
