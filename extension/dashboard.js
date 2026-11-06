/* global browser, WMExtract, WMStore, WMMarket, WMStats, WMSettings, WMTime, WMFormat, WMCharts */
'use strict';

const F = WMFormat;
const C = WMCharts;
const $ = (id) => document.getElementById(id);
const TABS = ['overview', 'market', 'cards', 'hours', 'prices', 'stock', 'tx', 'settings'];

const state = {
  db: null,
  model: null,
  settings: null,
  tab: 'overview',
  marketKey: null,
  marketScope: 'tracked',
  marketSearch: '',
  periodDays: 30,
  priceCard: '',
  txKind: 'purchases',
  txSearch: '',
  txTrackedOnly: false
};

/* ------------------------------------------------------------------ data */

async function load() {
  const data = await browser.storage.local.get(['db', 'settings', 'lastExport', 'exportState']);
  state.settings = WMSettings.normalize(data.settings);
  state.db = WMStore.normalizeDb(data.db || WMStore.emptyDb());
  state.model = WMStats.compute(state.db, state.settings, Date.now());
  $('export').hidden = !WMSettings.sheetsConfigured(state.settings);
  const meta = state.db.meta;
  const parts = [meta.lastOwnCapture ? `Transactions relevées le ${WMTime.formatDateTime(meta.lastOwnCapture)}` : 'Transactions pas encore relevées : ouvrez le Marché de WikiMasters'];
  if (meta.lastCapture) parts.push(`prix du marché : ${WMTime.formatDateTime(meta.lastCapture)}`);
  if (data.lastExport && data.lastExport.at) parts.push(`Google Sheets : ${WMTime.formatDateTime(data.lastExport.at)}`);
  $('updated').textContent = parts.join(' · ');
  renderExportState(data.exportState);
  render();
}

let reloadTimer = null;
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.exportState) renderExportState(changes.exportState.newValue);
  if (changes.db || changes.settings || changes.lastExport) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 300);
  }
});

function renderExportState(ex) {
  const box = $('export-state');
  box.textContent = '';
  $('export').disabled = !!(ex && ex.running);
  $('export').textContent = ex && ex.running ? 'Export en cours…' : 'Envoyer vers Google Sheets';
  if (!ex) return;
  const recent = Date.now() - (ex.at || 0) < 2 * 60000;
  if (!ex.running && !recent) return;
  const kind = ex.running ? 'ok' : ex.ok ? 'ok' : 'err';
  const lines = [ex.label].concat(ex.ok && ex.warnings && ex.warnings.length ? ex.warnings : []);
  const n = F.el('div', { class: `notice ${kind}`, text: lines.join('\n') });
  if (ex.running && ex.total) {
    n.append(F.el('div', { class: 'progress' }, F.el('div', { style: `width:${Math.round(100 * Math.max(0, ex.step - 0.5) / ex.total)}%` })));
  }
  box.append(n);
}

$('export').addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'export' }).catch(() => {});
});

$('go-market').addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'openMarketplace' }).catch(() => {});
});

/* --------------------------------------------------------------- routing */

// Same tab for everything: #overview, #market, #market/<card>, #settings…
function route() {
  const [tab, ...rest] = location.hash.replace(/^#/, '').split('/');
  state.tab = TABS.includes(tab) ? tab : 'overview';
  state.marketKey = state.tab === 'market' && rest.length ? decodeURIComponent(rest.join('/')) : null;
  document.querySelectorAll('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === state.tab)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== state.tab; });
  document.title = `${document.querySelector(`.tabs [data-tab="${state.tab}"]`).textContent} · WikiMasters Trading`;
  render();
  if (state.marketKey) window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

// Lets the extension bring this tab back instead of opening a new one.
browser.runtime.sendMessage({ type: 'dashboardTab' }).catch(() => {});

function segmented(id, attr, onPick) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onPick(b.dataset[attr]);
    });
  });
}
segmented('period', 'days', (v) => { state.periodDays = Number(v); render(); });
segmented('tx-kind', 'kind', (v) => { state.txKind = v; render(); });
segmented('market-scope', 'scope', (v) => { state.marketScope = v; render(); });
$('tx-search').addEventListener('input', (e) => { state.txSearch = e.target.value; render(); });
$('market-search').addEventListener('input', (e) => { state.marketSearch = e.target.value; render(); });
$('tx-tracked').addEventListener('change', (e) => { state.txTrackedOnly = e.target.checked; render(); });
$('price-card').addEventListener('change', (e) => { state.priceCard = e.target.value; render(); });

