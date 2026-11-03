/*
 * End-to-end test of the sync logic: real sheet rows + real API answer,
 * fake Apps Script runtime. Run with: node test/run-tests.js
 */
'use strict';

const assert = require('assert');
const { FakeSheet, FakeSpreadsheet, loadCodeGs, parisDate, formatDate, TZ } = require('./fake-gas');
const { ACHATS_ROWS, VENTES_ROWS, apiResponse, uuid, iso } = require('./fixtures');
const { extract, toMs } = require('../extension/lib/extract');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

const ACHATS_HEADERS = ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Vendeur', 'Inclure',
  'Heure', 'Jour (1 = lundi)', "N° achat de l'espèce", 'Indice prix'];
const VENTES_HEADERS = ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Statut', 'ID achat (FIFO)',
  "Prix d'achat (W)", 'Revenu net (W)', 'Profit (W)', 'Marge', 'Détention (h)', 'Heure', 'Jour (1 = lundi)',
  'Indice prix', 'Contrôle'];
const FIFO = (r) => `=IF(C${r}="";"";FIFO(C${r};C$1:C${r - 1};F$1:F${r - 1}))`;

function buildSpreadsheet() {
  const achats = new FakeSheet('Achats', 999, 26);
  ACHATS_HEADERS.forEach((h, i) => { achats.cell(1, i + 1).v = h; achats.cell(1, i + 1).fmt = 'header'; });
  ACHATS_ROWS.forEach((row, i) => {
    const r = i + 2;
    row.forEach((v, c) => { achats.cell(r, c + 1).v = c === 1 ? parisDate(v) : v; });
    for (let c = 1; c <= 11; c++) achats.cell(r, c).fmt = 'data';
  });
  for (let r = 2; r <= 999; r++) achats.cell(r, 7).dv = 'Oui/Non';
  ['H', 'I', 'J', 'K'].forEach((col, i) => { achats.cell(2, 8 + i).f = `=ARRAYFORMULA(IF(B2:B="";"";${col}))`; });
  achats.getRange(1, 1, 22, 11).createFilter();

  const ventes = new FakeSheet('Ventes', 998, 26);
  VENTES_HEADERS.forEach((h, i) => { ventes.cell(1, i + 1).v = h; ventes.cell(1, i + 1).fmt = 'header'; });
  VENTES_ROWS.forEach((row, i) => {
    const r = i + 2;
    row.forEach((v, c) => { ventes.cell(r, c + 1).v = c === 1 ? parisDate(v) : v; });
    ventes.cell(r, 7).f = FIFO(r);
    for (let c = 1; c <= 16; c++) ventes.cell(r, c).fmt = 'data';
  });
  for (let r = 2; r <= 998; r++) ventes.cell(r, 6).dv = 'Vendue/Non vendue';
  for (let c = 8; c <= 16; c++) ventes.cell(2, c).f = `=ARRAYFORMULA(IF(F2:F="";"";${c}))`;
  ventes.getRange(1, 1, 21, 16).createFilter();

  return { ss: new FakeSpreadsheet('WikiMasters', [achats, ventes]), achats, ventes };
}

function newRuntime() {
  const env = buildSpreadsheet();
  const gas = loadCodeGs(env.ss);
  gas.context.setup();
  const secret = gas.props.get('SECRET');
  const call = (body) => gas.post(Object.assign({ secret }, body));
  return Object.assign(env, { gas, secret, call });
}

const SETTINGS = { startDate: '2026-10-30', inclureDefault: 'Oui', matchWindowHours: 24, renumber: false };

function syncBody(data, extra) {
  const { purchases, sales } = extract(data);
  return Object.assign({ action: 'sync', purchases, sales }, SETTINGS, extra || {});
}

const fmt = (d) => (Object.prototype.toString.call(d) === '[object Date]' ? formatDate(d, TZ, 'dd/MM/yyyy HH:mm') : d);

/* ------------------------------------------------------------------------ */

test('toMs handles 6 fractional digits and offsets', () => {
  assert.strictEqual(toMs('2026-11-03T17:32:07.161979+00:00'), Date.UTC(2026, 10, 3, 17, 32, 7, 161));
  assert.strictEqual(toMs('2026-11-03T17:32:07+00:00'), Date.UTC(2026, 10, 3, 17, 32, 7));
  assert.strictEqual(toMs(null), null);
  assert.strictEqual(toMs('garbage'), null);
});

