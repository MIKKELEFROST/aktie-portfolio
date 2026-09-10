// Vælger lager ud fra miljøet: Supabase eller Redis (Upstash) hvis deres variabler findes,
// ellers en JSON-fil på disken. Vercel har ingen disk, så dér skal en af databaserne bruges.

import { createStore } from './store.js';
import { createRedisStore } from './store-redis.js';
import { createSupabaseStore } from './store-supabase.js';

// Supabase' egen Vercel-integration sætter NEXT_PUBLIC_SUPABASE_URL/ANON_KEY;
// sætter man variablerne selv, er SUPABASE_URL/SUPABASE_KEY nok.
export function supabaseConfigFromEnv(env = process.env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.POSTGRES_URL_NON_POOLING_REST || '';
  const key =
    env.SUPABASE_KEY ||
    env.SUPABASE_ANON_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    '';
  if (url && key && /^https?:\/\//.test(url)) return { url, key, prefix: env.STORAGE_PREFIX || 'aktie' };
  return null;
}

// Kendte navne først; derefter alle variabler der ender på _REST_API_URL / _REST_URL med
// tilhørende _TOKEN (Vercels Upstash-integration kan få et brugerdefineret præfiks, fx MINDB_KV_REST_API_URL).
export function redisConfigFromEnv(env = process.env) {
  const pairs = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['REDIS_REST_URL', 'REDIS_REST_TOKEN'],
  ];
  for (const key of Object.keys(env)) {
    const m = key.match(/^(.+?)(_REST_API_URL|_REST_URL)$/);
    if (m) pairs.push([key, `${m[1]}${m[2].replace('URL', 'TOKEN')}`]);
  }
  for (const [urlKey, tokenKey] of pairs) {
    const url = env[urlKey];
    const token = env[tokenKey];
    if (url && token && /^https?:\/\//.test(url)) return { url, token, prefix: env.REDIS_PREFIX || env.STORAGE_PREFIX || 'aktie' };
  }
  return null;
}

// Hvilken database miljøet peger på – 'supabase', 'redis' eller null. Bruges af Vercel-indgangen.
export function databaseModeFromEnv(env = process.env) {
  if (supabaseConfigFromEnv(env)) return 'supabase';
  if (redisConfigFromEnv(env)) return 'redis';
  return null;
}

// Til fejlsiden: navne (aldrig værdier) på variabler der ligner en database-opsætning.
export function describeStorageEnv(env = process.env) {
  return Object.keys(env).filter((k) => /KV|REDIS|UPSTASH|SUPABASE|POSTGRES/i.test(k)).sort();
}

export function createStoreFromConfig(config, env = process.env) {
  const supabase = supabaseConfigFromEnv(env);
  if (supabase) return withBaseCurrency(createSupabaseStore(supabase), config.baseCurrency);
  const redis = redisConfigFromEnv(env);
  if (redis) return withBaseCurrency(createRedisStore(redis), config.baseCurrency);
  return createStore(config.dataDir, { baseCurrency: config.baseCurrency });
}

// Database-lagrene kender ikke basisvalutaen; bind den her så interfacet matcher fil-lageret.
function withBaseCurrency(store, baseCurrency) {
  return {
    ...store,
    getPortfolio: () => store.getPortfolio(baseCurrency),
    updatePortfolio: (fn) => store.updatePortfolio(fn, baseCurrency),
    getUserPortfolio: (userId) => store.getUserPortfolio(userId, baseCurrency),
    updateUserPortfolio: (userId, fn) => store.updateUserPortfolio(userId, fn, baseCurrency),
    deleteUserPortfolio: (userId) => store.deleteUserPortfolio(userId, baseCurrency),
    getSessionSecret: (envSecret) => store.getSessionSecret(envSecret),
  };
}
