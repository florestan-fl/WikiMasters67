/*
 * All the statistics, computed from the local database and the settings.
 * Nothing here is stored: change the tracked cards and everything is
 * recomputed, history included.
 *
 *  - A transaction counts ("suivie") when its card matches a tracking rule
 *    (card name, or keyword in the card's Wikipedia description), it is not
 *    older than the rule's "since" date, and it is not excluded.
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

  /** Returns card -> rule ({ since } or null). */
  function makeMatcher(settings, db) {
    var names = {};
    settings.tracking.cards.forEach(function (c) {
      names[cardKey(c.name)] = { name: c.name, since: Time.parseDateInput(c.since) };
    });
    var kws = settings.tracking.categories.map(function (c) { return cardKey(c.keyword); }).filter(Boolean);
    var excluded = {};
    (settings.tracking.excluded || []).forEach(function (c) { excluded[cardKey(c.name)] = true; });
    return function (card) {
      var k = cardKey(card);
      if (excluded[k]) return null;
      if (names[k]) return names[k];
      if (kws.length) {
        var meta = db.cards[k];
        var cat = meta ? cardKey(meta.category) : '';
        if (cat && kws.some(function (kw) { return cat.indexOf(kw) >= 0; })) return { name: null, since: null };
      }
      return null;
    };
  }

  function compute(rawDb, rawSettings, now) {
    var db = Store.normalizeDb(rawDb || Store.emptyDb());
    var settings = rawSettings;
    now = now || Date.now();
    var v = settings.valuation;
    var fee = v.commissionPct / 100;
    var haircut = v.haircutPct / 100;
    var match = makeMatcher(settings, db);
    var warnings = [];

    function decorate(rec, isSale) {
      var key = cardKey(rec.card);
      var excluded = Store.isExcluded(db, rec.id);
      var rule = match(rec.card);
      var inRule = !!rule && (rule.since === null || rec.time >= rule.since);
      return Object.assign({}, rec, {
        key: key,
        excluded: excluded,
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
      if (s.status !== SOLD) { s.check = 'OK'; return; }
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
      if (s.status === SOLD && !s.excluded && !s.shiny) (soldEvidence[s.key] = soldEvidence[s.key] || []).push({ t: s.time, price: s.price });
    });
    var evidenceMaps = [db.marketSales || {}].concat(settings.market.useEstimates ? [db.marketEstimates || {}] : []);
    evidenceMaps.forEach(function (map) {
      Object.keys(map).forEach(function (k) {
        if (/ ✦$/.test(k)) return;
        map[k].forEach(function (o) { (soldEvidence[k] = soldEvidence[k] || []).push({ t: o.t, price: o.price }); });
      });
    });
    Object.keys(soldEvidence).forEach(function (k) { soldEvidence[k].sort(function (a, b) { return a.t - b.t; }); });

    var windowMs = v.windowDays * DAY;
    function unitValue(key, at, fallbackCost) {
      var ev = (soldEvidence[key] || []).filter(function (o) { return o.t <= at; });
      var recent = ev.filter(function (o) { return o.t >= at - windowMs; }).slice(-v.sampleSize);
      var base = null;
      var source = null;
      if (recent.length) {
        base = median(recent.map(function (o) { return o.price; }));
        source = SOURCE.recent;
      } else {
        var ask = Market.askAt(db, key, at);
        if (ask !== null) {
          base = ask;
          source = SOURCE.asks;
        } else if (ev.length) {
          base = median(ev.slice(-v.sampleSize).map(function (o) { return o.price; }));
          source = SOURCE.old;
        }
      }
      if (base === null) return { value: fallbackCost, source: SOURCE.cost };
      return { value: base * (1 - fee) * (1 - haircut), source: source };
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
      var uv = unitValue(k, now, it.cost / it.qty);
      return {
        key: k,
        card: titleOf(k, it.card),
        rarity: it.rarity,
        qty: it.qty,
        cost: it.cost,
        avgCost: it.cost / it.qty,
        unitValue: uv.value,
        valueSource: uv.source,
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

    // Per card.
    var cardKeys = {};
    tp.concat(ts).forEach(function (r) { cardKeys[r.key] = r.card; });
    settings.tracking.cards.forEach(function (c) { var k = cardKey(c.name); if (!cardKeys[k]) cardKeys[k] = c.name; });
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
      trackedPurchases: tp.length,
      trackedSales: ts.length
    };

    if (!settings.tracking.cards.length && !settings.tracking.categories.length) {
      warnings.push('Aucune carte suivie : ajoutez les cartes que vous échangez dans les paramètres.');
    }
    if (unmatched && v.unmatched === 'ignore') {
      warnings.push(unmatched + ' vente(s) suivie(s) sans achat correspondant : elles ne comptent pas dans le profit. Vérifiez les achats exclus ou la date de début de suivi.');
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

  function knownCards(db, purchases, sales) {
    var seen = {};
    Object.keys(db.cards).forEach(function (k) { if (db.cards[k].title) seen[k] = db.cards[k].title; });
    purchases.concat(sales).forEach(function (r) { if (!seen[r.key]) seen[r.key] = r.card; });
    return Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }

  var api = { compute: compute, makeMatcher: makeMatcher, median: median, round: round, SOURCE: SOURCE, MAX_SERIES: MAX_SERIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
