/*
 * Tests of the extension logic (extract, store, stats, tables) and of the
 * Apps Script v2 (fake runtime). Real data: your sheet rows and a real API
 * answer (test/fixtures.js). Run with: node test/run-tests.js
 */
'use strict';

const assert = require('assert');
const { FakeSheet, FakeSpreadsheet, loadCodeGs, parisDate } = require('./fake-gas');
const fx = require('./fixtures');
const Extract = require('../extension/lib/extract');
const Time = require('../extension/lib/time');
const Settings = require('../extension/lib/settings');
const Store = require('../extension/lib/store');
const Stats = require('../extension/lib/stats');
const Tables = require('../extension/lib/tables');

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

const P = (s) => parisDate(s).getTime(); // "dd/mm/yyyy hh:mm" Paris -> ms
const settingsWith = (cards, extra) => Settings.normalize(Object.assign({
  tracking: { cards: cards.map((c) => (typeof c === 'string' ? { name: c } : c)), categories: [] }
}, extra || {}));

/** v1 sheet rows as the Apps Script "readV1" returns them. */
function v1Rows() {
  const won = Extract.extract(fx.apiResponse()).purchases;
  const hist = Extract.extract(fx.apiResponse()).sales;
  // Same unique linking the v1 extension did: same card + price, closest date, each site id once.
  const used = new Set();
  const idFor = (list, card, price, time) => {
    const near = list.filter((x) => x.card === card && x.price === price && !used.has(x.id))
      .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
    if (!near || Math.abs(near.time - time) >= 24 * 3600e3) return '';
    used.add(near.id);
    return near.id;
  };
  return {
    purchases: fx.ACHATS_ROWS.map(([label, date, card, rarity, price, party, inclure]) => ({
      label, time: P(date), card, rarity, price, party, inclure, siteId: idFor(won, card, price, P(date))
    })),
    sales: fx.VENTES_ROWS.map(([label, date, card, rarity, price, status]) => ({
      label, time: P(date), card, rarity, price, status, party: '', siteId: idFor(hist, card, price, P(date))
    }))
  };
}

/* ------------------------------------------------------------------ time */

test('time: Paris day keys, boundaries and DST', () => {
  assert.strictEqual(Time.dayKey(Date.UTC(2026, 10, 3, 23, 30)), '2026-11-04'); // 00:30 Paris
  assert.strictEqual(Time.dayStart('2026-11-04'), Date.UTC(2026, 10, 3, 23, 0));
  assert.strictEqual(Time.dayEnd('2026-11-04'), Date.UTC(2026, 10, 4, 23, 0) - 1);
  assert.strictEqual(Time.dayEnd('2026-10-25') - Time.dayStart('2026-10-25') + 1, 25 * 3600e3, '25 h day (end of DST)');
  assert.strictEqual(Time.nextDay('2026-12-31'), '2027-01-01');
  assert.strictEqual(Time.hourOf(Date.UTC(2026, 10, 3, 17, 32)), 18);
  assert.strictEqual(Time.formatDateTime(Date.UTC(2026, 10, 3, 17, 32)), '03/11/2026 18:32');
  assert.strictEqual(Time.weekdayOf(Date.UTC(2026, 10, 2, 12)), 1, 'Monday');
});

/* --------------------------------------------------------------- extract */

