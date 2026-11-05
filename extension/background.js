/* global browser, WMExtract, WMStore, WMStats, WMTables, WMSettings */
'use strict';

const SITE_ORIGIN = 'https://www.wiki-masters.com';
const SITE_MATCH = ['https://www.wiki-masters.com/*', 'https://wiki-masters.com/*'];
const PAGE_LIMIT = 50;
const MAX_PAGES = 5;
const TAB_LOAD_TIMEOUT_MS = 45000;

let running = false;
let dbQueue = Promise.resolve();

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return undefined;
  switch (msg.type) {
    case 'sync': return runSync();
    case 'export': return safe(() => exportToSheets());
    case 'ping': return safe(() => pingScript(msg.sheets));
    case 'importV1': return safe(() => importFromSheet());
    case 'setExcluded': return safe(() => setExcluded(msg.id, !!msg.excluded));
    case 'restore': return safe(() => restoreBackup(msg.backup));
    case 'resetData': return safe(() => resetData());
    default: return undefined;
  }
});

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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
  await browser.storage.local.remove(['lastSync', 'lastResult', 'lastExport']);
  return { ok: true };
}

/* ------------------------------------------------------------------------ */
/* Update                                                                   */
/* ------------------------------------------------------------------------ */

async function runSync() {
  if (running) return { ok: false, error: 'Une mise à jour est déjà en cours.' };
  running = true;
  await browser.storage.local.set({ syncState: { running: true, startedAt: Date.now() } });

  let result;
  try {
    const settings = await getSettings();
    const { data, pages, balance } = await fetchMarketplace();
    const ex = WMExtract.extract(data);
    const now = Date.now();

    const { added, warnings } = await withDb((db) => {
      const before = WMStore.newestTimes(db);
      const out = WMStore.mergeSync(db, Object.assign({}, ex, { balance }), now);
      return { added: out, warnings: coverageWarnings(ex, before) };
    });

    if (balance === null) warnings.push("Le solde de wikibidous n'a pas pu être lu : le patrimoine ne sera pas mis à jour.");

    const db = await loadDb();
    const model = WMStats.compute(db, settings, now);

    let exported = null;
    if (WMSettings.sheetsConfigured(settings) && settings.sheets.autoExport) {
      exported = await exportModel(settings, model).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      if (!exported.ok) warnings.push(`Google Sheets : ${exported.error}`);
    }

    await browser.storage.local.set({ lastSync: { at: now } });
    result = {
      ok: true,
      finishedAt: now,
      fetched: { purchases: ex.purchases.length, sales: ex.sales.length, pages },
      added: {
        purchases: added.purchases.map((r) => summary(r, model)),
        sales: added.sales.map((r) => summary(r, model))
      },
      balance,
      kpis: model.kpis,
      exported: exported ? exported.ok : null,
      warnings: warnings.concat(model.warnings)
    };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e), finishedAt: Date.now() };
  } finally {
    running = false;
  }

  await browser.storage.local.set({ lastResult: result, syncState: { running: false } });
  updateBadge(result);
  return result;
}

function summary(rec, model) {
  const list = rec.status ? model.sales : model.purchases;
  const m = list.find((x) => x.id === rec.id) || rec;
  return {
    label: rec.label, time: rec.time, card: rec.card, price: rec.price, status: rec.status || null,
    party: rec.party, tracked: !!m.tracked, profit: m.profit === undefined ? null : m.profit
  };
}

/** Warns when the site lists may not reach back to the previous update. */
function coverageWarnings(ex, before) {
  const warnings = [];
  const check = (list, previousNewest, label) => {
    if (list.length < PAGE_LIMIT || previousNewest === null) return;
    const oldest = list.reduce((m, it) => Math.min(m, it.time), Infinity);
    if (oldest > previousNewest) {
      warnings.push(`La liste des ${label} renvoyée par le site ne remonte pas jusqu'à votre dernière mise à jour : il peut manquer des ${label}. Mettez à jour plus souvent.`);
    }
  };
  check(ex.purchases, before.purchases, 'achats');
  check(ex.sales, before.sales, 'ventes');
  return warnings;
}

function updateBadge(result) {
  try {
    if (!result.ok) {
      browser.action.setBadgeBackgroundColor({ color: '#d03b3b' });
      browser.action.setBadgeText({ text: '!' });
      return;
    }
    const n = result.added.purchases.length + result.added.sales.length;
    browser.action.setBadgeBackgroundColor({ color: '#1e7a34' });
    browser.action.setBadgeText({ text: n ? String(n) : '' });
  } catch (e) {
    // Badge is cosmetic.
  }
}

/* ------------------------------------------------------------------------ */
/* Reading wiki-masters.com                                                 */
/* ------------------------------------------------------------------------ */

