// Vælger lager ud fra miljøet: Redis (Upstash) hvis dets variabler findes, ellers JSON-fil.
// Upstash' Vercel-integration sætter KV_REST_API_URL/TOKEN eller UPSTASH_REDIS_REST_URL/TOKEN.

import { createStore } from './store.js';
import { createRedisStore } from './store-redis.js';

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
    if (url && token && /^https?:\/\//.test(url)) return { url, token, prefix: env.REDIS_PREFIX || 'aktie' };
  }
  return null;
}

// Til fejlsiden: navne (aldrig værdier) på variabler der ligner en database-opsætning.
export function describeRedisEnv(env = process.env) {
  return Object.keys(env).filter((k) => /KV|REDIS|UPSTASH/i.test(k)).sort();
}

export function createStoreFromConfig(config, env = process.env) {
  const redis = redisConfigFromEnv(env);
  if (redis) return withBaseCurrency(createRedisStore(redis), config.baseCurrency);
  return createStore(config.dataDir, { baseCurrency: config.baseCurrency });
}

// Redis-lageret kender ikke basisvalutaen; bind den her så interfacet matcher fil-lageret.
function withBaseCurrency(store, baseCurrency) {
  return {
    ...store,
    getPortfolio: () => store.getPortfolio(baseCurrency),
    updatePortfolio: (fn) => store.updatePortfolio(fn, baseCurrency),
    getSessionSecret: (envSecret) => store.getSessionSecret(envSecret),
  };
}
