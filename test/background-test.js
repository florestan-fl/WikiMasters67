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
const LIBS = ['lib/extract.js', 'lib/time.js', 'lib/settings.js', 'lib/store.js', 'lib/market.js', 'lib/searches.js', 'lib/stats.js', 'lib/tables.js', 'background.js'];

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

  // Requests made FROM THE GAME PAGE by the optional resolver (scripting.executeScript).
  const pageRequests = [];
  const pageResponses = {};
  let permissionGranted = false;
  const notifications = [];
  let siteTabs = [{ id: 7, url: 'https://www.wiki-masters.com/marketplace', windowId: 1 }];
  async function pageFetchImpl(url) {
    pageRequests.push(String(url));
    const body = pageResponses[String(url).split('/').pop()];
    if (!body) return { status: 404, text: async () => 'not found' };
    return { status: 200, text: async () => JSON.stringify(body) };
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
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    permissions: { contains: async () => permissionGranted },
    notifications: {
      create: async (id, opts) => { notifications.push([id, clone(opts)]); return id; },
      clear: async () => true,
      onClicked: { addListener: () => {} }
    },
    scripting: {
      executeScript: async ({ target, world, func, args }) => {
        assert.strictEqual(target.tabId, 7);
        assert.strictEqual(world, 'MAIN');
        const page = vm.createContext({ fetch: pageFetchImpl, JSON, String });
        return [{ result: await vm.runInContext(`(${func.toString()})`, page)(...args) }];
      }
    },
    tabs: {
      query: async () => siteTabs.slice(),
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
  assert.deepStrictEqual([ov.items[0].card, ov.items[0].tracked, ov.items[0].price, ov.items[0].next], ['Triceratops', true, 950, 1045]);
  assert.ok(ov.items[0].median > 0, 'median from your own Triceratops sales');

  // 5. "+ Suivre" from the site.
  await send({ type: 'follow', card: 'Neptune (planète)' });
  assert.ok(storage.settings.tracking.cards.some((c) => c.name === 'Neptune (planète)'));
  await send({ type: 'follow', card: 'neptune (planete)', follow: false });
  assert.ok(!storage.settings.tracking.cards.some((c) => c.name === 'Neptune (planète)'));
  // Unfollowing a card that a category keyword selects: excluded, and it really stops being followed.
  storage.db.cards.terre = { title: 'Terre', category: 'planète du Système solaire' };
  storage.settings.tracking.categories = [{ keyword: 'planète' }];
  assert.strictEqual((await send({ type: 'follow', card: 'Terre', follow: false })).followed, false);
  assert.deepStrictEqual(clone(storage.settings.tracking.excluded), [{ name: 'Terre' }]);
  assert.strictEqual((await send({ type: 'follow', card: 'Terre' })).followed, true, 'following again lifts the exclusion');
  assert.deepStrictEqual(clone(storage.settings.tracking.excluded), []);
  assert.ok(!storage.settings.tracking.cards.some((c) => c.name === 'Terre'), 'no duplicate name: the keyword already covers it');
  storage.settings.tracking.categories = [];

  // 6. Export with per-tab progress.
  const exp = await send({ type: 'export' });
  assert.strictEqual(exp.ok, true, exp.error);
  assert.strictEqual(exp.written.length, 11);
  const labels = exportStates.map((e) => e.label);
  assert.strictEqual(labels[0], 'Préparation des données…');
  assert.ok(labels.some((l) => /^Remplissage de l'onglet « Achats » \(10\/11, \d+ lignes\)…$/.test(l)), labels.join('\n'));
  assert.ok(/^Feuille « WikiMasters » à jour \(11 onglets\)\.$/.test(labels[labels.length - 1]));
  assert.deepStrictEqual(ss.getSheets().slice(0, 11).map((s) => s.getName()), ['Tableau de bord', 'Par jour', 'Par groupe', 'Inventaire', 'Par carte',
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

  // 10. Optional resolver: final prices of ended auctions of followed cards.
  const R = ctx.__wmt;
  const ID = (n) => `eeee0000-0000-4000-8000-00000000000${n}`;
  const t0 = Date.now();
  const active = (n, endAt, bid) => ({ id: ID(n), status: 'active', seller_id: 'other', card_id: 'c', card: { wikipedia_title: 'Triceratops', rarity: 'SR' },
    snapshot_rarity: 'SR', effective_bid: bid, current_bid: bid, base_amount: 500, end_at: new Date(endAt).toISOString() });
  await R.ingest('u', { auctions: [active(1, t0 - 10 * 60e3, 1000), active(2, t0 - 9 * 60e3, 1100), active(3, t0 - 8 * 60e3, 1200), active(4, t0 - 7 * 60e3, 1300)] }, t0 - 15 * 60e3);
  assert.deepStrictEqual(Object.keys(storage.db.checks).sort(), ['aaaa1111-0000-4000-8000-000000000001', ID(1), ID(2), ID(3), ID(4)],
    'the still-running auction from step 2 is queued too (not due yet)');

  assert.strictEqual((await R.resolveTick(t0)).skipped, 'off', 'off by default');
  storage.settings.market = Object.assign({}, storage.settings.market, { autoResolve: true, resolveSpacingSec: 60, resolveMaxPerDay: 3 });
  assert.strictEqual((await R.resolveTick(t0)).skipped, 'permission', 'needs the optional permission');
  permissionGranted = true;
  assert.deepStrictEqual(pageRequests, [], 'nothing sent so far');

  // Sold: exact price recorded, removed from the queue.
  pageResponses[ID(1)] = { auction: Object.assign(active(1, t0 - 10 * 60e3, 1000), { status: 'settled_sold', final_price: 1500, settled_at: new Date(t0 - 10 * 60e3).toISOString() }) };
  assert.deepStrictEqual(clone(await R.resolveTick(t0)), { id: ID(1), outcome: 'resolved' });
  assert.deepStrictEqual(pageRequests, [`https://www.wiki-masters.com/api/marketplace/${ID(1)}`]);
  assert.ok(!storage.db.checks[ID(1)]);
  assert.ok(storage.db.marketSales.triceratops.some((x) => x.price === 1500));

  // Fixed spacing between two requests.
  assert.strictEqual((await R.resolveTick(t0 + 30e3)).skipped, 'spacing');

  // Extended by late bids: re-timed to the new end.
  pageResponses[ID(2)] = { auction: active(2, t0 + 3600e3, 1400) };
  assert.strictEqual((await R.resolveTick(t0 + 61e3)).outcome, 'extended');
  assert.strictEqual(storage.db.checks[ID(2)].end, t0 + 3600e3);

  // No answer: retried later.
  assert.strictEqual((await R.resolveTick(t0 + 122e3)).outcome, 'no-answer');
  assert.strictEqual(storage.db.checks[ID(3)].attempts, 1);

  // Daily cap (3 here).
  assert.strictEqual((await R.resolveTick(t0 + 183e3)).skipped, 'cap');
  assert.strictEqual(storage.resolver.count, 3);
  storage.settings.market.resolveMaxPerDay = 100;

  // Only while a game tab is open.
  siteTabs = [];
  assert.strictEqual((await R.resolveTick(t0 + 244e3)).skipped, 'no-tab');
  siteTabs = [{ id: 7, url: 'https://www.wiki-masters.com/marketplace', windowId: 1 }];

  // Dropped after 3 attempts without an answer.
  storage.db.checks[ID(3)].attempts = 2;
  storage.db.checks[ID(3)].nextAt = 0;
  assert.strictEqual((await R.resolveTick(t0 + 305e3)).outcome, 'dropped');
  assert.ok(!storage.db.checks[ID(3)]);
  assert.strictEqual(pageRequests.length, 4, 'one request per tick, never more');

  // 11. Deal notifications (passive): off by default, once per auction.
  const D = (n) => `dddd0000-0000-4000-8000-00000000000${n}`;
  const t1 = Date.now();
  storage.db.marketSales.triceratops = [1, 2, 3].map((i) => ({ id: `ms${i}`, t: t1 - i * 3600e3, price: 1000 }));
  const deal = { id: D(1), status: 'active', seller_id: 'other', card_id: 'c', card: { wikipedia_title: 'Triceratops', rarity: 'SR' },
    snapshot_rarity: 'SR', effective_bid: 500, current_bid: 500, base_amount: 100, end_at: new Date(t1 + 10 * 60e3).toISOString() };
  await R.ingest('u', { auctions: [deal] }, t1);
  assert.strictEqual(notifications.length, 0, 'notifications are off by default');
  storage.settings.features = Object.assign({}, storage.settings.features, { notify: true, alertPct: 25, alertMinSales: 3 });
  permissionGranted = true;
  await R.ingest('u', { auctions: [deal] }, t1 + 1000);
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0][0], `wmt-deal:${D(1)}`);
  assert.match(notifications[0][1].title, /^Bonne affaire : Triceratops \(SR\) -\d+ %$/);
  assert.match(notifications[0][1].message, /^Prochaine mise 550 W · médiane [\d\u00a0\u202f ]+ W \(\d+ ventes\) · fin dans (9|10) min \d\d s$/,
    'next minimum bid = ceil(500 * 1.1)');
  await R.ingest('u', { auctions: [deal] }, t1 + 2000);
  assert.strictEqual(notifications.length, 1, 'the same auction is notified once');
  assert.deepStrictEqual(pageRequests.length, 4, 'deal detection sends nothing to the game');

  // 12. Groups and saved searches.
  // A search on the Marché: remembered with the page it came from.
  const searchUrl = 'https://www.wiki-masters.com/api/marketplace?search=dino&rarity=SR&page=1&limit=50';
  const igua = (n, bid) => ({ id: `cccc0000-0000-4000-8000-00000000000${n}`, status: 'active', seller_id: 'other', card_id: 'c',
    card: { wikipedia_title: 'Iguanodon', rarity: 'SR' }, snapshot_rarity: 'SR', effective_bid: bid, current_bid: bid, base_amount: 100,
    end_at: new Date(Date.now() + 3600e3).toISOString() });
  listeners.request.fn({ requestId: 's1', method: 'GET', url: searchUrl, documentUrl: 'https://www.wiki-masters.com/marketplace?search=dino' });
  filters.s1.ondata({ data: new TextEncoder().encode(JSON.stringify({ auctions: [igua(1, 300)] })).buffer });
  filters.s1.onstop();
  await settle();
  const logged = storage.db.meta.searchLog[storage.db.meta.searchLog.length - 1];
  assert.deepStrictEqual([logged.query, logged.paged, logged.pageUrl, logged.results, clone(logged.cards)],
    ['limit=50&rarity=SR&search=dino', true, 'https://www.wiki-masters.com/marketplace?search=dino', 1, ['Iguanodon']]);
  assert.ok(storage.db.meta.searchUse[logged.query].user > 0);
  assert.strictEqual(storage.db.meta.searchUse[logged.query].auto, undefined);

  // "+ Suivre" into a group, move, unfollow.
  storage.settings.groups = [{ id: 'dino', name: 'Dinosaures', cards: [] }, { id: 'art', name: 'Peintures', cards: [] }];
  assert.strictEqual((await send({ type: 'follow', card: 'Iguanodon', group: 'dino' })).group, 'dino');
  assert.deepStrictEqual(clone(storage.settings.groups[0].cards), ['Iguanodon']);
  await send({ type: 'follow', card: 'Iguanodon', group: 'art' });
  assert.deepStrictEqual([clone(storage.settings.groups[0].cards), clone(storage.settings.groups[1].cards)], [[], ['Iguanodon']], 'one group per card');
  const ov2 = await send({ type: 'overlayInfo', tiles: [{ ref: 0, id: igua(1).id }] });
  assert.deepStrictEqual([clone(ov2.items[0].group), ov2.items[0].tracked, ov2.groups.length], [{ id: 'art', name: 'Peintures', color: '#eb6834' }, true, 2]);
  assert.strictEqual((await send({ type: 'follow', card: 'Iguanodon', follow: false })).followed, false);
  assert.deepStrictEqual(clone(storage.settings.groups[1].cards), [], 'unfollowing takes it out of its group');
  await send({ type: 'follow', card: 'Iguanodon', group: 'dino' });

  // Save the search in the group (once).
  assert.strictEqual((await send({ type: 'saveSearch', group: 'dino', search: clone(logged) })).ok, true);
  assert.strictEqual((await send({ type: 'saveSearch', group: 'dino', search: clone(logged) })).already, true);
  const saved = storage.settings.groups[0].searches[0];
  assert.deepStrictEqual([saved.query, saved.paged, saved.pageUrl, saved.auto], [logged.query, true, logged.pageUrl, false]);

  // Booster tag on a sale.
  const saleId = Object.keys(storage.db.sales)[0];
  await send({ type: 'setBooster', id: saleId, booster: true });
  assert.strictEqual(storage.db.overrides[saleId].booster, true);

  // 13. Optional automated searches: off by default, then fixed pace, from the game tab.
  const S = ctx.__wmt;
  const n0 = Date.now() + 10 * 60e3;
  assert.strictEqual((await S.searchTick(n0)).skipped, 'off');
  storage.settings.features = Object.assign({}, storage.settings.features, { autoSearch: true, autoSearchMin: 15, autoSearchMaxPerDay: 2 });
  assert.strictEqual((await S.searchTick(n0)).skipped, 'empty', 'no search marked "auto" yet');
  storage.settings.groups[0].searches[0].auto = true;
  const runUrl = 'https://www.wiki-masters.com/api/marketplace?limit=50&rarity=SR&search=dino&page=1';
  pageResponses[runUrl.split('/').pop()] = { auctions: [igua(2, 200)] };
  const before13 = pageRequests.length;
  assert.deepStrictEqual(clone(await S.searchTick(n0)), { query: logged.query, outcome: 'ok', found: 1 });
  assert.deepStrictEqual(pageRequests.slice(before13), [runUrl], 'the same request as the Marché, first page');
  assert.ok(storage.db.auctions[igua(2).id], 'results captured like a page load');
  assert.strictEqual(storage.db.meta.searchUse[logged.query].auto, n0, 'counted as an automated run, not yours');
  assert.strictEqual((await S.searchTick(n0 + 1000)).skipped, 'spacing', 'never two requests within 30 s');
  assert.strictEqual((await R.resolveTick(n0 + 1000)).skipped, 'spacing', 'the resolver waits too');
  assert.strictEqual((await S.searchTick(n0 + 60e3)).skipped, 'empty', 'each search at most every 15 min');
  assert.strictEqual((await S.searchTick(n0 + 16 * 60e3)).outcome, 'ok');
  assert.strictEqual((await S.searchTick(n0 + 32 * 60e3)).skipped, 'cap', 'daily cap (2 here)');
  siteTabs = [];
  storage.settings.features.autoSearchMaxPerDay = 100;
  assert.strictEqual((await S.searchTick(n0 + 48 * 60e3)).skipped, 'no-tab');
  siteTabs = [{ id: 7, url: 'https://www.wiki-masters.com/marketplace', windowId: 1 }];
  assert.strictEqual(pageRequests.length, before13 + 2);

  // Shortcut: the page where the search was made, in the game tab.
  await send({ type: 'openSearch', pageUrl: saved.pageUrl });
  assert.deepStrictEqual(tabUpdates.pop(), [7, { active: true, url: 'https://www.wiki-masters.com/marketplace?search=dino' }]);
  await send({ type: 'openSearch', pageUrl: 'https://evil.example/' });
  assert.deepStrictEqual(tabUpdates.pop(), [7, { active: true, url: 'https://www.wiki-masters.com/marketplace' }], 'only game pages');

  // 14. Unknown messages are ignored.
  assert.strictEqual(send({ type: 'sync' }), undefined, 'there is no active "sync" any more');

  console.log('ok   background.js end-to-end (passive capture, balance, overlay, follow, groups, searches, booster, export progress, tab reuse, gap warning, backup, optional resolver, automated searches)');
}

main().catch((e) => {
  console.error(`FAIL background.js end-to-end\n${e.stack}`);
  process.exitCode = 1;
});
