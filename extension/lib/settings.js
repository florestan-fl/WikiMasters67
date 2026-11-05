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
      categories: []    // [{ keyword: 'dinosaure' }]
    },
    valuation: {
      windowDays: 14,      // sales younger than this are "recent"
      sampleSize: 3,       // median of the last N sales
      haircutPct: 0,       // safety discount on the estimated stock value
      commissionPct: 0,    // fee taken by the game on each sale
      targetMarginPct: 30, // used for the "max buy price" suggestion
      unmatched: 'ignore'  // sales without a tracked purchase: 'ignore' or 'zero' (cost 0)
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

    var v = raw.valuation || {};
    s.valuation.windowDays = num(v.windowDays, DEFAULTS.valuation.windowDays, 1, 365);
    s.valuation.sampleSize = Math.round(num(v.sampleSize, DEFAULTS.valuation.sampleSize, 1, 50));
    s.valuation.haircutPct = num(v.haircutPct, DEFAULTS.valuation.haircutPct, 0, 100);
    s.valuation.commissionPct = num(v.commissionPct, DEFAULTS.valuation.commissionPct, 0, 100);
    s.valuation.targetMarginPct = num(v.targetMarginPct, DEFAULTS.valuation.targetMarginPct, 0, 1000);
    s.valuation.unmatched = v.unmatched === 'zero' ? 'zero' : 'ignore';
    return s;
  }

  function sheetsConfigured(s) {
    return !!(s && s.sheets && s.sheets.scriptUrl && s.sheets.secret);
  }

  var api = { DEFAULTS: DEFAULTS, normalize: normalize, sheetsConfigured: sheetsConfigured };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