function render() {
  if (!state.model) return;
  renderWarnings();
  if (state.tab === 'settings') return; // handled by settings-panel.js
  C.destroyAll();
  ({ overview, market: renderMarket, cards: renderCards, hours: renderHours, prices: renderPrices, stock: renderStock, tx: renderTx })[state.tab]();
}

function renderWarnings() {
  const box = $('warnings');
  box.textContent = '';
  if (state.tab === 'settings') return;
  const meta = state.db.meta;
  if (meta.warning && Date.now() - meta.warning.t < 3 * 86400000) box.append(F.el('div', { class: 'notice warn', text: meta.warning.text }));
  state.model.warnings.forEach((w) => box.append(F.el('div', { class: 'notice warn', text: w })));
}

/* ---------------------------------------------------------------- market */

function marketRows() {
  const all = WMMarket.allStats(state.db, Date.now(), state.settings.market.windowDays, state.settings.market.useEstimates);
  const match = WMStats.makeMatcher(state.settings, state.db);
  let rows = Object.keys(all).map((k) => Object.assign({ tracked: !!match(all[k].card.replace(/ ✦$/, '')) }, all[k]));
  if (state.marketScope === 'tracked') rows = rows.filter((r) => r.tracked);
  const q = WMExtract.cardKey(state.marketSearch);
  if (q) rows = rows.filter((r) => r.key.includes(q));
  return { all, rows: rows.sort((a, b) => b.n - a.n || a.card.localeCompare(b.card, 'fr')) };
}

function salesCount(r) {
  const extra = [r.nOwn ? `${r.nOwn} à vous` : '', r.nEst ? `${r.nEst} ≈` : ''].filter(Boolean).join(' · ');
  return `${r.n}${extra ? ` (${extra})` : ''}`;
}

function renderChecks() {
  const box = $('market-checks');
  box.textContent = '';
  const match = WMStats.makeMatcher(state.settings, state.db);
  const pending = WMMarket.pendingChecks(state.db, Date.now(), (c) => !!match(c));
  const auto = state.settings.market.autoResolve;
  box.append(F.el('h3', { text: auto ? `File du relevé automatique (${pending.ended.length})` : `À vérifier (${pending.ended.length})` }));
  box.append(F.el('p', { class: 'small muted', text: auto
    ? `Enchères terminées de vos cartes suivies dont le prix final n'est pas encore connu. Le relevé automatique les traite une par une (toutes les ${state.settings.market.resolveSpacingSec} s, quand un onglet du jeu est ouvert). ${pending.upcoming} enchère(s) suivie(s) encore en cours.`
    : `Enchères terminées de vos cartes suivies dont le prix final n'a pas été vu. Ouvrez-les sur le site pour l'enregistrer, ou activez le relevé automatique dans les paramètres. ${pending.upcoming} enchère(s) suivie(s) encore en cours.` }));
  if (!pending.ended.length) {
    box.append(F.el('p', { class: 'muted', text: 'Rien à vérifier.' }));
    return;
  }
  box.append(F.table([
    { label: 'Carte', value: (c) => c.card },
    { label: 'Fin', value: (c) => WMTime.formatDateTime(c.end), cls: () => 'nowrap' },
    { label: 'Dernière enchère vue', value: (c) => (c.hasBid ? F.w(c.lastPrice) : `${F.w(c.lastPrice)} (sans enchère)`), num: true },
    { label: 'Vue le', value: (c) => WMTime.formatDateTime(c.lastSeenAt), cls: () => 'nowrap' },
    { label: 'Essais', value: (c) => c.attempts, num: true },
    { label: '', value: (c) => F.el('a', { href: `https://www.wiki-masters.com/marketplace/${encodeURIComponent(c.id)}`, target: '_blank', rel: 'noopener', text: 'Ouvrir ↗' }) }
  ], pending.ended.slice(0, 200), { maxHeight: '360px' }));
}

