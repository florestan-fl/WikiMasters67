/*
 * The local database (browser.storage.local, key "db"). Pure functions on a
 * plain object so they can be tested with Node.
 *
 *   purchases / sales  { [auctionId]: record }   insert-only: a finished auction never changes
 *   overrides          { [id]: { excluded: true } }  your per-transaction exceptions
 *   cards              { [cardKey]: { title, category, rarity } }
 *   auctions / marketSales   market observations (see market.js)
 *   listings           your active listings, as last seen
 *   snapshots          [{ t, balance }]  wikibidous balance, as read on the site
 *   meta               capture status (last data received, recent additions, warnings)
 */
(function (root) {
  'use strict';

  var Extract = root.WMExtract || (typeof require === 'function' ? require('./extract') : null);
  var cardKey = Extract.cardKey;

  var SNAPSHOT_KEEP = 5000;
  var RECENT_KEEP = 30;

  function emptyDb() {
    return {
      version: 2,
      purchases: {},
      sales: {},
      overrides: {},
      cards: {},
      auctions: {},
      marketSales: {},
      marketEstimates: {},
      checks: {},
      listings: [],
      snapshots: [],
      counters: { A: 0, V: 0 },
      meta: { me: null, lastCapture: null, captures: 0, recent: [], warning: null }
    };
  }

  function normalizeDb(db) {
    var base = emptyDb();
    if (!db || typeof db !== 'object') return base;
    Object.keys(base).forEach(function (k) {
      if (db[k] === undefined || db[k] === null) db[k] = base[k];
    });
    delete db.market; // v2.0 asks, replaced by db.auctions
    if (!Array.isArray(db.meta.recent)) db.meta.recent = [];
    if (!db.counters.A) db.counters.A = maxLabel(db.purchases, 'A');
    if (!db.counters.V) db.counters.V = maxLabel(db.sales, 'V');
    return db;
  }

  function maxLabel(map, prefix) {
    var re = new RegExp('^' + prefix + '(\\d+)$');
    var max = 0;
    Object.keys(map || {}).forEach(function (id) {
      var m = String(map[id].label || '').match(re);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return max;
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function nextLabel(db, prefix) {
    db.counters[prefix] = (db.counters[prefix] || 0) + 1;
    return prefix + pad(db.counters[prefix], 2);
  }

  function values(map) {
    return Object.keys(map || {}).map(function (k) { return map[k]; });
  }

  /**
   * Adds what an update fetched. Returns the new purchases and sales.
   * Existing records are never modified.
   */
  function mergeSync(db, data, now) {
    normalizeDb(db);
    now = now || Date.now();
    var added = { purchases: [], sales: [] };

    function insert(list, map, prefix, out) {
      list.slice().sort(function (a, b) { return a.time - b.time; }).forEach(function (r) {
        if (!r || !r.id || map[r.id]) return;
        var rec = {
          id: r.id,
          label: nextLabel(db, prefix),
          time: r.time,
          card: r.card,
          rarity: r.rarity || '',
          price: r.price,
          party: r.party || '',
          source: 'site'
        };
        if (r.status) rec.status = r.status;
        if (r.shiny) rec.shiny = true;
        map[r.id] = rec;
        out.push(rec);
      });
    }
    insert(data.purchases || [], db.purchases, 'A', added.purchases);
    insert(data.sales || [], db.sales, 'V', added.sales);

    Object.keys(data.cards || {}).forEach(function (k) {
      var c = data.cards[k];
      var prev = db.cards[k] || {};
      db.cards[k] = {
        title: c.title || prev.title,
        category: c.category || prev.category || '',
        rarity: c.rarity || prev.rarity || ''
      };
    });

    if (added.purchases.length || added.sales.length) {
      added.purchases.concat(added.sales).sort(function (a, b) { return a.time - b.time; }).forEach(function (r) {
        db.meta.recent.push({ id: r.id, label: r.label, time: r.time, card: r.card, price: r.price, status: r.status || null, addedAt: now });
      });
      db.meta.recent = db.meta.recent.slice(-RECENT_KEEP);
    }

    if (data.selling) db.listings = data.selling.map(function (s) { return { card: s.card, price: s.price, end: s.end, hasBid: !!s.hasBid }; });

    if (typeof data.balance === 'number') addBalance(db, data.balance, now);
    return added;
  }

  /** Adds a balance reading, at most one every 10 minutes unless it changed. */
  function addBalance(db, balance, now) {
    normalizeDb(db);
    if (typeof balance !== 'number' || !isFinite(balance)) return false;
    var last = db.snapshots[db.snapshots.length - 1];
    if (last && last.balance === balance && now - last.t < 10 * 60000) return false;
    db.snapshots.push({ t: now, balance: balance });
    if (db.snapshots.length > SNAPSHOT_KEEP) db.snapshots = db.snapshots.slice(-SNAPSHOT_KEEP);
    return true;
  }

  /**
   * Imports the rows of a v1 spreadsheet (Achats / Ventes tabs).
   * rows: { purchases: [{ label, time, card, rarity, price, party, inclure, siteId }],
   *         sales:     [{ label, time, card, rarity, price, status, party, siteId }] }
   * "Inclure = Non" becomes a per-transaction exclusion.
   */
  function importV1(db, rows) {
    normalizeDb(db);
    var res = { purchases: 0, sales: 0, skipped: 0, excluded: 0, trackedCards: [] };
    var usedLabels = { A: {}, V: {} };
    values(db.purchases).forEach(function (r) { usedLabels.A[r.label] = true; });
    values(db.sales).forEach(function (r) { usedLabels.V[r.label] = true; });
    var oui = {};

    function add(list, map, prefix, kind) {
      (list || []).forEach(function (r) {
        if (!r || !r.card || !isFinite(Number(r.time)) || !isFinite(Number(r.price))) { res.skipped++; return; }
        var id = r.siteId ? String(r.siteId) : 'v1:' + prefix + ':' + (r.label || (r.card + '@' + r.time));
        var inc = String(r.inclure || '').trim().toLowerCase();
        if ((kind === 'purchases' && inc === 'non') || r.excluded === true) {
          if (!isExcluded(db, id)) res.excluded++;
          db.overrides[id] = { excluded: true };
        }
        if (kind === 'purchases' && inc === 'oui') oui[cardKey(r.card)] = r.card;
        if (map[id]) { res.skipped++; return; }
        var label = r.label && /^[AV]\d+$/i.test(r.label) && !usedLabels[prefix][r.label] ? r.label : null;
        if (label) {
          usedLabels[prefix][label] = true;
          var n = Number(label.slice(1));
          if (n > db.counters[prefix]) db.counters[prefix] = n;
        }
        var rec = {
          id: id,
          label: label,
          time: Number(r.time),
          card: String(r.card),
          rarity: r.rarity ? String(r.rarity) : '',
          price: Number(r.price),
          party: r.party ? String(r.party) : '',
          source: 'sheet'
        };
        if (kind === 'sales') rec.status = r.status === Extract.SOLD ? Extract.SOLD : Extract.UNSOLD;
        map[id] = rec;
        res[kind]++;
      });
    }
    add(rows.purchases, db.purchases, 'A', 'purchases');
    add(rows.sales, db.sales, 'V', 'sales');

    // Rows whose label was already taken get the next free numbers.
    ['A', 'V'].forEach(function (prefix) {
      var map = prefix === 'A' ? db.purchases : db.sales;
      values(map).filter(function (r) { return !r.label; })
        .sort(function (a, b) { return a.time - b.time; })
        .forEach(function (r) { r.label = nextLabel(db, prefix); });
    });

    res.trackedCards = Object.keys(oui).map(function (k) { return oui[k]; }).sort();
    return res;
  }

  function setExcluded(db, id, excluded) {
    normalizeDb(db);
    if (excluded) db.overrides[id] = { excluded: true };
    else delete db.overrides[id];
  }

  function isExcluded(db, id) {
    return !!(db.overrides && db.overrides[id] && db.overrides[id].excluded);
  }

  /** Newest purchase / sale times, for the "gap" warning. */
  function newestTimes(db) {
    var p = null;
    var s = null;
    values(db.purchases).forEach(function (r) { if (r.source === 'site' && (p === null || r.time > p)) p = r.time; });
    values(db.sales).forEach(function (r) { if (r.source === 'site' && (s === null || r.time > s)) s = r.time; });
    return { purchases: p, sales: s };
  }

  var BACKUP_FORMAT = 'wikimasters-sheets-backup';

  function makeBackup(db, settings, now) {
    return { format: BACKUP_FORMAT, version: 2, exportedAt: now || Date.now(), settings: settings, db: db };
  }

  function readBackup(obj) {
    if (!obj || obj.format !== BACKUP_FORMAT || !obj.db) throw new Error("Ce fichier n'est pas une sauvegarde de l'extension.");
    return { db: normalizeDb(obj.db), settings: obj.settings || null };
  }

  var api = {
    emptyDb: emptyDb, normalizeDb: normalizeDb, mergeSync: mergeSync, importV1: importV1, addBalance: addBalance,
    setExcluded: setExcluded, isExcluded: isExcluded, newestTimes: newestTimes, values: values,
    makeBackup: makeBackup, readBackup: readBackup
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