test('extract maps won/history to purchases/sales', () => {
  const { purchases, sales, me } = extract(apiResponse());
  assert.strictEqual(me, '205ffe34-550c-402d-b1ce-eabaf5ece82c');
  assert.strictEqual(purchases.length, 38);
  assert.strictEqual(sales.length, 50);
  const tri = sales.find((s) => s.siteId.startsWith('13c0146a'));
  assert.deepStrictEqual([tri.status, tri.price, tri.party], ['Non vendue', 1500, ''], 'unsold uses base_amount');
  const giga = sales.find((s) => s.siteId.startsWith('c989f609'));
  assert.deepStrictEqual([giga.status, giga.price, giga.party, giga.card], ['Vendue', 750, 'Jørgen15', 'Giganotosaurus']);
  const t = purchases.find((p) => p.siteId.startsWith('fda70b88'));
  assert.deepStrictEqual([t.card, t.rarity, t.price, t.party], ['Tyrannosaurus', 'UR', 1641, 'laure0756']);
  assert.ok(purchases.every((p, i) => i === 0 || purchases[i - 1].time <= p.time), 'sorted by time');
});

test('extract ignores active auctions and other users', () => {
  const data = apiResponse();
  data.history.push(Object.assign({}, data.history[0], { id: 'x1', status: 'active' }));
  data.won.push(Object.assign({}, data.won[0], { id: 'x2', winner_id: 'someone-else' }));
  const { purchases, sales } = extract(data);
  assert.strictEqual(purchases.length, 38);
  assert.strictEqual(sales.length, 50);
});

test('extract rejects answers without history/won', () => {
  assert.throws(() => extract({ auctions: [] }), /logged in/);
});

