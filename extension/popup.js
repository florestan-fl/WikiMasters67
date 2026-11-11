/* global browser, WMStore, WMMarket, WMStats, WMSettings, WMTime, WMFormat, WMSearches, WMExtract */
'use strict';

const ORIGINS = [
  'https://www.wiki-masters.com/*',
  'https://wiki-masters.com/*',
  'https://script.google.com/*',
  'https://script.googleusercontent.com/*'
];
const SITE_MATCH = ['https://www.wiki-masters.com/*', 'https://wiki-masters.com/*'];

const F = WMFormat;
const $ = (id) => document.getElementById(id);

function ago(t) {
  if (!t) return 'jamais';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}`;
  const d = Math.floor(h / 24);
  return `il y a ${d} jour${d > 1 ? 's' : ''}`;
}

function go(msg) {
  return async () => {
    await browser.runtime.sendMessage(msg);
    window.close();
  };
}

async function init() {
  $('open-settings').addEventListener('click', go({ type: 'openDashboard', hash: '#settings' }));
  $('dashboard').addEventListener('click', go({ type: 'openDashboard', hash: '#overview' }));
  $('market').addEventListener('click', go({ type: 'openDashboard', hash: '#market' }));
  $('marketplace').addEventListener('click', go({ type: 'openMarketplace' }));
  $('grant').addEventListener('click', grant);
  $('export').addEventListener('click', async () => {
    $('export').disabled = true;
    await browser.runtime.sendMessage({ type: 'export' });
    $('export').disabled = false;
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.db || changes.settings || changes.exportState || changes.lastExport)) render();
  });
  browser.runtime.sendMessage({ type: 'popupOpened' }).catch(() => {});
  await checkPermissions();
  await render();
}

async function checkPermissions() {
  const ok = await browser.permissions.contains({ origins: ORIGINS });
  $('permission').hidden = ok;
  return ok;
}

async function grant() {
  try {
    await browser.permissions.request({ origins: ORIGINS });
  } finally {
    await checkPermissions();
  }
}

function item(state, title, detail) {
  return F.el('li', null,
    F.el('span', { class: `dot ${state}`, 'aria-hidden': 'true' }),
    F.el('div', null, F.el('div', { class: 'title', text: title }), detail ? F.el('div', { class: 'detail', text: detail }) : null));
}

async function render() {
  const data = await browser.storage.local.get(['db', 'settings', 'exportState', 'lastExport', 'resolver']);
  const db = WMStore.normalizeDb(data.db || WMStore.emptyDb());
  const settings = WMSettings.normalize(data.settings);
  const meta = db.meta;
  let siteTabs = [];
  try { siteTabs = await browser.tabs.query({ url: SITE_MATCH }); } catch (e) { /* no permission */ }

  const status = $('status');
  status.textContent = '';

  // 1. Capture.
  const open = siteTabs.length > 0;
  const ownAge = meta.lastOwnCapture ? Date.now() - meta.lastOwnCapture : Infinity;
  const stale = ownAge > 2 * 86400000;
  status.append(item(
    meta.captureError ? 'err' : stale ? 'warn' : 'ok',
    meta.lastOwnCapture ? `Vos transactions : relevées ${ago(meta.lastOwnCapture)}` : 'Vos transactions : pas encore relevées',
    meta.captureError ? `Erreur de lecture : ${meta.captureError.text}`
      : stale ? 'Ouvrez le Marché de WikiMasters (au moins tous les 2 jours) pour ne rien manquer.'
        : `${Object.keys(db.purchases).length} achats et ${Object.keys(db.sales).length} mises en vente enregistrés.`
  ));

  // 2. Market data.
  const auctions = Object.keys(db.auctions || {}).length;
  status.append(item(
    meta.lastCapture ? 'ok' : '',
    meta.lastCapture ? `Prix du marché : dernières données ${ago(meta.lastCapture)}` : 'Prix du marché : pas encore de données',
    `${auctions} enchère(s) en mémoire${open ? ` · ${siteTabs.length} onglet(s) WikiMasters ouvert(s)` : ' · aucun onglet WikiMasters ouvert'}`
  ));

  // 2b. Final prices of ended auctions.
  const match = WMStats.makeMatcher(settings, db);
  const pending = WMMarket.pendingChecks(db, Date.now(), (c) => !!match(c));
  if (settings.market.autoResolve) {
    const r = data.resolver && data.resolver.day === WMTime.dayKey(Date.now()) ? data.resolver : { count: 0, resolved: 0 };
    let perm = true;
    try { perm = await browser.permissions.contains({ permissions: ['scripting'] }); } catch (e) { perm = false; }
    const capped = r.count >= settings.market.resolveMaxPerDay;
    status.append(item(
      !perm ? 'err' : !open || capped ? 'warn' : 'ok',
      !perm ? 'Relevé automatique : permission manquante' : !open ? 'Relevé automatique : en pause' : capped ? 'Relevé automatique : maximum du jour atteint' : 'Relevé automatique : actif',
      `${pending.ended.length} prix final à relever · aujourd'hui ${r.count}/${settings.market.resolveMaxPerDay} requêtes, ${r.resolved || 0} relevé(s)${!open ? ' · ouvrez un onglet du jeu' : ''}`
    ));
  } else if (pending.ended.length) {
    status.append(item('', `${pending.ended.length} enchère(s) terminée(s) à vérifier`,
      'Prix final pas encore vu : liste dans l\'onglet Marché, ou activez le relevé automatique dans Fonctionnalités.'));
  }

  // 3. Balance.
  const snap = db.snapshots[db.snapshots.length - 1];
  status.append(item(snap ? 'ok' : '', snap ? `Solde : ${F.wUnit(snap.balance)}` : 'Solde : pas encore lu',
    snap ? `Lu ${ago(snap.t)} sur la page du jeu` : 'Il est lu sur n\'importe quelle page du jeu.'));

  // 4. Google Sheets.
  const ex = data.exportState;
  if (WMSettings.sheetsConfigured(settings)) {
    $('export').hidden = false;
    $('export').disabled = !!(ex && ex.running);
    if (ex && ex.running) status.append(item('warn', 'Google Sheets : export en cours', ex.label));
    else if (ex && ex.ok === false) status.append(item('err', 'Google Sheets : échec du dernier export', ex.label));
    else status.append(item(data.lastExport ? 'ok' : '', data.lastExport ? `Google Sheets : à jour ${ago(data.lastExport.at)}` : 'Google Sheets : jamais exporté',
      settings.sheets.autoExport ? 'Export automatique après chaque nouvelle transaction.' : 'Export manuel.'));
  } else {
    $('export').hidden = true;
  }

  $('how').textContent = settings.market.autoResolve
    ? "Vos données arrivent quand vous ouvrez le Marché. Relevé automatique activé : l'extension envoie aussi au jeu une requête par enchère terminée de vos cartes suivies."
    : "Les données arrivent quand vous ouvrez le Marché de WikiMasters : l'extension lit les réponses que votre navigateur reçoit, sans rien envoyer au jeu.";

  // Notices.
  const notices = $('notices');
  notices.textContent = '';
  if (meta.warning && Date.now() - meta.warning.t < 3 * 86400000) notices.append(F.el('div', { class: 'notice warn', text: meta.warning.text }));
  if (!settings.tracking.cards.length && !settings.tracking.categories.length && !settings.groups.some((g) => g.cards.length)) {
    notices.append(F.el('div', { class: 'notice warn', text: "Aucune carte suivie : créez un groupe (Tableau de bord → Groupes) ou choisissez vos cartes dans les paramètres, ou cliquez « + Suivre » sous une enchère sur le site." }));
  }

  // Groups not searched for a while, and the last search to save.
  renderGroupsDue(db, settings);
  renderLastSearch(db, settings);

  // Deals in progress (passive: auctions seen while browsing).
  renderDeals(db, settings);

  // Recent additions.
  const recent = (meta.recent || []).slice(-6).reverse();
  const box = $('recent');
  box.textContent = '';
  if (recent.length) {
    box.append(F.el('div', { class: 'small secondary', text: 'Dernières transactions enregistrées' }),
      F.table([
        { label: 'Date', value: (r) => WMTime.formatDateTime(r.time), cls: () => 'nowrap' },
        { label: 'Type', value: (r) => (r.status ? (r.status === 'Vendue' ? 'Vente' : 'Invendu') : 'Achat') },
        { label: 'Carte', value: (r) => r.card },
        { label: 'Prix', value: (r) => r.price, format: F.w, num: true }
      ], recent, { maxHeight: '170px' }));
  }
}

