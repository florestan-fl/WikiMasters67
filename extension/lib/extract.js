/*
 * Turns the JSON returned by https://www.wiki-masters.com/api/marketplace?...&mine=1
 * into plain records.
 *
 *   won[]       -> purchases (auctions you won)
 *   history[]   -> sales (your auctions that ended, sold or not)
 *   selling[]   -> your active listings (cards still in stock)
 *   auctions[]  -> other players' active listings (market prices)
 *   every card  -> card metadata (title, Wikipedia description, rarity)
 *
 * Shared by the extension pages and the Node tests (no browser APIs here).
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

  /** Normalised key used to compare card names (case and accents ignored). */
  function cardKey(name) {
    var s = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/\s+/g, ' ');
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

  function arr(v) { return Array.isArray(v) ? v : []; }

  function extract(data) {
    if (!data || !Array.isArray(data.history) || !Array.isArray(data.won)) {
      throw new Error('Réponse inattendue de wiki-masters.com (pas de listes "history"/"won"). Êtes-vous connecté ?');
    }
    // Your own user id: seller of your history, winner of your won auctions.
    var me = dominant(data.history, 'seller_id') || dominant(arr(data.selling), 'seller_id') ||
      dominant(data.won, 'winner_id');

    var cards = {};
    function learn(a) {
      if (!a) return;
      var title = cardName(a);
      if (!title) return;
      var key = cardKey(title);
      var c = a.card || {};
      var prev = cards[key] || {};
      cards[key] = {
        title: title,
        category: c.category || prev.category || '',
        rarity: rarity(a) || prev.rarity || ''
      };
    }

    var purchases = [];
    data.won.forEach(function (a) {
      learn(a);
      if (!a || !a.id || a.status !== 'settled_sold') return;
      if (me && a.winner_id && a.winner_id !== me) return;
      var price = num(a.final_price);
      var time = toMs(a.end_at) || toMs(a.settled_at);
      if (price === null || time === null) return;
      purchases.push({
        id: a.id,
        time: time,
        card: cardName(a),
        rarity: rarity(a),
        price: price,
        party: (a.seller && a.seller.username) || '',
        shiny: !!a.is_shiny
      });
    });

    var sales = [];
    data.history.forEach(function (a) {
      learn(a);
      if (!a || !a.id) return;
      if (a.status !== 'settled_sold' && a.status !== 'settled_unsold') return;
      if (me && a.seller_id && a.seller_id !== me) return;
      var sold = a.status === 'settled_sold';
      var price = sold ? num(a.final_price) : num(a.base_amount);
      if (price === null && !sold) price = num(a.listing_base_amount);
      var time = toMs(a.end_at) || toMs(a.settled_at);
      if (price === null || time === null) return;
      sales.push({
        id: a.id,
        time: time,
        card: cardName(a),
        rarity: rarity(a),
        price: price,
        status: sold ? SOLD : UNSOLD,
        party: sold ? ((a.winner && a.winner.username) || '') : '',
        shiny: !!a.is_shiny
      });
    });

    var selling = [];
    arr(data.selling).forEach(function (a) {
      learn(a);
      if (!a || !a.id || a.status !== 'active') return;
      if (me && a.seller_id && a.seller_id !== me) return;
      selling.push({
        id: a.id,
        card: cardName(a),
        price: num(a.effective_bid) !== null ? num(a.effective_bid) : num(a.base_amount),
        hasBid: num(a.current_bid) !== null,
        end: toMs(a.end_at)
      });
    });

    var asks = [];
    arr(data.auctions).concat(arr(data.bidding)).forEach(function (a) {
      learn(a);
      if (!a || !a.id || a.status !== 'active') return;
      if (me && a.seller_id === me) return;
      var price = num(a.effective_bid) !== null ? num(a.effective_bid) : num(a.base_amount);
      if (price === null) return;
      asks.push({ id: a.id, card: cardName(a), price: price, time: toMs(a.created_at) || Date.now() });
    });

    purchases.sort(function (x, y) { return x.time - y.time; });
    sales.sort(function (x, y) { return x.time - y.time; });
    return { me: me, purchases: purchases, sales: sales, selling: selling, asks: asks, cards: cards };
  }

  var api = {
    toMs: toMs, cardKey: cardKey, cardName: cardName, rarityOf: rarity, num: num, extract: extract,
    SOLD: SOLD, UNSOLD: UNSOLD
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
