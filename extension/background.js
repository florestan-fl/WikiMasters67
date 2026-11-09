/* global browser, WMExtract, WMStore, WMMarket, WMStats, WMTables, WMSettings, WMTime */
'use strict';

/*
 * Passive capture: the extension never sends a request to wiki-masters.com.
 * When YOUR marketplace page loads its data (/api/marketplace…), Firefox hands
 * the extension a copy of the response while it is passed to the page
 * unchanged (webRequest.filterResponseData). The balance is read from the page
 * by the content script. Everything else happens locally.
 */

const API_URLS = ['https://www.wiki-masters.com/api/marketplace*', 'https://wiki-masters.com/api/marketplace*'];
const SITE_MATCH = ['https://www.wiki-masters.com/*', 'https://wiki-masters.com/*'];
const MARKET_PAGE = 'https://www.wiki-masters.com/marketplace';
const FULL_LIST = 50;
const MAX_BODY = 8 * 1024 * 1024;
const AUTO_EXPORT_DELAY_MS = 90 * 1000;

let dbQueue = Promise.resolve();
let exporting = false;
let exportTimer = null;

/* ------------------------------------------------------------------------ */
/* Capture                                                                  */
/* ------------------------------------------------------------------------ */

browser.webRequest.onBeforeRequest.addListener(onApiRequest, { urls: API_URLS, types: ['xmlhttprequest'] }, ['blocking']);

function onApiRequest(details) {
  if (details.method !== 'GET') return {};
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(details.requestId);
  } catch (e) {
    setCaptureError(`Lecture impossible : ${(e && e.message) || e}`);
    return {};
  }
  const chunks = [];
  let size = 0;
  filter.ondata = (event) => {
    filter.write(event.data); // the page receives the response untouched
    size += event.data.byteLength;
    if (size <= MAX_BODY) chunks.push(event.data);
  };
  filter.onstop = () => {
    filter.close();
    if (size <= MAX_BODY) handleBody(details.url, chunks).catch((e) => setCaptureError(String((e && e.message) || e)));
  };
  filter.onerror = () => {
    try { filter.disconnect(); } catch (e) { /* already gone */ }
  };
  return {};
}

async function handleBody(url, chunks) {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { bytes.set(new Uint8Array(c), offset); offset += c.byteLength; }
  let json;
  try {
    json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch (e) {
    return; // not JSON (error page…): ignore
  }
  await ingest(url, json, Date.now());
}

/** Exposed for tests: processes one API answer. */
async function ingest(url, json, now) {
  const settings = await getSettings();
  const result = await withDb((db) => {
    const match = WMStats.makeMatcher(settings, db);
    const out = { added: { purchases: [], sales: [] }, auctions: 0, marketSales: 0, own: false, warning: null };
    if (json && Array.isArray(json.history) && Array.isArray(json.won)) {
      const ex = WMExtract.extract(json);
      if (ex.me) db.meta.me = ex.me;
      const before = WMStore.newestTimes(db);
      out.added = WMStore.mergeSync(db, ex, now);
      out.own = true;
      out.warning = gapWarning(ex, before);
      db.meta.warning = out.warning ? { t: now, text: out.warning } : null;
    }
    const m = WMMarket.ingest(db, json, now, db.meta.me, (card) => !!match(card));
    out.auctions = m.auctions;
    out.marketSales = m.sales;
    out.ids = m.ids;
    if (out.own || m.auctions) {
      db.meta.lastCapture = now;
      db.meta.lastCaptureKind = out.own ? 'own' : 'market';
      if (out.own) db.meta.lastOwnCapture = now;
      db.meta.captures = (db.meta.captures || 0) + 1;
      db.meta.captureError = null;
    }
    return out;
  });
  if (result.added.purchases.length || result.added.sales.length) scheduleAutoExport();
  if (result.auctions) notifySiteTabs({ type: 'marketUpdated' });
  if (result.ids && result.ids.length) await notifyDeals(result.ids, now).catch(() => {});
  updateBadge();
  return result;
}

/** The site only lists your last 50 sales / won auctions. */
function gapWarning(ex, before) {
  const parts = [];
  const check = (list, previousNewest, label) => {
    if (list.length < FULL_LIST || previousNewest === null) return;
    const oldest = list.reduce((m, it) => Math.min(m, it.time), Infinity);
    if (oldest > previousNewest) parts.push(label);
  };
  check(ex.purchases, before.purchases, 'achats');
  check(ex.sales, before.sales, 'ventes');
  if (!parts.length) return null;
  return `Des ${parts.join(' et des ')} ont pu être manqués : le site n'affiche que les 50 derniers. Ouvrez le marché au moins tous les deux jours.`;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) notifySiteTabs({ type: 'marketUpdated' });
});

