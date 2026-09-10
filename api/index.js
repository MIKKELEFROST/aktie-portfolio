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

// Hver serverless-instans er sin egen proces, så en tilfældig opsætningsnøgle ville skifte
// mellem kald. Derfor kan den første adgangskode ikke oprettes i browseren her: den skal
// komme fra DASHBOARD_PASSWORD. Er databasen på plads uden en adgangskode, forklarer vi det.
let passwordConfirmed = Boolean(config.envPassword);

function plain(res, status, lines) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(lines.join('\n'));
}

export default async function handler(req, res) {
  if (!passwordConfirmed && config.storageMode === 'redis') {
    try {
      passwordConfirmed = Boolean((await store.getAuth()).passwordHash);
    } catch (err) {
      return plain(res, 503, [
        'Databasen svarer ikke.',
        '',
        `Fejl: ${err.message}`,
        '',
        'Tjek i Vercel under Storage, at databasen er forbundet til projektet, og deploy igen.',
      ]);
    }
    if (!passwordConfirmed) {
      return plain(res, 503, [
        'Databasen er koblet på. Der mangler kun en adgangskode.',
        '',
        'I Vercel-projektet: Settings → Environment Variables → Add:',
        '  DASHBOARD_PASSWORD = din adgangskode (mindst 8 tegn)',
        'Gerne også:',
        '  SESSION_SECRET = en lang tilfældig streng',
        '',
        'Derefter: Deployments → ⋯ → Redeploy. Så kan du logge ind fra alle dine enheder.',
      ]);
    }
  }
  return app(req, res);
}
