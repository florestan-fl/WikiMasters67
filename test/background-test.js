/*
 * Runs extension/background.js with a mocked `browser` API: the "page" fetch
 * returns the fixture API answer and the Apps Script URL is served by Code.gs
 * running on the fake spreadsheet. Run with: node test/background-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCodeGs, FakeSheet, FakeSpreadsheet, parisDate } = require('./fake-gas');
const fx = require('./fixtures');

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfyc-test/exec';

function buildSheets() {
  const achats = new FakeSheet('Achats', 999, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Vendeur', 'Inclure'].forEach((h, i) => { achats.cell(1, i + 1).v = h; });
  fx.ACHATS_ROWS.forEach((row, i) => row.forEach((v, c) => { achats.cell(i + 2, c + 1).v = c === 1 ? parisDate(v) : v; }));
  const ventes = new FakeSheet('Ventes', 998, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Statut', 'ID achat (FIFO)'].forEach((h, i) => { ventes.cell(1, i + 1).v = h; });
  fx.VENTES_ROWS.forEach((row, i) => row.forEach((v, c) => { ventes.cell(i + 2, c + 1).v = c === 1 ? parisDate(v) : v; }));
  return new FakeSpreadsheet('WikiMasters', [achats, ventes]);
}

async function main() {
  const gas = loadCodeGs(buildSheets());
  gas.context.setup();
  const secret = gas.props.get('SECRET');

  const storage = {
    settings: { scriptUrl: SCRIPT_URL, secret, startDate: '2026-10-30', inclureDefault: 'Oui', matchWindowHours: 24, renumber: false }
  };
  const apiCalls = [];
  let listener = null;
  const badge = {};

  // fetch as seen from the page (MAIN world) and from the extension.
  async function fakeFetch(url, init) {
    url = String(url);
    if (url.startsWith('https://www.wiki-masters.com/api/marketplace')) {
      apiCalls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      // Like the real site: history/won do not depend on "page".
      const body = JSON.stringify(Object.assign(fx.apiResponse(), { page }));
      return { status: 200, ok: true, text: async () => body };
    }
    if (url === SCRIPT_URL) {
      assert.strictEqual(init.method, 'POST');
      assert.strictEqual(init.credentials, 'omit');
      const out = gas.post(JSON.parse(init.body));
      return { status: 200, ok: true, text: async () => JSON.stringify(out) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  const browser = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: {
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, JSON.parse(JSON.stringify(storage[k]))]));
        },
        set: async (obj) => { Object.assign(storage, JSON.parse(JSON.stringify(obj))); }
      }
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.wiki-masters.com/marketplace', status: 'complete', discarded: false }],
      create: async () => { throw new Error('should reuse the open tab'); },
      remove: async () => {},
      get: async () => ({ id: 7, status: 'complete' }),
      onUpdated: { addListener() {}, removeListener() {} }
    },
    scripting: {
      executeScript: async ({ target, world, func, args }) => {
        assert.strictEqual(target.tabId, 7);
        assert.strictEqual(world, 'MAIN');
        // Run the injected function in a separate realm, like a page.
        const page = vm.createContext({ fetch: fakeFetch, JSON, String });
        const fn = vm.runInContext(`(${func.toString()})`, page);
        return [{ result: await fn(...args) }];
      }
    },
    action: {
      setBadgeText: ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: () => {}
    }
  };

  const ctx = vm.createContext({ browser, fetch: fakeFetch, console, URL, Map, setTimeout, clearTimeout, Promise });
  for (const f of ['lib/extract.js', 'background.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'), ctx, { filename: f });
  }
  assert.ok(listener, 'message listener registered');

  // Preview.
  const preview = await listener({ type: 'sync', dryRun: true });
  assert.strictEqual(preview.ok, true, preview.error);
  assert.strictEqual(preview.dryRun, true);
  assert.deepStrictEqual([preview.purchases.stats.added, preview.purchases.stats.matched], [13, 21]);
  assert.deepStrictEqual([preview.sales.stats.added, preview.sales.stats.matched], [28, 22]);
  assert.strictEqual(apiCalls.length, 2, 'page 2 fetched once, then stops because nothing new');
  assert.ok(!storage.lastSync, 'preview does not record a sync');
  assert.ok(storage.lastResult && storage.lastResult.dryRun);

  // Real update.
  const res = await listener({ type: 'sync', dryRun: false });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(badge.text, String(13 + 28));
  assert.ok(storage.lastSync && storage.lastSync.newestSale);

  // Again: nothing new.
  const again = await listener({ type: 'sync', dryRun: false });
  assert.deepStrictEqual([again.purchases.stats.added, again.sales.stats.added], [0, 0]);
  assert.strictEqual(badge.text, '');

  // Ping from the options page.
  const ping = await listener({ type: 'ping' });
  assert.strictEqual(ping.ok, true, ping.error);

  // Wrong secret -> readable error, red badge.
  storage.settings.secret = 'bad';
  const bad = await listener({ type: 'sync', dryRun: true });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /Wrong secret/);
  assert.strictEqual(badge.text, '!');

  // Unknown messages are ignored.
  assert.strictEqual(listener({ type: 'nope' }), undefined);

  console.log('ok   background.js end-to-end (preview, update, re-sync, ping, errors)');
}

main().catch((e) => {
  console.error(`FAIL background.js end-to-end\n${e.stack}`);
  process.exitCode = 1;
});