async function setCaptureError(text) {
  await withDb((db) => { db.meta.captureError = { t: Date.now(), text }; });
}

async function notifySiteTabs(msg) {
  try {
    const tabs = await browser.tabs.query({ url: SITE_MATCH });
    tabs.forEach((t) => browser.tabs.sendMessage(t.id, msg).catch(() => {}));
  } catch (e) { /* no tab */ }
}

async function updateBadge() {
  try {
    const db = await loadDb();
    const since = db.meta.badgeClearedAt || 0;
    const n = (db.meta.recent || []).filter((r) => r.addedAt > since).length;
    browser.action.setBadgeBackgroundColor({ color: '#1e7a34' });
    browser.action.setBadgeText({ text: n ? String(n) : '' });
  } catch (e) { /* cosmetic */ }
}

/* ------------------------------------------------------------------------ */
/* Deals: passive detection, optional notifications                         */
/* ------------------------------------------------------------------------ */

/** Options of the deal detection, from the settings. */
function dealOptions(settings, db) {
  const match = WMStats.makeMatcher(settings, db);
  return {
    pct: settings.features.alertPct,
    minSales: settings.features.alertMinSales,
    windowDays: settings.market.windowDays,
    useEstimates: settings.market.useEstimates,
    isEligible: settings.features.alertScope === 'all' ? null : (card) => !!match(card)
  };
}

let notificationClicks = false;
function listenToNotificationClicks() {
  if (notificationClicks || !browser.notifications || !browser.notifications.onClicked) return;
  notificationClicks = true;
  browser.notifications.onClicked.addListener(async (nid) => {
    const m = /^wmt-deal:(.+)$/.exec(nid);
    if (!m) return;
    browser.notifications.clear(nid).catch(() => {});
    await browser.tabs.create({ url: `${MARKET_PAGE}/${encodeURIComponent(m[1])}`, active: true });
  });
}
listenToNotificationClicks();

function timeLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * Called after each capture with the auctions it contained: notifies the new
 * deals among them, once per auction. Nothing is requested from the game.
 */