function maxBuy(median) {
  if (median === null || median === undefined) return null;
  const v = state.settings.valuation;
  return median * (1 - v.commissionPct / 100) / (1 + v.targetMarginPct / 100);
}

function follow(card, on) {
  return browser.runtime.sendMessage({ type: 'follow', card: card.replace(/ ✦$/, ''), follow: on });
}

function renderMarket() {
  const { all, rows } = marketRows();
  const detail = $('market-detail');
  detail.textContent = '';
  if (state.marketKey) {
    const s = all[state.marketKey];
    if (s) detail.append(marketDetail(s));
    else detail.append(F.el('div', { class: 'notice warn', text: "Pas encore de données pour cette carte : parcourez le Marché pour en recueillir." }));
  }

  renderChecks();
  const box = $('market-table');
  box.textContent = '';
  if (!rows.length) {
    box.append(F.el('p', { class: 'muted', text: state.marketScope === 'tracked'
      ? 'Aucune donnée pour vos cartes suivies. Parcourez le Marché de WikiMasters (ou recherchez une carte) pour recueillir des prix.'
      : 'Aucune donnée de marché pour l\'instant.' }));
    return;
  }
  const trend = (v) => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${F.pct(v)}`);
  box.append(F.table([
    { label: 'Carte', value: (r) => F.el('span', null, r.card, r.rarity ? F.el('span', { class: 'tag', text: r.rarity }) : null) },
    { label: 'Médiane', value: (r) => r.median, format: F.w, num: true },
    { label: 'Ventes', title: 'Ventes observées sur la période : total (dont les vôtres · dont estimées ≈)', value: (r) => salesCount(r), num: true },
    { label: 'P25 – P75', value: (r) => (r.p25 === null ? '–' : `${F.w(r.p25)} – ${F.w(r.p75)}`), num: true },
    { label: 'Min / Max', value: (r) => (r.min === null ? '–' : `${F.w(r.min)} / ${F.w(r.max)}`), num: true },
    { label: 'Tendance 7 j', value: (r) => trend(r.trend7), num: true, cls: (r) => F.signClass(r.trend7) },
    { label: 'Tendance 30 j', value: (r) => trend(r.trend30), num: true, cls: (r) => F.signClass(r.trend30) },
    { label: 'Moins chère en vente', value: (r) => r.lowestAsk, format: F.w, num: true },
    { label: 'Annonces', value: (r) => r.asks, num: true },
    { label: 'Achat max conseillé', title: `Médiane ÷ (1 + marge visée de ${state.settings.valuation.targetMarginPct} %)`, value: (r) => maxBuy(r.median), format: F.w, num: true },
    { label: '', value: (r) => F.el('button', { class: 'link', text: r.tracked ? 'Ne plus suivre' : '+ Suivre',
      onclick: (e) => { e.stopPropagation(); follow(r.card, !r.tracked); } }) }
  ], rows.slice(0, 500), {
    rowClass: (r) => `clickable${r.key === state.marketKey ? ' selected' : ''}`,
    onRowClick: (r) => { location.hash = `#market/${encodeURIComponent(r.key)}`; }
  }));
}

