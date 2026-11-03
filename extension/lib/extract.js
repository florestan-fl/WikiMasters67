/*
 * Turns the JSON returned by https://www.wiki-masters.com/api/marketplace?...&mine=1
 * into the purchase / sale records sent to the Apps Script.
 *
 *   won[]     -> purchases (auctions you won)
 *   history[] -> sales (your auctions that ended, sold or not)
 *
 * Shared by the background script and the Node tests (no browser APIs here).
 */
(function (root) {
  'use strict';

  var SOLD = 'Vendue';
  var UNSOLD = 'Non vendue';

  /** "2026-11-03T17:32:07.161979+00:00" -> epoch milliseconds (or null). */
  function toMs(iso) {
    if (iso === null || iso === undefined || iso === '') return null;
    // Date.parse only guarantees 3 fractional digits.
    var s = String(iso).replace(/(\.\d{3})\d+/, '$1');
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  function cardName(a) {
    var c = a.card || {};
    return c.wikipedia_title || a.snapshot_search_document || c.id || a.card_id || '';
  }

  function rarity(a) {
    return a.snapshot_rarity || (a.card && a.card.rarity) || '';
  }

  function num(v) {
    var n = Number(v);
    return v === null || v === undefined || v === '' || !isFinite(n) ? null : n;
  }

  /** Most frequent non-empty value of key across the list. */
  function dominant(list, key) {
    var counts = {};
    var best = null;
    list.forEach(function (a) {
      var v = a && a[key];
      if (!v) return;
      counts[v] = (counts[v] || 0) + 1;
      if (best === null || counts[v] > counts[best]) best = v;
    });
    return best;
  }

  function extract(data) {
    if (!data || !Array.isArray(data.history) || !Array.isArray(data.won)) {
      throw new Error('Unexpected answer from wiki-masters.com: no "history"/"won" lists. Are you logged in?');
    }
    // Your own user id: seller of your history, winner of your won auctions.
    var me = dominant(data.history, 'seller_id') || dominant(data.won, 'winner_id');

    var purchases = [];
    data.won.forEach(function (a) {
      if (!a || !a.id || a.status !== 'settled_sold') return;
      if (me && a.winner_id && a.winner_id !== me) return;
      var price = num(a.final_price);
      var time = toMs(a.end_at) || toMs(a.settled_at);
      if (price === null || time === null) return;
      purchases.push({
        siteId: a.id,
        time: time,
        card: cardName(a),
        rarity: rarity(a),
        price: price,
        party: (a.seller && a.seller.username) || ''
      });
    });

    var sales = [];
    data.history.forEach(function (a) {
      if (!a || !a.id) return;
      if (a.status !== 'settled_sold' && a.status !== 'settled_unsold') return;
      if (me && a.seller_id && a.seller_id !== me) return;
      var sold = a.status === 'settled_sold';
      var price = sold ? num(a.final_price) : num(a.base_amount);
      if (price === null && !sold) price = num(a.listing_base_amount);
      var time = toMs(a.end_at) || toMs(a.settled_at);
      if (price === null || time === null) return;
      sales.push({
        siteId: a.id,
        time: time,
        card: cardName(a),
        rarity: rarity(a),
        price: price,
        status: sold ? SOLD : UNSOLD,
        party: sold ? ((a.winner && a.winner.username) || '') : ''
      });
    });

    purchases.sort(function (x, y) { return x.time - y.time; });
    sales.sort(function (x, y) { return x.time - y.time; });
    return { me: me, purchases: purchases, sales: sales };
  }

  var api = { toMs: toMs, extract: extract, SOLD: SOLD, UNSOLD: UNSOLD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
