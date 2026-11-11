/*
 * All the statistics, computed from the local database and the settings.
 * Nothing here is stored: change the tracked cards and everything is
 * recomputed, history included.
 *
 *  - A transaction counts ("suivie") when its card matches a tracking rule
 *    (card name, card of one of your groups, or keyword in the card's
 *    Wikipedia description), it is not older than the rule's "since" date,
 *    and it is not excluded.
 *  - A sale tagged "Booster" (card opened in a booster, never bought) costs
 *    the booster cost set in the settings and consumes no purchase.
 *  - Sold listings consume tracked purchases of the same card, oldest first
 *    (FIFO), never a purchase made after the sale.
 *  - Stock = tracked purchases not consumed yet. Its value is estimated per
 *    card: median of your last sales -> other players' current listings ->
 *    older sales -> purchase cost.
 */
(function (root) {
  'use strict';

  var Time = root.WMTime || (typeof require === 'function' ? require('./time') : null);
  var Extract = root.WMExtract || (typeof require === 'function' ? require('./extract') : null);
  var Store = root.WMStore || (typeof require === 'function' ? require('./store') : null);
  var Market = root.WMMarket || (typeof require === 'function' ? require('./market') : null);
  var cardKey = Extract.cardKey;
  var SOLD = Extract.SOLD;

  var DAY = 86400000;
  var HOUR = 3600000;
  var MAX_SERIES = 8;

  var SOURCE = {
    recent: 'ventes récentes',
    asks: 'annonces en cours',
    old: 'ventes anciennes',
    cost: "coût d'achat"
  };
  var METHOD = { 'ventes récentes': 'recent', 'annonces en cours': 'asks', 'ventes anciennes': 'old', "coût d'achat": 'cost' };

  function byTime(a, b) { return a.time - b.time || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0); }

  function mean(list) {
    if (!list.length) return null;
    return list.reduce(function (s, x) { return s + x; }, 0) / list.length;
  }

  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function round(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return null;
    var f = Math.pow(10, d || 0);
    return Math.round(x * f) / f;
  }

  /** card key -> its group ({ id, name, color, … }). */
  function groupIndex(settings) {
    var idx = {};
    (settings.groups || []).forEach(function (g) {
      g.cards.forEach(function (name) { var k = cardKey(name); if (!idx[k]) idx[k] = g; });
    });
    return idx;
  }

  /** The group of a card, or null. */
  function groupOf(settings) {
    var idx = groupIndex(settings);
    return function (card) { return idx[cardKey(card)] || null; };
  }

  /**
   * Returns card -> rule ({ since } or null). A card is followed by name, by
   * being in one of your groups, or by a category keyword; never when excluded.
   * only: restrict to one group id ('' = followed cards in no group).
   */
  function makeMatcher(settings, db, only) {
    var names = {};
    (settings.groups || []).forEach(function (g) {
      g.cards.forEach(function (name) { names[cardKey(name)] = { name: name, since: null }; });
    });
    settings.tracking.cards.forEach(function (c) {
      names[cardKey(c.name)] = { name: c.name, since: Time.parseDateInput(c.since) };
    });
    var groups = groupIndex(settings);
    var restrict = only !== undefined && only !== null;
    var kws = settings.tracking.categories.map(function (c) { return cardKey(c.keyword); }).filter(Boolean);
    var excluded = {};
    (settings.tracking.excluded || []).forEach(function (c) { excluded[cardKey(c.name)] = true; });
    return function (card) {
      var k = cardKey(card);
      if (excluded[k]) return null;
      if (restrict && (groups[k] ? groups[k].id : '') !== only) return null;
      if (names[k]) return names[k];
      if (kws.length) {
        var meta = db.cards[k];
        var cat = meta ? cardKey(meta.category) : '';
        if (cat && kws.some(function (kw) { return cat.indexOf(kw) >= 0; })) return { name: null, since: null };
      }
      return null;
    };
  }

  /**
   * opts.group: only the cards of this group id ('' = followed cards in no group);
   * omitted: every followed card.
   */
  function compute(rawDb, rawSettings, now, opts) {
    var db = Store.normalizeDb(rawDb || Store.emptyDb());
    var settings = rawSettings;
    now = now || Date.now();
    opts = opts || {};
    var v = settings.valuation;
    var fee = v.commissionPct / 100;
    var haircut = v.haircutPct / 100;
    var onlyGroup = opts.group === undefined ? null : opts.group;
    var match = makeMatcher(settings, db, onlyGroup);
    var groupIdx = groupIndex(settings);
    var warnings = [];

    function decorate(rec, isSale) {
      var key = cardKey(rec.card);
      var excluded = Store.isExcluded(db, rec.id);
      var rule = match(rec.card);
      var inRule = !!rule && (rule.since === null || rec.time >= rule.since);
      return Object.assign({}, rec, {
        key: key,
        group: groupIdx[key] ? groupIdx[key].id : null,
        excluded: excluded,
        booster: isSale && Store.isBooster(db, rec.id),
        matchesRule: !!rule,
        tracked: inRule && !excluded,
        isSale: isSale
      });
    }

    var purchases = Store.values(db.purchases).map(function (r) { return decorate(r, false); }).sort(byTime);
    var sales = Store.values(db.sales).map(function (r) { return decorate(r, true); }).sort(byTime);

    var tp = purchases.filter(function (r) { return r.tracked; });
    var ts = sales.filter(function (r) { return r.tracked; });
    var tsSold = ts.filter(function (r) { return r.status === SOLD; });

    // Averages per card (price indices, max buy price).
    var buyPrices = {};
    var sellPrices = {};
    tp.forEach(function (r) { (buyPrices[r.key] = buyPrices[r.key] || []).push(r.price); });
    tsSold.forEach(function (r) { (sellPrices[r.key] = sellPrices[r.key] || []).push(r.price); });
    var avgBuy = {};
    var avgSell = {};
    Object.keys(buyPrices).forEach(function (k) { avgBuy[k] = mean(buyPrices[k]); });
    Object.keys(sellPrices).forEach(function (k) { avgSell[k] = mean(sellPrices[k]); });

    // Purchase number per card and price index.
    var counts = {};
    tp.forEach(function (r) {
      counts[r.key] = (counts[r.key] || 0) + 1;
      r.n = counts[r.key];
      r.index = avgBuy[r.key] ? r.price / avgBuy[r.key] : null;
      r.soldBy = null;
      r.soldAt = null;
    });

    // FIFO.
    var queues = {};
    tp.forEach(function (r) { (queues[r.key] = queues[r.key] || []).push(r); });
    var heads = {};
    var unmatched = 0;
    var boosterCost = v.boosterCost || 0;
    sales.forEach(function (s) {
      s.lot = null;
      s.cost = null;
      s.profit = null;
      s.margin = null;
      s.hold = null;
      s.net = s.status === SOLD ? s.price * (1 - fee) : null;
      s.index = s.tracked && s.status === SOLD && avgSell[s.key] ? s.price / avgSell[s.key] : null;
      if (s.excluded) { s.check = 'Exclue'; return; }
      if (!s.tracked) { s.check = s.matchesRule ? 'Avant la date de suivi' : 'Non suivie'; return; }
      if (s.status !== SOLD) { s.check = s.booster ? 'Booster (invendue)' : 'OK'; return; }
      if (s.booster) {
        // Opened in a booster: never bought, consumes no purchase.
        s.cost = boosterCost;
        s.profit = s.net - boosterCost;
        s.margin = null; // no real purchase behind it
        s.check = 'Booster';
        return;
      }
      var q = queues[s.key] || [];
      var h = heads[s.key] || 0;
      var lot = q[h];
      if (lot && lot.time <= s.time) {
        heads[s.key] = h + 1;
        lot.soldBy = s.label;
        lot.soldAt = s.time;
        s.lot = lot.label;
        s.cost = lot.price;
        s.profit = s.net - lot.price;
        s.margin = lot.price > 0 ? s.profit / lot.price : null;
        s.hold = (s.time - lot.time) / HOUR;
        s.check = 'OK';
      } else {
        unmatched++;
        if (v.unmatched === 'zero') {
          s.cost = 0;
          s.profit = s.net;
          s.check = 'Sans achat (coût 0)';
        } else {
          s.check = 'Sans achat correspondant';
        }
      }
    });

    // Price evidence per card: your sold listings (tracked or not, not excluded)
    // and other players' sales seen on the site (non-shiny copies).
    var soldEvidence = {};
    sales.forEach(function (s) {
      if (s.status === SOLD && !s.excluded && !s.shiny) (soldEvidence[s.key] = soldEvidence[s.key] || []).push({ t: s.time, price: s.price, kind: 'own' });
    });
    var evidenceMaps = [[db.marketSales || {}, 'market']].concat(settings.market.useEstimates ? [[db.marketEstimates || {}, 'est']] : []);
    evidenceMaps.forEach(function (pair) {
      var map = pair[0];
      Object.keys(map).forEach(function (k) {
        if (/ ✦$/.test(k)) return;
        map[k].forEach(function (o) { (soldEvidence[k] = soldEvidence[k] || []).push({ t: o.t, price: o.price, kind: pair[1] }); });
      });
    });
    Object.keys(soldEvidence).forEach(function (k) { soldEvidence[k].sort(function (a, b) { return a.t - b.t; }); });

    var windowMs = v.windowDays * DAY;
    /**
     * Estimated value of one card at time `at`, with how it was obtained
     * (detail: the sales or the listing used, for the "Stock" tab).
     */
    function unitValue(key, at, fallbackCost, withDetail) {
      var ev = (soldEvidence[key] || []).filter(function (o) { return o.t <= at; });
      var recent = ev.filter(function (o) { return o.t >= at - windowMs; }).slice(-v.sampleSize);
      var base = null;
      var source = null;
      var samples = [];
      var ask = null;
      if (recent.length) {
        base = median(recent.map(function (o) { return o.price; }));
        source = SOURCE.recent;
        samples = recent;
      } else {
        ask = withDetail ? Market.askDetail(db, key, at) : null;
        var askPrice = withDetail ? (ask ? ask.price : null) : Market.askAt(db, key, at);
        if (askPrice !== null) {
          base = askPrice;
          source = SOURCE.asks;
        } else if (ev.length) {
          samples = ev.slice(-v.sampleSize);
          base = median(samples.map(function (o) { return o.price; }));
          source = SOURCE.old;
        }
      }
      if (base === null) {
        return { value: fallbackCost, source: SOURCE.cost, detail: withDetail ? { method: 'cost', base: fallbackCost, samples: [], ask: null } : null };
      }
      return {
        value: base * (1 - fee) * (1 - haircut),
        source: source,
        detail: withDetail ? { method: METHOD[source], base: base, samples: samples.slice(), ask: source === SOURCE.asks ? ask : null } : null
      };
    }

    // Inventory now.
    var listed = {};
    (db.listings || []).forEach(function (l) { var k = cardKey(l.card); listed[k] = (listed[k] || 0) + 1; });
    var held = tp.filter(function (r) { return r.soldAt === null; });
    var invByKey = {};
    held.forEach(function (r) {
      var it = invByKey[r.key] = invByKey[r.key] || { key: r.key, card: r.card, rarity: r.rarity, qty: 0, cost: 0, oldest: r.time, ages: [] };
      it.qty++;
      it.cost += r.price;
      it.oldest = Math.min(it.oldest, r.time);
      it.ages.push((now - r.time) / HOUR);
      it.rarity = r.rarity || it.rarity;
    });
    var inventory = Object.keys(invByKey).map(function (k) {
      var it = invByKey[k];
      var uv = unitValue(k, now, it.cost / it.qty, true);
      return {
        key: k,
        group: groupIdx[k] ? groupIdx[k].id : null,
        card: titleOf(k, it.card),
        rarity: it.rarity,
        qty: it.qty,
        cost: it.cost,
        avgCost: it.cost / it.qty,
        unitValue: uv.value,
        valueSource: uv.source,
        valuation: uv.detail,
        value: uv.value * it.qty,
        unrealized: uv.value * it.qty - it.cost,
        oldest: it.oldest,
        avgAge: mean(it.ages),
        listed: listed[k] || 0
      };
    }).sort(function (a, b) { return b.value - a.value; });

    function titleOf(key, fallback) {
      var named = settings.tracking.cards.filter(function (c) { return cardKey(c.name) === key; })[0];
      if (db.cards[key] && db.cards[key].title) return db.cards[key].title;
      return named ? named.name : fallback;
    }

    // Per card (followed cards without any transaction are listed too).
    var cardKeys = {};
    tp.concat(ts).forEach(function (r) { cardKeys[r.key] = r.card; });
    var followedNames = settings.tracking.cards.map(function (c) { return c.name; });
    (settings.groups || []).forEach(function (g) { followedNames = followedNames.concat(g.cards); });
    followedNames.forEach(function (name) { var k = cardKey(name); if (!cardKeys[k] && match(name)) cardKeys[k] = name; });
    var target = v.targetMarginPct / 100;
    var cards = Object.keys(cardKeys).map(function (k) {
      var ps = tp.filter(function (r) { return r.key === k; });
      var ls = ts.filter(function (r) { return r.key === k; });
      var sold = ls.filter(function (r) { return r.status === SOLD; });
      var withProfit = sold.filter(function (r) { return r.profit !== null; });
      var matched = sold.filter(function (r) { return r.lot !== null; });
      var cost = ps.reduce(function (s, r) { return s + r.price; }, 0);
      var revenue = sold.reduce(function (s, r) { return s + r.net; }, 0);
      var cogs = withProfit.reduce(function (s, r) { return s + r.cost; }, 0);
      var profit = withProfit.reduce(function (s, r) { return s + r.profit; }, 0);
      var inv = invByKey[k];
      var last = ps.concat(ls).sort(byTime).pop();
      return {
        key: k,
        group: groupIdx[k] ? groupIdx[k].id : null,
        card: titleOf(k, cardKeys[k]),
        rarity: last ? last.rarity : (db.cards[k] && db.cards[k].rarity) || '',
        purchases: ps.length,
        avgBuy: ps.length ? cost / ps.length : null,
        totalCost: cost,
        listings: ls.length,
        sold: sold.length,
        sellRate: ls.length ? sold.length / ls.length : null,
        avgSell: avgSell[k] || null,
        revenue: revenue,
        cogs: cogs,
        profit: profit,
        avgProfit: withProfit.length ? profit / withProfit.length : null,
        margin: cogs > 0 ? profit / cogs : null,
        stock: inv ? inv.qty : 0,
        avgHold: mean(matched.map(function (r) { return r.hold; })),
        maxBuy: avgSell[k] ? avgSell[k] * (1 - fee) / (1 + target) : null
      };
    }).sort(function (a, b) { return b.profit - a.profit || b.purchases - a.purchases || (a.card < b.card ? -1 : 1); });

    // Per hour of the day (Paris time).
    var hours = [];
    for (var h = 0; h < 24; h++) hours.push({ hour: h, purchases: 0, buyIdx: [], listings: 0, sold: 0, sellIdx: [] });
    tp.forEach(function (r) {
      var x = hours[Time.hourOf(r.time)];
      x.purchases++;
      if (r.index !== null) x.buyIdx.push(r.index);
    });
    ts.forEach(function (r) {
      var x = hours[Time.hourOf(r.time)];
      x.listings++;
      if (r.status === SOLD) {
        x.sold++;
        if (r.index !== null) x.sellIdx.push(r.index);
      }
    });
    hours = hours.map(function (x) {
      return {
        hour: x.hour,
        purchases: x.purchases,
        buyIndex: mean(x.buyIdx),
        listings: x.listings,
        sold: x.sold,
        sellRate: x.listings ? x.sold / x.listings : null,
        sellIndex: mean(x.sellIdx)
      };
    });

    // Per day.
    var days = [];
    var firstTime = null;
    tp.concat(ts).forEach(function (r) { if (firstTime === null || r.time < firstTime) firstTime = r.time; });
    (db.snapshots || []).forEach(function (sn) { if (firstTime === null || sn.t < firstTime) firstTime = sn.t; });
    if (firstTime !== null) {
      var key = Time.dayKey(firstTime);
      var todayKey = Time.dayKey(now);
      var prevUnrealized = 0;
      var cumRealized = 0;
      var cumTrading = 0;
      var guard = 0;
      while (key <= todayKey && guard++ < 5000) {
        var start = Time.dayStart(key);
        var end = Math.min(Time.dayEnd(key), now);
        var dp = tp.filter(function (r) { return r.time >= start && r.time <= end; });
        var dsales = ts.filter(function (r) { return r.status === SOLD && r.time >= start && r.time <= end; });
        var realized = dsales.reduce(function (s, r) { return s + (r.profit || 0); }, 0);
        var heldThen = tp.filter(function (r) { return r.time <= end && (r.soldAt === null || r.soldAt > end); });
        var cache = {};
        var stockCost = 0;
        var stockValue = 0;
        heldThen.forEach(function (r) {
          if (!cache[r.key]) {
            var lots = heldThen.filter(function (x) { return x.key === r.key; });
            var avgCost = lots.reduce(function (s, x) { return s + x.price; }, 0) / lots.length;
            cache[r.key] = unitValue(r.key, end, avgCost).value;
          }
          stockCost += r.price;
          stockValue += cache[r.key];
        });
        var unrealized = stockValue - stockCost;
        var trading = realized + unrealized - prevUnrealized;
        prevUnrealized = unrealized;
        cumRealized += realized;
        cumTrading += trading;
        var snaps = (db.snapshots || []).filter(function (sn) { return sn.t >= start && sn.t <= end; });
        var balance = snaps.length ? snaps[snaps.length - 1].balance : null;
        days.push({
          day: key,
          start: start,
          purchases: dp.length,
          spent: dp.reduce(function (s, r) { return s + r.price; }, 0),
          sales: dsales.length,
          revenue: dsales.reduce(function (s, r) { return s + r.net; }, 0),
          realized: realized,
          stockQty: heldThen.length,
          stockCost: stockCost,
          stockValue: stockValue,
          unrealized: unrealized,
          trading: trading,
          cumRealized: cumRealized,
          cumTrading: cumTrading,
          balance: balance,
          netWorth: balance === null ? null : balance + stockValue
        });
        key = Time.nextDay(key);
      }
    }

    // Headline numbers.
    function sumDays(n, field) {
      var from = Time.addDays(Time.dayKey(now), -(n - 1));
      return days.filter(function (d) { return d.day >= from; }).reduce(function (s, d) { return s + d[field]; }, 0);
    }
    var lastSnap = (db.snapshots || []).length ? db.snapshots[db.snapshots.length - 1] : null;
    var stockValue = inventory.reduce(function (s, it) { return s + it.value; }, 0);
    var stockCost = inventory.reduce(function (s, it) { return s + it.cost; }, 0);
    var allSold = tsSold.filter(function (r) { return r.profit !== null; });
    var totalCogs = allSold.reduce(function (s, r) { return s + r.cost; }, 0);
    var totalProfit = allSold.reduce(function (s, r) { return s + r.profit; }, 0);
    var activeDays7 = days.filter(function (d) { return d.day >= Time.addDays(Time.dayKey(now), -6); }).length;
    var boosterSold = tsSold.filter(function (r) { return r.booster; });
    var kpis = {
      realizedToday: sumDays(1, 'realized'),
      realized7: sumDays(7, 'realized'),
      realized30: sumDays(30, 'realized'),
      realizedTotal: days.reduce(function (s, d) { return s + d.realized; }, 0),
      tradingToday: sumDays(1, 'trading'),
      trading7: sumDays(7, 'trading'),
      tradingPerDay7: activeDays7 ? sumDays(7, 'trading') / activeDays7 : null,
      stockQty: held.length,
      stockValue: stockValue,
      stockCost: stockCost,
      unrealized: stockValue - stockCost,
      balance: lastSnap ? lastSnap.balance : null,
      balanceAt: lastSnap ? lastSnap.t : null,
      netWorth: lastSnap ? lastSnap.balance + stockValue : null,
      sold: tsSold.length,
      listings: ts.length,
      sellRate: ts.length ? tsSold.length / ts.length : null,
      margin: totalCogs > 0 ? totalProfit / totalCogs : null,
      unmatched: unmatched,
      boosterSales: boosterSold.length,
      boosterProfit: boosterSold.reduce(function (s, r) { return s + r.profit; }, 0),
      trackedPurchases: tp.length,
      trackedSales: ts.length
    };

    var groupCards = (settings.groups || []).reduce(function (n, g) { return n + g.cards.length; }, 0);
    if (!settings.tracking.cards.length && !settings.tracking.categories.length && !groupCards) {
      warnings.push('Aucune carte suivie : ajoutez les cartes que vous échangez dans les paramètres ou dans un groupe.');
    }
    if (unmatched && v.unmatched === 'ignore') {
      warnings.push(unmatched + ' vente(s) suivie(s) sans achat correspondant : elles ne comptent pas dans le profit. Si la carte vient d\'un booster, cochez « Booster » sur la vente (onglet Transactions → Ventes) ; sinon vérifiez les achats exclus ou la date de début de suivi.');
    }

    // Prices over time (for the "Prix" charts).
    var seriesCards = cards.filter(function (c) { return c.purchases + c.sold > 0; })
      .sort(function (a, b) { return (b.purchases + b.sold) - (a.purchases + a.sold); })
      .map(function (c) { return { key: c.key, card: c.card }; });
    // Inflation: average purchase price per card and per day, on a time axis.
    var byDay = {};
    var inSeries = {};
    seriesCards.forEach(function (c) { inSeries[c.key] = true; });
    tp.forEach(function (r) {
      if (!inSeries[r.key]) return;
      var d = byDay[Time.dayKey(r.time)] = byDay[Time.dayKey(r.time)] || {};
      (d[r.key] = d[r.key] || []).push(r.price);
    });
    var inflation = {
      cards: seriesCards,
      // [day start (ms), average price of card 1 that day | null, card 2…]
      rows: Object.keys(byDay).sort().map(function (day) {
        return [Time.dayStart(day)].concat(seriesCards.map(function (c) {
          var list = byDay[day][c.key];
          return list ? mean(list) : null;
        }));
      })
    };
    var priceSeries = {};
    seriesCards.forEach(function (c) {
      priceSeries[c.key] = {
        card: c.card,
        buys: tp.filter(function (r) { return r.key === c.key; }).map(function (r) { return { t: r.time, price: r.price }; }),
        sells: tsSold.filter(function (r) { return r.key === c.key; }).map(function (r) { return { t: r.time, price: r.price }; })
      };
    });

    // Market prices of the tracked cards.
    var marketAll = Market.allStats(db, now, settings.market.windowDays, settings.market.useEstimates);
    var market = Object.keys(marketAll).map(function (k) { return marketAll[k]; })
      .filter(function (x) { return !!match(x.card.replace(/ ✦$/, '')); })
      .sort(function (a, b) { return a.card.localeCompare(b.card, 'fr'); });

    return {
      now: now,
      settings: settings,
      group: onlyGroup,
      market: market,
      purchases: purchases,
      sales: sales,
      inventory: inventory,
      cards: cards,
      hours: hours,
      days: days,
      kpis: kpis,
      inflation: inflation,
      priceSeries: priceSeries,
      seriesCards: seriesCards,
      warnings: warnings,
      knownCards: knownCards(db, purchases, sales),
      listings: db.listings || [],
      snapshots: db.snapshots || []
    };
  }

  /**
   * Totals per group (and "Sans groupe" for followed cards in no group), from a
   * model computed for every followed card.
   */
  function summarizeGroups(m) {
    var groups = (m.settings.groups || []).map(function (g) {
      return { id: g.id, name: g.name, color: g.color, cards: g.cards.length };
    }).concat([{ id: '', name: 'Sans groupe', color: '', cards: 0 }]);
    var by = {};
    groups.forEach(function (g) {
      by[g.id] = Object.assign(g, {
        purchases: 0, spent: 0, sold: 0, revenue: 0, realized: 0, realized7: 0, realized30: 0,
        boosterSales: 0, stockQty: 0, stockCost: 0, stockValue: 0, unrealized: 0
      });
    });
    var d7 = Time.dayStart(Time.addDays(Time.dayKey(m.now), -6));
    var d30 = Time.dayStart(Time.addDays(Time.dayKey(m.now), -29));
    m.purchases.forEach(function (r) {
      if (!r.tracked) return;
      var g = by[r.group || ''];
      g.purchases++;
      g.spent += r.price;
    });
    m.sales.forEach(function (r) {
      if (!r.tracked || r.status !== SOLD) return;
      var g = by[r.group || ''];
      g.sold++;
      g.revenue += r.net;
      if (r.booster) g.boosterSales++;
      if (r.profit === null) return;
      g.realized += r.profit;
      if (r.time >= d7) g.realized7 += r.profit;
      if (r.time >= d30) g.realized30 += r.profit;
    });
    m.inventory.forEach(function (it) {
      var g = by[it.group || ''];
      g.stockQty += it.qty;
      g.stockCost += it.cost;
      g.stockValue += it.value;
      g.unrealized += it.unrealized;
    });
    var none = by[''];
    var noneCards = {};
    m.cards.forEach(function (c) { if (!c.group) noneCards[c.key] = true; });
    none.cards = Object.keys(noneCards).length;
    return groups.filter(function (g) { return g.id || g.purchases || g.sold || g.stockQty; });
  }

  function knownCards(db, purchases, sales) {
    var seen = {};
    Object.keys(db.cards).forEach(function (k) { if (db.cards[k].title) seen[k] = db.cards[k].title; });
    purchases.concat(sales).forEach(function (r) { if (!seen[r.key]) seen[r.key] = r.card; });
    return Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }

  var api = {
    compute: compute, makeMatcher: makeMatcher, groupIndex: groupIndex, groupOf: groupOf, summarizeGroups: summarizeGroups,
    median: median, round: round,
    SOURCE: SOURCE, MAX_SERIES: MAX_SERIES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
