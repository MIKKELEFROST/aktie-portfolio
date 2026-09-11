// Klienten og serveren skal være enige om, hvilke sider der findes.
// Ellers virker navigation inde i appen, mens et direkte link eller en
// genindlæsning giver 404 – præcis det, der skete for /liste.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { createMockYahooClient } from '../server/yahoo-mock.js';

const rod = path.dirname(fileURLToPath(import.meta.url));

async function klientensRuter() {
  const kode = await readFile(path.join(rod, '..', 'public', 'app.js'), 'utf8');
  const linje = /const ROUTES = \{([^}]+)\}/.exec(kode);
  assert.ok(linje, 'kunne ikke finde ROUTES i public/app.js');
  return [...linje[1].matchAll(/'([^']+)':/g)].map((m) => m[1]);
}

test('hver side i klienten kan også hentes direkte fra serveren', async () => {
  const ruter = await klientensRuter();
  const store = createStore(await mkdtemp(path.join(tmpdir(), 'aktie-sider-')));
  const config = { envPassword: '', sessionSecret: '', setupToken: 'x', baseCurrency: 'DKK', publicAccess: true, storageMode: 'file' };
  const app = createApp({ store, yahoo: createMockYahooClient(), config, logger: { warn() {}, error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const rute of ruter) {
      const res = await fetch(base + rute, { redirect: 'manual' });
      assert.equal(res.status, 200, `${rute} gav ${res.status} – mangler den i PAGE_ROUTES på serveren?`);
      assert.match(res.headers.get('content-type'), /text\/html/, rute);
    }
  } finally {
    server.close();
  }
});
