/*
 * Runs extension/background.js with a mocked `browser` API.
 *  - The marketplace page's own API answer is fed through a fake
 *    webRequest.filterResponseData stream (passive capture).
 *  - Any request from the extension to wiki-masters.com fails the test.
 *  - The Apps Script URL is served by Code.gs on a fake spreadsheet.
 * Run with: node test/background-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCodeGs, FakeSheet, FakeSpreadsheet, parisDate } = require('./fake-gas');
const fx = require('./fixtures');

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfyc-test/exec';
const LIBS = ['lib/extract.js', 'lib/time.js', 'lib/settings.js', 'lib/store.js', 'lib/market.js', 'lib/stats.js', 'lib/tables.js', 'background.js'];

function v1Spreadsheet() {
  const achats = new FakeSheet('Achats', 999, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Vendeur', 'Inclure'].forEach((h, i) => { achats.cell(1, i + 1).v = h; });
  fx.ACHATS_ROWS.forEach((row, i) => row.forEach((v, c) => { achats.cell(i + 2, c + 1).v = c === 1 ? parisDate(v) : v; }));
  const ventes = new FakeSheet('Ventes', 998, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Statut'].forEach((h, i) => { ventes.cell(1, i + 1).v = h; });
  fx.VENTES_ROWS.forEach((row, i) => row.forEach((v, c) => { ventes.cell(i + 2, c + 1).v = c === 1 ? parisDate(v) : v; }));
  return new FakeSpreadsheet('WikiMasters', [achats, ventes]);
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }

async function main() {
  const ss = v1Spreadsheet();
  const gas = loadCodeGs(ss);
  gas.context.setup();
  const secret = gas.props.get('SECRET');

  const storage = { settings: { sheets: { scriptUrl: SCRIPT_URL, secret, autoExport: true } } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const listeners = { message: null, request: null, storage: [] };
  const sent = [];
  const tabUpdates = [];
  const exportStates = [];

  async function fakeFetch(url, init) {
    url = String(url);
    if (/wiki-masters\.com/.test(url)) throw new Error(`the extension must not call the game: ${url}`);
    if (url === SCRIPT_URL) {
      assert.strictEqual(init.method, 'POST');
      assert.strictEqual(init.credentials, 'omit');
      const out = gas.post(JSON.parse(init.body));
      return { status: 200, ok: true, text: async () => JSON.stringify(out) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  // Fake StreamFilter: records what is forwarded to the page.
  const filters = {};
  const browser = {
    webRequest: {
      onBeforeRequest: { addListener: (fn, filter, extra) => { listeners.request = { fn, filter, extra }; } },
      filterResponseData: (requestId) => {
        const f = { written: [], closed: false, write(d) { this.written.push(d); }, close() { this.closed = true; }, disconnect() {} };
        filters[requestId] = f;
        return f;
      }
    },
    runtime: {
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      getURL: (p) => `moz-extension://test/${p}`
    },
    storage: {
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(list.filter((k) => k in storage).map((k) => [k, clone(storage[k])]));
        },
        set: async (obj) => {
          Object.assign(storage, clone(obj));
          if (obj.exportState) exportStates.push(clone(obj.exportState));
        },
        remove: async (keys) => { [].concat(keys).forEach((k) => delete storage[k]); }
      }
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.wiki-masters.com/marketplace', windowId: 1 }],
      sendMessage: async (id, msg) => { sent.push([id, msg.type]); },
      get: async (id) => { if (id !== 42) throw new Error('no tab'); return { id: 42, windowId: 3 }; },
      update: async (id, props) => { tabUpdates.push([id, clone(props)]); return { id }; },
      create: async (props) => { tabUpdates.push(['new', clone(props)]); return { id: 99 }; }
    },
    windows: { update: async () => ({}) },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} }
  };

  // Timers are unref'd so the auto-export delay does not keep Node alive.
  const timers = [];
  const ctx = vm.createContext({
    browser, fetch: fakeFetch, console, URL, Map, Set, Promise, Intl, Date, TextDecoder, Uint8Array, ArrayBuffer,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); timers.push({ fn, ms }); return t; },
    clearTimeout
  });
  for (const f of LIBS) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'), ctx, { filename: f });
  const send = (msg) => listeners.message(msg, { tab: { id: 42 } });

  // Only the marketplace API, read-only, with a blocking listener (required to read the stream).
  assert.deepStrictEqual(clone(listeners.request.filter.urls), ['https://www.wiki-masters.com/api/marketplace*', 'https://wiki-masters.com/api/marketplace*']);
  assert.deepStrictEqual(clone(listeners.request.extra), ['blocking']);

  /** Plays one response through the capture as Firefox would. */
  async function pageLoads(json, requestId) {
    listeners.request.fn({ requestId, method: 'GET', url: 'https://www.wiki-masters.com/api/marketplace?page=1&limit=50&sort=recent&mine=1' });
    const f = filters[requestId];
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const half = Math.floor(bytes.length / 2);
    const parts = [bytes.slice(0, half).buffer, bytes.slice(half).buffer];
    parts.forEach((data) => f.ondata({ data }));
    f.onstop();
    await settle();
    const forwarded = Buffer.concat(f.written.map((b) => Buffer.from(b)));
    assert.ok(forwarded.equals(Buffer.from(bytes)), 'the page receives exactly the same bytes');
    assert.ok(f.closed);
  }

  // 1. One-time import of the v1 sheet.
  const imp = await send({ type: 'importV1' });
  assert.strictEqual(imp.ok, true, imp.error);
  assert.deepStrictEqual([imp.purchases, imp.sales, imp.excluded], [21, 23, 5]);
  assert.strictEqual(storage.settings.tracking.cards.length, 8);

  // 2. The marketplace page loads: own lists + market captured passively.
  const api = fx.apiResponse();
  api.auctions = [{
    id: 'aaaa1111-0000-4000-8000-000000000001', status: 'active', seller_id: 'other', card_id: 'c', card: { wikipedia_title: 'Triceratops', rarity: 'SR' },
    snapshot_rarity: 'SR', effective_bid: 950, current_bid: 950, base_amount: 500, end_at: new Date(Date.now() + 3600e3).toISOString()
  }];
  await pageLoads(api, 'r1');
  assert.ok(Object.keys(storage.db.purchases).length > 21, 'site data merged with the import');
  assert.ok(storage.db.meta.lastOwnCapture, 'own capture time recorded');
  assert.ok(storage.db.auctions['aaaa1111-0000-4000-8000-000000000001'], 'market listing recorded');
  assert.ok(sent.some(([id, t]) => id === 7 && t === 'marketUpdated'), 'site tabs told to refresh the badges');
  assert.ok(storage.db.meta.recent.length > 0);
  assert.ok(timers.some((t) => t.ms === 90000), 'auto-export scheduled after new transactions');

  // Same page again: nothing new.
  const before = Object.keys(storage.db.sales).length;
  await pageLoads(fx.apiResponse(), 'r2');
  assert.strictEqual(Object.keys(storage.db.sales).length, before);

  // Non-JSON answers are ignored, and still forwarded.
  listeners.request.fn({ requestId: 'r3', method: 'GET', url: 'https://www.wiki-masters.com/api/marketplace/x' });
  filters.r3.ondata({ data: new TextEncoder().encode('<html>oops</html>').buffer });
  filters.r3.onstop();
  await settle();
  assert.strictEqual(filters.r3.written.length, 1);

  // 3. Balance read by the content script.
  assert.strictEqual((await send({ type: 'balance', value: 1667 })).changed, true);
  assert.strictEqual((await send({ type: 'balance', value: 1667 })).changed, false, 'same value within 10 min is not repeated');
  assert.strictEqual(storage.db.snapshots.length, 1);

  // 4. Overlay data for the site's tiles.
  const ov = await send({ type: 'overlayInfo', tiles: [{ ref: 0, id: 'aaaa1111-0000-4000-8000-000000000001' }] });
  assert.strictEqual(ov.enabled, true);
  assert.deepStrictEqual([ov.items[0].card, ov.items[0].tracked, ov.items[0].price], ['Triceratops', true, 950]);
  assert.ok(ov.items[0].median > 0, 'median from your own Triceratops sales');

  // 5. "+ Suivre" from the site.
  await send({ type: 'follow', card: 'Neptune (planète)' });
  assert.ok(storage.settings.tracking.cards.some((c) => c.name === 'Neptune (planète)'));
  await send({ type: 'follow', card: 'neptune (planete)', follow: false });
  assert.ok(!storage.settings.tracking.cards.some((c) => c.name === 'Neptune (planète)'));

  // 6. Export with per-tab progress.
  const exp = await send({ type: 'export' });
  assert.strictEqual(exp.ok, true, exp.error);
  assert.strictEqual(exp.written.length, 10);
  const labels = exportStates.map((e) => e.label);
  assert.strictEqual(labels[0], 'Préparation des données…');
  assert.ok(labels.some((l) => /^Remplissage de l'onglet « Achats » \(9\/10, \d+ lignes\)…$/.test(l)), labels.join('\n'));
  assert.ok(/^Feuille « WikiMasters » à jour \(10 onglets\)\.$/.test(labels[labels.length - 1]));
  assert.deepStrictEqual(ss.getSheets().slice(0, 10).map((s) => s.getName()), ['Tableau de bord', 'Par jour', 'Inventaire', 'Par carte',
    'Prix du marché', 'Par heure', 'Inflation', 'Prix dans le temps', 'Achats', 'Ventes'], 'tabs in order although sent one by one');
  assert.ok(storage.lastExport && storage.lastExport.spreadsheet === 'WikiMasters');

  // A failing export leaves a readable state.
  storage.settings.sheets.secret = 'bad';
  const bad = await send({ type: 'export' });
  assert.strictEqual(bad.ok, false);
  assert.match(storage.exportState.label, /^Échec de l'export : Secret incorrect/);
  storage.settings.sheets.secret = secret;

  // 7. Dashboard tab reuse.
  storage.dashboardTab = 42;
  await send({ type: 'openDashboard', hash: '#market/terre' });
  assert.deepStrictEqual(tabUpdates.pop(), [42, { active: true, url: 'moz-extension://test/dashboard.html#market/terre' }]);
  storage.dashboardTab = 5; // closed tab
  await send({ type: 'openDashboard', hash: 'settings' });
  assert.deepStrictEqual(tabUpdates.pop(), ['new', { url: 'moz-extension://test/dashboard.html#settings' }]);
  assert.strictEqual(storage.dashboardTab, 99);
  await send({ type: 'openMarketplace' });
  assert.deepStrictEqual(tabUpdates.pop(), [7, { active: true }], 'existing marketplace tab focused, not reloaded');

  // 8. Gap warning when the site's list no longer reaches the last capture.
  const later = fx.apiResponse({ history: fx.HISTORY.map((h, i) => [`ffff${String(i).padStart(4, '0')}`, '2026-11-20T10:00:00', 'Triceratops', 'SR', 'U', 1500 + i]), won: [] });
  await pageLoads(later, 'r4');
  assert.match(storage.db.meta.warning.text, /ventes ont pu être manqués/);

  // 9. Exclusion, backup, reset, restore.
  const someId = Object.keys(storage.db.purchases)[0];
  await send({ type: 'setExcluded', id: someId, excluded: true });
  assert.deepStrictEqual(clone(storage.db.overrides[someId]), { excluded: true });
  const backup = { format: 'wikimasters-sheets-backup', version: 2, db: clone(storage.db), settings: clone(storage.settings) };
  const count = Object.keys(storage.db.purchases).length;
  await send({ type: 'resetData' });
  assert.strictEqual(Object.keys(storage.db.purchases).length, 0);
  await send({ type: 'restore', backup });
  assert.strictEqual(Object.keys(storage.db.purchases).length, count);
  assert.strictEqual((await send({ type: 'restore', backup: { nope: 1 } })).ok, false);

  // 10. Unknown messages are ignored.
  assert.strictEqual(send({ type: 'sync' }), undefined, 'there is no active "sync" any more');

  console.log('ok   background.js end-to-end (passive capture, balance, overlay, follow, export progress, tab reuse, gap warning, backup)');
}

main().catch((e) => {
  console.error(`FAIL background.js end-to-end\n${e.stack}`);
  process.exitCode = 1;
});