test('wrong secret is refused', () => {
  const env = newRuntime();
  const res = env.gas.post({ secret: 'nope', action: 'ping' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Wrong secret/);
});

test('ping reports the spreadsheet', () => {
  const env = newRuntime();
  const res = env.call({ action: 'ping' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.sheets.map((s) => s.found), [true, true]);
});

test('first sync: dry run writes nothing and reports the plan', () => {
  const env = newRuntime();
  const before = env.achats.snapshot() + env.ventes.snapshot();
  const res = env.call(syncBody(apiResponse(), { dryRun: true }));
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(env.achats.snapshot() + env.ventes.snapshot(), before, 'sheet untouched');
  assert.strictEqual(env.gas.props.has('CUTOFF_Achats'), false, 'cutoff not stored by a dry run');

  const p = res.purchases.stats;
  assert.deepStrictEqual(p, { received: 38, alreadyKnown: 0, beforeStart: 4, matched: 21, added: 13 });
  const s = res.sales.stats;
  assert.deepStrictEqual(s, { received: 50, alreadyKnown: 0, beforeStart: 0, matched: 22, added: 28 });

  // Every hand-entered purchase is linked to the right auction.
  const byId = Object.fromEntries(res.purchases.matched.map((m) => [m.id, m]));
  assert.strictEqual(Object.keys(byId).length, 21);
  assert.strictEqual(byId.A18.siteDate, '03/11/2026 12:02', 'A18 CuteName');
  assert.strictEqual(byId.A21.siteDate, '03/11/2026 17:02', 'A21 brunolegros');
  assert.strictEqual(byId.A01.siteDate, '31/10/2026 10:42', 'A01 Himmel_');

  // Hand-entered sales: V01 (too old for the site) is the only one left alone.
  const salesById = Object.fromEntries(res.sales.matched.map((m) => [m.id, m]));
  assert.ok(!salesById.V01);
  assert.strictEqual(Object.keys(salesById).length, 22);
  assert.strictEqual(salesById.V05.siteDate, '01/11/2026 12:56');
  assert.ok(salesById.V05.notes.some((n) => /status/.test(n)), 'V05 status difference reported');
  assert.strictEqual(salesById.V14.siteDate, '02/11/2026 21:34');
  assert.strictEqual(salesById.V13.siteDate, '02/11/2026 18:30');
  assert.strictEqual(salesById.V17.siteDate, '02/11/2026 23:04');
  assert.strictEqual(salesById.V22.siteDate, '03/11/2026 18:31');

  // Backfilled purchases get Inclure = Non.
  assert.ok(res.purchases.added.every((a) => a.inclure === 'Non'));
  assert.ok(res.warnings.some((w) => /Inclure = "Non"/.test(w)));
});

test('first sync: real run merges chronologically and keeps formulas', () => {
  const env = newRuntime();
  const res = env.call(syncBody(apiResponse()));
  assert.strictEqual(res.ok, true, res.error);

  const A = env.achats;
  // Headers: "ID site" created in L and hidden; nothing else changed in row 1.
  assert.strictEqual(A.cell(1, 12).v, 'ID site');
  assert.strictEqual(A.cell(1, 12).fmt, 'header');
  assert.ok(A.hidden.has(12));
  const rowsA = A.dump([1, 2, 3, 4, 5, 6, 7, 12]);
  assert.strictEqual(rowsA.length, 21 + 13);
  // Chronological except where the hand-entered order already differs (A04/A05).
  const ids = rowsA.map((r) => r[0]);
  assert.deepStrictEqual(ids.slice(0, 5), ['A22', 'A23', 'A24', 'A01', 'A25'],
    'Gasproutine, MewiSecler, SURPRYZ before A01, then vedved');
  assert.strictEqual(new Set(ids).size, ids.length, 'unique IDs');
  // Hand-entered values are untouched, only "ID site" is filled.
  const a01 = rowsA.find((r) => r[0] === 'A01');
  assert.deepStrictEqual([fmt(a01[1]), a01[2], a01[4], a01[5], a01[6]], ['30/10/2026 23:44', 'Velociraptor', 549, 'Himmel_', 'Non']);
  assert.ok(String(a01[7]).startsWith('a9def0fb'));
  assert.ok(rowsA.every((r) => r[7]), 'every row has a site id');
  const a22 = rowsA[0];
  assert.deepStrictEqual([fmt(a22[1]), a22[2], a22[3], a22[4], a22[5], a22[6]],
    ['30/10/2026 00:15', 'Triceratops', 'SR', 910, 'Gasproutine', 'Non']);
  // ARRAYFORMULAs untouched, formats/validation copied to the new rows.
  assert.match(A.cell(2, 8).f, /^=ARRAYFORMULA/);
  assert.strictEqual(A.cell(35, 1).fmt, 'data');
  assert.strictEqual(A.cell(35, 7).dv, 'Oui/Non');
  // Filter now covers all rows and the new column.
  assert.deepStrictEqual([A.filter.range.getLastRow(), A.filter.range.getLastColumn()], [35, 12]);

  const V = env.ventes;
  assert.deepStrictEqual([V.cell(1, 17).v, V.cell(1, 18).v], ['Acheteur', 'ID site']);
  assert.ok(V.hidden.has(18) && !V.hidden.has(17));
  const rowsV = V.dump([1, 2, 3, 4, 5, 6, 17, 18]);
  assert.strictEqual(rowsV.length, 23 + 28);
  // Buyer filled in for hand-entered sold rows.
  const v23 = rowsV.find((r) => r[0] === 'V23');
  assert.strictEqual(v23[6], 'Jørgen15');
  const v05 = rowsV.find((r) => r[0] === 'V05');
  assert.deepStrictEqual([v05[5], v05[6]], ['Non vendue', ''], 'status of hand-entered row is not changed');
  // Per-row FIFO formula copied to the new rows with adjusted references.
  for (let r = 2; r <= 52; r++) assert.strictEqual(V.cell(r, 7).f, FIFO(r), `FIFO formula row ${r}`);
  assert.strictEqual(V.cell(53, 7).f, '');
  // Sales are in chronological order (hand-entered order was already chronological).
  const times = rowsV.map((r) => r[1].getTime());
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      // Only allowed where an existing hand-entered row is later than the site date.
      assert.ok(/^V(0[1-9]|1\d|2[0-3])$/.test(rowsV[i - 1][0]) || /^V(0[1-9]|1\d|2[0-3])$/.test(rowsV[i][0]),
        `out of order at ${rowsV[i][0]}`);
    }
  }
  assert.deepStrictEqual([V.filter.range.getLastRow(), V.filter.range.getLastColumn()], [52, 18]);
  assert.strictEqual(env.gas.props.get('CUTOFF_Achats'), String(parisDate('03/11/2026 16:57').getTime()));
});

test('second sync with the same data adds nothing', () => {
  const env = newRuntime();
  env.call(syncBody(apiResponse()));
  const snapshot = env.achats.snapshot() + env.ventes.snapshot();
  const res = env.call(syncBody(apiResponse()));
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(res.purchases.stats, { received: 38, alreadyKnown: 34, beforeStart: 4, matched: 0, added: 0 });
  assert.deepStrictEqual(res.sales.stats, { received: 50, alreadyKnown: 50, beforeStart: 0, matched: 0, added: 0 });
  assert.strictEqual(env.achats.snapshot() + env.ventes.snapshot(), snapshot, 'sheet unchanged');
});

