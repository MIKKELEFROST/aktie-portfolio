// Vercel-indgang: hele appen kører som én serverless-funktion.
// Statiske filer i public/ serveres af Vercels CDN; alt andet rammer denne funktion (se vercel.json).
//
// Lager: Upstash Redis hvis projektet har KV_REST_API_URL/TOKEN (login + synkronisering mellem
// enheder). Ellers "browser-tilstand": beholdningerne gemmes i brugerens browser, og serveren
// leverer kun kurser og beregninger – virker uden nogen opsætning.

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/index.js';
import { createStoreFromConfig, redisConfigFromEnv } from '../server/storage.js';
import { createYahooClient } from '../server/yahoo.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

const config = loadConfig();
config.trustProxy = true; // Vercel sætter selv X-Forwarded-For/-Proto
config.secureCookies = true; // altid HTTPS
config.alwaysRequireSetupToken = true; // "localhost" findes ikke på Vercel
config.storageMode = redisConfigFromEnv() ? 'redis' : 'browser';

const store = config.storageMode === 'redis' ? createStoreFromConfig(config) : null;
const yahoo = config.mockYahoo ? createMockYahooClient() : createYahooClient({ quoteTtlMs: config.quoteTtlMs });
const app = createApp({ store, yahoo, config });

export default function handler(req, res) {
  return app(req, res);
}
