// Vælger lager ud fra miljøet: Redis (Upstash) hvis dets variabler findes, ellers JSON-fil.
// Upstash' Vercel-integration sætter KV_REST_API_URL/TOKEN eller UPSTASH_REDIS_REST_URL/TOKEN.

import { createStore } from './store.js';
import { createRedisStore } from './store-redis.js';

export function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_TOKEN || '';
  return url && token ? { url, token, prefix: env.REDIS_PREFIX || 'aktie' } : null;
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
