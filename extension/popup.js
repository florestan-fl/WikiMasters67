/* global browser, WMStore, WMSettings, WMTime, WMFormat */
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
  const data = await browser.storage.local.get(['db', 'settings', 'exportState', 'lastExport']);
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

  // Notices.
  const notices = $('notices');
  notices.textContent = '';
  if (meta.warning && Date.now() - meta.warning.t < 3 * 86400000) notices.append(F.el('div', { class: 'notice warn', text: meta.warning.text }));
  if (!settings.tracking.cards.length && !settings.tracking.categories.length) {
    notices.append(F.el('div', { class: 'notice warn', text: "Aucune carte suivie : choisissez vos cartes dans les paramètres, ou cliquez « + Suivre » sous une enchère sur le site." }));
  }

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

init();
