// Vercel-indgang: hele appen kører som én serverless-funktion.
// Statiske filer i public/ serveres af Vercels CDN; alt andet rammer denne funktion (se vercel.json).
//
// Lager, i den rækkefølge der ledes:
//   1. Supabase (SUPABASE_URL + SUPABASE_KEY) – porteføljen følger med til alle enheder.
//   2. Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN) – samme, via Vercels Storage-fane.
//   3. Ingen database: "browser-tilstand", hvor beholdningerne kun ligger i den browser,
//      de blev tastet i, og serveren udelukkende leverer kurser og beregninger.
//
// Er der en database og ingen DASHBOARD_PASSWORD, er siden åben: man ser porteføljen
// ved bare at besøge adressen. Sæt DASHBOARD_PASSWORD for at kræve login i stedet,
// eller PUBLIC_ACCESS=0 for at slå den åbne adgang fra.

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/index.js';
import { createStoreFromConfig, databaseModeFromEnv, describeStorageEnv } from '../server/storage.js';
import { createYahooClient } from '../server/yahoo.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

const database = databaseModeFromEnv(); // 'supabase', 'redis' eller null

const config = loadConfig();
config.trustProxy = true; // Vercel sætter selv X-Forwarded-For/-Proto
config.secureCookies = true; // altid HTTPS
config.alwaysRequireSetupToken = true; // "localhost" findes ikke på Vercel
config.storageMode = database || 'browser';
// Med en database er siden en platform: hver bruger opretter sin egen profil og portefølje.
config.platform = Boolean(database) && process.env.PLATFORM !== '0' && process.env.PLATFORM !== 'false';
config.publicAccess = config.platform || process.env.PUBLIC_ACCESS === '0' || process.env.PUBLIC_ACCESS === 'false'
  ? false
  : Boolean(database) && !config.envPassword;

const store = database ? createStoreFromConfig(config) : null;
const yahoo = config.mockYahoo ? createMockYahooClient() : createYahooClient({ quoteTtlMs: config.quoteTtlMs });
const app = createApp({ store, yahoo, config });

function plain(res, status, lines) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(lines.join('\n'));
}

// Databasen tjekkes én gang pr. instans, så en forkert opsætning giver en forklaring
// i stedet for en fejl inde i dashboardet.
let databaseChecked = !database;

// Hver serverless-instans er sin egen proces, så en tilfældig opsætningsnøgle ville skifte
// mellem kald. Kræves der ét fælles login, skal adgangskoden derfor komme fra
// DASHBOARD_PASSWORD og ikke oprettes i browseren.
// Som platform har hver profil sin egen adgangskode, og uden database er der intet login –
// i begge tilfælde er der intet at bekræfte.
let passwordConfirmed = !database || config.platform || config.publicAccess || Boolean(config.envPassword);

export default async function handler(req, res) {
  if (!databaseChecked) {
    try {
      await store.getPortfolio();
      databaseChecked = true;
    } catch (err) {
      return plain(res, 503, [
        `Databasen (${database}) svarer ikke.`,
        '',
        `Fejl: ${err.message}`,
        '',
        'Fundne variabler: ' + (describeStorageEnv().join(', ') || 'ingen'),
        '',
        database === 'supabase'
          ? 'Tjek SUPABASE_URL og SUPABASE_KEY under Settings → Environment Variables, og at projektet i Supabase er aktivt.'
          : 'Tjek i Vercel under Storage, at databasen er forbundet til projektet, og deploy igen.',
      ]);
    }
  }

  if (!passwordConfirmed) {
    try {
      passwordConfirmed = Boolean((await store.getAuth()).passwordHash);
    } catch (err) {
      return plain(res, 503, ['Databasen svarer ikke.', '', `Fejl: ${err.message}`]);
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
        'Vil du hellere have siden åben uden login, så fjern PUBLIC_ACCESS=0 igen.',
        '',
        'Derefter: Deployments → ⋯ → Redeploy.',
      ]);
    }
  }

  return app(req, res);
}
