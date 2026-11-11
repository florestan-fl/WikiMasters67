/*
 * Extension settings: defaults, normalisation and migration from v1.
 * Stored in browser.storage.local under "settings".
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    version: 2,
    tracking: {
      cards: [],        // [{ name: 'Triceratops', since: '' | 'YYYY-MM-DD' }]
      categories: [],   // [{ keyword: 'dinosaure' }]
      excluded: []      // [{ name }] never followed, even if a keyword matches ("Ne plus suivre")
    },
    valuation: {
      windowDays: 14,      // sales younger than this are "recent"
      sampleSize: 3,       // median of the last N sales
      haircutPct: 0,       // safety discount on the estimated stock value
      commissionPct: 0,    // fee taken by the game on each sale
      targetMarginPct: 30, // used for the "max buy price" suggestion
      unmatched: 'ignore', // sales without a tracked purchase: 'ignore' or 'zero' (cost 0)
      boosterCost: 0       // cost given to a card sold after opening it in a booster (sales tagged "Booster")
    },
    // Your own card groups (not the game's categories). A card is in one group at most, and a card
    // in a group is followed. [{ id, name, color, cards: [name], searches: [search], remindDays }]
    // search: { id, label, query, paged, pageUrl, auto } (query = the game's own search parameters,
    // as your browser sent them, without the page number)
    groups: [],
    market: {
      overlay: true,       // show market prices on the site's auction tiles
      dealPct: 15,         // green / red pill when the price is this far from the median
      windowDays: 30,      // period used for the market median
      useEstimates: true,  // count "last bid seen" estimates in the median
      autoResolve: false,  // opt-in: fetch the final price of ended auctions of followed cards
      resolveSpacingSec: 60,
      resolveMaxPerDay: 300
    },
    features: {
      fullArt: false,              // illustration over the whole card, on the site
      fullArtRarities: ['L', 'UR'],
      fullArtWide: 'fit',          // landscape pictures: 'fit' (whole, blurred backdrop), 'skip' (normal card), 'crop'
      deals: true,                 // "Bonnes affaires en cours" list in the popup
      notify: false,               // desktop notification for a new deal (optional permission)
      alertPct: 25,                // a deal: price to take it <= median - alertPct %
      alertMinSales: 3,            // ignore medians built on fewer sales
      alertScope: 'tracked',       // 'tracked' or 'all' cards with market data
      autoSearch: false,           // opt-in: the extension runs the saved searches marked "auto" itself
      autoSearchMin: 15,           // each automated search at most every N minutes
      autoSearchMaxPerDay: 200
    },
    sheets: {
      scriptUrl: '',
      secret: '',
      autoExport: true
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function num(v, def, min, max) {
    var n = Number(v);
    if (v === '' || v === null || v === undefined || !isFinite(n)) return def;
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    return n;
  }

  /** Same key as WMExtract.cardKey (this file is loaded before it in some pages). */
  function key(name) {
    var s = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/\s+/g, ' ');
  }

  // Light-theme categorical palette (same order as the charts): default group colours.
  var PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

  function freeColor(groups) {
    var used = groups.map(function (g) { return String(g.color || '').toLowerCase(); });
    for (var i = 0; i < PALETTE.length; i++) if (used.indexOf(PALETTE[i]) < 0) return PALETTE[i];
    return PALETTE[groups.length % PALETTE.length];
  }

  function cleanId(v, prefix, taken) {
    var id = /^[a-z0-9_-]{1,40}$/i.test(String(v || '')) ? String(v) : '';
    var n = 1;
    while (!id || taken[id]) id = prefix + (n++);
    taken[id] = true;
    return id;
  }

  var SITE_URL = /^https:\/\/(www\.)?wiki-masters\.com\//;

  function normalizeGroups(raw) {
    var out = [];
    var ids = {};
    var searchIds = {};
    var cardOwner = {};
    var list = (Array.isArray(raw) ? raw : []).filter(function (g) { return g && typeof g === 'object'; });
    // Stored ids are kept; only missing or duplicate ones get a new one.
    var stored = {};
    var explicit = list.map(function (g) {
      var ok = /^[a-z0-9_-]{1,40}$/i.test(String(g.id || '')) && !stored[g.id];
      if (ok) stored[g.id] = true;
      return ok;
    });
    Object.keys(stored).forEach(function (id) { ids[id] = true; });
    list.forEach(function (g, gi) {
      var group = {
        id: explicit[gi] ? String(g.id) : cleanId('', 'g', ids),
        name: String(g.name || '').trim().slice(0, 60) || 'Groupe ' + (out.length + 1),
        color: /^#[0-9a-f]{6}$/i.test(String(g.color || '')) ? String(g.color).toLowerCase() : '',
        cards: [],
        searches: [],
        remindDays: Math.round(num(g.remindDays, 3, 1, 60))
      };
      (Array.isArray(g.cards) ? g.cards : []).forEach(function (c) {
        var name = String((c && c.name) || c || '').trim();
        var k = key(name);
        if (!name || cardOwner[k]) return; // one group per card: the first one keeps it
        cardOwner[k] = group.id;
        group.cards.push(name);
      });
      (Array.isArray(g.searches) ? g.searches : []).forEach(function (q) {
        if (!q || typeof q.query !== 'string' || q.query.length > 2000) return;
        group.searches.push({
          id: cleanId(q.id, 's', searchIds),
          label: String(q.label || '').trim().slice(0, 80),
          query: q.query,
          paged: !!q.paged,
          pageUrl: SITE_URL.test(String(q.pageUrl || '')) ? String(q.pageUrl) : '',
          auto: !!q.auto
        });
      });
      out.push(group);
    });
    out.forEach(function (g) { if (!g.color) g.color = freeColor(out); });
    return out;
  }

  function cleanDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '';
  }

  function normalize(raw) {
    var s = clone(DEFAULTS);
    raw = raw || {};

    // v1 settings had scriptUrl / secret at the top level.
    var sheets = raw.sheets || { scriptUrl: raw.scriptUrl, secret: raw.secret };
    s.sheets.scriptUrl = String(sheets.scriptUrl || '').trim();
    s.sheets.secret = String(sheets.secret || '').trim();
    if (sheets.autoExport !== undefined) s.sheets.autoExport = !!sheets.autoExport;

    var tr = raw.tracking || {};
    var seen = {};
    (Array.isArray(tr.cards) ? tr.cards : []).forEach(function (c) {
      var name = String((c && c.name) || '').trim();
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      s.tracking.cards.push({ name: name, since: cleanDate(c.since) });
    });
    (Array.isArray(tr.categories) ? tr.categories : []).forEach(function (c) {
      var kw = String((c && c.keyword) || '').trim();
      if (kw) s.tracking.categories.push({ keyword: kw });
    });
    var seenEx = {};
    (Array.isArray(tr.excluded) ? tr.excluded : []).forEach(function (c) {
      var name = String((c && c.name) || '').trim();
      if (!name || seenEx[name.toLowerCase()]) return;
      seenEx[name.toLowerCase()] = true;
      s.tracking.excluded.push({ name: name });
    });

    s.groups = normalizeGroups(raw.groups);

    var v = raw.valuation || {};
    s.valuation.windowDays = num(v.windowDays, DEFAULTS.valuation.windowDays, 1, 365);
    s.valuation.sampleSize = Math.round(num(v.sampleSize, DEFAULTS.valuation.sampleSize, 1, 50));
    s.valuation.haircutPct = num(v.haircutPct, DEFAULTS.valuation.haircutPct, 0, 100);
    s.valuation.commissionPct = num(v.commissionPct, DEFAULTS.valuation.commissionPct, 0, 100);
    s.valuation.targetMarginPct = num(v.targetMarginPct, DEFAULTS.valuation.targetMarginPct, 0, 1000);
    s.valuation.unmatched = v.unmatched === 'zero' ? 'zero' : 'ignore';
    s.valuation.boosterCost = num(v.boosterCost, DEFAULTS.valuation.boosterCost, 0, 1e7);

    var ft = raw.features || {};
    var FULLART = ['L', 'UR', 'SR', 'R', 'PC', 'C', 'SHINY'];
    if (ft.fullArt !== undefined) s.features.fullArt = !!ft.fullArt;
    if (Array.isArray(ft.fullArtRarities)) {
      s.features.fullArtRarities = FULLART.filter(function (r) { return ft.fullArtRarities.indexOf(r) >= 0; });
    }
    if (['fit', 'skip', 'crop'].indexOf(ft.fullArtWide) >= 0) s.features.fullArtWide = ft.fullArtWide;
    if (ft.deals !== undefined) s.features.deals = !!ft.deals;
    if (ft.notify !== undefined) s.features.notify = !!ft.notify;
    s.features.alertPct = num(ft.alertPct, DEFAULTS.features.alertPct, 1, 95);
    s.features.alertMinSales = Math.round(num(ft.alertMinSales, DEFAULTS.features.alertMinSales, 1, 100));
    s.features.alertScope = ft.alertScope === 'all' ? 'all' : 'tracked';
    if (ft.autoSearch !== undefined) s.features.autoSearch = !!ft.autoSearch;
    s.features.autoSearchMin = Math.round(num(ft.autoSearchMin, DEFAULTS.features.autoSearchMin, 5, 1440));
    s.features.autoSearchMaxPerDay = Math.round(num(ft.autoSearchMaxPerDay, DEFAULTS.features.autoSearchMaxPerDay, 1, 2000));

    var mk = raw.market || {};
    if (mk.overlay !== undefined) s.market.overlay = !!mk.overlay;
    s.market.dealPct = num(mk.dealPct, DEFAULTS.market.dealPct, 1, 90);
    s.market.windowDays = Math.round(num(mk.windowDays, DEFAULTS.market.windowDays, 1, 120));
    if (mk.useEstimates !== undefined) s.market.useEstimates = !!mk.useEstimates;
    if (mk.autoResolve !== undefined) s.market.autoResolve = !!mk.autoResolve;
    s.market.resolveSpacingSec = Math.round(num(mk.resolveSpacingSec, DEFAULTS.market.resolveSpacingSec, 30, 3600));
    s.market.resolveMaxPerDay = Math.round(num(mk.resolveMaxPerDay, DEFAULTS.market.resolveMaxPerDay, 1, 2000));
    return s;
  }

  function sheetsConfigured(s) {
    return !!(s && s.sheets && s.sheets.scriptUrl && s.sheets.secret);
  }

  /** A new group (not stored yet): next free id and colour. */
  function newGroup(groups, name) {
    var ids = {};
    groups.forEach(function (g) { ids[g.id] = true; });
    return { id: cleanId('', 'g', ids), name: name || 'Groupe ' + (groups.length + 1), color: freeColor(groups), cards: [], searches: [], remindDays: 3 };
  }

  var api = {
    DEFAULTS: DEFAULTS, RARITIES: ['L', 'UR', 'SR', 'R', 'PC', 'C'], FULLART_RARITIES: ['L', 'UR', 'SR', 'R', 'PC', 'C', 'SHINY'],
    PALETTE: PALETTE, normalize: normalize, sheetsConfigured: sheetsConfigured, newGroup: newGroup, freeColor: freeColor
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