function marketDetail(s) {
  const tracked = !!WMStats.makeMatcher(state.settings, state.db)(s.card.replace(/ ✦$/, ''));
  const trend = (v) => (v === null || v === undefined ? '–' : `${v > 0 ? '+' : ''}${F.pct(v)}`);
  const wrap = F.el('div', { class: 'card market-detail' },
    F.el('div', { class: 'head' },
      F.el('h2', null, s.card, s.rarity ? F.el('span', { class: 'tag', text: s.rarity }) : null),
      F.el('div', { class: 'buttons' },
        F.el('button', { text: tracked ? 'Ne plus suivre' : '+ Suivre', onclick: () => follow(s.card, !tracked) }),
        F.el('a', { class: 'button', href: '#market', text: '✕', title: 'Fermer', 'aria-label': 'Fermer' }))),
    F.el('div', { class: 'tiles' },
      F.tile('Médiane des ventes', F.wUnit(s.median), `${s.n} vente(s) sur ${state.settings.market.windowDays} j${s.nOwn ? `, dont ${s.nOwn} à vous` : ''}${s.nEst ? `, dont ${s.nEst} estimée(s) ≈` : ''}`),
      F.tile('Achat max conseillé', F.wUnit(maxBuy(s.median)), `Marge visée ${state.settings.valuation.targetMarginPct} %`),
      F.tile('P25 – P75', s.p25 === null ? '–' : `${F.w(s.p25)} – ${F.w(s.p75)}`, 'La moitié des ventes est dans cette fourchette'),
      F.tile('Min / Max', s.min === null ? '–' : `${F.w(s.min)} / ${F.w(s.max)}`),
      F.tile('Tendance 7 j', trend(s.trend7), 'Médiane 7 j vs 8–30 j', F.signClass(s.trend7)),
      F.tile('Tendance 30 j', trend(s.trend30), 'Médiane 30 j vs 31–90 j', F.signClass(s.trend30)),
      F.tile('Moins chère en vente', F.wUnit(s.lowestAsk), `${s.asks} annonce(s) vue(s) récemment`)),
    F.el('figure', { class: 'chart' },
      F.el('figcaption', null, F.el('h3', { text: 'Prix des ventes observées et médiane journalière' }),
        F.el('span', { class: 'small muted', text: `${state.settings.market.windowDays} derniers jours (W)` })),
      F.el('div', { class: 'chart-box' }, F.el('canvas', { id: 'c-market' }), F.el('div', { class: 'chart-empty muted', hidden: true, text: 'Aucune vente observée sur la période.' }))));

  setTimeout(() => {
    const daily = WMMarket.dailyMedians(s.sales);
    C.render('c-market', {
      type: 'scatter', unit: 'W', xType: 'linear',
      xTicks: { callback: (v) => WMTime.formatDay(WMTime.dayKey(v)).slice(0, 5), maxTicksLimit: 8 },
      tooltipTitle: (items) => (items.length ? WMTime.formatDateTime(items[0].parsed.x) : ''),
      datasets: [
        { label: 'Ventes des autres joueurs', data: s.sales.filter((x) => !x.own && !x.est).map((x) => ({ x: x.t, y: x.price })), slot: 0 },
        { label: 'Estimées ≈ (dernière enchère vue)', data: s.sales.filter((x) => x.est).map((x) => ({ x: x.t, y: x.price })), slot: 3, pointStyle: 'rectRot' },
        { label: 'Vos ventes', data: s.sales.filter((x) => x.own).map((x) => ({ x: x.t, y: x.price })), slot: 1, pointStyle: 'triangle' },
        { label: 'Médiane journalière', data: daily.map((d) => ({ x: d.t, y: d.median })), slot: 2, line: true }
      ].filter((d, i) => i !== 1 || d.data.length) // no empty "estimated" legend entry
    });
  }, 0);
  return wrap;
}

/** Stable colour slot per card: order of the tracked list, then alphabetical. */
function cardSlots() {
  const slots = {};
  let i = 0;
  state.settings.tracking.cards.forEach((c) => {
    const k = WMExtract.cardKey(c.name);
    if (!(k in slots)) slots[k] = i++;
  });
  state.model.cards.slice().sort((a, b) => a.card.localeCompare(b.card, 'fr')).forEach((c) => {
    if (!(c.key in slots)) slots[c.key] = i++;
  });
  return slots;
}

/* -------------------------------------------------------------- overview */

function periodDays() {
  const days = state.model.days;
  if (!state.periodDays) return days;
  const from = WMTime.addDays(WMTime.dayKey(Date.now()), -(state.periodDays - 1));
  return days.filter((d) => d.day >= from);
}

function shortDay(key) {
  return WMTime.formatDay(key).slice(0, 5);
}