test('extract: purchases, sales, listings, market, categories', () => {
  const data = fx.apiResponse();
  data.selling = [{ id: 's1', status: 'active', seller_id: fx.ME, card: { wikipedia_title: 'Triceratops', category: 'genre de dinosaures' }, effective_bid: 1500, current_bid: null, end_at: '2026-11-05T20:00:00+00:00' }];
  data.auctions = [
    { id: 'm1', status: 'active', seller_id: 'other', card: { wikipedia_title: 'Triceratops' }, effective_bid: 950, created_at: '2026-11-05T10:00:00+00:00' },
    { id: 'm2', status: 'active', seller_id: fx.ME, card: { wikipedia_title: 'Triceratops' }, effective_bid: 10 }
  ];
  const ex = Extract.extract(data);
  assert.strictEqual(ex.me, fx.ME);
  assert.strictEqual(ex.purchases.length, 38);
  assert.strictEqual(ex.sales.length, 50);
  const tri = ex.sales.find((s) => s.id.startsWith('13c0146a'));
  assert.deepStrictEqual([tri.status, tri.price, tri.party], ['Non vendue', 1500, ''], 'unsold uses base_amount, not the repriced listing');
  assert.deepStrictEqual(ex.selling.map((s) => [s.card, s.price]), [['Triceratops', 1500]]);
  assert.deepStrictEqual(ex.asks.map((a) => [a.card, a.price]), [['Triceratops', 950]], 'own listings are not market prices');
  assert.strictEqual(ex.cards[Extract.cardKey('Triceratops')].category, 'genre de dinosaures');
  assert.strictEqual(Extract.cardKey('  Norvège '), 'norvege');
  assert.throws(() => Extract.extract({ auctions: [] }), /connecté/);
});

/* ----------------------------------------------------------------- store */

test('store: insert-only merge with chronological labels', () => {
  const db = Store.emptyDb();
  const ex = Extract.extract(fx.apiResponse());
  const added = Store.mergeSync(db, Object.assign({}, ex, { balance: 1667 }), Date.UTC(2026, 10, 3, 18));
  assert.strictEqual(added.purchases.length, 38);
  assert.strictEqual(added.sales.length, 50);
  assert.strictEqual(added.purchases[0].label, 'A01');
  assert.strictEqual(added.purchases[0].card, 'Hong Kong', 'oldest first');
  assert.strictEqual(added.sales[49].label, 'V50');
  assert.deepStrictEqual(db.snapshots, [{ t: Date.UTC(2026, 10, 3, 18), balance: 1667 }]);
  const again = Store.mergeSync(db, ex, Date.UTC(2026, 10, 3, 19));
  assert.deepStrictEqual([again.purchases.length, again.sales.length], [0, 0]);
  assert.strictEqual(db.snapshots.length, 1, 'no balance -> no snapshot');
  // A record never changes once stored.
  const id = added.sales[0].id;
  const tampered = JSON.parse(JSON.stringify(ex));
  tampered.sales.find((s) => s.id === id).price = 99999;
  Store.mergeSync(db, tampered);
  assert.notStrictEqual(db.sales[id].price, 99999);
});

test('store: v1 import keeps labels, history and "Inclure = Non" as exclusions', () => {
  const db = Store.emptyDb();
  const res = Store.importV1(db, v1Rows());
  assert.deepStrictEqual([res.purchases, res.sales, res.excluded], [21, 23, 5]);
  assert.deepStrictEqual(res.trackedCards, ['Allosaurus', 'Ankylosaurus', 'Argentinosaurus', 'Deinonychus', 'Giganotosaurus', 'Triceratops', 'Tyrannosaurus', 'Velociraptor']);
  const a01 = Object.values(db.purchases).find((r) => r.label === 'A01');
  assert.ok(Store.isExcluded(db, a01.id), 'A01 was Non');
  assert.ok(a01.id.startsWith('a9def0fb'), 'linked to its site id');
  const v01 = Object.values(db.sales).find((r) => r.label === 'V01');
  assert.ok(v01.id.startsWith('v1:'), 'V01 is too old for the site: kept with a local id');
  // Then the site data: no duplicates, new labels continue after A21 / V23.
  const added = Store.mergeSync(db, Extract.extract(fx.apiResponse()));
  assert.strictEqual(added.purchases.length, 38 - 21);
  assert.strictEqual(added.sales.length, 50 - 22);
  assert.strictEqual(added.purchases[0].label, 'A22');
  assert.strictEqual(added.sales[0].label, 'V24');
  // Importing twice changes nothing.
  const again = Store.importV1(db, v1Rows());
  assert.deepStrictEqual([again.purchases, again.sales], [0, 0]);
});

