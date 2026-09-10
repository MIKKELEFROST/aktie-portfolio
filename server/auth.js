// Adgangskode-hash (scrypt) og HMAC-signerede session-tokens.
// Ingen eksterne afhængigheder – kun node:crypto.

import { scrypt, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, salt, hex] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hex) return false;
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hex, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

// Token = base64url(payload).base64url(hmac). Payload: { exp, iat, nonce }.
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// `pv` (password version) binder tokenet til den aktuelle adgangskode, så alle sessioner
// falder bort når adgangskoden skiftes – også hvis SESSION_SECRET kommer fra miljøet.
export function passwordVersion(passwordHash) {
  return createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 16);
}

export function createSessionToken(secret, { ttlMs = 30 * 24 * 60 * 60 * 1000, now = Date.now(), pv = '' } = {}) {
  const payload = JSON.stringify({ iat: now, exp: now + ttlMs, nonce: randomBytes(8).toString('hex'), pv });
  const body = b64url(payload);
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(secret, token, { now = Date.now(), pv = null } = {}) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (pv !== null && payload.pv !== pv) return null;
  return payload;
}

// Simpel brute-force-bremse pr. IP: max `limit` fejlede forsøg pr. `windowMs`.
export function createLoginLimiter({ limit = 8, windowMs = 15 * 60_000 } = {}) {
  const attempts = new Map();
  function prune(now) {
    for (const [ip, entry] of attempts) if (entry.resetAt <= now) attempts.delete(ip);
  }
  return {
    isBlocked(ip, now = Date.now()) {
      prune(now);
      const entry = attempts.get(ip);
      return Boolean(entry && entry.count >= limit);
    },
    retryAfterSeconds(ip, now = Date.now()) {
      const entry = attempts.get(ip);
      return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
    },
    recordFailure(ip, now = Date.now()) {
      prune(now);
      const entry = attempts.get(ip);
      if (entry) entry.count++;
      else attempts.set(ip, { count: 1, resetAt: now + windowMs });
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
}