function overview() {
  const k = state.model.kpis;
  const tiles = $('kpis');
  tiles.textContent = '';
  tiles.append(
    F.tile("Profit réalisé aujourd'hui", F.signedUnit(k.realizedToday), `7 j : ${F.signedUnit(k.realized7)} · 30 j : ${F.signedUnit(k.realized30)}`, F.signClass(k.realizedToday)),
    F.tile('Profit réalisé total', F.signedUnit(k.realizedTotal), `${k.sold} vente(s) · marge ${F.pct(k.margin)}`, F.signClass(k.realizedTotal)),
    F.tile("Trading estimé aujourd'hui", F.signedUnit(k.tradingToday), 'Réalisé + variation du latent', F.signClass(k.tradingToday)),
    F.tile('Trading estimé moyen', `${F.signedUnit(k.tradingPerDay7)}/j`, `Sur 7 jours : ${F.signedUnit(k.trading7)}`, F.signClass(k.tradingPerDay7)),
    F.tile('Valeur estimée du stock', F.wUnit(k.stockValue), `${k.stockQty} carte(s) · coût ${F.wUnit(k.stockCost)}`),
    F.tile('Plus-value latente', F.signedUnit(k.unrealized), 'Valeur estimée − coût FIFO', F.signClass(k.unrealized)),
    F.tile('Solde wikibidous', F.wUnit(k.balance), k.balanceAt ? `Relevé le ${WMTime.formatDateTime(k.balanceAt)}` : 'Relevé à la prochaine mise à jour'),
    F.tile('Patrimoine estimé', F.wUnit(k.netWorth), 'Solde + valeur du stock')
  );

  const days = periodDays();
  const labels = days.map((d) => shortDay(d.day));
  const title = (items) => (items.length ? WMTime.formatDay(days[items[0].dataIndex].day) : '');

  C.render('c-daily', {
    type: 'bar', unit: 'W', labels, tooltipTitle: title,
    datasets: [
      { label: 'Profit réalisé', data: days.map((d) => d.realized), slot: 0 },
      { label: 'Trading estimé', data: days.map((d) => d.trading), slot: 1 }
    ]
  });

  let cr = 0;
  let ct = 0;
  C.render('c-cumul', {
    type: 'line', unit: 'W', labels, tooltipTitle: title, beginAtZero: true,
    datasets: [
      { label: 'Profit réalisé cumulé', data: days.map((d) => (cr += d.realized)), slot: 0 },
      { label: 'Trading estimé cumulé', data: days.map((d) => (ct += d.trading)), slot: 1 }
    ]
  });

  const withBalance = days.filter((d) => d.balance !== null);
  C.render('c-networth', {
    type: 'bar', unit: 'W', stacked: true,
    labels: withBalance.map((d) => shortDay(d.day)),
    tooltipTitle: (items) => (items.length ? WMTime.formatDay(withBalance[items[0].dataIndex].day) : ''),
    datasets: [
      { label: 'Solde', data: withBalance.map((d) => d.balance), slot: 0 },
      { label: 'Valeur du stock', data: withBalance.map((d) => d.stockValue), slot: 1 }
    ]
  });

  C.render('c-stock', {
    type: 'line', unit: 'W', labels, tooltipTitle: title, beginAtZero: true,
    datasets: [
      { label: 'Valeur estimée', data: days.map((d) => (d.stockQty ? d.stockValue : null)), slot: 0 },
      { label: 'Coût FIFO', data: days.map((d) => (d.stockQty ? d.stockCost : null)), slot: 1 }
    ]
  });

  const box = $('days-table');
  box.textContent = '';
  box.append(F.table([
    { label: 'Jour', value: (d) => WMTime.formatDay(d.day) },
    { label: 'Achats', value: (d) => d.purchases, num: true },
    { label: 'Dépensé', value: (d) => d.spent, format: F.w, num: true },
    { label: 'Ventes', value: (d) => d.sales, num: true },
    { label: 'Revenu', value: (d) => d.revenue, format: F.w, num: true },
    { label: 'Profit réalisé', value: (d) => d.realized, format: F.signed, num: true, cls: (d, v) => F.signClass(v) },
    { label: 'Stock (cartes)', value: (d) => d.stockQty, num: true },
    { label: 'Coût du stock', value: (d) => d.stockCost, format: F.w, num: true },
    { label: 'Valeur du stock', value: (d) => d.stockValue, format: F.w, num: true },
    { label: 'Trading estimé', value: (d) => d.trading, format: F.signed, num: true, cls: (d, v) => F.signClass(v) },
    { label: 'Solde', value: (d) => d.balance, format: F.w, num: true },
    { label: 'Patrimoine', value: (d) => d.netWorth, format: F.w, num: true }
  ], days.slice().reverse()));
}

