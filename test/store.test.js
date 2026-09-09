import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

test('store: standarddata, atomisk skrivning og serialiserede opdateringer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aktie-store-'));
  const store = createStore(dir, { baseCurrency: 'DKK' });

  const initial = await store.getPortfolio();
  assert.deepEqual(initial.holdings, []);
  assert.equal(initial.settings.baseCurrency, 'DKK');

  await Promise.all([
    store.updatePortfolio((p) => { p.holdings.push({ id: 'a', symbol: 'A' }); }),
    store.updatePortfolio((p) => { p.holdings.push({ id: 'b', symbol: 'B' }); }),
    store.updatePortfolio((p) => { p.holdings.push({ id: 'c', symbol: 'C' }); }),
  ]);

  const onDisk = JSON.parse(await readFile(path.join(dir, 'portfolio.json'), 'utf8'));
  assert.deepEqual(onDisk.holdings.map((h) => h.id), ['a', 'b', 'c']);
  assert.equal((await readdir(dir)).filter((f) => f.endsWith('.tmp')).length, 0, 'ingen efterladte tmp-filer');

  // Ny store-instans læser fra disk
  const again = createStore(dir);
  assert.equal((await again.getPortfolio()).holdings.length, 3);
});

test('store: session-hemmelighed genereres én gang og genbruges', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aktie-store-'));
  const store = createStore(dir);
  const s1 = await store.getSessionSecret();
  const s2 = await store.getSessionSecret();
  assert.equal(s1, s2);
  assert.equal(s1.length, 64);
  assert.equal(await store.getSessionSecret('fra-env'), 'fra-env');
  assert.equal((await createStore(dir).getSessionSecret()), s1);
});