async function notifyDeals(ids, now) {
  const settings = await getSettings();
  if (!settings.features.notify) return [];
  if (!(await browser.permissions.contains({ permissions: ['notifications'] }))) return [];
  listenToNotificationClicks();
  const fresh = await withDb((db) => {
    db.meta.notified = db.meta.notified || {};
    Object.keys(db.meta.notified).forEach((id) => { if (db.meta.notified[id] < now) delete db.meta.notified[id]; });
    const seen = new Set(ids);
    const list = WMMarket.deals(db, now, dealOptions(settings, db)).filter((d) => seen.has(d.id) && !db.meta.notified[d.id]);
    list.forEach((d) => { db.meta.notified[d.id] = d.end; });
    return list;
  });
  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  for (const d of fresh.slice(0, 5)) {
    await browser.notifications.create(`wmt-deal:${d.id}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-96.png'),
      title: `Bonne affaire : ${d.card}${d.rarity ? ` (${d.rarity})` : ''} ${Math.round(d.diff * 100)} %`,
      message: `${d.hasBid ? 'Prochaine mise' : 'Mise de départ'} ${nf.format(d.next)} W · médiane ${nf.format(Math.round(d.median))} W (${d.n} ventes) · fin dans ${timeLeft(d.end - now)}`
    });
  }
  if (fresh.length > 5) {
    await browser.notifications.create('wmt-deals-more', {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-96.png'),
      title: `${fresh.length - 5} autre(s) bonne(s) affaire(s)`,
      message: 'Liste complète dans le popup de l\'extension.'
    });
  }
  return fresh;
}

/* ------------------------------------------------------------------------ */
/* Optional: final price of ended auctions (off by default)                 */
/* ------------------------------------------------------------------------ */
/*
 * When "Relever automatiquement le prix final" is on, the extension asks the
 * game for ended auctions of your followed cards, one at a time:
 *  - one small request (/api/marketplace/<id>, the same data the auction
 *    page loads), sent from your open game tab so that it uses your session;
 *  - only while a game tab is open, never more than one at a time;
 *  - a fixed spacing (60 s by default, 30 s minimum) and a daily cap;
 *  - still running (extended by late bids): re-timed to the new end;
 *    no answer: retried 30 min later, dropped after 3 attempts.
 * It does not try to look like a person (no random delays, no fake page views).
 */

const RESOLVE_ALARM = 'wmt-resolve';
const RETRY_MS = 30 * 60000;
const MAX_ATTEMPTS = 3;
let resolving = false;

browser.alarms.create(RESOLVE_ALARM, { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === RESOLVE_ALARM) resolveTick().catch((e) => setResolverState({ lastError: String((e && e.message) || e) }));
});

async function getResolverState() {
  const { resolver } = await browser.storage.local.get('resolver');
  const today = WMTime.dayKey(Date.now());
  const r = Object.assign({ day: today, count: 0, lastAt: 0, resolved: 0, dropped: 0 }, resolver || {});
  if (r.day !== today) Object.assign(r, { day: today, count: 0, resolved: 0, dropped: 0 });
  return r;
}

async function setResolverState(patch) {
  const r = Object.assign(await getResolverState(), patch);
  await browser.storage.local.set({ resolver: r });
  return r;
}

/** Runs inside the game page (your session). Must stay self-contained. */
function pageFetch(url) {
  return fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
    .then((r) => r.text().then((t) => JSON.stringify({ status: r.status, text: t })))
    .catch((e) => JSON.stringify({ status: 0, text: String(e) }));
}

/** One step: at most one request. Returns what happened (for tests and the status line). */
async function resolveTick(now) {
  now = now || Date.now();
  const settings = await getSettings();
  if (!settings.market.autoResolve || resolving) return { skipped: 'off' };
  if (!(await browser.permissions.contains({ permissions: ['scripting'] }))) return { skipped: 'permission' };
  const state = await getResolverState();
  if (now - state.lastAt < settings.market.resolveSpacingSec * 1000) return { skipped: 'spacing' };
  if (state.count >= settings.market.resolveMaxPerDay) return { skipped: 'cap' };

  const db = await loadDb();
  const match = WMStats.makeMatcher(settings, db);
  const due = Object.keys(db.checks || {})
    .map((id) => Object.assign({ id }, db.checks[id]))
    .filter((c) => c.nextAt <= now && match(c.card))
    .sort((a, b) => a.nextAt - b.nextAt)[0];
  if (!due) return { skipped: 'empty' };

  const tabs = (await browser.tabs.query({ url: SITE_MATCH })).filter((t) => !t.discarded && !t.incognito);
  const tab = tabs[0];
  if (!tab) return { skipped: 'no-tab' };

  resolving = true;
  try {
    const origin = new URL(tab.url).origin;
    const url = `${origin}/api/marketplace/${encodeURIComponent(due.id)}`;
    await setResolverState({ lastAt: now, count: state.count + 1 });
    let json = null;
    try {
      const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageFetch, args: [url] });
      const r = results && results[0] && results[0].result;
      const res = typeof r === 'string' ? JSON.parse(r) : null;
      if (res && res.status >= 200 && res.status < 300) json = JSON.parse(res.text);
    } catch (e) {
      json = null;
    }
    if (json) await ingest(url, json, now);

    // Outcome.
    let outcome = 'resolved';
    await withDb((d) => {
      const c = d.checks[due.id];
      if (!c) return; // settled: removed by ingest, the sale (if any) is stored
      if (c.end > now) { outcome = 'extended'; return; } // re-timed by ingest
      if (c.attempts + 1 >= MAX_ATTEMPTS) { delete d.checks[due.id]; outcome = 'dropped'; return; }
      d.checks[due.id] = Object.assign({}, c, { attempts: c.attempts + 1, nextAt: now + RETRY_MS });
      outcome = json ? 'not-settled' : 'no-answer';
    });
    const after = await getResolverState();
    await setResolverState({
      lastCard: due.card, lastOutcome: outcome, lastError: null,
      resolved: after.resolved + (outcome === 'resolved' ? 1 : 0),
      dropped: after.dropped + (outcome === 'dropped' ? 1 : 0)
    });
    return { id: due.id, outcome };
  } finally {
    resolving = false;
  }
}

/* ------------------------------------------------------------------------ */
/* Messages                                                                 */
/* ------------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return undefined;
  switch (msg.type) {
    case 'balance': return safe(() => onBalance(msg.value));
    case 'overlayInfo': return safe(() => overlayInfo(msg.tiles || []));
    case 'follow': return safe(() => follow(msg.card, msg.follow !== false));
    case 'openDashboard': return safe(() => openDashboard(msg.hash || ''));
    case 'openMarketplace': return safe(() => openMarketplace());
    case 'popupOpened': return safe(() => clearBadge());
    case 'export': return safe(() => exportToSheets());
    case 'ping': return safe(() => pingScript(msg.sheets));
    case 'importV1': return safe(() => importFromSheet());
    case 'setExcluded': return safe(() => setExcluded(msg.id, !!msg.excluded));
    case 'restore': return safe(() => restoreBackup(msg.backup));
    case 'resetData': return safe(() => resetData());
    case 'dashboardTab': return safe(() => browser.storage.local.set({ dashboardTab: sender && sender.tab ? sender.tab.id : null }));
    default: return undefined;
  }
});

async function safe(fn) {
  try {
    const out = await fn();
    return out === undefined ? { ok: true } : out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function onBalance(value) {
  const changed = await withDb((db) => WMStore.addBalance(db, Number(value), Date.now()));
  return { ok: true, changed };
}

async function overlayInfo(tiles) {
  const settings = await getSettings();
  if (!settings.market.overlay) return { ok: true, enabled: false, items: [] };
  const db = await loadDb();
  const match = WMStats.makeMatcher(settings, db);
  const items = WMMarket.overlayInfo(db, tiles, (card) => !!match(card), Date.now(), settings.market.windowDays,
    settings.market.dealPct, settings.market.useEstimates);
  return { ok: true, enabled: true, items };
}

/**
 * Follow / unfollow one card. Unfollowing a card that a category keyword still
 * matches puts it on the exclusion list, which wins over keywords.
 */
async function follow(card, on) {
  const settings = await getSettings();
  const db = await loadDb();
  const key = WMExtract.cardKey(card);
  const sameCard = (c) => WMExtract.cardKey(c.name) === key;
  settings.tracking.excluded = settings.tracking.excluded.filter((c) => !sameCard(c));
  if (on) {
    if (!WMStats.makeMatcher(settings, db)(card)) settings.tracking.cards.push({ name: String(card), since: '' });
  } else {
    settings.tracking.cards = settings.tracking.cards.filter((c) => !sameCard(c));
    if (WMStats.makeMatcher(settings, db)(card)) settings.tracking.excluded.push({ name: String(card) });
  }
  await browser.storage.local.set({ settings });
  notifySiteTabs({ type: 'marketUpdated' });
  return { ok: true, followed: !!WMStats.makeMatcher(settings, db)(card) };
}

async function clearBadge() {
  await withDb((db) => { db.meta.badgeClearedAt = Date.now(); });
  browser.action.setBadgeText({ text: '' });
}

/* ------------------------------------------------------------------------ */
/* Tabs: dashboard reuse, marketplace                                       */
/* ------------------------------------------------------------------------ */

async function openDashboard(hash) {
  const url = browser.runtime.getURL('dashboard.html') + (hash ? (hash[0] === '#' ? hash : `#${hash}`) : '');
  const { dashboardTab } = await browser.storage.local.get('dashboardTab');
  if (dashboardTab !== undefined && dashboardTab !== null) {
    try {
      const tab = await browser.tabs.get(dashboardTab);
      await browser.tabs.update(tab.id, { active: true, url });
      await browser.windows.update(tab.windowId, { focused: true });
      return { ok: true, reused: true };
    } catch (e) { /* closed: open a new one */ }
  }
  const tab = await browser.tabs.create({ url });
  await browser.storage.local.set({ dashboardTab: tab.id });
  return { ok: true, reused: false };
}

/** Brings your marketplace tab to the front, or opens one (a normal page visit). */
async function openMarketplace() {
  const tabs = await browser.tabs.query({ url: SITE_MATCH });
  const market = tabs.find((t) => /\/marketplace(\/|$|\?)/.test(t.url || '')) || null;
  if (market) {
    await browser.tabs.update(market.id, { active: true });
    await browser.windows.update(market.windowId, { focused: true });
    return { ok: true, reused: true };
  }
  await browser.tabs.create({ url: MARKET_PAGE });
  return { ok: true, reused: false };
}

/* ------------------------------------------------------------------------ */
/* Storage                                                                  */
/* ------------------------------------------------------------------------ */

async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return WMSettings.normalize(settings);
}

async function loadDb() {
  const { db } = await browser.storage.local.get('db');
  return WMStore.normalizeDb(db || WMStore.emptyDb());
}

/** Serialises every read-modify-write of the database. */
function withDb(fn) {
  const run = dbQueue.then(async () => {
    const db = await loadDb();
    const out = await fn(db);
    await browser.storage.local.set({ db });
    return out;
  });
  dbQueue = run.catch(() => {});
  return run;
}

async function setExcluded(id, excluded) {
  await withDb((db) => WMStore.setExcluded(db, id, excluded));
  return { ok: true };
}

async function restoreBackup(backup) {
  const parsed = WMStore.readBackup(backup);
  await withDb((db) => {
    Object.keys(db).forEach((k) => delete db[k]);
    Object.assign(db, parsed.db);
  });
  if (parsed.settings) await browser.storage.local.set({ settings: WMSettings.normalize(parsed.settings) });
  return { ok: true };
}

async function resetData() {
  await withDb((db) => {
    Object.keys(db).forEach((k) => delete db[k]);
    Object.assign(db, WMStore.emptyDb());
  });
  await browser.storage.local.remove(['lastExport', 'exportState', 'lastResult', 'lastSync', 'syncState', 'resolver']);
  return { ok: true };
}

/* ------------------------------------------------------------------------ */
/* Google Sheets (optional)                                                 */
/* ------------------------------------------------------------------------ */

function scheduleAutoExport() {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(async () => {
    const settings = await getSettings();
    if (WMSettings.sheetsConfigured(settings) && settings.sheets.autoExport) exportToSheets().catch(() => {});
  }, AUTO_EXPORT_DELAY_MS);
}

async function callScript(sheets, payload) {
  const url = String((sheets && sheets.scriptUrl) || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
    throw new Error("L'URL de l'Apps Script doit ressembler à https://script.google.com/macros/s/…/exec");
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, payload, { secret: String(sheets.secret || '').trim() })),
      redirect: 'follow',
      credentials: 'omit'
    });
  } catch (e) {
    throw new Error(`Impossible de joindre l'Apps Script (${(e && e.message) || e}).`);
  }
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    if (!resp.ok) throw new Error(`L'Apps Script a répondu HTTP ${resp.status}.`);
    throw new Error("L'Apps Script n'a pas répondu en JSON. Vérifiez le déploiement « Tout le monde » et l'URL /exec.");
  }
  if (!json.ok) throw new Error(json.error || "Erreur inconnue de l'Apps Script.");
  return json;
}