test('later sync appends new transactions with the default Inclure', () => {
  const env = newRuntime();
  env.call(syncBody(apiResponse()));
  const data = apiResponse({
    history: [
      ['aaaa0001', '2026-11-04T09:00:00', 'Triceratops', 'SR', 'S', 1400, 'Bob'],
      ['aaaa0002', '2026-11-04T10:00:00', 'Diplodocus', 'SR', 'U', 2500]
    ],
    won: [
      ['bbbb0001', '2026-11-04T08:00:00', 'Triceratops', 'SR', 1100, 'Alice'],
      ['bbbb0002', '2026-11-04T08:30:00', 'Stegosaurus', 'SR', 500, 'Carol']
    ]
  });
  const res = env.call(syncBody(data));
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.purchases.stats.added, 2);
  assert.strictEqual(res.sales.stats.added, 2);
  const rowsA = env.achats.dump([1, 2, 3, 7]);
  assert.deepStrictEqual(rowsA.slice(-2).map((r) => [r[0], r[2], r[3]]), [['A35', 'Triceratops', 'Oui'], ['A36', 'Stegosaurus', 'Oui']]);
  const rowsV = env.ventes.dump([1, 3, 6, 17]);
  assert.deepStrictEqual(rowsV.slice(-2), [['V52', 'Triceratops', 'Vendue', 'Bob'], ['V53', 'Diplodocus', 'Non vendue', '']]);
  assert.strictEqual(env.ventes.cell(54, 7).f, FIFO(54));
  assert.strictEqual(res.warnings.length, 0);
});

test('"auto" Inclure follows the card history', () => {
  const env = newRuntime();
  env.call(syncBody(apiResponse()));
  const data = apiResponse({
    history: [],
    won: [
      ['cccc0001', '2026-11-04T08:00:00', 'Giganotosaurus', 'SR', 400, 'Alice'],
      ['cccc0002', '2026-11-04T08:30:00', 'Allemagne', 'L', 1800, 'Carol']
    ]
  });
  const res = env.call(syncBody(data, { inclureDefault: 'auto' }));
  assert.deepStrictEqual(res.purchases.added.map((a) => [a.card, a.inclure]), [['Giganotosaurus', 'Oui'], ['Allemagne', 'Non']]);
});

test('renumber option rewrites IDs in row order', () => {
  const env = newRuntime();
  env.call(syncBody(apiResponse(), { renumber: true }));
  const ids = env.achats.dump([1]).map((r) => r[0]);
  assert.deepStrictEqual(ids.slice(0, 3), ['A01', 'A02', 'A03']);
  assert.strictEqual(ids[ids.length - 1], 'A34');
  const vIds = env.ventes.dump([1]).map((r) => r[0]);
  assert.strictEqual(vIds[vIds.length - 1], 'V51');
});

test('no start date imports everything the site returns', () => {
  const env = newRuntime();
  const res = env.call(syncBody(apiResponse(), { startDate: '', dryRun: true }));
  assert.strictEqual(res.purchases.stats.beforeStart, 0);
  assert.strictEqual(res.purchases.stats.added, 17);
});

test('missing column is reported clearly', () => {
  const env = newRuntime();
  env.ventes.cell(1, 6).v = 'State';
  const res = env.call(syncBody(apiResponse(), { dryRun: true }));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Ventes.*Statut/);
});

test('helper column is not created over existing data', () => {
  const env = newRuntime();
  env.achats.cell(1, 12).v = 'Notes';
  // "Notes" is now the last header, so "ID site" goes to M: no conflict.
  const res = env.call(syncBody(apiResponse()));
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(env.achats.cell(1, 13).v, 'ID site');
});

test('incomplete items are ignored with a warning', () => {
  const env = newRuntime();
  const body = syncBody(apiResponse({ history: [], won: [] }));
  body.purchases = [{ siteId: 'z', time: Date.now(), card: '', price: 1 }];
  const res = env.call(body);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.purchases.stats.received, 0);
  assert.ok(res.warnings.some((w) => /incomplete/.test(w)));
});

test('rows inserted near the cutoff use the stored cutoff, not the new last row', () => {
  const env = newRuntime();
  env.call(syncBody(apiResponse()));
  const data = apiResponse({ history: [], won: [['dddd0001', '2026-11-03T15:00:00', 'Triceratops', 'SR', 999, 'Late']] });
  const res = env.call(syncBody(data));
  // 16:00 Paris is before the last hand-entered purchase (16:57): treated as backfill.
  assert.deepStrictEqual(res.purchases.added.map((a) => a.inclure), ['Non']);
  void uuid; void iso;
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
