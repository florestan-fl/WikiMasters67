/*
 * Market prices, built only from what your browser already received:
 * every auction object found in a /api/marketplace response (market list,
 * search, auction page, your own lists).
 *
 *   db.auctions     { [auctionId]: latest observation }  (pruned 2 days after the end)
 *   db.marketSales  { [marketKey]: [{ id, t, price }] }  other players' sales seen (exact final price)
 *   db.marketEstimates { [marketKey]: [{ id, t, price }] } estimated sales: last bid seen shortly
 *                                                        before the end of an auction whose final
 *                                                        price was never seen (a lower bound)
 *   db.checks       { [auctionId]: {...} }  auctions of followed cards whose final price is still
 *                                           unknown: the "À vérifier" list / resolver queue
 * Your own sales come from db.sales. A market key is the card name, with
 * shiny copies kept apart.
 */
(function (root) {
  'use strict';

  var Extract = root.WMExtract || (typeof require === 'function' ? require('./extract') : null);
  var Time = root.WMTime || (typeof require === 'function' ? require('./time') : null);
  var cardKey = Extract.cardKey;

  var DAY = 86400000;
  var HOUR = 3600000;
  var AUCTION_KEEP_AFTER_END = 2 * DAY;
  var MAX_AUCTIONS = 6000;
  var SALES_KEEP_DAYS = 120;
  var SALES_PER_CARD = 400;
  var ASK_FRESH = 3 * HOUR;
  var GRACE = 3 * 60000;          // the game settles an auction a few seconds after its end
  var EST_MAX_GAP = 30 * 60000;   // estimate only if the last bid was seen this close to the end
  var CHECK_KEEP = 7 * DAY;

  function marketKey(title, shiny) {
    return cardKey(title) + (shiny ? ' ✦' : '');
  }

  /**
   * What it costs to take the auction now: with a bid, the next minimum bid
   * (current bid + 10 %, rounded up); without a bid, the starting price.
   * Integer arithmetic: 750 * 1.1 is 825.0000000000001 in floating point.
   */
  function nextPrice(a) {
    if (!a) return null;
    var bid = a.bid !== undefined ? a.bid : (a.hasBid ? a.price : null);
    if (bid !== null && bid !== undefined && isFinite(bid)) return Math.ceil((Math.round(bid) * 11) / 10);
    var base = a.base !== undefined && a.base !== null ? a.base : a.price;
    return base === null || base === undefined ? null : base;
  }

  function looksLikeAuction(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o) && typeof o.id === 'string' &&
      typeof o.status === 'string' && 'end_at' in o && ('card' in o || 'card_id' in o);
  }

  /** Every auction-shaped object in a JSON answer (depth-limited). */
  function findAuctions(json) {
    var out = [];
    var seen = {};
    (function walk(v, depth) {
      if (!v || typeof v !== 'object' || depth > 6) return;
      if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
      if (looksLikeAuction(v)) {
        if (!seen[v.id]) { seen[v.id] = true; out.push(v); }
        return;
      }
      Object.keys(v).forEach(function (k) { walk(v[k], depth + 1); });
    })(json, 0);
    return out;
  }

  function normalize(a) {
    var title = Extract.cardName(a);
    if (!title) return null;
    var num = Extract.num;
    var bid = num(a.current_bid);
    var base = num(a.base_amount);
    if (base === null) base = num(a.listing_base_amount);
    var price = num(a.effective_bid); // what the site displays
    if (price === null) price = bid !== null ? bid : base;
    return {
      id: a.id,
      card: title,
      key: marketKey(title, a.is_shiny),
      baseKey: cardKey(title),
      shiny: !!a.is_shiny,
      rarity: Extract.rarityOf(a),
      category: (a.card && a.card.category) || '',
      status: a.status,
      price: price,
      bid: bid,
      base: base,
      hasBid: bid !== null,
      final: num(a.final_price),
      end: Extract.toMs(a.end_at),
      settledAt: Extract.toMs(a.settled_at),
      seller: a.seller_id || (a.seller && a.seller.id) || null,
      bidder: a.current_bidder_id || (a.current_bidder && a.current_bidder.id) || null
    };
  }

  function removeById(map, key, id) {
    if (!map[key]) return false;
    var before = map[key].length;
    map[key] = map[key].filter(function (s) { return s.id !== id; });
    if (!map[key].length) delete map[key];
    return map[key] ? map[key].length !== before : before > 0;
  }

  /**
   * Records the auctions of one API answer. Returns what was learned.
   * isTracked(card): auctions of followed cards are queued until their final price is known.
   */
  function ingest(db, json, now, me, isTracked) {
    db.auctions = db.auctions || {};
    db.marketSales = db.marketSales || {};
    db.marketEstimates = db.marketEstimates || {};
    db.checks = db.checks || {};
    db.cards = db.cards || {};
    var res = { auctions: 0, sales: 0, resolved: 0, ids: [] };
    findAuctions(json).map(normalize).forEach(function (x) {
      if (!x) return;
      res.auctions++;
      var mine = !!me && x.seller === me;
      db.auctions[x.id] = {
        card: x.card, key: x.key, baseKey: x.baseKey, shiny: x.shiny, rarity: x.rarity, status: x.status,
        price: x.price, bid: x.bid, base: x.base, hasBid: x.hasBid, end: x.end, seenAt: now, mine: mine,
        myBid: !!me && x.bidder === me
      };
      res.ids.push(x.id);
      var meta = db.cards[x.baseKey] || {};
      db.cards[x.baseKey] = { title: x.card, category: x.category || meta.category || '', rarity: x.rarity || meta.rarity || '' };

      // Final price queue (followed cards, other players' auctions).
      var check = db.checks[x.id];
      if (x.status === 'active') {
        if (!mine && x.end !== null && isTracked && isTracked(x.card)) {
          db.checks[x.id] = {
            card: x.card, key: x.key, end: x.end, lastPrice: x.price, hasBid: x.hasBid, lastSeenAt: now,
            attempts: check ? check.attempts : 0,
            nextAt: Math.max(x.end + GRACE, check && check.end === x.end ? check.nextAt : 0)
          };
        }
      } else {
        if (check) { delete db.checks[x.id]; res.resolved++; }
        removeById(db.marketEstimates, x.key, x.id); // the real outcome is known
      }

      // Someone else's finished sale (your own sales are already in db.sales).
      if (x.status === 'settled_sold' && x.final !== null && !mine) {
        var list = db.marketSales[x.key] = db.marketSales[x.key] || [];
        if (!list.some(function (s) { return s.id === x.id; })) {
          list.push({ id: x.id, t: x.settledAt || x.end || now, price: x.final });
          res.sales++;
        }
      }
    });
    prune(db, now);
    return res;
  }

  function prune(db, now) {
    db.marketEstimates = db.marketEstimates || {};
    db.checks = db.checks || {};
    // Ended auctions whose final price was never seen: last bid seen near the end -> estimate.
    Object.keys(db.auctions).forEach(function (id) {
      var a = db.auctions[id];
      if (a.mine || a.status !== 'active' || !a.hasBid || a.price === null || a.end === null) return;
      if (a.end > now - GRACE || a.end - a.seenAt > EST_MAX_GAP) return;
      var known = (db.marketSales[a.key] || []).some(function (s) { return s.id === id; });
      var list = db.marketEstimates[a.key] = db.marketEstimates[a.key] || [];
      var lastBid = a.bid !== undefined && a.bid !== null ? a.bid : a.price;
      if (!known && !list.some(function (s) { return s.id === id; })) list.push({ id: id, t: a.end, price: lastBid });
    });
    Object.keys(db.checks).forEach(function (id) {
      if (db.checks[id].end < now - CHECK_KEEP) delete db.checks[id];
    });
    var ids = Object.keys(db.auctions);
    ids.forEach(function (id) {
      var a = db.auctions[id];
      if (a.end !== null && a.end < now - AUCTION_KEEP_AFTER_END) delete db.auctions[id];
    });
    ids = Object.keys(db.auctions);
    if (ids.length > MAX_AUCTIONS) {
      ids.sort(function (x, y) { return db.auctions[x].seenAt - db.auctions[y].seenAt; })
        .slice(0, ids.length - MAX_AUCTIONS).forEach(function (id) { delete db.auctions[id]; });
    }
    [db.marketSales, db.marketEstimates].forEach(function (map) {
      Object.keys(map).forEach(function (k) {
        var list = map[k].filter(function (s) { return s.t >= now - SALES_KEEP_DAYS * DAY; })
          .sort(function (a, b) { return a.t - b.t; });
        if (list.length > SALES_PER_CARD) list = list.slice(-SALES_PER_CARD);
        if (list.length) map[k] = list; else delete map[k];
      });
    });
  }

  /** Ended auctions of followed cards whose final price is still unknown, newest first. */
  function pendingChecks(db, now, isTracked) {
    var ended = [];
    var upcoming = 0;
    Object.keys(db.checks || {}).forEach(function (id) {
      var c = db.checks[id];
      if (isTracked && !isTracked(c.card)) return;
      if (c.end > now) upcoming++;
      else ended.push(Object.assign({ id: id }, c));
    });
    ended.sort(function (a, b) { return b.end - a.end; });
    return { ended: ended, upcoming: upcoming };
  }

  /* --------------------------------------------------------------- stats */

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function medianOf(list) {
    return quantile(list.slice().sort(function (a, b) { return a - b; }), 0.5);
  }

  /** All observed sales by market key: yours (db.sales) + seen ones (db.marketSales) [+ estimates]. */
  function salesByKey(db, useEstimates) {
    var by = {};
    Object.keys(db.sales || {}).forEach(function (id) {
      var s = db.sales[id];
      if (s.status !== Extract.SOLD) return;
      var k = marketKey(s.card, s.shiny);
      (by[k] = by[k] || []).push({ id: id, t: s.time, price: s.price, own: true });
    });
    Object.keys(db.marketSales || {}).forEach(function (k) {
      db.marketSales[k].forEach(function (s) {
        var list = by[k] = by[k] || [];
        if (!list.some(function (x) { return x.id === s.id; })) list.push({ id: s.id, t: s.t, price: s.price, own: false });
      });
    });
    if (useEstimates) {
      Object.keys(db.marketEstimates || {}).forEach(function (k) {
        db.marketEstimates[k].forEach(function (s) {
          var list = by[k] = by[k] || [];
          if (!list.some(function (x) { return x.id === s.id; })) list.push({ id: s.id, t: s.t, price: s.price, own: false, est: true });
        });
      });
    }
    Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return a.t - b.t; }); });
    return by;
  }

  /** Other players' active listings by market key (seen in the last hours). */
  function asksByKey(db, now) {
    var by = {};
    Object.keys(db.auctions || {}).forEach(function (id) {
      var a = db.auctions[id];
      if (a.mine || a.status !== 'active' || a.price === null) return;
      if (a.end !== null && a.end <= now) return;
      if (a.seenAt < now - ASK_FRESH) return;
      (by[a.key] = by[a.key] || []).push({ id: id, price: nextPrice(a), hasBid: a.hasBid, end: a.end });
    });
    return by;
  }

  /**
   * Cheapest listing of a card (non-shiny) seen in the 2 days before `at`:
   * { id, price (next minimum bid or starting price), hasBid, seenAt, end }, or null.
   */
  function askDetail(db, baseKey, at) {
    var best = null;
    Object.keys(db.auctions || {}).forEach(function (id) {
      var a = db.auctions[id];
      if (a.mine || a.shiny || a.baseKey !== baseKey || a.price === null) return;
      if (a.seenAt > at || a.seenAt < at - 2 * DAY) return;
      var p = nextPrice(a);
      if (best === null || p < best.price) best = { id: id, price: p, hasBid: a.hasBid, seenAt: a.seenAt, end: a.end };
    });
    return best;
  }

  /** Lowest current listing price of a card (non-shiny) seen around time `at`. */
  function askAt(db, baseKey, at) {
    var best = askDetail(db, baseKey, at);
    return best ? best.price : null;
  }

  function trend(sales, now, recentDays, refDays) {
    var recent = sales.filter(function (s) { return s.t >= now - recentDays * DAY; }).map(function (s) { return s.price; });
    var ref = sales.filter(function (s) { return s.t < now - recentDays * DAY && s.t >= now - refDays * DAY; }).map(function (s) { return s.price; });
    if (recent.length < 2 || ref.length < 2) return null;
    return medianOf(recent) / medianOf(ref) - 1;
  }

  function statsFor(key, title, rarity, sales, asks, now, windowDays) {
    var inWindow = sales.filter(function (s) { return s.t >= now - windowDays * DAY; });
    var prices = inWindow.map(function (s) { return s.price; }).sort(function (a, b) { return a - b; });
    var askPrices = asks.map(function (a) { return a.price; });
    return {
      key: key,
      card: title,
      rarity: rarity,
      shiny: / ✦$/.test(key),
      n: prices.length,
      nOwn: inWindow.filter(function (s) { return s.own; }).length,
      nEst: inWindow.filter(function (s) { return s.est; }).length,
      median: quantile(prices, 0.5),
      p25: quantile(prices, 0.25),
      p75: quantile(prices, 0.75),
      min: prices.length ? prices[0] : null,
      max: prices.length ? prices[prices.length - 1] : null,
      trend7: trend(sales, now, 7, 30),
      trend30: trend(sales, now, 30, 90),
      lastSale: sales.length ? sales[sales.length - 1] : null,
      asks: askPrices.length,
      lowestAsk: askPrices.length ? Math.min.apply(null, askPrices) : null,
      sales: inWindow
    };
  }

  /**
   * Market stats for every card with data. windowDays: period used for the
   * median (default 30).
   */
  function allStats(db, now, windowDays, useEstimates) {
    windowDays = windowDays || 30;
    var sales = salesByKey(db, useEstimates !== false);
    var asks = asksByKey(db, now);
    var meta = {};
    Object.keys(db.auctions || {}).forEach(function (id) {
      var a = db.auctions[id];
      meta[a.key] = { card: a.card, rarity: a.rarity };
    });
    Object.keys(db.sales || {}).forEach(function (id) {
      var s = db.sales[id];
      var k = marketKey(s.card, s.shiny);
      if (!meta[k]) meta[k] = { card: s.card, rarity: s.rarity };
    });
    Object.keys(db.marketSales || {}).concat(Object.keys(db.marketEstimates || {})).forEach(function (k) {
      if (!meta[k]) meta[k] = { card: (db.cards[k.replace(/ ✦$/, '')] && db.cards[k.replace(/ ✦$/, '')].title) || k, rarity: '' };
    });
    var out = {};
    Object.keys(meta).forEach(function (k) {
      var title = (db.cards[cardKey(meta[k].card)] && db.cards[cardKey(meta[k].card)].title) || meta[k].card;
      out[k] = statsFor(k, title + (/ ✦$/.test(k) ? ' ✦' : ''), meta[k].rarity, sales[k] || [], asks[k] || [], now, windowDays);
    });
    return out;
  }

  /** Median per day of a list of sales, for the chart line. */
  function dailyMedians(sales) {
    var by = {};
    sales.forEach(function (s) { (by[Time.dayKey(s.t)] = by[Time.dayKey(s.t)] || []).push(s.price); });
    return Object.keys(by).sort().map(function (day) {
      return { day: day, t: Time.dayStart(day) + 12 * HOUR, median: medianOf(by[day]) };
    });
  }

  /**
   * Running auctions whose price to take them now (next minimum bid, or the
   * starting price) is at least `pct` % under the card's median.
   * opts: { pct, minSales, isEligible(card), windowDays, useEstimates, maxAgeMs }
   * Your own auctions and those where you are already the top bidder are left out.
   */
  function deals(db, now, opts) {
    var stats = allStats(db, now, opts.windowDays, opts.useEstimates);
    var maxAge = opts.maxAgeMs || 2 * HOUR;
    var out = [];
    Object.keys(db.auctions || {}).forEach(function (id) {
      var a = db.auctions[id];
      if (a.mine || a.myBid || a.status !== 'active' || a.end === null || a.end <= now) return;
      if (now - a.seenAt > maxAge) return;
      if (opts.isEligible && !opts.isEligible(a.card)) return;
      var s = stats[a.key];
      if (!s || s.n < opts.minSales || !s.median) return;
      var next = nextPrice(a);
      if (next === null) return;
      var diff = next / s.median - 1;
      if (diff > -opts.pct / 100) return;
      out.push({
        id: id, card: a.card, key: a.key, rarity: a.rarity, next: next, hasBid: a.hasBid,
        median: s.median, n: s.n, diff: diff, end: a.end, seenAt: a.seenAt
      });
    });
    return out.sort(function (x, y) { return x.end - y.end; });
  }

  /**
   * Badge data for auctions shown on the site.
   * tiles: [{ ref, id, text }]; id may be null: then the card is guessed from
   * the tile text (card title + price).
   */
  function overlayInfo(db, tiles, isTracked, now, windowDays, dealPct, useEstimates) {
    var stats = null;
    function st() { if (!stats) stats = allStats(db, now, windowDays, useEstimates); return stats; }
    var active = null;
    function activeList() {
      if (!active) {
        active = Object.keys(db.auctions || {}).map(function (id) { return Object.assign({ id: id }, db.auctions[id]); })
          .filter(function (a) { return a.end === null || a.end > now - HOUR; })
          .sort(function (a, b) { return b.card.length - a.card.length; });
      }
      return active;
    }
    var used = {};
    return tiles.map(function (t) {
      var a = t.id && db.auctions && db.auctions[t.id] ? Object.assign({ id: t.id }, db.auctions[t.id]) : null;
      if (!a && t.text) {
        var text = cardKey(t.text);
        var nums = (String(t.text).match(/\d[\d\s  ]*/g) || []).map(function (x) { return Number(x.replace(/\D/g, '')); });
        a = activeList().filter(function (x) {
          return !used[x.id] && text.indexOf(x.baseKey) >= 0 && (x.price === null || nums.indexOf(x.price) >= 0);
        })[0] || null;
      }
      if (!a) return { ref: t.ref, found: false };
      used[a.id] = true;
      var s = st()[a.key];
      var ref = s && s.n ? s.median : null;
      var next = nextPrice(a);
      var diff = ref && next !== null ? next / ref - 1 : null;
      return {
        ref: t.ref,
        found: true,
        id: a.id,
        card: a.card,
        key: a.key,
        price: a.price,
        next: next,
        hasBid: a.hasBid,
        tracked: isTracked(a.card),
        median: ref,
        n: s ? s.n : 0,
        nEst: s ? s.nEst : 0,
        p25: s ? s.p25 : null,
        p75: s ? s.p75 : null,
        trend7: s ? s.trend7 : null,
        diff: diff,
        deal: diff === null ? 'none' : diff <= -dealPct / 100 ? 'good' : diff >= dealPct / 100 ? 'bad' : 'neutral'
      };
    });
  }

  var api = {
    marketKey: marketKey, findAuctions: findAuctions, normalize: normalize, ingest: ingest, prune: prune,
    allStats: allStats, dailyMedians: dailyMedians, askAt: askAt, askDetail: askDetail, overlayInfo: overlayInfo, quantile: quantile,
    pendingChecks: pendingChecks, nextPrice: nextPrice, deals: deals, GRACE: GRACE
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMMarket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