/* ---------------------------------------------------------------- cards */

function renderCards() {
  const cards = state.model.cards;
  const box = $('cards-table');
  box.textContent = '';
  box.append(F.table([
    { label: 'Carte', value: (c) => c.card },
    { label: 'Rareté', value: (c) => c.rarity },
    { label: 'Achats', value: (c) => c.purchases, num: true },
    { label: 'Prix achat moyen', value: (c) => c.avgBuy, format: F.w, num: true },
    { label: 'Mises en vente', value: (c) => c.listings, num: true },
    { label: 'Ventes', value: (c) => c.sold, num: true },
    { label: 'Taux de vente', value: (c) => c.sellRate, format: F.pct, num: true },
    { label: 'Prix vente moyen', value: (c) => c.avgSell, format: F.w, num: true },
    { label: 'Profit réalisé', value: (c) => c.profit, format: F.signed, num: true, cls: (c, v) => F.signClass(v) },
    { label: 'Profit moyen / vente', value: (c) => c.avgProfit, format: F.signed, num: true, cls: (c, v) => F.signClass(v) },
    { label: 'Marge', value: (c) => c.margin, format: F.pct, num: true },
    { label: 'En stock', value: (c) => c.stock, num: true },
    { label: 'Détention moy. (h)', value: (c) => c.avgHold, format: F.dec1, num: true },
    { label: 'Achat max conseillé', title: `Prix de vente moyen ÷ (1 + marge visée de ${state.settings.valuation.targetMarginPct} %)`, value: (c) => c.maxBuy, format: F.w, num: true }
  ], cards));

  const withSales = cards.filter((c) => c.sold > 0);
  const names = withSales.map((c) => c.card);
  C.render('c-card-profit', { type: 'bar', horizontal: true, unit: 'W', labels: names, datasets: [{ label: 'Profit réalisé', data: withSales.map((c) => c.profit), slot: 0 }] });
  const traded = cards.filter((c) => c.purchases + c.sold > 0);
  C.render('c-card-prices', {
    type: 'bar', horizontal: true, unit: 'W', labels: traded.map((c) => c.card),
    datasets: [
      { label: 'Prix achat moyen', data: traded.map((c) => c.avgBuy), slot: 0 },
      { label: 'Prix vente moyen', data: traded.map((c) => c.avgSell), slot: 1 }
    ]
  });
  C.render('c-card-avgprofit', { type: 'bar', horizontal: true, unit: 'W', labels: names, datasets: [{ label: 'Profit moyen / vente', data: withSales.map((c) => c.avgProfit), slot: 0 }] });
  C.render('c-card-margin', { type: 'bar', horizontal: true, unit: 'pct', labels: names, datasets: [{ label: 'Marge', data: withSales.map((c) => c.margin), slot: 0 }] });
}

/* ---------------------------------------------------------------- hours */