async function fetchMarketplace() {
  const { tab, created } = await getSiteTab();
  try {
    const origin = tabOrigin(tab);
    const merged = { history: new Map(), won: new Map(), auctions: new Map(), selling: [], bidding: [] };
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${origin}/api/marketplace?page=${page}&limit=${PAGE_LIMIT}&sort=recent&mine=1`;
      const data = await fetchJson(tab, url);
      pages++;
      if (!data || !Array.isArray(data.history) || !Array.isArray(data.won)) {
        throw new Error('Réponse inattendue de wiki-masters.com (pas de listes "history"/"won"). Êtes-vous connecté ?');
      }
      if (page === 1) {
        merged.selling = Array.isArray(data.selling) ? data.selling : [];
        merged.bidding = Array.isArray(data.bidding) ? data.bidding : [];
      }
      let added = 0;
      for (const a of data.history) if (a && a.id && !merged.history.has(a.id)) { merged.history.set(a.id, a); added++; }
      for (const a of data.won) if (a && a.id && !merged.won.has(a.id)) { merged.won.set(a.id, a); added++; }
      for (const a of data.auctions || []) if (a && a.id) merged.auctions.set(a.id, a);
      const full = data.history.length >= PAGE_LIMIT || data.won.length >= PAGE_LIMIT;
      if (!added || !full) break; // the site ignores "page" for these lists, or there is nothing older
    }
    const balance = await readBalance(tab);
    return {
      data: {
        history: [...merged.history.values()],
        won: [...merged.won.values()],
        auctions: [...merged.auctions.values()],
        selling: merged.selling,
        bidding: merged.bidding
      },
      pages,
      balance
    };
  } finally {
    if (created) browser.tabs.remove(tab.id).catch(() => {});
  }
}

function tabOrigin(tab) {
  try {
    const u = new URL(tab.url);
    if (/(^|\.)wiki-masters\.com$/.test(u.hostname)) return u.origin;
  } catch (e) { /* fall through */ }
  return SITE_ORIGIN;
}

/** Uses an open wiki-masters.com tab, or opens one in the background. */
async function getSiteTab() {
  const tabs = await browser.tabs.query({ url: SITE_MATCH });
  const usable = tabs.filter((t) => !t.discarded);
  const tab = usable.find((t) => t.status === 'complete') || usable[0];
  if (tab) return { tab, created: false };

  const createdTab = await browser.tabs.create({ url: `${SITE_ORIGIN}/marketplace`, active: false });
  await waitForTabComplete(createdTab.id);
  return { tab: await browser.tabs.get(createdTab.id), created: true };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      if (err) reject(err); else resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(() => finish(new Error('wiki-masters.com met trop de temps à charger.')), TAB_LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
  });
}

/**
 * Runs inside the wiki-masters.com page, exactly like the site's own request
 * (same origin, your login cookies). Must stay self-contained.
 */
function pageFetch(url) {
  return fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
    .then((r) => r.text().then((t) => JSON.stringify({ status: r.status, text: t })))
    .catch((e) => JSON.stringify({ status: 0, text: String(e) }));
}

/**
 * Runs inside the page: reads the wikibidous balance from a fresh copy of the
 * page (server-rendered "initialWikibidousBalance"), or from the header button.
 */
function pageBalance() {
  const fromDom = () => {
    const el = document.querySelector('[title*="wikibidous" i]');
    const m = el && String(el.getAttribute('title')).match(/(\d[\d\s  .]*)\s*wikibidous/i);
    return m ? Number(m[1].replace(/\D/g, '')) : null;
  };
  return fetch('/marketplace', { credentials: 'include' })
    .then((r) => r.text())
    .then((t) => {
      const m = t.match(/initialWikibidousBalance\\?"\s*:\s*(\d+)/);
      return m ? Number(m[1]) : fromDom();
    })
    .catch(() => fromDom());
}

async function readBalance(tab) {
  try {
    const results = await browser.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: pageBalance });
    const v = results && results[0] && results[0].result;
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch (e) {
    return null;
  }
}

async function fetchJson(tab, url) {
  let status;
  let text;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pageFetch,
      args: [url]
    });
    const r = results && results[0] && results[0].result;
    if (typeof r !== 'string') throw new Error('no result from page');
    ({ status, text } = JSON.parse(r));
    if (status === 0) throw new Error(text);
  } catch (e) {
    // Fallback: request from the extension itself (also sends your cookies).
    const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    status = resp.status;
    text = await resp.text();
  }
  if (status === 401 || status === 403) {
    throw new Error(`wiki-masters.com a refusé la demande (HTTP ${status}). Connectez-vous sur le site puis réessayez.`);
  }
  if (status < 200 || status >= 300) throw new Error(`wiki-masters.com a répondu HTTP ${status}.`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Réponse inattendue de wiki-masters.com (pas du JSON). Êtes-vous connecté ?');
  }
}

/* ------------------------------------------------------------------------ */
/* Google Sheets (optional)                                                 */
/* ------------------------------------------------------------------------ */

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

async function exportModel(settings, model) {
  const tables = WMTables.build(model);
  const res = await callScript(settings.sheets, { action: 'write', version: 2, tables });
  await browser.storage.local.set({ lastExport: { at: Date.now(), spreadsheet: res.spreadsheet || '' } });
  return Object.assign({ ok: true }, res);
}

async function exportToSheets() {
  const settings = await getSettings();
  if (!WMSettings.sheetsConfigured(settings)) throw new Error("Renseignez l'URL et le secret Google Sheets dans les paramètres.");
  const model = WMStats.compute(await loadDb(), settings, Date.now());
  return exportModel(settings, model);
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
