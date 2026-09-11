// Startpunkt: læser konfiguration, opretter lager + Yahoo-klient og starter HTTP-serveren.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, promises as fs, constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { createStoreFromConfig, databaseModeFromEnv } from './storage.js';
import { createYahooClient } from './yahoo.js';
import { createMockYahooClient } from './yahoo-mock.js';

// Læser en .env-fil (KEY=VALUE pr. linje) uden at overskrive allerede satte variabler.
export function loadDotEnv(file = path.resolve('.env'), env = process.env) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    envPassword: env.DASHBOARD_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    quoteTtlMs: Math.max(10, Number(env.QUOTE_CACHE_SECONDS) || 60) * 1000,
    baseCurrency: (env.BASE_CURRENCY || 'DKK').toUpperCase(),
    secureCookies: env.SECURE_COOKIES === '1' || env.SECURE_COOKIES === 'true',
    mockYahoo: env.YAHOO_MOCK === '1' || env.YAHOO_MOCK === 'true',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    publicAccess: env.PUBLIC_ACCESS === '1' || env.PUBLIC_ACCESS === 'true',
    // Profiler med hver sin portefølje. Kræver en database; sæt PLATFORM=0 for at
    // køre som ét enkelt dashboard med én adgangskode.
    platform: env.PLATFORM !== '0' && env.PLATFORM !== 'false',
    setupToken: env.SETUP_TOKEN || randomBytes(12).toString('hex'),
    storageMode: env.STORAGE === 'browser' ? 'browser' : null, // null = vælges ud fra miljøet (fil/redis)
    warmCache: env.WARM_CACHE !== '0',
  };
}

// Cache-opvarmning: mens nogen har kigget på dashboardet for nylig og mindst
// én børs er åben, genhentes kurserne i baggrunden, så browserens kald rammer cachen.
export function startCacheWarmer({ store, yahoo, config, logger = console }) {
  const IDLE_AFTER_MS = 10 * 60_000;
  let lastClientRequest = 0;
  let running = false;

  async function tick() {
    if (running || Date.now() - lastClientRequest > IDLE_AFTER_MS) return;
    running = true;
    try {
      const data = await store.getPortfolio();
      const symbols = data.holdings.map((h) => h.symbol);
      if (!symbols.length) return;
      const quotes = await yahoo.getQuotes(symbols, { refresh: true });
      const anyOpen = Object.values(quotes).some((q) => q.ok && q.quote.marketOpen === true);
      if (!anyOpen) lastClientRequest = 0; // Ingen grund til at hente igen før næste besøg.
      const currencies = Object.values(quotes).filter((q) => q.ok).map((q) => q.quote.currency);
      if (currencies.length) await yahoo.getFxRates(currencies, data.settings.baseCurrency);
    } catch (err) {
      logger.warn('Cache-opvarmning fejlede:', err.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, Math.max(15_000, config.quoteTtlMs - 5_000));
  timer.unref();
  return {
    touch() {
      lastClientRequest = Date.now();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export async function startServer(config = loadConfig()) {
  const database = databaseModeFromEnv(); // 'supabase', 'redis' eller null
  if (!config.storageMode) config.storageMode = database || 'file';
  if (!database && config.storageMode === 'file') {
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.access(config.dataDir, fsConstants.W_OK);
    } catch (err) {
      console.error(`DATA_DIR ${config.dataDir} kan ikke bruges (${err.code || err.message}). Tjek stien og rettigheder (i Docker: mappen skal kunne skrives af uid 1000).`);
      process.exit(1);
    }
  }
  const store = createStoreFromConfig(config);
  const yahoo = config.mockYahoo ? createMockYahooClient() : createYahooClient({ quoteTtlMs: config.quoteTtlMs });
  const warmer = config.warmCache && !config.mockYahoo ? startCacheWarmer({ store, yahoo, config }) : null;
  const app = createApp({ store, yahoo, config, onPortfolioRequest: warmer ? () => warmer.touch() : null });
  const server = http.createServer(app);
  server.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`Aktie-portfolio kører på http://${shownHost}:${config.port}`);
    console.log(config.storageMode === 'browser' ? 'STORAGE=browser: data gemmes i brugerens browser, intet login.' : database === 'supabase' ? 'Data gemmes i Supabase' : database === 'redis' ? 'Data gemmes i Redis (Upstash)' : `Data gemmes i ${config.dataDir}`);
    const platform = config.platform && config.storageMode !== 'browser';
    if (platform) console.log('Platform: hver profil har sin egen portefølje. Den første profil oprettes uden invitationskode.');
    if (!platform && config.publicAccess && config.storageMode !== 'browser') console.log('PUBLIC_ACCESS=1: ingen login – alle med adressen kan se og ændre porteføljen.');
    if (config.mockYahoo) console.log('YAHOO_MOCK=1: bruger falske kurser (ingen kald til Yahoo Finance).');
    if (!config.envPassword && config.storageMode !== 'browser' && !config.publicAccess && !platform) {
      store.getAuth().then((auth) => {
        if (auth.passwordHash) return;
        console.log('Ingen adgangskode endnu – åbn siden i browseren for at oprette den.');
        console.log(`Åbner du siden fra en anden maskine, skal du bruge denne opsætningsnøgle: ${config.setupToken}`);
      });
    }
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadDotEnv();
  startServer().catch((err) => {
    console.error('Serveren kunne ikke starte:', err);
    process.exit(1);
  });
}
