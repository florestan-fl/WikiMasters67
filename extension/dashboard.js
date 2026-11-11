/* global browser, WMExtract, WMStore, WMMarket, WMStats, WMSettings, WMTime, WMFormat, WMCharts, WMSearches */
'use strict';

const F = WMFormat;
const C = WMCharts;
const $ = (id) => document.getElementById(id);
const TABS = ['overview', 'groups', 'market', 'cards', 'hours', 'prices', 'stock', 'tx', 'features', 'settings'];
const FORM_TABS = ['features', 'settings']; // rendered by settings-panel.js
const STAT_TABS = ['overview', 'market', 'cards', 'hours', 'prices', 'stock', 'tx']; // follow the group filter
const NO_GROUP_COLOR = '#898781';
const SITE = 'https://www.wiki-masters.com';

const state = {
  db: null,
  model: null,       // statistics shown (the group filter applied)
  fullModel: null,   // every followed card
  groupModels: {},   // per group, computed when needed
  settings: null,
  group: readGroupFilter(), // null: all groups, '': followed cards in no group, else a group id
  groupDetail: null,
  groupsPeriod: 30,
  picker: { q: '', cat: '', rarity: '', hideGrouped: true, sel: new Set() },
  listing: { rarity: '', sort: 'end' },
  stockKey: null,
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

function readGroupFilter() {
  try {
    const v = localStorage.getItem('wmt-group');
    return v === null ? null : v;
  } catch (e) { return null; }
}

function writeGroupFilter(v) {
  try {
    if (v === null) localStorage.removeItem('wmt-group'); else localStorage.setItem('wmt-group', v);
  } catch (e) { /* private window: per-visit only */ }
}

async function load() {
  const data = await browser.storage.local.get(['db', 'settings', 'lastExport', 'exportState']);
  state.settings = WMSettings.normalize(data.settings);
  state.db = WMStore.normalizeDb(data.db || WMStore.emptyDb());
  if (state.group && !groupById(state.group)) state.group = null; // deleted group
  const now = Date.now();
  state.fullModel = WMStats.compute(state.db, state.settings, now);
  state.model = state.group === null ? state.fullModel : WMStats.compute(state.db, state.settings, now, { group: state.group });
  state.groupModels = {};
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
  const detail = state.tab === 'groups' && rest.length ? decodeURIComponent(rest.join('/')) : null;
  if (detail !== state.groupDetail) state.picker = { q: '', cat: '', rarity: '', hideGrouped: true, sel: new Set() };
  state.groupDetail = detail;
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
segmented('groups-period', 'days', (v) => { state.groupsPeriod = Number(v); render(); });
$('group-filter').addEventListener('change', (e) => {
  const v = e.target.value;
  state.group = v === '*' ? null : v;
  writeGroupFilter(state.group);
  state.model = state.group === null ? state.fullModel : WMStats.compute(state.db, state.settings, Date.now(), { group: state.group });
  render();
});
$('new-group').addEventListener('click', async () => {
  let id = null;
  await updateSettings((s) => {
    const g = WMSettings.newGroup(s.groups);
    s.groups.push(g);
    id = g.id;
  });
  location.hash = `#groups/${encodeURIComponent(id)}`;
});
segmented('tx-kind', 'kind', (v) => { state.txKind = v; render(); });
segmented('market-scope', 'scope', (v) => { state.marketScope = v; render(); });
$('tx-search').addEventListener('input', (e) => { state.txSearch = e.target.value; render(); });
$('market-search').addEventListener('input', (e) => { state.marketSearch = e.target.value; render(); });
$('tx-tracked').addEventListener('change', (e) => { state.txTrackedOnly = e.target.checked; render(); });
$('price-card').addEventListener('change', (e) => { state.priceCard = e.target.value; render(); });

function render() {
  if (!state.model) return;
  renderGroupBar();
  renderWarnings();
  if (FORM_TABS.includes(state.tab)) return; // handled by settings-panel.js
  C.destroyAll();
  ({ overview, groups: renderGroups, market: renderMarket, cards: renderCards, hours: renderHours, prices: renderPrices, stock: renderStock, tx: renderTx })[state.tab]();
}

/* ---------------------------------------------------------------- groups: helpers */

function groupById(id) {
  return (state.settings ? state.settings.groups : []).find((g) => g.id === id) || null;
}

function groupOfCard(card) {
  return WMStats.groupOf(state.settings)(String(card || '').replace(/ ✦$/, ''));
}

/** Coloured chip with the group name (or nothing). */
function chip(g, extra) {
  if (!g) return null;
  return F.el('span', { class: 'g-chip', style: `--g:${g.color}`, title: extra || null }, F.el('span', { class: 'g-dot' }), g.name);
}

function groupCell(id) {
  return chip(groupById(id)) || F.el('span', { class: 'muted', text: '–' });
}

/** Read-modify-write of the stored settings (other pages may have changed them). */
async function updateSettings(fn) {
  const { settings } = await browser.storage.local.get('settings');
  const s = WMSettings.normalize(settings);
  fn(s);
  const out = WMSettings.normalize(s);
  await browser.storage.local.set({ settings: out });
  state.settings = out;
  return out;
}

function groupModel(id) {
  if (!state.groupModels[id]) state.groupModels[id] = WMStats.compute(state.db, state.settings, Date.now(), { group: id });
  return state.groupModels[id];
}

function ago(t) {
  if (!t) return 'jamais';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

function leftText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)} j`;
}

function renderGroupBar() {
  const bar = $('group-bar');
  const groups = state.settings.groups;
  const show = STAT_TABS.includes(state.tab) && groups.length > 0;
  bar.hidden = !show;
  const g = state.group ? groupById(state.group) : null;
  const grouped = show && state.group !== null;
  document.body.classList.toggle('grouped', grouped);
  document.body.style.setProperty('--g', g ? g.color : NO_GROUP_COLOR);
  if (!show) return;
  const sel = $('group-filter');
  sel.textContent = '';
  sel.append(F.el('option', { value: '*', text: 'Tous les groupes', selected: state.group === null }));
  groups.forEach((x) => sel.append(F.el('option', { value: x.id, text: x.name, selected: state.group === x.id })));
  sel.append(F.el('option', { value: '', text: 'Sans groupe', selected: state.group === '' }));
  $('group-bar-note').textContent = grouped
    ? `Statistiques limitées à ${g ? `« ${g.name} » (${g.cards.length} carte${g.cards.length > 1 ? 's' : ''})` : 'vos cartes suivies sans groupe'}.`
    : '';
}

function renderWarnings() {
  const box = $('warnings');
  box.textContent = '';
  if (FORM_TABS.includes(state.tab)) return;
  const meta = state.db.meta;
  if (meta.warning && Date.now() - meta.warning.t < 3 * 86400000) box.append(F.el('div', { class: 'notice warn', text: meta.warning.text }));
  state.model.warnings.forEach((w) => box.append(F.el('div', { class: 'notice warn', text: w })));
}

/* ---------------------------------------------------------------- groups tab */

function currentDeals() {
  const ft = state.settings.features;
  return WMMarket.deals(state.db, Date.now(), {
    pct: ft.alertPct, minSales: ft.alertMinSales, windowDays: state.settings.market.windowDays,
    useEstimates: state.settings.market.useEstimates, isEligible: null
  });
}

function renderGroups() {
  const detail = state.groupDetail ? groupById(state.groupDetail) : null;
  $('groups-list').hidden = !!detail;
  $('group-detail').hidden = !detail;
  if (state.groupDetail && !detail) {
    $('group-detail').hidden = false;
    $('group-detail').textContent = '';
    $('group-detail').append(F.el('div', { class: 'notice warn', text: 'Ce groupe n\'existe plus.' }), F.el('a', { href: '#groups', text: '← Tous les groupes' }));
    return;
  }
  if (detail) renderGroupDetail(detail);
  else renderGroupList();
}

function activityLine(g) {
  const act = WMSearches.activity(state.db, g, Date.now(), WMExtract.cardKey);
  const parts = [];
  if (!g.searches.length) parts.push('Aucune recherche enregistrée');
  else {
    parts.push(`Recherche : vous ${ago(act.user)}`);
    if (g.searches.some((x) => x.auto)) parts.push(`auto ${ago(act.auto)}`);
  }
  parts.push(act.seen ? `annonces vues ${ago(act.seen)}` : 'aucune annonce vue');
  return { act, text: parts.join(' · ') };
}

function shortcutButton(search) {
  return F.el('button', {
    title: `${WMSearches.describe(search.query)}\nOuvre la page du Marché où vous avez fait cette recherche.`,
    text: `↗ ${search.label || WMSearches.describe(search.query)}`,
    onclick: () => browser.runtime.sendMessage({ type: 'openSearch', pageUrl: search.pageUrl })
  });
}

function renderGroupList() {
  const groups = state.settings.groups;
  const sums = WMStats.summarizeGroups(state.fullModel);
  const byId = {};
  sums.forEach((x) => { byId[x.id] = x; });
  const deals = currentDeals();
  const followed = WMStats.makeMatcher(state.settings, state.db);
  const dealCount = (id) => deals.filter((d) => { const g = groupOfCard(d.card); return (g ? g.id : '') === id && (id || !!followed(d.card)); }).length;

  const box = $('group-panels');
  box.textContent = '';
  groups.forEach((g) => {
    const x = byId[g.id];
    const { act, text } = activityLine(g);
    const nums = (items) => F.el('div', { class: 'nums' }, items.map(([label, value, cls]) =>
      F.el('div', { class: 'num' }, F.el('div', { class: 'label', text: label }), F.el('div', { class: `value ${cls || ''}`, text: value }))));
    const dc = dealCount(g.id);
    box.append(F.el('div', { class: 'card g-tint group-panel', style: `--g:${g.color}` },
      F.el('div', { class: 'head' },
        F.el('span', { class: 'g-dot' }),
        F.el('h3', { text: g.name }),
        F.el('span', { class: 'count small secondary', text: `${g.cards.length} carte${g.cards.length > 1 ? 's' : ''}` })),
      nums([
        ['Réalisé 7 j', F.signedUnit(x.realized7), F.signClass(x.realized7)],
        ['Réalisé 30 j', F.signedUnit(x.realized30), F.signClass(x.realized30)],
        ['Réalisé total', F.signedUnit(x.realized), F.signClass(x.realized)]
      ]),
      nums([
        ['En stock', `${x.stockQty} carte${x.stockQty > 1 ? 's' : ''}`],
        ['Valeur estimée', F.wUnit(x.stockValue)],
        ['Latent', F.signedUnit(x.unrealized), F.signClass(x.unrealized)]
      ]),
      F.el('div', { class: 'activity' }, text, act.overdue ? F.el('span', { class: 'due', text: `À refaire (> ${g.remindDays} j)` }) : null),
      dc ? F.el('div', { class: 'activity' }, F.el('a', { href: '#groups/' + encodeURIComponent(g.id), text: `${dc} bonne(s) affaire(s) en cours` })) : null,
      F.el('div', { class: 'buttons' },
        F.el('button', { text: 'Statistiques', title: 'Toutes les statistiques limitées à ce groupe', onclick: () => showGroupStats(g.id) }),
        F.el('a', { class: 'button', href: '#groups/' + encodeURIComponent(g.id), text: 'Gérer' }),
        g.searches.slice(0, 3).map(shortcutButton))));
  });
  const none = byId[''];
  if (none) {
    box.append(F.el('div', { class: 'card group-panel', style: `--g:${NO_GROUP_COLOR}` },
      F.el('div', { class: 'head' }, F.el('span', { class: 'g-dot' }), F.el('h3', { text: 'Sans groupe' }),
        F.el('span', { class: 'count small secondary', text: `${none.cards} carte(s) suivie(s)` })),
      F.el('div', { class: 'small secondary', text: `Réalisé total ${F.signedUnit(none.realized)} · stock ${none.stockQty} carte(s), ${F.wUnit(none.stockValue)}` }),
      F.el('div', { class: 'buttons' }, F.el('button', { text: 'Statistiques', onclick: () => showGroupStats('') }))));
  }
  if (!groups.length) {
    box.append(F.el('div', { class: 'card group-panel empty-panel' },
      F.el('div', { text: 'Aucun groupe pour l\'instant.' }),
      F.el('div', { class: 'small', text: 'Créez par exemple « Dinosaures », « Peintures » et « Mythologie grecque », puis ajoutez-y vos cartes.' })));
  }

  // Charts: realized profit per day (stacked), cumulative estimated trading per group.
  const days = groupsDays(state.fullModel.days);
  const labels = days.map((d) => shortDay(d.day));
  const title = (items) => (items.length ? WMTime.formatDay(days[items[0].dataIndex].day) : '');
  const series = groups.map((g) => ({ id: g.id, label: g.name, color: g.color }));
  if (none) series.push({ id: '', label: 'Sans groupe', color: NO_GROUP_COLOR });
  const realizedBy = {};
  state.fullModel.sales.forEach((r) => {
    if (!r.tracked || r.status !== 'Vendue' || r.profit === null) return;
    const k = `${r.group || ''}|${WMTime.dayKey(r.time)}`;
    realizedBy[k] = (realizedBy[k] || 0) + r.profit;
  });
  C.render('c-groups-daily', {
    type: 'bar', unit: 'W', labels, tooltipTitle: title, stacked: true,
    datasets: series.map((x) => ({ label: x.label, color: x.color, data: days.map((d) => realizedBy[`${x.id}|${d.day}`] || 0) }))
  });
  C.render('c-groups-cumul', {
    type: 'line', unit: 'W', labels, tooltipTitle: title, beginAtZero: true,
    datasets: series.map((x) => {
      const gd = {};
      groupModel(x.id).days.forEach((d) => { gd[d.day] = d.trading; });
      let c = 0;
      return { label: x.label, color: x.color, data: days.map((d) => (c += gd[d.day] || 0)) };
    })
  });

  const tbox = $('groups-table');
  tbox.textContent = '';
  const rows = sums.map((x) => Object.assign({ trading7: groupModel(x.id).kpis.trading7, deals: dealCount(x.id) }, x));
  tbox.append(F.table([
    { label: 'Groupe', value: (x) => (x.id ? chip(groupById(x.id)) : F.el('span', { class: 'g-chip', style: `--g:${NO_GROUP_COLOR}` }, F.el('span', { class: 'g-dot' }), 'Sans groupe')) },
    { label: 'Cartes', value: (x) => x.cards, num: true },
    { label: 'Achats', value: (x) => x.purchases, num: true },
    { label: 'Ventes', value: (x) => x.sold, num: true },
    { label: 'Dont boosters', value: (x) => x.boosterSales, num: true },
    { label: 'Réalisé 7 j', value: (x) => x.realized7, format: F.signed, num: true, cls: (x, v) => F.signClass(v) },
    { label: 'Réalisé 30 j', value: (x) => x.realized30, format: F.signed, num: true, cls: (x, v) => F.signClass(v) },
    { label: 'Réalisé total', value: (x) => x.realized, format: F.signed, num: true, cls: (x, v) => F.signClass(v) },
    { label: 'Trading estimé 7 j', value: (x) => x.trading7, format: F.signed, num: true, cls: (x, v) => F.signClass(v) },
    { label: 'Stock', value: (x) => x.stockQty, num: true },
    { label: 'Valeur du stock', value: (x) => x.stockValue, format: F.w, num: true },
    { label: 'Latent', value: (x) => x.unrealized, format: F.signed, num: true, cls: (x, v) => F.signClass(v) },
    { label: 'Bonnes affaires', value: (x) => x.deals, num: true }
  ], rows));
}

function groupsDays(days) {
  if (!state.groupsPeriod) return days;
  const from = WMTime.addDays(WMTime.dayKey(Date.now()), -(state.groupsPeriod - 1));
  return days.filter((d) => d.day >= from);
}

function showGroupStats(id) {
  state.group = id;
  writeGroupFilter(id);
  state.model = WMStats.compute(state.db, state.settings, Date.now(), { group: id });
  location.hash = '#overview';
  render();
}

/* ---------------------------------------------------------- group detail */

function knownCardIndex() {
  const out = {};
  Object.keys(state.db.cards).forEach((k) => {
    const c = state.db.cards[k];
    out[k] = { key: k, title: c.title || k, category: c.category || '', rarity: c.rarity || '' };
  });
  state.fullModel.purchases.concat(state.fullModel.sales).forEach((r) => {
    if (!out[r.key]) out[r.key] = { key: r.key, title: r.card, category: '', rarity: r.rarity || '' };
  });
  return out;
}

function renderGroupDetail(g) {
  const box = $('group-detail');
  box.textContent = '';
  const gm = groupModel(g.id);
  const k = gm.kpis;
  const deals = currentDeals().filter((d) => { const x = groupOfCard(d.card); return x && x.id === g.id; });
  const save = (fn) => updateSettings((s) => { const x = s.groups.find((y) => y.id === g.id); if (x) fn(x, s); });

  const name = F.el('input', { type: 'text', value: g.name, 'aria-label': 'Nom du groupe', maxlength: '60',
    onchange: (e) => save((x) => { x.name = e.target.value.trim() || x.name; }) });
  const color = F.el('input', { type: 'color', value: g.color, title: 'Couleur du groupe', 'aria-label': 'Couleur du groupe',
    onchange: (e) => save((x) => { x.color = e.target.value; }) });
  const remind = F.el('input', { type: 'number', min: '1', max: '60', value: String(g.remindDays), style: 'width:64px', 'aria-label': 'Jours avant rappel',
    onchange: (e) => save((x) => { x.remindDays = Number(e.target.value) || 3; }) });

  const wrap = F.el('div', { class: 'group-detail', style: `--g:${g.color}` });
  wrap.append(F.el('div', { class: 'card g-tint' },
    F.el('div', { class: 'head' },
      F.el('a', { href: '#groups', text: '← Groupes' }),
      F.el('span', { class: 'g-dot' }), name, color,
      F.el('button', { class: 'link', text: 'Couleur auto', title: 'Première couleur libre de la palette',
        onclick: () => save((x, s) => { x.color = ''; x.color = WMSettings.freeColor(s.groups.filter((y) => y.id !== x.id)); }) }),
      F.el('span', { class: 'spacer' }),
      F.el('button', { text: 'Statistiques du groupe', onclick: () => showGroupStats(g.id) }),
      F.el('button', { class: 'link', text: 'Supprimer le groupe', onclick: async () => {
        if (!confirm(`Supprimer le groupe « ${g.name} » ? Ses ${g.cards.length} carte(s) ne seront plus suivies (sauf celles de vos cartes suivies ou de vos mots-clés). Les transactions restent enregistrées.`)) return;
        await updateSettings((s) => { s.groups = s.groups.filter((y) => y.id !== g.id); });
        location.hash = '#groups';
      } })),
    F.el('div', { class: 'tiles', style: 'margin-top:10px' },
      F.tile('Réalisé 7 j', F.signedUnit(k.realized7), `30 j : ${F.signedUnit(k.realized30)}`, F.signClass(k.realized7)),
      F.tile('Réalisé total', F.signedUnit(k.realizedTotal), `${k.sold} vente(s)${k.boosterSales ? `, dont ${k.boosterSales} de booster` : ''}`, F.signClass(k.realizedTotal)),
      F.tile('Trading estimé 7 j', F.signedUnit(k.trading7), 'Réalisé + variation du latent', F.signClass(k.trading7)),
      F.tile('Valeur du stock', F.wUnit(k.stockValue), `${k.stockQty} carte(s) · latent ${F.signedUnit(k.unrealized)}`),
      F.tile('Bonnes affaires', String(deals.length), `≥ ${state.settings.features.alertPct} % sous la médiane`))));

  wrap.append(groupSearches(g, save, remind));
  wrap.append(groupListings(g));
  wrap.append(groupCards(g, gm, save));
  box.append(wrap);
}

function groupSearches(g, save, remind) {
  const card = F.el('div', { class: 'card' });
  card.append(F.el('h3', { text: `Recherches (${g.searches.length})` }));
  card.append(F.el('p', { class: 'small secondary help', text: 'Pour ajouter une recherche : faites-la sur le Marché du jeu (texte, rareté, tri…), puis revenez ici : elle apparaît dans « Recherches récentes ». ' +
    'L\'extension garde les paramètres exacts du jeu et reconnaît quand vous la refaites, pour savoir depuis quand ce groupe n\'a pas été regardé.' }));
  card.append(F.el('div', { class: 'small secondary' }, 'Me signaler le groupe s\'il n\'a pas été recherché depuis ', remind, ' jour(s).'));
  const autoOff = !state.settings.features.autoSearch;
  if (autoOff && g.searches.some((x) => x.auto)) {
    card.append(F.el('div', { class: 'notice warn small', text: 'Des recherches sont cochées « Auto », mais les recherches automatiques sont désactivées (onglet Fonctionnalités).' }));
  }
  const list = F.el('div');
  g.searches.forEach((x) => {
    const use = WMSearches.lastUse(state.db, x.query);
    list.append(F.el('div', { class: 'search-row' },
      F.el('div', null,
        F.el('input', { type: 'text', value: x.label, placeholder: WMSearches.describe(x.query), 'aria-label': 'Nom de la recherche', maxlength: '80',
          onchange: (e) => save((gg) => { const y = gg.searches.find((z) => z.id === x.id); if (y) y.label = e.target.value.trim(); }) }),
        F.el('div', { class: 'params', text: WMSearches.describe(x.query) }),
        F.el('div', { class: 'when', text: `Vous : ${ago(use.user)}${x.auto ? ` · auto : ${ago(use.auto)}` : ''}${x.pageUrl ? '' : ' · pas de page enregistrée : le raccourci ouvre le Marché'}` })),
      F.el('div', { class: 'acts' },
        F.el('label', { class: 'check small', title: 'Lancée par les recherches automatiques (onglet Fonctionnalités)' },
          F.el('input', { type: 'checkbox', checked: x.auto, onchange: (e) => save((gg) => { const y = gg.searches.find((z) => z.id === x.id); if (y) y.auto = e.target.checked; }) }), ' Auto'),
        shortcutButton(x),
        F.el('button', { class: 'link', text: '✕', title: 'Retirer cette recherche', 'aria-label': 'Retirer cette recherche',
          onclick: () => save((gg) => { gg.searches = gg.searches.filter((z) => z.id !== x.id); }) }))));
  });
  if (!g.searches.length) list.append(F.el('p', { class: 'muted small', text: 'Aucune recherche enregistrée.' }));
  card.append(list);

  // Recent searches seen on the Marché, not saved in this group yet.
  const inGroup = {};
  g.cards.forEach((c) => { inGroup[WMExtract.cardKey(c)] = true; });
  const recent = (state.db.meta.searchLog || []).slice().reverse().filter((x) => !g.searches.some((y) => y.query === x.query)).slice(0, 10);
  const det = F.el('details', { open: !g.searches.length || null });
  det.append(F.el('summary', { class: 'small', text: `Recherches récentes sur le Marché (${recent.length})` }));
  if (!recent.length) det.append(F.el('p', { class: 'muted small', text: 'Aucune pour l\'instant : faites une recherche sur le Marché du jeu.' }));
  recent.forEach((x) => {
    const names = x.cards || [];
    const hits = names.filter((n) => inGroup[WMExtract.cardKey(n)]).length;
    det.append(F.el('div', { class: 'search-row' },
      F.el('div', null,
        F.el('div', { class: 'params', text: WMSearches.describe(x.query) }),
        F.el('div', { class: 'cards-in-search' }, `${ago(x.at)} · ${x.results} annonce(s)`, names.length ? ' · ' : '',
          names.map((n, i) => [i ? ', ' : '', inGroup[WMExtract.cardKey(n)] ? F.el('b', { text: n }) : n]).flat(),
          hits ? ` (${hits} de ce groupe)` : '')),
      F.el('div', { class: 'acts' },
        F.el('button', { text: '+ Enregistrer', onclick: async (e) => {
          e.target.disabled = true;
          await browser.runtime.sendMessage({ type: 'saveSearch', group: g.id, search: x });
        } }))));
  });
  card.append(det);
  return card;
}

/** Running auctions of the group's cards seen while browsing (no request): a local search. */
function groupListings(g) {
  const keys = {};
  g.cards.forEach((c) => { keys[WMExtract.cardKey(c)] = true; });
  const now = Date.now();
  const stats = WMMarket.allStats(state.db, now, state.settings.market.windowDays, state.settings.market.useEstimates);
  let rows = Object.keys(state.db.auctions || {}).map((id) => Object.assign({ id }, state.db.auctions[id]))
    .filter((a) => keys[a.baseKey] && !a.mine && a.status === 'active' && a.end && a.end > now && now - a.seenAt < 6 * 3600e3)
    .map((a) => {
      const st = stats[a.key];
      const next = WMMarket.nextPrice(a);
      const median = st && st.n ? st.median : null;
      return Object.assign(a, { next, median, diff: median && next !== null ? next / median - 1 : null });
    });
  const L = state.listing;
  if (L.rarity) rows = rows.filter((a) => (a.rarity || '') === L.rarity);
  const sorters = {
    end: (a, b) => a.end - b.end,
    diff: (a, b) => (a.diff === null) - (b.diff === null) || a.diff - b.diff,
    price: (a, b) => a.next - b.next
  };
  rows.sort(sorters[L.sort] || sorters.end);
  const card = F.el('div', { class: 'card' });
  const rar = F.el('select', { 'aria-label': 'Rareté', onchange: (e) => { L.rarity = e.target.value; render(); } },
    [F.el('option', { value: '', text: 'Toutes les raretés' })].concat(WMSettings.RARITIES.map((r) => F.el('option', { value: r, text: r, selected: L.rarity === r }))));
  const sort = F.el('select', { 'aria-label': 'Tri', onchange: (e) => { L.sort = e.target.value; render(); } },
    [['end', 'Fin la plus proche'], ['diff', 'Le plus sous la médiane'], ['price', 'Prix à payer le plus bas']]
      .map(([v, t]) => F.el('option', { value: v, text: t, selected: L.sort === v })));
  const dealPct = state.settings.market.dealPct / 100;
  card.append(F.el('h3', { text: `Annonces en cours vues pour ce groupe (${rows.length})` }),
    F.el('p', { class: 'small secondary help', text: 'Les enchères des cartes du groupe reçues en parcourant le Marché (ou par les recherches automatiques) ces 6 dernières heures. Prix à payer : prochaine enchère minimale (enchère + 10 %) ou mise de départ.' }),
    F.el('div', { class: 'filters' }, rar, sort));
  if (!rows.length) card.append(F.el('p', { class: 'muted small', text: 'Aucune annonce vue récemment : lancez une recherche du groupe.' }));
  else {
    card.append(F.table([
      { label: 'Carte', value: (a) => a.card },
      { label: 'Rareté', value: (a) => a.rarity },
      { label: 'Prix à payer', value: (a) => a.next, format: F.w, num: true, title: 'Prochaine enchère minimale, ou mise de départ sans enchère' },
      { label: 'Médiane', value: (a) => a.median, format: F.w, num: true },
      { label: 'Écart', num: true, value: (a) => (a.diff === null ? F.el('span', { class: 'muted', text: '–' })
        : F.el('span', { class: `pill ${a.diff <= -dealPct ? 'good' : a.diff >= dealPct ? 'bad' : 'neutral'}`, text: `${a.diff > 0 ? '+' : ''}${Math.round(a.diff * 100)} %` })) },
      { label: 'Fin dans', value: (a) => leftText(a.end - now), num: true },
      { label: 'Vue', value: (a) => ago(a.seenAt) },
      { label: '', value: (a) => F.el('a', { href: `${SITE}/marketplace/${encodeURIComponent(a.id)}`, target: '_blank', rel: 'noopener', text: 'Ouvrir ↗' }) }
    ], rows.slice(0, 200), { maxHeight: '420px' }));
  }
  return card;
}

function groupCards(g, gm, save) {
  const card = F.el('div', { class: 'card' });
  const idx = knownCardIndex();
  const stats = WMMarket.allStats(state.db, Date.now(), state.settings.market.windowDays, state.settings.market.useEstimates);
  const perCard = {};
  gm.cards.forEach((c) => { perCard[c.key] = c; });
  card.append(F.el('h3', { text: `Cartes (${g.cards.length})` }),
    F.el('p', { class: 'small secondary help', text: 'Une carte est dans un seul groupe, et une carte d\'un groupe est suivie. La retirer du groupe arrête son suivi, sauf si elle est aussi dans vos cartes suivies (Paramètres) ou sélectionnée par un mot-clé.' }));
  if (g.cards.length) {
    card.append(F.table([
      { label: 'Carte', value: (n) => (idx[WMExtract.cardKey(n)] ? idx[WMExtract.cardKey(n)].title : n) },
      { label: 'Rareté', value: (n) => (perCard[WMExtract.cardKey(n)] || {}).rarity || (idx[WMExtract.cardKey(n)] || {}).rarity || '' },
      { label: 'Description (jeu)', value: (n) => (idx[WMExtract.cardKey(n)] || {}).category || '' },
      { label: 'Achats', value: (n) => (perCard[WMExtract.cardKey(n)] || {}).purchases || 0, num: true },
      { label: 'Ventes', value: (n) => (perCard[WMExtract.cardKey(n)] || {}).sold || 0, num: true },
      { label: 'Profit réalisé', value: (n) => (perCard[WMExtract.cardKey(n)] || {}).profit || 0, format: F.signed, num: true, cls: (n, v) => F.signClass(v) },
      { label: 'En stock', value: (n) => (perCard[WMExtract.cardKey(n)] || {}).stock || 0, num: true },
      { label: 'Médiane marché', value: (n) => (stats[WMExtract.cardKey(n)] || {}).median, format: F.w, num: true },
      { label: '', value: (n) => F.el('button', { class: 'link', text: '✕', title: `Retirer « ${n} » du groupe`, 'aria-label': `Retirer ${n} du groupe`,
        onclick: () => save((x) => { x.cards = x.cards.filter((c) => WMExtract.cardKey(c) !== WMExtract.cardKey(n)); }) }) }
    ], g.cards.slice().sort((a, b) => a.localeCompare(b, 'fr')), { maxHeight: '420px' }));
  }
  card.append(cardPicker(g, idx));
  return card;
}

function cardPicker(g, idx) {
  const P = state.picker;
  const det = F.el('details', { class: 'picker', open: !g.cards.length || P.q || P.cat || P.sel.size ? true : null });
  det.append(F.el('summary', { text: '+ Ajouter des cartes' }));
  const owner = WMStats.groupIndex(state.settings);
  const here = {};
  g.cards.forEach((c) => { here[WMExtract.cardKey(c)] = true; });
  const q = WMExtract.cardKey(P.q);
  const cat = WMExtract.cardKey(P.cat);
  const all = Object.keys(idx).map((k) => idx[k]).filter((c) => !here[c.key])
    .filter((c) => !q || c.key.includes(q))
    .filter((c) => !cat || WMExtract.cardKey(c.category).includes(cat))
    .filter((c) => !P.rarity || c.rarity === P.rarity)
    .filter((c) => !P.hideGrouped || !owner[c.key])
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  const shown = all.slice(0, 300);
  const rerender = () => { render(); const d = document.querySelector('.picker'); if (d) d.open = true; };
  const qInput = F.el('input', { type: 'search', value: P.q, placeholder: 'Nom de la carte', 'aria-label': 'Filtrer par nom',
    onchange: (e) => { P.q = e.target.value; rerender(); } });
  const catInput = F.el('input', { type: 'search', value: P.cat, placeholder: 'Description contient… (ex. dinosaure)', 'aria-label': 'Filtrer par description',
    onchange: (e) => { P.cat = e.target.value; rerender(); } });
  const rar = F.el('select', { 'aria-label': 'Rareté', onchange: (e) => { P.rarity = e.target.value; rerender(); } },
    [F.el('option', { value: '', text: 'Toutes les raretés' })].concat(WMSettings.RARITIES.map((r) => F.el('option', { value: r, text: r, selected: P.rarity === r }))));
  const hide = F.el('label', { class: 'check small' }, F.el('input', { type: 'checkbox', checked: P.hideGrouped, onchange: (e) => { P.hideGrouped = e.target.checked; rerender(); } }), ' Masquer les cartes déjà dans un groupe');
  det.append(F.el('p', { class: 'small secondary', text: 'Toutes les cartes que l\'extension a vues (vos transactions et les enchères parcourues). Les filtres aident seulement à trouver les cartes : seules celles que vous cochez sont ajoutées.' }),
    F.el('div', { class: 'filters' }, qInput, catInput, rar, hide));
  const count = F.el('span', { class: 'small secondary' });
  const addBtn = F.el('button', { class: 'primary' });
  const refresh = () => {
    addBtn.textContent = `Ajouter ${P.sel.size} carte${P.sel.size > 1 ? 's' : ''} au groupe`;
    addBtn.disabled = !P.sel.size;
    count.textContent = `${all.length} carte(s)${all.length > shown.length ? ` (${shown.length} affichées : précisez le filtre)` : ''}`;
  };
  const list = F.el('div', { class: 'list' });
  shown.forEach((c) => {
    const other = owner[c.key];
    list.append(F.el('label', null,
      F.el('input', { type: 'checkbox', checked: P.sel.has(c.title), onchange: (e) => { if (e.target.checked) P.sel.add(c.title); else P.sel.delete(c.title); refresh(); } }),
      F.el('span', null, c.title, c.rarity ? F.el('span', { class: 'tag', text: c.rarity }) : null, c.category ? F.el('div', { class: 'meta', text: c.category }) : null),
      other ? chip(other, 'Déjà dans ce groupe : l\'ajouter ici l\'en retire') : F.el('span')));
  });
  if (!shown.length) list.append(F.el('div', { class: 'muted small', style: 'padding:8px', text: 'Aucune carte ne correspond.' }));
  addBtn.addEventListener('click', async () => {
    const names = [...P.sel];
    const keys = new Set(names.map((n) => WMExtract.cardKey(n)));
    await updateSettings((s) => {
      s.groups.forEach((x) => { x.cards = x.cards.filter((c) => !keys.has(WMExtract.cardKey(c))); });
      s.groups.find((x) => x.id === g.id).cards.push(...names);
      s.tracking.excluded = s.tracking.excluded.filter((c) => !keys.has(WMExtract.cardKey(c.name)));
    });
    P.sel.clear();
  });
  const selectAll = F.el('button', { class: 'link', text: 'Tout cocher', onclick: () => { shown.forEach((c) => P.sel.add(c.title)); rerender(); } });
  const byName = F.el('input', { type: 'text', placeholder: 'ou un nom exact (titre Wikipédia)', 'aria-label': 'Nom exact' });
  const addName = F.el('button', { text: 'Ajouter ce nom', onclick: async () => {
    const n = byName.value.trim();
    if (!n) return;
    const k = WMExtract.cardKey(n);
    await updateSettings((s) => {
      s.groups.forEach((x) => { x.cards = x.cards.filter((c) => WMExtract.cardKey(c) !== k); });
      s.groups.find((x) => x.id === g.id).cards.push(n);
      s.tracking.excluded = s.tracking.excluded.filter((c) => WMExtract.cardKey(c.name) !== k);
    });
  } });
  det.append(list, F.el('div', { class: 'buttons' }, addBtn, selectAll, count), F.el('div', { class: 'buttons' }, byName, addName));
  refresh();
  return det;
}

/* ---------------------------------------------------------------- market */

function marketRows() {
  const all = WMMarket.allStats(state.db, Date.now(), state.settings.market.windowDays, state.settings.market.useEstimates);
  const match = WMStats.makeMatcher(state.settings, state.db);
  const inFilter = WMStats.makeMatcher(state.settings, state.db, state.group);
  let rows = Object.keys(all).map((k) => Object.assign({
    tracked: !!match(all[k].card.replace(/ ✦$/, '')),
    inFilter: !!inFilter(all[k].card.replace(/ ✦$/, ''))
  }, all[k]));
  if (state.marketScope === 'tracked') rows = rows.filter((r) => (state.group === null ? r.tracked : r.inFilter));
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
    : `Enchères terminées de vos cartes suivies dont le prix final n'a pas été vu. Ouvrez-les sur le site pour l'enregistrer, ou activez le relevé automatique dans l'onglet Fonctionnalités. ${pending.upcoming} enchère(s) suivie(s) encore en cours.` }));
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

function follow(card, on, group) {
  return browser.runtime.sendMessage({ type: 'follow', card: card.replace(/ ✦$/, ''), follow: on, group });
}

/**
 * Follow / group control for a card: a button without groups, otherwise a
 * menu "Non suivie / Suivie sans groupe / <groups>".
 */
function followControl(card, tracked) {
  const groups = state.settings.groups;
  if (!groups.length) {
    return F.el('button', { class: 'link', text: tracked ? 'Ne plus suivre' : '+ Suivre',
      onclick: (e) => { e.stopPropagation(); follow(card, !tracked); } });
  }
  const g = groupOfCard(card);
  const value = !tracked ? '__off' : g ? g.id : '__none';
  const sel = F.el('select', { class: 'small', 'aria-label': `Groupe de ${card}`, onclick: (e) => e.stopPropagation(),
    onchange: (e) => {
      const v = e.target.value;
      if (v === '__off') follow(card, false);
      else follow(card, true, v === '__none' ? '' : v);
    } },
  F.el('option', { value: '__off', text: 'Non suivie', selected: value === '__off' }),
  F.el('option', { value: '__none', text: 'Suivie, sans groupe', selected: value === '__none' }),
  groups.map((x) => F.el('option', { value: x.id, text: x.name, selected: value === x.id })));
  return sel;
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
    { label: 'Groupe', value: (r) => (r.tracked ? groupCell(groupOfCard(r.card) && groupOfCard(r.card).id) : F.el('span', { class: 'muted', text: '–' })) },
    { label: 'Médiane', value: (r) => r.median, format: F.w, num: true },
    { label: 'Ventes', title: 'Ventes observées sur la période : total (dont les vôtres · dont estimées ≈)', value: (r) => salesCount(r), num: true },
    { label: 'P25 – P75', value: (r) => (r.p25 === null ? '–' : `${F.w(r.p25)} – ${F.w(r.p75)}`), num: true },
    { label: 'Min / Max', value: (r) => (r.min === null ? '–' : `${F.w(r.min)} / ${F.w(r.max)}`), num: true },
    { label: 'Tendance 7 j', value: (r) => trend(r.trend7), num: true, cls: (r) => F.signClass(r.trend7) },
    { label: 'Tendance 30 j', value: (r) => trend(r.trend30), num: true, cls: (r) => F.signClass(r.trend30) },
    { label: 'Moins chère à enchérir', title: 'Parmi les annonces vues récemment : prochaine enchère minimale (enchère actuelle + 10 %), ou mise de départ', value: (r) => r.lowestAsk, format: F.w, num: true },
    { label: 'Annonces', value: (r) => r.asks, num: true },
    { label: 'Achat max conseillé', title: `Médiane ÷ (1 + marge visée de ${state.settings.valuation.targetMarginPct} %)`, value: (r) => maxBuy(r.median), format: F.w, num: true },
    { label: '', value: (r) => followControl(r.card, r.tracked) }
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
        chip(tracked ? groupOfCard(s.card) : null),
        state.settings.groups.length ? followControl(s.card, tracked)
          : F.el('button', { text: tracked ? 'Ne plus suivre' : '+ Suivre', onclick: () => follow(s.card, !tracked) }),
        F.el('a', { class: 'button', href: '#market', text: '✕', title: 'Fermer', 'aria-label': 'Fermer' }))),
    F.el('div', { class: 'tiles' },
      F.tile('Médiane des ventes', F.wUnit(s.median), `${s.n} vente(s) sur ${state.settings.market.windowDays} j${s.nOwn ? `, dont ${s.nOwn} à vous` : ''}${s.nEst ? `, dont ${s.nEst} estimée(s) ≈` : ''}`),
      F.tile('Achat max conseillé', F.wUnit(maxBuy(s.median)), `Marge visée ${state.settings.valuation.targetMarginPct} %`),
      F.tile('P25 – P75', s.p25 === null ? '–' : `${F.w(s.p25)} – ${F.w(s.p75)}`, 'La moitié des ventes est dans cette fourchette'),
      F.tile('Min / Max', s.min === null ? '–' : `${F.w(s.min)} / ${F.w(s.max)}`),
      F.tile('Tendance 7 j', trend(s.trend7), 'Médiane 7 j vs 8–30 j', F.signClass(s.trend7)),
      F.tile('Tendance 30 j', trend(s.trend30), 'Médiane 30 j vs 31–90 j', F.signClass(s.trend30)),
      F.tile('Moins chère à enchérir', F.wUnit(s.lowestAsk), `Prochaine enchère min. ou mise de départ · ${s.asks} annonce(s) vue(s)`)),
    F.el('figure', { class: 'chart' },
      F.el('figcaption', null, F.el('h3', { text: 'Ventes observées, vos achats et médiane journalière' }),
        F.el('span', { class: 'small muted', text: `${state.settings.market.windowDays} derniers jours (W)` })),
      F.el('div', { class: 'chart-box' }, F.el('canvas', { id: 'c-market' }), F.el('div', { class: 'chart-empty muted', hidden: true, text: 'Aucune vente observée sur la période.' }))));

  // Your purchases of this card (shiny copies apart, like the market key), within the period.
  const from = Date.now() - state.settings.market.windowDays * 86400e3;
  const buys = state.model.purchases.filter((r) => !r.excluded && r.time >= from &&
    WMMarket.marketKey(r.card, r.shiny) === s.key).map((r) => ({ x: r.time, y: r.price }));

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
        { label: 'Vos achats', data: buys, slot: 4, pointStyle: 'rect' },
        { label: 'Médiane journalière', data: daily.map((d) => ({ x: d.t, y: d.median })), slot: 2, line: true }
      ].filter((d) => d.line || d.data.length) // no legend entry for an empty series
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
  const grouped = state.group !== null;
  const tiles = $('kpis');
  tiles.textContent = '';
  const stockTile = F.tile('Valeur estimée du stock', F.wUnit(k.stockValue), `${k.stockQty} carte(s) · coût ${F.wUnit(k.stockCost)} · détail ›`);
  stockTile.classList.add('clickable');
  stockTile.title = 'Voir le calcul carte par carte (onglet Stock)';
  stockTile.addEventListener('click', () => { location.hash = '#stock'; });
  tiles.append(...[
    F.tile("Profit réalisé aujourd'hui", F.signedUnit(k.realizedToday), `7 j : ${F.signedUnit(k.realized7)} · 30 j : ${F.signedUnit(k.realized30)}`, F.signClass(k.realizedToday)),
    F.tile('Profit réalisé total', F.signedUnit(k.realizedTotal),
      `${k.sold} vente(s) · marge ${F.pct(k.margin)}${k.boosterSales ? ` · dont ${k.boosterSales} de booster (${F.signedUnit(k.boosterProfit)})` : ''}`, F.signClass(k.realizedTotal)),
    F.tile("Trading estimé aujourd'hui", F.signedUnit(k.tradingToday), 'Réalisé + variation du latent', F.signClass(k.tradingToday)),
    F.tile('Trading estimé moyen', `${F.signedUnit(k.tradingPerDay7)}/j`, `Sur 7 jours : ${F.signedUnit(k.trading7)}`, F.signClass(k.tradingPerDay7)),
    stockTile,
    F.tile('Plus-value latente', F.signedUnit(k.unrealized), 'Valeur estimée − coût FIFO', F.signClass(k.unrealized)),
    grouped ? null : F.tile('Solde wikibidous', F.wUnit(k.balance), k.balanceAt ? `Relevé le ${WMTime.formatDateTime(k.balanceAt)}` : 'Relevé à la prochaine mise à jour'),
    grouped ? null : F.tile('Patrimoine estimé', F.wUnit(k.netWorth), 'Solde + valeur du stock')
  ].filter(Boolean));
  $('c-networth').closest('figure').hidden = grouped; // the balance is not per group

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
    { label: 'Groupe', value: (c) => groupCell(c.group) },
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
  // Each card keeps its colour; past 8 followed cards, a card whose colour is taken
  // on this chart gets a free one (never two series with the same colour).
  const used = new Set();
  shown.forEach((c) => {
    let slot = slots[c.key] % 8;
    if (used.has(slot)) slot = [0, 1, 2, 3, 4, 5, 6, 7].find((x) => !used.has(x));
    used.add(slot);
    slots[c.key] = slot;
  });
  const dayTick = (v) => WMTime.formatDay(WMTime.dayKey(v)).slice(0, 5);
  C.render('c-inflation', {
    type: 'scatter', unit: 'W', xType: 'linear',
    xTicks: { callback: dayTick, maxTicksLimit: 8 },
    tooltipTitle: (items) => (items.length ? WMTime.formatDay(WMTime.dayKey(items[0].parsed.x)) : ''),
    // One line per card: average purchase price of each day (noon), days without purchase skipped.
    datasets: shown.map((c, i) => ({
      label: c.card,
      data: m.inflation.rows.filter((r) => r[idx[i]] !== null).map((r) => ({ x: r[0] + 12 * 3600e3, y: Math.round(r[idx[i]]) })),
      slot: slots[c.key], line: true, points: true
    }))
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

const METHOD_LABEL = {
  recent: 'Ventes récentes',
  asks: 'Annonce la moins chère',
  old: 'Ventes anciennes',
  cost: "Coût d'achat"
};
const KIND_LABEL = { own: 'votre vente', market: 'vente observée', est: 'estimation ≈ (dernière enchère vue)' };

function renderStock() {
  const m = state.model;
  // Share of the stock value per estimation method: how solid the total is.
  const methods = $('stock-methods');
  methods.textContent = '';
  const total = m.kpis.stockValue;
  if (m.inventory.length) {
    ['recent', 'asks', 'old', 'cost'].forEach((key) => {
      const items = m.inventory.filter((i) => i.valuation && i.valuation.method === key);
      if (!items.length) return;
      const v = items.reduce((x, i) => x + i.value, 0);
      methods.append(F.tile(METHOD_LABEL[key], F.wUnit(v), `${items.length} carte(s) · ${total ? Math.round(100 * v / total) : 0} % de la valeur`));
    });
  }
  const sel = state.stockKey ? m.inventory.find((i) => i.key === state.stockKey) : null;
  const detailBox = $('stock-detail');
  detailBox.textContent = '';
  if (sel) detailBox.append(stockDetail(sel));

  const box = $('stock-table');
  box.textContent = '';
  if (!m.inventory.length) box.append(F.el('p', { class: 'muted', text: 'Aucune carte suivie en stock.' }));
  else {
    box.append(F.table([
      { label: 'Carte', value: (i) => i.card },
      { label: 'Groupe', value: (i) => groupCell(i.group) },
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
    ], m.inventory, {
      rowClass: (i) => `clickable${i.key === state.stockKey ? ' selected' : ''}`,
      onRowClick: (i) => { state.stockKey = state.stockKey === i.key ? null : i.key; render(); if (state.stockKey) window.scrollTo({ top: 0 }); }
    }));
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

/** How the value of one stock line was computed. */
function stockDetail(i) {
  const v = state.settings.valuation;
  const d = i.valuation || { method: 'cost', base: i.avgCost, samples: [] };
  const fee = v.commissionPct;
  const cut = v.haircutPct;
  const card = F.el('div', { class: 'card stock-detail' });
  card.append(F.el('div', { class: 'head' },
    F.el('h2', null, i.card, i.rarity ? F.el('span', { class: 'tag', text: i.rarity }) : null, ' ', chip(groupById(i.group))),
    F.el('button', { text: '✕', title: 'Fermer', 'aria-label': 'Fermer', onclick: () => { state.stockKey = null; render(); } })));
  card.append(F.el('p', { class: 'small secondary', text: `${i.qty} exemplaire(s) en stock, coût FIFO ${F.wUnit(i.cost)} (moyenne ${F.wUnit(i.avgCost)}). Méthode : ${METHOD_LABEL[d.method]}.` }));
  const why = {
    recent: `Médiane des ${d.samples.length} dernière(s) vente(s) des ${v.windowDays} derniers jours (au plus ${v.sampleSize}) : la vôtre et celles vues sur le marché${state.settings.market.useEstimates ? ', estimations ≈ comprises' : ''}.`,
    asks: `Aucune vente sur les ${v.windowDays} derniers jours : annonce la moins chère vue ces 2 derniers jours (prochaine enchère minimale = enchère actuelle + 10 %, ou mise de départ sans enchère).`,
    old: `Aucune vente récente ni annonce : médiane des ${d.samples.length} dernière(s) vente(s) connue(s), plus anciennes que ${v.windowDays} jours.`,
    cost: "Aucune vente ni annonce connue pour cette carte : valeur = coût d'achat moyen (ni commission ni décote)."
  }[d.method];
  card.append(F.el('p', { text: why }));
  if (d.samples && d.samples.length) {
    card.append(F.table([
      { label: 'Date', value: (x) => WMTime.formatDateTime(x.t), cls: () => 'nowrap' },
      { label: 'Prix', value: (x) => x.price, format: F.w, num: true },
      { label: 'Source', value: (x) => KIND_LABEL[x.kind] || '' }
    ], d.samples.slice().reverse()));
  }
  if (d.method === 'asks' && d.ask) {
    card.append(F.el('p', { class: 'small' }, `Annonce : ${d.ask.hasBid ? 'prochaine enchère minimale' : 'mise de départ'} ${F.wUnit(d.ask.price)}, vue ${ago(d.ask.seenAt)}${d.ask.end ? `, fin le ${WMTime.formatDateTime(d.ask.end)}` : ''}. `,
      F.el('a', { href: `${SITE}/marketplace/${encodeURIComponent(d.ask.id)}`, target: '_blank', rel: 'noopener', text: 'Ouvrir ↗' })));
  }
  const baseLabel = { recent: 'médiane', asks: 'annonce', old: 'médiane', cost: 'coût moyen' }[d.method];
  const adjust = d.method === 'cost' ? '' : `${fee ? ` × (1 − ${fee} % de commission)` : ''}${cut ? ` × (1 − ${cut} % de décote)` : ''}`;
  const formula = `${F.wUnit(d.base)} (${baseLabel})${adjust ? `${adjust} = ${F.wUnit(i.unitValue)} par carte` : ''} × ${i.qty} exemplaire${i.qty > 1 ? 's' : ''} = ${F.wUnit(i.value)}`;
  card.append(F.el('div', { class: 'formula', text: formula }));
  card.append(F.el('p', { class: 'small muted', text: `Plus-value latente : ${F.signedUnit(i.unrealized)} (valeur estimée − coût FIFO). Réglages : Paramètres → Valorisation du stock.` }));
  return card;
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
  const booster = (r) => F.el('input', {
    type: 'checkbox', checked: r.booster, 'aria-label': `${r.label} : carte de booster`,
    title: 'Carte ouverte dans un booster : pas d\'achat correspondant, coût = coût d\'une carte de booster (Paramètres)',
    onchange: async (e) => {
      e.target.disabled = true;
      await browser.runtime.sendMessage({ type: 'setBooster', id: r.id, booster: e.target.checked });
    }
  });
  const common = [
    { label: 'ID', value: (r) => r.label },
    { label: 'Date', value: (r) => WMTime.formatDateTime(r.time), cls: () => 'nowrap' },
    { label: 'Carte', value: (r) => r.card },
    { label: 'Groupe', value: (r) => groupCell(r.group) },
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
      { label: 'Contrôle', value: (r) => r.check, cls: (r) => (r.check === 'Sans achat correspondant' ? 'neg' : '') },
      { label: 'Booster', value: booster },
      { label: 'Exclure', value: exclude }
    ]);
  const box = $('tx-table');
  box.textContent = '';
  box.append(F.el('div', { class: 'small muted', text: `${total} ligne(s)${total > 1000 ? ' (1 000 premières affichées)' : ''}. En gris : non suivies.` }));
  box.append(F.table(cols, rows, { rowClass: (r) => (r.tracked ? null : 'dim') }));
}

route();
load();