test('store: backup round trip and validation', () => {
  const db = Store.emptyDb();
  Store.mergeSync(db, Extract.extract(fx.apiResponse()));
  const b = JSON.parse(JSON.stringify(Store.makeBackup(db, settingsWith(['Triceratops']))));
  const back = Store.readBackup(b);
  assert.strictEqual(Object.keys(back.db.purchases).length, 38);
  assert.strictEqual(back.settings.tracking.cards[0].name, 'Triceratops');
  assert.throws(() => Store.readBackup({ hello: 1 }), /sauvegarde/);
});

/* ----------------------------------------------------------------- stats */

/** Small hand-checked scenario. */
function scenario() {
  const db = Store.emptyDb();
  const T = (d, h) => Time.fromLocal(2026, 11, d, h, 0);
  Store.mergeSync(db, {
    purchases: [
      { id: 'p1', time: T(1, 10), card: 'Triceratops', rarity: 'SR', price: 100, party: 'a' },
      { id: 'p2', time: T(1, 11), card: 'Triceratops', rarity: 'SR', price: 200, party: 'b' },
      { id: 'p3', time: T(1, 12), card: 'Norvège', rarity: 'L', price: 1600, party: 'c' }
    ],
    sales: [
      { id: 's1', time: T(2, 18), card: 'Triceratops', rarity: 'SR', price: 300, status: 'Vendue', party: 'x' },
      { id: 's2', time: T(2, 20), card: 'Triceratops', rarity: 'SR', price: 400, status: 'Non vendue', party: '' },
      { id: 's3', time: T(2, 21), card: 'Norvège', rarity: 'L', price: 1950, status: 'Vendue', party: 'y' }
    ]
  });
  db.snapshots.push({ t: T(2, 22), balance: 1000 });
  return { db, now: T(2, 23), T };
}

test('stats: FIFO, stock value, daily realized / trading profit, net worth', () => {
  const { db, now } = scenario();
  const m = Stats.compute(db, settingsWith(['Triceratops']), now);
  const s1 = m.sales.find((s) => s.id === 's1');
  assert.deepStrictEqual([s1.lot, s1.cost, s1.profit, s1.check], ['A01', 100, 200, 'OK'], 'oldest purchase first');
  assert.strictEqual(s1.hold, 32);
  assert.strictEqual(m.sales.find((s) => s.id === 's3').check, 'Non suivie');
  // Stock: the 200 W Triceratops, valued at the median of recent sales (300).
  assert.deepStrictEqual(m.inventory.map((i) => [i.card, i.qty, i.cost, i.unitValue, i.valueSource]),
    [['Triceratops', 1, 200, 300, 'ventes récentes']]);
  assert.deepStrictEqual(m.days.map((d) => d.day), ['2026-11-01', '2026-11-02']);
  const [d1, d2] = m.days;
  assert.deepStrictEqual([d1.realized, d1.stockCost, d1.stockValue, d1.trading], [0, 300, 300, 0], 'day 1: no price evidence yet -> valued at cost');
  assert.deepStrictEqual([d2.realized, d2.stockCost, d2.stockValue, d2.unrealized, d2.trading], [200, 200, 300, 100, 300]);
  assert.deepStrictEqual([d2.balance, d2.netWorth], [1000, 1300]);
  const k = m.kpis;
  assert.deepStrictEqual([k.realizedToday, k.realizedTotal, k.tradingToday, k.stockValue, k.netWorth, k.margin],
    [200, 200, 300, 300, 1300, 2]);
  assert.strictEqual(k.sellRate, 0.5);
  const c = m.cards.find((x) => x.card === 'Triceratops');
  assert.deepStrictEqual([c.purchases, c.avgBuy, c.listings, c.sold, c.avgSell, c.profit, c.stock, c.maxBuy],
    [2, 150, 2, 1, 300, 200, 1, 300 / 1.3]);
});

