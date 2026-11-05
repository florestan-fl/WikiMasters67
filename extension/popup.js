/* global browser, WMStore, WMStats, WMSettings, WMTime, WMFormat */
'use strict';

const ORIGINS = [
  'https://www.wiki-masters.com/*',
  'https://wiki-masters.com/*',
  'https://script.google.com/*',
  'https://script.googleusercontent.com/*'
];

const F = WMFormat;
const $ = (id) => document.getElementById(id);

async function init() {
  $('open-options').addEventListener('click', openOptions);
  $('open-options-2').addEventListener('click', openOptions);
  $('grant').addEventListener('click', grant);
  $('sync').addEventListener('click', sync);
  $('dashboard').addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('dashboard.html') });
    window.close();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.syncState) renderState(changes.syncState.newValue);
    if (changes.lastResult) renderResult(changes.lastResult.newValue);
    if (changes.db || changes.settings || changes.lastSync || changes.lastExport) refresh();
  });

  const { syncState, lastResult } = await browser.storage.local.get(['syncState', 'lastResult']);
  await checkPermissions();
  renderState(syncState);
  renderResult(lastResult);
  await refresh();
}

function openOptions(e) {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
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

async function sync() {
  if (!(await checkPermissions())) return;
  renderState({ running: true });
  try {
    await browser.runtime.sendMessage({ type: 'sync' });
  } catch (e) {
    renderResult({ ok: false, error: String((e && e.message) || e) });
    renderState({ running: false });
  }
}

async function refresh() {
  const { db, settings, lastSync, lastExport } = await browser.storage.local.get(['db', 'settings', 'lastSync', 'lastExport']);
  const s = WMSettings.normalize(settings);
  $('no-cards').hidden = !!(s.tracking.cards.length || s.tracking.categories.length);
  const m = WMStats.compute(WMStore.normalizeDb(db || WMStore.emptyDb()), s, Date.now());
  const k = m.kpis;
  const tiles = $('tiles');
  tiles.textContent = '';
  tiles.append(
    F.tile("Profit réalisé aujourd'hui", F.signedUnit(k.realizedToday), `7 jours : ${F.signedUnit(k.realized7)}`, F.signClass(k.realizedToday)),
    F.tile("Trading estimé aujourd'hui", F.signedUnit(k.tradingToday), `Moyenne 7 j : ${F.signedUnit(k.tradingPerDay7)}/jour`, F.signClass(k.tradingToday)),
    F.tile('Valeur du stock', F.wUnit(k.stockValue), `${k.stockQty} carte(s) · latent ${F.signedUnit(k.unrealized)}`),
    F.tile('Patrimoine estimé', F.wUnit(k.netWorth), k.balance === null ? 'Solde pas encore relevé' : `Solde ${F.wUnit(k.balance)} + stock`)
  );
  const parts = [lastSync && lastSync.at ? `Dernière mise à jour : ${WMTime.formatDateTime(lastSync.at)}` : 'Jamais mis à jour.'];
  if (WMSettings.sheetsConfigured(s)) {
    parts.push(lastExport && lastExport.at ? `Export Sheets : ${WMTime.formatDateTime(lastExport.at)}` : 'Export Sheets : jamais');
  }
  $('footer').textContent = parts.join(' · ');
}

function renderState(state) {
  const busy = !!(state && state.running);
  $('sync').disabled = busy;
  $('status').textContent = busy ? 'Mise à jour en cours…' : '';
}

function renderResult(r) {
  const box = $('result');
  box.textContent = '';
  if (!r) return;
  if (!r.ok) {
    box.append(F.el('div', { class: 'notice err', text: r.error || 'Erreur inconnue.' }));
    return;
  }
  const np = r.added.purchases.length;
  const ns = r.added.sales.length;
  const head = np + ns
    ? `${np} achat(s) et ${ns} vente(s) ajoutés.`
    : 'Rien de nouveau depuis la dernière mise à jour.';
  const exp = r.exported === true ? ' Feuille Google mise à jour.' : '';
  box.append(F.el('div', { class: 'small secondary', text: `${WMTime.formatDateTime(r.finishedAt)} · ${head}${exp}` }));
  for (const w of r.warnings || []) box.append(F.el('div', { class: 'notice warn', text: w }));

  const rows = r.added.purchases.map((x) => Object.assign({ kind: 'Achat' }, x))
    .concat(r.added.sales.map((x) => Object.assign({ kind: x.status === 'Vendue' ? 'Vente' : 'Invendu' }, x)))
    .sort((a, b) => b.time - a.time);
  if (rows.length) {
    box.append(F.el('div', { class: 'added' },
      F.table([
        { label: 'Date', value: (x) => WMTime.formatDateTime(x.time), cls: () => 'nowrap' },
        { label: 'Type', value: (x) => x.kind },
        { label: 'Carte', value: (x) => x.card },
        { label: 'Prix', value: (x) => x.price, format: F.w, num: true },
        { label: 'Profit', value: (x) => x.profit, format: (v) => (v === null || v === undefined ? '' : F.signed(v)), num: true, cls: (x, v) => F.signClass(v) }
      ], rows, { maxHeight: '200px', rowClass: (x) => (x.tracked ? null : 'dim') }),
      F.el('div', { class: 'small muted', text: 'En gris : cartes non suivies.' })));
  }
}

init();