function renderHours() {
  const hours = state.model.hours;
  const labels = hours.map((h) => `${h.hour} h`);
  C.render('c-hour-index', {
    type: 'bar', unit: 'idx', labels,
    datasets: [
      { label: 'Indice prix achat', data: hours.map((h) => h.buyIndex), slot: 0 },
      { label: 'Indice prix vente', data: hours.map((h) => h.sellIndex), slot: 1 }
    ]
  });
  C.render('c-hour-rate', { type: 'bar', unit: 'pct', labels, datasets: [{ label: 'Taux de vente', data: hours.map((h) => h.sellRate), slot: 0 }] });

  const best = (field, dir) => {
    const list = hours.filter((h) => h[field] !== null);
    if (!list.length) return null;
    return list.reduce((a, b) => (dir * (b[field] - a[field]) > 0 ? b : a));
  };
  const bBuy = best('buyIndex', -1);
  const bSell = best('sellIndex', 1);
  const bRate = best('sellRate', 1);
  const box = $('hours-table');
  box.textContent = '';
  box.append(F.el('p', { class: 'small secondary', text: [
    bBuy ? `Meilleure heure pour acheter (prix le plus bas) : ${bBuy.hour} h (indice ${F.dec2(bBuy.buyIndex)}).` : '',
    bSell ? `Meilleure heure pour vendre (prix le plus haut) : ${bSell.hour} h (indice ${F.dec2(bSell.sellIndex)}).` : '',
    bRate ? `Meilleur taux de vente : ${bRate.hour} h (${F.pct(bRate.sellRate)}).` : ''
  ].filter(Boolean).join(' ') || 'Pas encore assez de données.' }));
  box.append(F.table([
    { label: 'Heure', value: (h) => `${h.hour} h` },
    { label: 'Achats', value: (h) => h.purchases, num: true },
    { label: 'Indice prix achat moyen', value: (h) => h.buyIndex, format: F.dec2, num: true },
    { label: 'Mises en vente', value: (h) => h.listings, num: true },
    { label: 'Ventes', value: (h) => h.sold, num: true },
    { label: 'Taux de vente', value: (h) => h.sellRate, format: F.pct, num: true },
    { label: 'Indice prix vente moyen', value: (h) => h.sellIndex, format: F.dec2, num: true }
  ], hours));
}

/* --------------------------------------------------------------- prices */

function renderPrices() {
  const m = state.model;
  const slots = cardSlots();
  const select = $('price-card');
  const cards = m.seriesCards;
  if (state.priceCard && !cards.some((c) => c.key === state.priceCard)) state.priceCard = '';
  select.textContent = '';
  select.append(F.el('option', { value: '', text: `Les ${Math.min(cards.length, WMStats.MAX_SERIES)} cartes les plus échangées` }));
  cards.forEach((c) => select.append(F.el('option', { value: c.key, text: c.card, selected: c.key === state.priceCard })));

  const shown = state.priceCard ? cards.filter((c) => c.key === state.priceCard) : cards.slice(0, WMStats.MAX_SERIES);
  const idx = shown.map((c) => cards.indexOf(c) + 1);
  C.render('c-inflation', {
    type: 'line', unit: 'W', labels: m.inflation.rows.map((r) => `${r[0]}`),
    tooltipTitle: (items) => (items.length ? `${items[0].label}e achat` : ''),
    datasets: shown.map((c, i) => ({ label: c.card, data: m.inflation.rows.map((r) => r[idx[i]]), slot: slots[c.key] }))
  });

  // Scatter: one card at a time (purchases vs sales), to keep points readable.
  const focus = state.priceCard ? cards.find((c) => c.key === state.priceCard) : cards[0];
  $('scatter-sub').textContent = focus ? `${focus.card} · achats et ventes (W)` : 'W';
  const series = focus ? m.priceSeries[focus.key] : { buys: [], sells: [] };
  C.render('c-scatter', {
    type: 'scatter', unit: 'W', xType: 'linear',
    xTicks: { callback: (v) => WMTime.formatDay(WMTime.dayKey(v)).slice(0, 5), maxTicksLimit: 8 },
    tooltipTitle: (items) => (items.length ? WMTime.formatDateTime(items[0].parsed.x) : ''),
    datasets: [
      { label: 'Achats', data: series.buys.map((p) => ({ x: p.t, y: p.price })), slot: 0 },
      { label: 'Ventes', data: series.sells.map((p) => ({ x: p.t, y: p.price })), slot: 1, pointStyle: 'triangle' }
    ]
  });
}

/* ---------------------------------------------------------------- stock */