test('stats: excluding a purchase changes the FIFO match', () => {
  const { db, now } = scenario();
  Store.setExcluded(db, 'p1', true);
  const m = Stats.compute(db, settingsWith(['Triceratops']), now);
  const s1 = m.sales.find((s) => s.id === 's1');
  assert.deepStrictEqual([s1.lot, s1.profit], ['A02', 100]);
  assert.strictEqual(m.kpis.stockQty, 0);
  assert.strictEqual(m.purchases.find((p) => p.id === 'p1').tracked, false);
});

test('stats: "since" date, category keyword and unmatched sales', () => {
  const { db, now } = scenario();
  // Tracking Triceratops only from 01/12 10:30: the 100 W purchase is ignored.
  const since = Stats.compute(db, settingsWith([{ name: 'triceratops', since: '2026-11-02' }]), now);
  const s1 = since.sales.find((s) => s.id === 's1');
  assert.strictEqual(s1.check, 'Sans achat correspondant', 'purchases are older than the tracking start');
  assert.strictEqual(s1.profit, null);
  assert.ok(since.warnings.some((w) => /sans achat correspondant/.test(w)));
  const zero = Stats.compute(db, settingsWith([{ name: 'Triceratops', since: '2026-11-02' }], { valuation: { unmatched: 'zero' } }), now);
  assert.strictEqual(zero.sales.find((s) => s.id === 's1').profit, 300);
  // Category keyword (accents and case ignored).
  db.cards[Extract.cardKey('Norvège')] = { title: 'Norvège', category: "Pays d'Europe du Nord", rarity: 'L' };
  const cat = Stats.compute(db, Settings.normalize({ tracking: { cards: [], categories: [{ keyword: 'PAYS' }] } }), now);
  assert.deepStrictEqual(cat.sales.filter((s) => s.tracked).map((s) => s.id), ['s3']);
  assert.strictEqual(cat.sales.find((s) => s.id === 's3').profit, 350);
});

test('stats: commission and haircut', () => {
  const { db, now } = scenario();
  const m = Stats.compute(db, settingsWith(['Triceratops'], { valuation: { commissionPct: 10, haircutPct: 20 } }), now);
  const s1 = m.sales.find((s) => s.id === 's1');
  assert.strictEqual(s1.net, 270);
  assert.strictEqual(s1.profit, 170);
  assert.strictEqual(m.inventory[0].unitValue, 300 * 0.9 * 0.8);
});

test('stats: market listings value stock without recent sales', () => {
  const { db, now, T } = scenario();
  Store.mergeSync(db, { purchases: [{ id: 'p9', time: T(2, 12), card: 'Diplodocus', price: 2350 }], asks: [{ id: 'm1', card: 'Diplodocus', price: 1800 }] }, now - 3600e3);
  const m = Stats.compute(db, settingsWith(['Triceratops', 'Diplodocus']), now);
  const dip = m.inventory.find((i) => i.card === 'Diplodocus');
  assert.deepStrictEqual([dip.unitValue, dip.valueSource], [1800, 'annonces en cours']);
});

test('stats: hours use Paris time and price indices', () => {
  const { db, now } = scenario();
  const m = Stats.compute(db, settingsWith(['Triceratops']), now);
  assert.strictEqual(m.hours[10].purchases, 1);
  assert.strictEqual(m.hours[11].purchases, 1);
  assert.strictEqual(m.hours[10].buyIndex, 100 / 150);
  assert.strictEqual(m.hours[18].sellRate, 1);
  assert.strictEqual(m.hours[20].sellRate, 0);
});

test('stats on your real data: v1 import + site data', () => {
  const db = Store.emptyDb();
  const imp = Store.importV1(db, v1Rows());
  Store.mergeSync(db, Extract.extract(fx.apiResponse()));
  const m = Stats.compute(db, settingsWith(imp.trackedCards), P('03/11/2026 23:00'));
  const t = m.cards.find((c) => c.card === 'Tyrannosaurus');
  assert.deepStrictEqual([t.purchases, t.sold, t.profit], [1, 1, 504], 'same as the v1 "Par espèce" tab');
  const v01 = m.sales.find((s) => s.label === 'V01');
  assert.deepStrictEqual([v01.lot, v01.cost], ['A04', 1641]);
  // Excluded rows from v1 stay out.
  assert.strictEqual(m.purchases.find((p) => p.label === 'A02').tracked, false);
  assert.ok(m.days.length >= 5);
  assert.ok(m.days.every((d) => isFinite(d.trading) && isFinite(d.stockValue)));
  assert.strictEqual(m.kpis.realizedTotal, m.days.reduce((s, d) => s + d.realized, 0));
});