function groupDot(g) {
  return F.el('span', { class: 'g-dot', style: `--g:${g.color}`, title: g.name, 'aria-hidden': 'true' });
}

function renderGroupsDue(db, settings) {
  const box = $('groups-due');
  box.textContent = '';
  const due = settings.groups.map((g) => ({ g, act: WMSearches.activity(db, g, Date.now(), WMExtract.cardKey) })).filter((x) => x.act.overdue);
  if (!due.length) return;
  box.append(F.el('div', { class: 'head' }, F.el('span', { text: 'Groupes à regarder' }), F.el('span', { class: 'small secondary', text: 'pas de recherche récente' })));
  box.append(F.el('ul', null, due.map(({ g, act }) => F.el('li', null,
    F.el('div', { class: 'line' }, groupDot(g), F.el('b', { text: g.name }),
      F.el('span', { class: 'small secondary', text: act.last ? `dernière recherche ${ago(act.last)}` : 'jamais recherché' })),
    F.el('div', { class: 'shortcuts' }, g.searches.slice(0, 4).map((x) => F.el('button', {
      class: 'small', title: WMSearches.describe(x.query), text: `↗ ${x.label || WMSearches.describe(x.query)}`,
      onclick: go({ type: 'openSearch', pageUrl: x.pageUrl })
    })))))));
}

