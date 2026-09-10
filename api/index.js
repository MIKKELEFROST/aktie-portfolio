// Vercel-indgang: hele appen kører som én serverless-funktion.
// Statiske filer i public/ serveres af Vercels CDN; alt andet rammer denne funktion (se vercel.json).

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/index.js';
import { createStoreFromConfig, redisConfigFromEnv } from '../server/storage.js';
import { createYahooClient } from '../server/yahoo.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

const config = loadConfig();
config.trustProxy = true; // Vercel sætter selv X-Forwarded-For/-Proto
config.secureCookies = true; // altid HTTPS
config.alwaysRequireSetupToken = true; // "localhost" findes ikke på Vercel

const store = createStoreFromConfig(config);
const yahoo = config.mockYahoo ? createMockYahooClient() : createYahooClient({ quoteTtlMs: config.quoteTtlMs });
const app = createApp({ store, yahoo, config });

const missingRedis = !redisConfigFromEnv();

export default function handler(req, res) {
  if (missingRedis) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Der er ikke koblet en database til. Tilføj Upstash Redis under Storage i Vercel-projektet og deploy igen. Se README.');
    return;
  }
  return app(req, res);
}