/* ---------------------------------------------------------------- tables */

test('tables: every row matches its headers; CSV for French Excel', () => {
  const { db, now } = scenario();
  const m = Stats.compute(db, settingsWith(['Triceratops']), now);
  const tables = Tables.build(m);
  assert.deepStrictEqual(tables.map((t) => t.name), ['Tableau de bord', 'Par jour', 'Inventaire', 'Par carte', 'Par heure',
    'Inflation', 'Prix dans le temps', 'Achats', 'Ventes']);
  tables.forEach((t) => {
    assert.strictEqual(t.formats.length, t.headers.length, `${t.name} formats`);
    t.rows.forEach((r) => assert.strictEqual(r.length, t.headers.length, `${t.name} row length`));
    t.charts.forEach((c) => c.series.concat([c.domain]).forEach((i) => assert.ok(i < t.headers.length, `${t.name} chart column`)));
  });
  const csv = Tables.toCsv(tables.find((t) => t.name === 'Ventes'));
  assert.ok(csv.startsWith('﻿ID;Date/heure;Carte'));
  assert.ok(csv.includes('V01;02/11/2026 18:00;Triceratops;SR;300;Vendue;x;Oui;Non;A01;100;300;200;2;32;'));
});

/* ----------------------------------------------------------- Apps Script */

