/*
 * Runs extension/background.js with a mocked `browser` API. The "page" fetch
 * returns the fixture API answer, and the Apps Script URL is served by Code.gs
 * on a fake spreadsheet holding your v1 tabs. Run with: node test/background-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCodeGs, FakeSheet, FakeSpreadsheet, parisDate } = require('./fake-gas');
const fx = require('./fixtures');

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfyc-test/exec';
const LIBS = ['lib/extract.js', 'lib/time.js', 'lib/settings.js', 'lib/store.js', 'lib/stats.js', 'lib/tables.js', 'background.js'];

function v1Spreadsheet() {
  const achats = new FakeSheet('Achats', 999, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Vendeur', 'Inclure'].forEach((h, i) => { achats.cell(1, i + 1).v = h; });
  fx.ACHATS_ROWS.forEach((row, i) => row.forEach((v, c) => { achats.cell(i + 2, c + 1).v = c === 1 ? parisDate(v) : v; }));
  const ventes = new FakeSheet('Ventes', 998, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Statut'].forEach((h, i) => { ventes.cell(1, i + 1).v = h; });
  fx.VENTES_ROWS.forEach((row, i) => row.forEach((v, c) => { ventes.cell(i + 2, c + 1).v = c === 1 ? parisDate(v) : v; }));
  return new FakeSpreadsheet('WikiMasters', [achats, ventes]);
}

async function main() {
  const ss = v1Spreadsheet();
  const gas = loadCodeGs(ss);
  gas.context.setup();
  const secret = gas.props.get('SECRET');

  const storage = { settings: { sheets: { scriptUrl: SCRIPT_URL, secret, autoExport: true } } };
  const apiCalls = [];
  let listener = null;
  const badge = {};
  let balance = 1667;

  async function fakeFetch(url, init) {
    url = String(url);
    if (url.startsWith('https://www.wiki-masters.com/api/marketplace')) {
      apiCalls.push(url);
      const body = JSON.stringify(fx.apiResponse()); // history/won do not depend on "page", like the real site
      return { status: 200, ok: true, text: async () => body };
    }
    if (url === '/marketplace') {
      const html = `<script>self.__next_f.push([1,"7:[\\"$\\",\\"$L15\\",null,{\\"userId\\":\\"x\\",\\"initialWikibidousBalance\\":${balance},\\"initialHideSensitive\\":false}]"])</script>`;
      return { status: 200, ok: true, text: async () => html };
    }
    if (url === SCRIPT_URL) {
      assert.strictEqual(init.method, 'POST');
      assert.strictEqual(init.credentials, 'omit');
      const out = gas.post(JSON.parse(init.body));
      return { status: 200, ok: true, text: async () => JSON.stringify(out) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const browser = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: {
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, clone(storage[k])]));
        },
        set: async (obj) => { Object.assign(storage, clone(obj)); },
        remove: async (keys) => { [].concat(keys).forEach((k) => delete storage[k]); }
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
        const page = vm.createContext({ fetch: fakeFetch, JSON, String, Number, document: { querySelector: () => null } });
        const fn = vm.runInContext(`(${func.toString()})`, page);
        return [{ result: await fn(...(args || [])) }];
      }
    },
    action: {
      setBadgeText: ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: () => {}
    }
  };

  const ctx = vm.createContext({ browser, fetch: fakeFetch, console, URL, Map, Set, setTimeout, clearTimeout, Promise, Intl, Date });
  for (const f of LIBS) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'), ctx, { filename: f });
  assert.ok(listener, 'message listener registered');

  // 1. One-time import of the v1 sheet.
  const imp = await listener({ type: 'importV1' });
  assert.strictEqual(imp.ok, true, imp.error);
  assert.deepStrictEqual([imp.purchases, imp.sales, imp.excluded], [21, 23, 5]);
  assert.strictEqual(storage.settings.tracking.cards.length, 8, 'tracked cards taken from Inclure = Oui');

  // 2. Update: site data merged, balance read, sheet exported.
  const r1 = await listener({ type: 'sync' });
  assert.strictEqual(r1.ok, true, r1.error);
  assert.strictEqual(r1.balance, 1667);
  assert.strictEqual(r1.added.purchases.length + r1.added.sales.length > 0, true);
  assert.strictEqual(r1.exported, true, JSON.stringify(r1.warnings));
  assert.strictEqual(apiCalls.length, 2, 'page 2 fetched once, then stops because nothing new');
  assert.strictEqual(storage.db.snapshots.length, 1);
  assert.ok(ss.getSheetByName('Tableau de bord'), 'template created');
  assert.ok(ss.getSheetByName('Achats (v1)'), 'v1 tab archived');
  assert.strictEqual(badge.text, String(r1.added.purchases.length + r1.added.sales.length));
  assert.ok(r1.kpis && typeof r1.kpis.realizedTotal === 'number');

  // 3. Update again: nothing new, another balance snapshot.
  balance = 1800;
  const r2 = await listener({ type: 'sync' });
  assert.deepStrictEqual([r2.added.purchases.length, r2.added.sales.length], [0, 0]);
  assert.deepStrictEqual(storage.db.snapshots.map((s) => s.balance), [1667, 1800]);
  assert.strictEqual(badge.text, '');

  // 4. Exclusion from the dashboard.
  const someId = Object.keys(storage.db.purchases)[0];
  assert.strictEqual((await listener({ type: 'setExcluded', id: someId, excluded: true })).ok, true);
  assert.deepStrictEqual(storage.db.overrides[someId], { excluded: true });
  await listener({ type: 'setExcluded', id: someId, excluded: false });
  assert.strictEqual(storage.db.overrides[someId], undefined);

  // 5. Manual export and ping.
  const exp = await listener({ type: 'export' });
  assert.strictEqual(exp.ok, true, exp.error);
  assert.strictEqual(exp.written.length, 9);
  const ping = await listener({ type: 'ping' });
  assert.deepStrictEqual([ping.ok, ping.version], [true, 2]);

  // 6. Backup / reset / restore.
  const backup = { format: 'wikimasters-sheets-backup', version: 2, db: clone(storage.db), settings: clone(storage.settings) };
  const count = Object.keys(storage.db.purchases).length;
  assert.strictEqual((await listener({ type: 'resetData' })).ok, true);
  assert.strictEqual(Object.keys(storage.db.purchases).length, 0);
  assert.strictEqual((await listener({ type: 'restore', backup })).ok, true);
  assert.strictEqual(Object.keys(storage.db.purchases).length, count);
  const bad = await listener({ type: 'restore', backup: { nope: 1 } });
  assert.strictEqual(bad.ok, false);

  // 7. Wrong Google secret: the update still works locally, with a warning.
  storage.settings.sheets.secret = 'bad';
  const r3 = await listener({ type: 'sync' });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.exported, false);
  assert.ok(r3.warnings.some((w) => /Google Sheets : Secret incorrect/.test(w)));

  // 8. Unknown messages are ignored.
  assert.strictEqual(listener({ type: 'nope' }), undefined);

  console.log('ok   background.js end-to-end (import v1, update, balance, export, exclusions, backup, errors)');
}

main().catch((e) => {
  console.error(`FAIL background.js end-to-end\n${e.stack}`);
  process.exitCode = 1;
});