function renderStock() {
  const m = state.model;
  const box = $('stock-table');
  box.textContent = '';
  if (!m.inventory.length) box.append(F.el('p', { class: 'muted', text: 'Aucune carte suivie en stock.' }));
  else {
    box.append(F.table([
      { label: 'Carte', value: (i) => i.card },
      { label: 'Rareté', value: (i) => i.rarity },
      { label: 'Quantité', value: (i) => i.qty, num: true },
      { label: 'Dont en vente', value: (i) => i.listed, num: true },
      { label: 'Coût FIFO', value: (i) => i.cost, format: F.w, num: true },
      { label: 'Coût moyen', value: (i) => i.avgCost, format: F.w, num: true },
      { label: 'Valeur unitaire est.', value: (i) => i.unitValue, format: F.w, num: true },
      { label: 'Source', value: (i) => i.valueSource },
      { label: 'Valeur totale est.', value: (i) => i.value, format: F.w, num: true },
      { label: 'Latent', value: (i) => i.unrealized, format: F.signed, num: true, cls: (i, v) => F.signClass(v) },
      { label: 'Plus ancien achat', value: (i) => WMTime.formatDateTime(i.oldest), cls: () => 'nowrap' },
      { label: 'Détention moy. (h)', value: (i) => i.avgAge, format: F.dec1, num: true }
    ], m.inventory));
  }
  const lb = $('listings-table');
  lb.textContent = '';
  if (!m.listings.length) lb.append(F.el('p', { class: 'muted', text: 'Aucune annonce en cours lors de la dernière mise à jour.' }));
  else {
    lb.append(F.table([
      { label: 'Carte', value: (l) => l.card },
      { label: 'Prix actuel', value: (l) => l.price, format: F.w, num: true },
      { label: 'Enchère reçue', value: (l) => (l.hasBid ? 'Oui' : 'Non') },
      { label: 'Fin', value: (l) => WMTime.formatDateTime(l.end), cls: () => 'nowrap' }
    ], m.listings));
  }
}

/* --------------------------------------------------------- transactions */

function renderTx() {
  const m = state.model;
  const q = WMExtract.cardKey(state.txSearch);
  let rows = (state.txKind === 'purchases' ? m.purchases : m.sales).slice().reverse();
  if (state.txTrackedOnly) rows = rows.filter((r) => r.matchesRule);
  if (q) rows = rows.filter((r) => WMExtract.cardKey(r.card).includes(q) || WMExtract.cardKey(r.party).includes(q));
  const total = rows.length;
  rows = rows.slice(0, 1000);

  const exclude = (r) => F.el('input', {
    type: 'checkbox', checked: r.excluded, 'aria-label': `Exclure ${r.label}`,
    onchange: async (e) => {
      e.target.disabled = true;
      await browser.runtime.sendMessage({ type: 'setExcluded', id: r.id, excluded: e.target.checked });
    }
  });
  const common = [
    { label: 'ID', value: (r) => r.label },
    { label: 'Date', value: (r) => WMTime.formatDateTime(r.time), cls: () => 'nowrap' },
    { label: 'Carte', value: (r) => r.card },
    { label: 'Rareté', value: (r) => r.rarity },
    { label: 'Prix', value: (r) => r.price, format: F.w, num: true }
  ];
  const cols = state.txKind === 'purchases'
    ? common.concat([
      { label: 'Vendeur', value: (r) => r.party },
      { label: 'Suivie', value: (r) => (r.tracked ? 'Oui' : 'Non') },
      { label: 'N°', value: (r) => (r.tracked ? r.n : null), num: true },
      { label: 'Vendue par', value: (r) => r.soldBy || '' },
      { label: 'Exclure', value: exclude }
    ])
    : common.concat([
      { label: 'Statut', value: (r) => r.status },
      { label: 'Acheteur', value: (r) => r.party },
      { label: 'Achat (FIFO)', value: (r) => r.lot || '' },
      { label: 'Coût', value: (r) => r.cost, format: F.w, num: true },
      { label: 'Profit', value: (r) => r.profit, format: F.signed, num: true, cls: (r, v) => F.signClass(v) },
      { label: 'Marge', value: (r) => r.margin, format: F.pct, num: true },
      { label: 'Détention (h)', value: (r) => r.hold, format: F.dec1, num: true },
      { label: 'Contrôle', value: (r) => r.check },
      { label: 'Exclure', value: exclude }
    ]);
  const box = $('tx-table');
  box.textContent = '';
  box.append(F.el('div', { class: 'small muted', text: `${total} ligne(s)${total > 1000 ? ' (1 000 premières affichées)' : ''}. En gris : non suivies.` }));
  box.append(F.table(cols, rows, { rowClass: (r) => (r.tracked ? null : 'dim') }));
}

route();
load();