function v1Spreadsheet() {
  const achats = new FakeSheet('Achats', 999, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Vendeur', 'Inclure', 'Heure', 'Jour', 'N°', 'Indice', 'ID site']
    .forEach((h, i) => { achats.cell(1, i + 1).v = h; });
  const rows = v1Rows();
  rows.purchases.forEach((r, i) => {
    [r.label, new Date(r.time), r.card, r.rarity, r.price, r.party, r.inclure].forEach((v, c) => { achats.cell(i + 2, c + 1).v = v; });
    achats.cell(i + 2, 12).v = r.siteId;
  });
  const ventes = new FakeSheet('Ventes', 998, 26);
  ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Statut', 'ID achat (FIFO)'].forEach((h, i) => { ventes.cell(1, i + 1).v = h; });
  ventes.cell(1, 17).v = 'Acheteur';
  ventes.cell(1, 18).v = 'ID site';
  rows.sales.forEach((r, i) => {
    [r.label, new Date(r.time), r.card, r.rarity, r.price, r.status].forEach((v, c) => { ventes.cell(i + 2, c + 1).v = v; });
    ventes.cell(i + 2, 18).v = r.siteId;
  });
  const parEspece = new FakeSheet('Par espèce', 1000, 26);
  parEspece.cell(1, 1).v = 'Synthèse';
  const parHeure = new FakeSheet('Par heure', 1000, 26);
  parHeure.cell(1, 1).v = 'Heure';
  return new FakeSpreadsheet('WikiMasters', [achats, ventes, parEspece, parHeure]);
}

function runtime(ss) {
  const gas = loadCodeGs(ss);
  gas.context.setup();
  const secret = gas.props.get('SECRET');
  return { gas, call: (body) => gas.post(Object.assign({ secret }, body)) };
}

test('apps script: secret, ping and unknown action', () => {
  const { gas, call } = runtime(v1Spreadsheet());
  assert.match(gas.post({ secret: 'x', action: 'ping' }).error, /Secret incorrect/);
  assert.deepStrictEqual([call({ action: 'ping' }).ok, call({ action: 'ping' }).version], [true, 2]);
  assert.match(call({ action: 'merge' }).error, /Action inconnue/);
});

test('apps script: readV1 returns the v1 rows', () => {
  const { call } = runtime(v1Spreadsheet());
  const res = call({ action: 'readV1' });
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(res.sheets, ['Achats', 'Ventes']);
  assert.strictEqual(res.purchases.length, 21);
  assert.strictEqual(res.sales.length, 23);
  assert.deepStrictEqual(res.purchases[0], Object.assign({}, v1Rows().purchases[0]));
  assert.strictEqual(res.sales[0].status, 'Vendue');
});

test('apps script: write creates the template, archives v1 tabs, then reuses its tabs', () => {
  const ss = v1Spreadsheet();
  const { call } = runtime(ss);
  const db = Store.emptyDb();
  const imp = Store.importV1(db, call({ action: 'readV1' }));
  Store.mergeSync(db, Extract.extract(fx.apiResponse()), P('03/11/2026 23:00'));
  const m = Stats.compute(db, settingsWith(imp.trackedCards), P('03/11/2026 23:00'));
  const tables = JSON.parse(JSON.stringify(Tables.build(m)));

  const res = call({ action: 'write', tables });
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(res.warnings.filter((w) => !/conservé/.test(w)), []);
  const names = ss.getSheets().map((s) => s.getName());
  assert.deepStrictEqual(names.slice(0, 9), ['Tableau de bord', 'Par jour', 'Inventaire', 'Par carte', 'Par heure', 'Inflation',
    'Prix dans le temps', 'Achats', 'Ventes']);
  assert.ok(names.includes('Achats (v1)') && names.includes('Ventes (v1)') && names.includes('Par heure (v1)') && names.includes('Par espèce'));

  const ventes = ss.getSheetByName('Ventes');
  assert.strictEqual(ventes.cell(1, 1).v, 'ID');
  assert.strictEqual(ventes.cell(1, 1).bg, '#1f4e3d');
  assert.strictEqual(ventes.getLastRow(), m.sales.length + 1);
  assert.strictEqual(Object.prototype.toString.call(ventes.cell(2, 2).v), '[object Date]', 'dates converted');
  assert.strictEqual(ventes.cell(2, 2).nf, 'dd/mm/yyyy hh:mm');
  assert.ok(ventes.filter, 'filter on transaction tabs');
  assert.strictEqual(ss.getSheetByName('Par carte').getCharts().length, 4);
  assert.strictEqual(ss.getSheetByName('Par jour').getCharts().length, 3);
  const chart = ss.getSheetByName('Par carte').getCharts()[1];
  assert.deepStrictEqual(chart.ranges.map((r) => r[1]), [1, 4, 9], 'domain + avg buy + avg sell columns');

  // Second write: same tabs, no new archive, charts replaced not duplicated.
  const res2 = call({ action: 'write', tables });
  assert.strictEqual(res2.ok, true);
  assert.deepStrictEqual(res2.warnings, []);
  assert.strictEqual(ss.getSheets().length, names.length);
  assert.strictEqual(ss.getSheetByName('Par carte').getCharts().length, 4);

  // readV1 still finds the archived v1 rows after the migration.
  const again = call({ action: 'readV1' });
  assert.deepStrictEqual(again.sheets, ['Achats (v1)', 'Ventes (v1)']);
});

test('apps script: write on an empty spreadsheet (template for new players)', () => {
  const ss = new FakeSpreadsheet('Nouveau', [new FakeSheet('Feuille 1', 1000, 26)]);
  const { call } = runtime(ss);
  const m = Stats.compute(Store.emptyDb(), Settings.normalize({}), Date.now());
  const res = call({ action: 'write', tables: JSON.parse(JSON.stringify(Tables.build(m))) });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(ss.getSheets().length, 10);
  assert.strictEqual(ss.getSheetByName('Achats').cell(1, 3).v, 'Carte');
});

test('apps script: malformed tables are refused', () => {
  const { call } = runtime(new FakeSpreadsheet('X', []));
  const res = call({ action: 'write', tables: [{ name: 'T', headers: ['a', 'b'], rows: [[1]] }] });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /colonnes/);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', some FAILED' : ''}.`);
