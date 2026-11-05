/*
 * Builds the tables sent to Google Sheets (and the CSV exports) from the
 * computed statistics. Each table: { name, headers, rows, formats, charts, filter }.
 * formats per column: text | int | dec1 | dec2 | pct | datetime | date
 * Dates are sent as epoch milliseconds.
 */
(function (root) {
  'use strict';

  var Time = root.WMTime || (typeof require === 'function' ? require('./time') : null);
  var Stats = root.WMStats || (typeof require === 'function' ? require('./stats') : null);

  function r0(x) { return x === null || x === undefined || !isFinite(x) ? null : Math.round(x); }
  function r1(x) { return Stats.round(x, 1); }
  function r2(x) { return Stats.round(x, 2); }
  function r3(x) { return Stats.round(x, 3); }
  function yesNo(b) { return b ? 'Oui' : 'Non'; }

  function dashboard(m) {
    var k = m.kpis;
    var rows = [
      ['Profit réalisé aujourd\'hui', r0(k.realizedToday), 'Ventes du jour - coût FIFO des cartes vendues'],
      ['Profit réalisé sur 7 jours', r0(k.realized7), ''],
      ['Profit réalisé sur 30 jours', r0(k.realized30), ''],
      ['Profit réalisé total', r0(k.realizedTotal), ''],
      ['Profit de trading estimé aujourd\'hui', r0(k.tradingToday), 'Profit réalisé + variation de la plus-value latente du stock'],
      ['Profit de trading estimé sur 7 jours', r0(k.trading7), ''],
      ['Profit de trading estimé moyen par jour (7 j)', r0(k.tradingPerDay7), ''],
      ['Cartes en stock', k.stockQty, ''],
      ['Coût du stock (FIFO)', r0(k.stockCost), ''],
      ['Valeur estimée du stock', r0(k.stockValue), 'Voir l\'onglet Inventaire pour la méthode par carte'],
      ['Plus-value latente', r0(k.unrealized), ''],
      ['Solde wikibidous', r0(k.balance), k.balanceAt ? 'Relevé le ' + Time.formatDateTime(k.balanceAt) : 'Pas encore relevé'],
      ['Patrimoine estimé (solde + stock)', r0(k.netWorth), ''],
      ['Mises en vente suivies', k.listings, ''],
      ['Ventes suivies', k.sold, ''],
      ['Taux de vente', k.sellRate === null ? '' : Math.round(k.sellRate * 1000) / 10 + ' %', ''],
      ['Marge moyenne sur les ventes', k.margin === null ? '' : Math.round(k.margin * 1000) / 10 + ' %', ''],
      ['Ventes sans achat correspondant', k.unmatched, ''],
      ['Dernier calcul', Time.formatDateTime(m.now), 'Généré par l\'extension WikiMasters → Google Sheets. Ne modifiez pas ces onglets : ils sont réécrits à chaque mise à jour.']
    ];
    return {
      name: 'Tableau de bord',
      headers: ['Indicateur', 'Valeur (W)', 'Détail'],
      rows: rows,
      formats: ['text', 'int', 'text'],
      charts: []
    };
  }

  function perDay(m) {
    return {
      name: 'Par jour',
      headers: ['Jour', 'Achats', 'Dépensé (W)', 'Ventes', 'Revenu (W)', 'Profit réalisé (W)', 'Cartes en stock',
        'Coût du stock (W)', 'Valeur estimée du stock (W)', 'Plus-value latente (W)', 'Profit de trading estimé (W)',
        'Profit réalisé cumulé (W)', 'Profit de trading cumulé (W)', 'Solde (W)', 'Patrimoine estimé (W)'],
      rows: m.days.map(function (d) {
        return [d.start, d.purchases, r0(d.spent), d.sales, r0(d.revenue), r0(d.realized), d.stockQty, r0(d.stockCost),
          r0(d.stockValue), r0(d.unrealized), r0(d.trading), r0(d.cumRealized), r0(d.cumTrading), r0(d.balance), r0(d.netWorth)];
      }),
      formats: ['date', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int'],
      charts: [
        { type: 'COLUMN', title: 'Profit par jour (W)', domain: 0, series: [5, 10], legend: 'bottom' },
        { type: 'LINE', title: 'Profit cumulé (W)', domain: 0, series: [11, 12], legend: 'bottom' },
        { type: 'AREA', title: 'Patrimoine estimé : solde + valeur du stock (W)', domain: 0, series: [13, 8], stacked: true, legend: 'bottom' }
      ],
      freezeCols: 1
    };
  }

  function inventory(m) {
    return {
      name: 'Inventaire',
      headers: ['Carte', 'Rareté', 'Quantité', 'Dont en vente', 'Coût FIFO total (W)', 'Coût moyen (W)', 'Valeur unitaire estimée (W)',
        'Source de l\'estimation', 'Valeur totale estimée (W)', 'Plus-value latente (W)', 'Plus ancien achat', 'Détention moyenne (h)'],
      rows: m.inventory.map(function (it) {
        return [it.card, it.rarity, it.qty, it.listed, r0(it.cost), r0(it.avgCost), r0(it.unitValue), it.valueSource,
          r0(it.value), r0(it.unrealized), it.oldest, r1(it.avgAge)];
      }),
      formats: ['text', 'text', 'int', 'int', 'int', 'int', 'int', 'text', 'int', 'int', 'datetime', 'dec1'],
      charts: [],
      freezeCols: 1
    };
  }

  function perCard(m) {
    return {
      name: 'Par carte',
      headers: ['Carte', 'Rareté', 'Achats', 'Prix achat moyen (W)', 'Coût total (W)', 'Mises en vente', 'Ventes', 'Taux de vente',
        'Prix vente moyen (W)', 'Revenu net (W)', 'Coût FIFO des cartes vendues (W)', 'Profit réalisé (W)', 'Profit moyen / vente (W)',
        'Marge', 'En stock', 'Détention moyenne (h)', 'Prix d\'achat max conseillé (W)'],
      rows: m.cards.map(function (c) {
        return [c.card, c.rarity, c.purchases, r0(c.avgBuy), r0(c.totalCost), c.listings, c.sold, r3(c.sellRate), r0(c.avgSell),
          r0(c.revenue), r0(c.cogs), r0(c.profit), r0(c.avgProfit), r3(c.margin), c.stock, r1(c.avgHold), r0(c.maxBuy)];
      }),
      formats: ['text', 'text', 'int', 'int', 'int', 'int', 'int', 'pct', 'int', 'int', 'int', 'int', 'int', 'pct', 'int', 'dec1', 'int'],
      charts: [
        { type: 'COLUMN', title: 'Profit réalisé par carte (W)', domain: 0, series: [11], legend: 'none' },
        { type: 'COLUMN', title: 'Prix moyen d\'achat et de vente par carte (W)', domain: 0, series: [3, 8], legend: 'bottom' },
        { type: 'COLUMN', title: 'Profit moyen réalisé par carte (W)', domain: 0, series: [12], legend: 'none' },
        { type: 'COLUMN', title: 'Marge', domain: 0, series: [13], legend: 'none' }
      ],
      freezeCols: 1
    };
  }

  function marketPrices(m) {
    var target = m.settings.valuation.targetMarginPct / 100;
    var fee = m.settings.valuation.commissionPct / 100;
    return {
      name: 'Prix du marché',
      headers: ['Carte', 'Rareté', 'Médiane des ventes (W)', 'Ventes observées', 'Dont les vôtres', 'P25 (W)', 'P75 (W)', 'Min (W)',
        'Max (W)', 'Tendance 7 j', 'Tendance 30 j', 'Moins chère en vente (W)', 'Annonces actives', 'Achat max conseillé (W)'],
      rows: m.market.map(function (x) {
        return [x.card, x.rarity, r0(x.median), x.n, x.nOwn, r0(x.p25), r0(x.p75), r0(x.min), r0(x.max), r3(x.trend7), r3(x.trend30),
          r0(x.lowestAsk), x.asks, x.median === null ? null : r0(x.median * (1 - fee) / (1 + target))];
      }),
      formats: ['text', 'text', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'pct', 'pct', 'int', 'int', 'int'],
      charts: [{ type: 'COLUMN', title: 'Médiane des ventes par carte (W)', domain: 0, series: [2], legend: 'none' }],
      freezeCols: 1
    };
  }

  function perHour(m) {
    return {
      name: 'Par heure',
      headers: ['Heure', 'Achats', 'Indice prix achat moyen', 'Mises en vente', 'Ventes', 'Taux de vente', 'Indice prix vente moyen'],
      rows: m.hours.map(function (h) {
        return [h.hour, h.purchases, r2(h.buyIndex), h.listings, h.sold, r3(h.sellRate), r2(h.sellIndex)];
      }),
      formats: ['int', 'int', 'dec2', 'int', 'int', 'pct', 'dec2'],
      charts: [
        { type: 'COLUMN', title: 'Indice de prix par heure (1 = prix moyen de la carte)', domain: 0, series: [2, 6], legend: 'bottom' },
        { type: 'COLUMN', title: 'Taux de vente par heure', domain: 0, series: [5], legend: 'none' }
      ]
    };
  }

  function inflation(m) {
    var cards = m.inflation.cards;
    return {
      name: 'Inflation',
      headers: ['N° achat'].concat(cards.map(function (c) { return c.card; })),
      rows: m.inflation.rows,
      formats: ['int'].concat(cards.map(function () { return 'int'; })),
      charts: cards.length ? [{
        type: 'LINE', title: 'Prix d\'achat successifs par carte (W)', domain: 0,
        series: cards.slice(0, Stats.MAX_SERIES).map(function (c, i) { return i + 1; }), legend: 'right'
      }] : []
    };
  }

  function pricesOverTime(m) {
    var cards = m.seriesCards.slice(0, Stats.MAX_SERIES);
    var rows = [];
    cards.forEach(function (c, i) {
      (m.priceSeries[c.key].buys || []).forEach(function (p) {
        var row = [p.t];
        cards.forEach(function (x, j) { row.push(j === i ? p.price : null); });
        rows.push(row);
      });
    });
    rows.sort(function (a, b) { return a[0] - b[0]; });
    return {
      name: 'Prix dans le temps',
      headers: ['Date'].concat(cards.map(function (c) { return c.card; })),
      rows: rows,
      formats: ['datetime'].concat(cards.map(function () { return 'int'; })),
      charts: cards.length ? [{
        type: 'SCATTER', title: 'Prix d\'achat dans le temps (W)', domain: 0,
        series: cards.map(function (c, i) { return i + 1; }), legend: 'right'
      }] : []
    };
  }

  function purchasesTable(m) {
    return {
      name: 'Achats',
      headers: ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Vendeur', 'Suivie', 'Exclue', 'N° achat de la carte',
        'Indice prix', 'Vendue par (FIFO)', 'Vendue le', 'ID site'],
      rows: m.purchases.map(function (r) {
        return [r.label, r.time, r.card, r.rarity, r.price, r.party, yesNo(r.tracked), yesNo(r.excluded), r.tracked ? r.n : null,
          r.tracked ? r2(r.index) : null, r.soldBy || '', r.soldAt, /^v1:/.test(r.id) ? '' : r.id];
      }),
      formats: ['text', 'datetime', 'text', 'text', 'int', 'text', 'text', 'text', 'int', 'dec2', 'text', 'datetime', 'text'],
      charts: [],
      filter: true,
      freezeCols: 1
    };
  }

  function salesTable(m) {
    return {
      name: 'Ventes',
      headers: ['ID', 'Date/heure', 'Carte', 'Rareté', 'Prix (W)', 'Statut', 'Acheteur', 'Suivie', 'Exclue', 'ID achat (FIFO)',
        'Prix d\'achat (W)', 'Revenu net (W)', 'Profit (W)', 'Marge', 'Détention (h)', 'Indice prix', 'Contrôle', 'ID site'],
      rows: m.sales.map(function (r) {
        return [r.label, r.time, r.card, r.rarity, r.price, r.status, r.party, yesNo(r.tracked), yesNo(r.excluded), r.lot || '',
          r0(r.cost), r0(r.net), r0(r.profit), r3(r.margin), r1(r.hold), r2(r.index), r.check, /^v1:/.test(r.id) ? '' : r.id];
      }),
      formats: ['text', 'datetime', 'text', 'text', 'int', 'text', 'text', 'text', 'text', 'text', 'int', 'int', 'int', 'pct',
        'dec1', 'dec2', 'text', 'text'],
      charts: [],
      filter: true,
      freezeCols: 1
    };
  }

  /** All tables, in tab order. */
  function build(m) {
    return [dashboard(m), perDay(m), inventory(m), perCard(m), marketPrices(m), perHour(m), inflation(m), pricesOverTime(m),
      purchasesTable(m), salesTable(m)];
  }

  /* ------------------------------------------------------------- CSV */

  function csvCell(v, fmt) {
    if (v === null || v === undefined) return '';
    if ((fmt === 'datetime' || fmt === 'date') && typeof v === 'number') {
      v = fmt === 'date' ? Time.formatDay(Time.dayKey(v)) : Time.formatDateTime(v);
    } else if (typeof v === 'number') {
      v = String(v).replace('.', ','); // French Excel
    }
    var s = String(v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Semicolon-separated, with BOM, so that Excel (French) opens it directly. */
  function toCsv(table) {
    var lines = [table.headers.map(function (h) { return csvCell(h, 'text'); }).join(';')];
    table.rows.forEach(function (row) {
      lines.push(row.map(function (v, i) { return csvCell(v, table.formats[i]); }).join(';'));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  var api = { build: build, toCsv: toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMTables = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
