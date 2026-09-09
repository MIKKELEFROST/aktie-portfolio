import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

test('store: rullende sikkerhedskopier (maks 5)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aktie-backup-'));
  const store = createStore(dir);
  for (let i = 0; i < 8; i++) {
    await store.updatePortfolio((p) => { p.holdings = [{ id: String(i), symbol: `S${i}`, quantity: 1 }]; });
    await new Promise((r) => setTimeout(r, 3)); // sikrer unikke tidsstempler
  }
  const files = (await readdir(path.join(dir, 'backups'))).sort();
  assert.equal(files.length, 5);
  assert.ok(files.every((f) => /^portfolio-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(f)), files.join(','));
  const newest = JSON.parse(await readFile(path.join(dir, 'backups', files.at(-1)), 'utf8'));
  assert.equal(newest.holdings[0].symbol, 'S6', 'nyeste kopi er tilstanden før seneste skrivning');
  const current = await store.getPortfolio();
  assert.equal(current.holdings[0].symbol, 'S7');
});
