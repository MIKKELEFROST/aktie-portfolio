import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken, createLoginLimiter } from '../server/auth.js';

test('adgangskode: hash og verificér', async () => {
  const hash = await hashPassword('hemmelig123');
  assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('hemmelig123', hash), true);
  assert.equal(await verifyPassword('forkert', hash), false);
  assert.equal(await verifyPassword('hemmelig123', 'ikke-en-hash'), false);
  assert.equal(await verifyPassword('hemmelig123', null), false);
});

test('session-token: bundet til adgangskode-version', async () => {
  const { passwordVersion } = await import('../server/auth.js');
  const token = createSessionToken('s', { pv: passwordVersion('hash-a') });
  assert.ok(verifySessionToken('s', token, { pv: passwordVersion('hash-a') }));
  assert.equal(verifySessionToken('s', token, { pv: passwordVersion('hash-b') }), null, 'ny adgangskode → gammelt token ugyldigt');
  assert.ok(verifySessionToken('s', token), 'uden pv-krav accepteres tokenet stadig');
});

test('session-token: gyldigt, udløbet, manipuleret', () => {
  const secret = 'test-secret';
  const now = 1_700_000_000_000;
  const token = createSessionToken(secret, { ttlMs: 1000, now });
  assert.ok(verifySessionToken(secret, token, { now: now + 500 }));
  assert.equal(verifySessionToken(secret, token, { now: now + 1000 }), null, 'udløbet');
  assert.equal(verifySessionToken('anden-secret', token, { now }), null, 'forkert secret');
  assert.equal(verifySessionToken(secret, token.slice(0, -2) + 'xx', { now }), null, 'manipuleret signatur');
  assert.equal(verifySessionToken(secret, 'ikke.et.token', { now }), null);
  assert.equal(verifySessionToken(secret, undefined, { now }), null);
});

test('login-bremse: blokerer efter grænsen og nulstiller', () => {
  const limiter = createLoginLimiter({ limit: 3, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(limiter.isBlocked('1.2.3.4', now), false);
  limiter.recordFailure('1.2.3.4', now);
  limiter.recordFailure('1.2.3.4', now);
  assert.equal(limiter.isBlocked('1.2.3.4', now), false);
  limiter.recordFailure('1.2.3.4', now);
  assert.equal(limiter.isBlocked('1.2.3.4', now), true);
  assert.equal(limiter.isBlocked('5.6.7.8', now), false, 'andre IP\'er påvirkes ikke');
  assert.equal(limiter.isBlocked('1.2.3.4', now + 1001), false, 'vinduet udløber');
  limiter.recordFailure('1.2.3.4', now);
  limiter.recordFailure('1.2.3.4', now);
  limiter.recordFailure('1.2.3.4', now);
  limiter.reset('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4', now), false);
});