async function setExportState(state) {
  await browser.storage.local.set({ exportState: Object.assign({ at: Date.now() }, state) });
}

/** One request per tab, so the progress can be shown ("Remplissage de l'onglet Achats…"). */
async function exportToSheets() {
  if (exporting) throw new Error('Un export est déjà en cours.');
  const settings = await getSettings();
  if (!WMSettings.sheetsConfigured(settings)) throw new Error("Renseignez l'URL et le secret Google Sheets dans les paramètres.");
  exporting = true;
  try {
    await setExportState({ running: true, step: 0, total: 0, label: 'Préparation des données…' });
    const model = WMStats.compute(await loadDb(), settings, Date.now());
    const tables = WMTables.build(model);
    const warnings = [];
    let spreadsheet = '';
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      await setExportState({
        running: true, step: i + 1, total: tables.length,
        label: `Remplissage de l'onglet « ${t.name} » (${i + 1}/${tables.length}, ${t.rows.length} ligne${t.rows.length > 1 ? 's' : ''})…`
      });
      const res = await callScript(settings.sheets, { action: 'write', version: 2, index: i, tables: [t] });
      spreadsheet = res.spreadsheet || spreadsheet;
      (res.warnings || []).forEach((w) => warnings.push(w));
    }
    const done = { running: false, ok: true, step: tables.length, total: tables.length, spreadsheet, warnings, label: `Feuille « ${spreadsheet} » à jour (${tables.length} onglets).` };
    await setExportState(done);
    await browser.storage.local.set({ lastExport: { at: Date.now(), spreadsheet } });
    return Object.assign({ ok: true, written: tables.map((t) => t.name) }, done);
  } catch (e) {
    const msg = String((e && e.message) || e);
    await setExportState({ running: false, ok: false, label: `Échec de l'export : ${msg}` });
    throw e;
  } finally {
    exporting = false;
  }
}

async function pingScript(override) {
  const settings = await getSettings();
  return callScript(Object.assign({}, settings.sheets, override || {}), { action: 'ping' });
}

/** One-time import of the v1 spreadsheet (Achats / Ventes written by version 1). */
async function importFromSheet() {
  const settings = await getSettings();
  if (!WMSettings.sheetsConfigured(settings)) throw new Error("Renseignez l'URL et le secret Google Sheets dans les paramètres.");
  const res = await callScript(settings.sheets, { action: 'readV1' });
  const summary = await withDb((db) => WMStore.importV1(db, res));
  let addedCards = [];
  if (!settings.tracking.cards.length && !settings.tracking.categories.length && summary.trackedCards.length) {
    settings.tracking.cards = summary.trackedCards.map((name) => ({ name, since: '' }));
    addedCards = summary.trackedCards;
    await browser.storage.local.set({ settings });
  }
  return Object.assign({ ok: true, addedCards, sheets: res.sheets || [] }, summary);
}

// For the Node tests.
globalThis.__wmt = { ingest, onApiRequest, resolveTick, notifyDeals };
