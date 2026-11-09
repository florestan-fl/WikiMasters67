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
      unmatched: 'ignore'  // sales without a tracked purchase: 'ignore' or 'zero' (cost 0)
    },
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
      deals: true,                 // "Bonnes affaires en cours" list in the popup
      notify: false,               // desktop notification for a new deal (optional permission)
      alertPct: 25,                // a deal: price to take it <= median - alertPct %
      alertMinSales: 3,            // ignore medians built on fewer sales
      alertScope: 'tracked'        // 'tracked' or 'all' cards with market data
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

    var v = raw.valuation || {};
    s.valuation.windowDays = num(v.windowDays, DEFAULTS.valuation.windowDays, 1, 365);
    s.valuation.sampleSize = Math.round(num(v.sampleSize, DEFAULTS.valuation.sampleSize, 1, 50));
    s.valuation.haircutPct = num(v.haircutPct, DEFAULTS.valuation.haircutPct, 0, 100);
    s.valuation.commissionPct = num(v.commissionPct, DEFAULTS.valuation.commissionPct, 0, 100);
    s.valuation.targetMarginPct = num(v.targetMarginPct, DEFAULTS.valuation.targetMarginPct, 0, 1000);
    s.valuation.unmatched = v.unmatched === 'zero' ? 'zero' : 'ignore';

    var ft = raw.features || {};
    var RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
    if (ft.fullArt !== undefined) s.features.fullArt = !!ft.fullArt;
    if (Array.isArray(ft.fullArtRarities)) {
      s.features.fullArtRarities = RARITIES.filter(function (r) { return ft.fullArtRarities.indexOf(r) >= 0; });
    }
    if (ft.deals !== undefined) s.features.deals = !!ft.deals;
    if (ft.notify !== undefined) s.features.notify = !!ft.notify;
    s.features.alertPct = num(ft.alertPct, DEFAULTS.features.alertPct, 1, 95);
    s.features.alertMinSales = Math.round(num(ft.alertMinSales, DEFAULTS.features.alertMinSales, 1, 100));
    s.features.alertScope = ft.alertScope === 'all' ? 'all' : 'tracked';

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

  var api = { DEFAULTS: DEFAULTS, RARITIES: ['L', 'UR', 'SR', 'R', 'PC', 'C'], normalize: normalize, sheetsConfigured: sheetsConfigured };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