/** The last search made on the Marché, if not saved in a group yet: one click to save it. */
function renderLastSearch(db, settings) {
  const box = $('last-search');
  box.textContent = '';
  const log = db.meta.searchLog || [];
  const last = log[log.length - 1];
  if (!settings.groups.length || !last || Date.now() - last.at > 6 * 3600e3) return;
  if (settings.groups.some((g) => g.searches.some((x) => x.query === last.query))) return;
  // Suggest the group that holds most of the cards found.
  const groupOf = WMStats.groupOf(settings);
  const votes = {};
  (last.cards || []).forEach((c) => { const g = groupOf(c); if (g) votes[g.id] = (votes[g.id] || 0) + 1; });
  const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || settings.groups[0].id;
  const sel = F.el('select', { 'aria-label': 'Groupe' }, settings.groups.map((g) => F.el('option', { value: g.id, text: g.name, selected: g.id === best })));
  const btn = F.el('button', { class: 'small', text: 'Enregistrer', onclick: async () => {
    btn.disabled = true;
    await browser.runtime.sendMessage({ type: 'saveSearch', group: sel.value, search: last });
  } });
  box.append(F.el('div', { class: 'small secondary', text: `Dernière recherche sur le Marché (${ago(last.at)}, ${last.results} annonce(s)) :` }),
    F.el('div', { class: 'params', text: WMSearches.describe(last.query) }),
    F.el('div', { class: 'save' }, F.el('span', { class: 'small', text: 'Ajouter à' }), sel, btn));
}

let dealTimer = null;

function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function renderDeals(db, settings) {
  const box = $('deals');
  box.textContent = '';
  clearInterval(dealTimer);
  if (!settings.features.deals) return;
  const match = WMStats.makeMatcher(settings, db);
  const list = WMMarket.deals(db, Date.now(), {
    pct: settings.features.alertPct, minSales: settings.features.alertMinSales, windowDays: settings.market.windowDays,
    useEstimates: settings.market.useEstimates, isEligible: settings.features.alertScope === 'all' ? null : (c) => !!match(c)
  });
  box.append(F.el('div', { class: 'head' }, F.el('span', { text: 'Bonnes affaires en cours' }), F.el('span', { text: String(list.length) })));
  if (!list.length) {
    box.append(F.el('div', { class: 'small muted', text: `Aucune enchère vue récemment à ${settings.features.alertPct} % ou plus sous la médiane. Parcourez le Marché pour en trouver.` }));
    return;
  }
  const timers = [];
  const groupOf = WMStats.groupOf(settings);
  box.append(F.el('ul', null, list.slice(0, 30).map((d) => {
    const g = groupOf(d.card);
    const left = F.el('span', { class: 'left', text: countdown(d.end - Date.now()) });
    timers.push([left, d.end]);
    return F.el('li', null, F.el('a', {
      href: `https://www.wiki-masters.com/marketplace/${encodeURIComponent(d.id)}`, target: '_blank', rel: 'noopener',
      title: 'Ouvrir l\'enchère'
    },
    F.el('span', null,
      F.el('div', { class: 'card-name' }, g ? groupDot(g) : null, `${d.card}${d.rarity ? ` · ${d.rarity}` : ''}`),
      F.el('div', { class: 'sub', text: `${d.hasBid ? 'Prochaine mise' : 'Mise de départ'} ${F.w(d.next)} · méd. ${F.w(d.median)} · vu ${ago(d.seenAt)}` })),
    F.el('span', { class: 'pill', text: `${Math.round(d.diff * 100)} %` }),
    left));
  })));
  dealTimer = setInterval(() => timers.forEach(([el, end]) => { el.textContent = countdown(end - Date.now()); }), 1000);
}

init();
