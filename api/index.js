// Vercel-indgang: hele appen kører som én serverless-funktion.
// Statiske filer i public/ serveres af Vercels CDN; alt andet rammer denne funktion (se vercel.json).

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/index.js';
import { createStoreFromConfig, redisConfigFromEnv, describeRedisEnv } from '../server/storage.js';
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
    const found = describeRedisEnv();
    const lines = [
      'Min Portefølje: der er ikke koblet en database til.',
      '',
      'Sådan løser du det i Vercel-projektet:',
      '1) Storage → Create Database → Upstash Redis → Connect to project (sætter KV_REST_API_URL og KV_REST_API_TOKEN).',
      '2) Settings → Environment Variables: DASHBOARD_PASSWORD (din adgangskode).',
      '3) Deployments → Redeploy.',
      '',
      found.length
        ? `Database-lignende variabler fundet (kun navne): ${found.join(', ')}. Der skal være ét par med en https://-REST-adresse og et token.`
        : 'Ingen database-variabler fundet i dette deployment.',
      process.env.DASHBOARD_PASSWORD ? 'DASHBOARD_PASSWORD: sat.' : 'DASHBOARD_PASSWORD: ikke sat (kræves på Vercel).',
    ];
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(lines.join('\n'));
    return;
  }
  return app(req, res);
}
