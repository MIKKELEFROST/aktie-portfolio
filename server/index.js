// Startpunkt: læser konfiguration, opretter lager + Yahoo-klient og starter HTTP-serveren.

import http from 'node:http';
import path from 'node:path';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { createYahooClient } from './yahoo.js';
import { createMockYahooClient } from './yahoo-mock.js';

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
      const quotes = await yahoo.getQuotes(symbols);
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

export function startServer(config = loadConfig()) {
  const store = createStore(config.dataDir, { baseCurrency: config.baseCurrency });
  const yahoo = config.mockYahoo ? createMockYahooClient() : createYahooClient({ quoteTtlMs: config.quoteTtlMs });
  const warmer = config.warmCache && !config.mockYahoo ? startCacheWarmer({ store, yahoo, config }) : null;
  const app = createApp({ store, yahoo, config, onPortfolioRequest: warmer ? () => warmer.touch() : null });
  const server = http.createServer(app);
  server.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log(`Aktie-portfolio kører på http://${shownHost}:${config.port}`);
    console.log(`Data gemmes i ${config.dataDir}`);
    if (config.mockYahoo) console.log('YAHOO_MOCK=1: bruger falske kurser (ingen kald til Yahoo Finance).');
    if (!config.envPassword) console.log('Ingen DASHBOARD_PASSWORD sat – adgangskoden oprettes i browseren første gang.');
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) startServer();
