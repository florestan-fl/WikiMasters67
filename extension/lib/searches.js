/*
 * Saved searches of your groups.
 *
 * A search is the game's own search, as your browser sent it to
 * /api/marketplace?… while you searched on the Marché (text, rarity, sort…):
 * the extension does not need to know the game's parameter names, it keeps
 * them as they are (without the page number) and recognises them when they
 * come back.
 *
 *   db.meta.searchLog  [{ query, paged, pageUrl, at, results, cards, auto }]  last distinct searches seen
 *   db.meta.searchUse  { [query]: { user: time, auto: time } }               last use of each search
 *
 * "user": you ran it on the site; "auto": the optional automated run did.
 */
(function (root) {
  'use strict';

  var LOG_KEEP = 40;
  var USE_KEEP = 500;
  var USE_DAYS = 120;
  var DAY = 86400000;

  function sortPairs(a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  }

  /**
   * The search behind a marketplace list request, or null (your own lists,
   * an auction page, another URL).
   * Returns { query, paged, params: [[name, value]] } — query: sorted, without "page".
   */
  function parse(url) {
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (!/^(www\.)?wiki-masters\.com$/.test(u.hostname) || !/^\/api\/marketplace\/?$/.test(u.pathname)) return null;
    var params = [];
    u.searchParams.forEach(function (v, k) { params.push([k, v]); });
    if (params.some(function (p) { return p[0] === 'mine' && p[1] && p[1] !== '0' && p[1] !== 'false'; })) return null;
    var paged = params.some(function (p) { return p[0] === 'page'; });
    var kept = params.filter(function (p) { return p[0] !== 'page' && p[0].charAt(0) !== '_'; }).sort(sortPairs);
    return {
      query: kept.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&'),
      paged: paged,
      params: kept
    };
  }

  function paramsOf(query) {
    var out = [];
    String(query || '').split('&').filter(Boolean).forEach(function (part) {
      var i = part.indexOf('=');
      var k = i < 0 ? part : part.slice(0, i);
      var v = i < 0 ? '' : part.slice(i + 1);
      try { out.push([decodeURIComponent(k), decodeURIComponent(v)]); } catch (e) { out.push([k, v]); }
    });
    return out;
  }

  /** "search : dinosaure · rarity : SR · sort : price_asc" (the game's own names). */
  function describe(query) {
    var params = paramsOf(query).filter(function (p) { return p[0] !== 'limit' && p[1] !== ''; });
    if (!params.length) return 'Toutes les annonces';
    return params.map(function (p) { return p[0] + ' : ' + p[1]; }).join(' · ');
  }

  /** The API address to run a saved search (first page). */
  function apiUrl(origin, search) {
    var parts = [search.query, search.paged ? 'page=1' : ''].filter(Boolean);
    return origin + '/api/marketplace' + (parts.length ? '?' + parts.join('&') : '');
  }

  /** Records one search seen (by your browsing, or by the automated run). */
  function record(db, info) {
    db.meta.searchLog = Array.isArray(db.meta.searchLog) ? db.meta.searchLog : [];
    db.meta.searchUse = db.meta.searchUse && typeof db.meta.searchUse === 'object' ? db.meta.searchUse : {};
    var use = db.meta.searchUse[info.query] = db.meta.searchUse[info.query] || {};
    use[info.auto ? 'auto' : 'user'] = info.at;
    if (!info.auto) {
      var prev = db.meta.searchLog.filter(function (x) { return x.query === info.query; })[0];
      db.meta.searchLog = db.meta.searchLog.filter(function (x) { return x.query !== info.query; });
      db.meta.searchLog.push({
        query: info.query,
        paged: info.paged,
        // The page you were on when you searched (kept from the first page of the search).
        pageUrl: info.pageUrl || (prev && prev.pageUrl) || '',
        at: info.at,
        results: info.results,
        cards: info.cards.slice(0, 8)
      });
      if (db.meta.searchLog.length > LOG_KEEP) db.meta.searchLog = db.meta.searchLog.slice(-LOG_KEEP);
    }
    // Forget searches nobody ran for a long time.
    var keys = Object.keys(db.meta.searchUse);
    keys.forEach(function (k) {
      var u = db.meta.searchUse[k];
      if (Math.max(u.user || 0, u.auto || 0) < info.at - USE_DAYS * DAY) delete db.meta.searchUse[k];
    });
    keys = Object.keys(db.meta.searchUse);
    if (keys.length > USE_KEEP) {
      keys.sort(function (a, b) {
        var x = db.meta.searchUse[a];
        var y = db.meta.searchUse[b];
        return Math.max(x.user || 0, x.auto || 0) - Math.max(y.user || 0, y.auto || 0);
      }).slice(0, keys.length - USE_KEEP).forEach(function (k) { delete db.meta.searchUse[k]; });
    }
  }

  function lastUse(db, query) {
    var u = (db.meta && db.meta.searchUse && db.meta.searchUse[query]) || {};
    return { user: u.user || null, auto: u.auto || null };
  }

  /**
   * How recently a group was looked at:
   *  user / auto: last run of one of its saved searches (by you / automated);
   *  seen: last time an auction of one of its cards came through your browser;
   *  last: the most recent search (user or auto); overdue: no search for remindDays.
   */
  function activity(db, group, now, cardKey) {
    var user = null;
    var auto = null;
    group.searches.forEach(function (s) {
      var u = lastUse(db, s.query);
      if (u.user && (user === null || u.user > user)) user = u.user;
      if (u.auto && (auto === null || u.auto > auto)) auto = u.auto;
    });
    var keys = {};
    group.cards.forEach(function (c) { keys[cardKey(c)] = true; });
    var seen = null;
    Object.keys(db.auctions || {}).forEach(function (id) {
      var a = db.auctions[id];
      if (!a.mine && keys[a.baseKey] && (seen === null || a.seenAt > seen)) seen = a.seenAt;
    });
    var last = Math.max(user || 0, auto || 0) || null;
    return {
      user: user,
      auto: auto,
      seen: seen,
      last: last,
      overdue: group.searches.length > 0 && (last === null || now - last > group.remindDays * DAY)
    };
  }

  var api = { parse: parse, paramsOf: paramsOf, describe: describe, apiUrl: apiUrl, record: record, lastUse: lastUse, activity: activity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMSearches = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
