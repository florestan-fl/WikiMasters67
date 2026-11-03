/* global browser, WMExtract */
'use strict';

const SITE_ORIGIN = 'https://www.wiki-masters.com';
const SITE_MATCH = ['https://www.wiki-masters.com/*', 'https://wiki-masters.com/*'];
const PAGE_LIMIT = 50;
const MAX_PAGES = 5;
const TAB_LOAD_TIMEOUT_MS = 45000;

const DEFAULT_SETTINGS = {
  scriptUrl: '',
  secret: '',
  startDate: '2026-10-30',
  inclureDefault: 'Oui',
  matchWindowHours: 24,
  renumber: false
};

let running = false;

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return undefined;
  if (msg.type === 'sync') return runSync(!!msg.dryRun);
  if (msg.type === 'ping') return pingScript(msg.settings);
  return undefined;
});

async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

/* ------------------------------------------------------------------------ */
/* Sync                                                                     */
/* ------------------------------------------------------------------------ */

async function runSync(dryRun) {
  if (running) return { ok: false, error: 'A sync is already running.' };
  running = true;
  await browser.storage.local.set({ syncState: { running: true, dryRun, startedAt: Date.now() } });

  let result;
  try {
    const settings = await getSettings();
    if (!settings.scriptUrl || !settings.secret) {
      throw new Error('Open the extension settings and fill in the Apps Script URL and the secret.');
    }

    const { data, pages } = await fetchMarketplace();
    const { purchases, sales } = WMExtract.extract(data);
    const warnings = await coverageWarnings(purchases, sales);

    const res = await callScript(settings, {
      action: 'sync',
      dryRun,
      startDate: settings.startDate || null,
      inclureDefault: settings.inclureDefault,
      matchWindowHours: Number(settings.matchWindowHours),
      renumber: !!settings.renumber,
      purchases,
      sales
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Unknown error returned by the Apps Script.');

    if (!dryRun) {
      await browser.storage.local.set({
        lastSync: {
          at: Date.now(),
          newestPurchase: newest(purchases),
          newestSale: newest(sales)
        }
      });
    }

    result = Object.assign({}, res, {
      ok: true,
      dryRun,
      fetched: { purchases: purchases.length, sales: sales.length, pages },
      warnings: warnings.concat(res.warnings || []),
      finishedAt: Date.now()
    });
  } catch (e) {
    result = { ok: false, dryRun, error: String((e && e.message) || e), finishedAt: Date.now() };
  } finally {
    running = false;
  }

  await browser.storage.local.set({ lastResult: result, syncState: { running: false } });
  updateBadge(result);
  return result;
}

function newest(list) {
  return list.reduce((m, it) => (m === null || it.time > m ? it.time : m), null);
}

function oldest(list) {
  return list.reduce((m, it) => (m === null || it.time < m ? it.time : m), null);
}

/** Warns when the site lists may not reach back to the previous sync. */
async function coverageWarnings(purchases, sales) {
  const warnings = [];
  const { lastSync } = await browser.storage.local.get('lastSync');
  if (!lastSync) return warnings;
  const check = (list, previousNewest, label) => {
    if (list.length < PAGE_LIMIT || previousNewest === null || previousNewest === undefined) return;
    const o = oldest(list);
    if (o !== null && o > previousNewest) {
      warnings.push(`The ${label} list returned by the site does not go back to your previous sync: some ${label} may be missing. Sync more often to avoid gaps.`);
    }
  };
  check(purchases, lastSync.newestPurchase, 'purchases');
  check(sales, lastSync.newestSale, 'sales');
  return warnings;
}

function updateBadge(result) {
  try {
    if (!result.ok) {
      browser.action.setBadgeBackgroundColor({ color: '#c0392b' });
      browser.action.setBadgeText({ text: '!' });
      return;
    }
    if (result.dryRun) {
      browser.action.setBadgeText({ text: '' });
      return;
    }
    const added = ((result.purchases && result.purchases.stats.added) || 0) +
      ((result.sales && result.sales.stats.added) || 0);
    browser.action.setBadgeBackgroundColor({ color: '#1e7a34' });
    browser.action.setBadgeText({ text: added ? String(added) : '' });
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
    const history = new Map();
    const won = new Map();
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${origin}/api/marketplace?page=${page}&limit=${PAGE_LIMIT}&sort=recent&mine=1`;
      const data = await fetchJson(tab, url);
      pages++;
      if (!data || !Array.isArray(data.history) || !Array.isArray(data.won)) {
        throw new Error('Unexpected answer from wiki-masters.com: no "history"/"won" lists. Are you logged in?');
      }
      let added = 0;
      for (const a of data.history) if (a && a.id && !history.has(a.id)) { history.set(a.id, a); added++; }
      for (const a of data.won) if (a && a.id && !won.has(a.id)) { won.set(a.id, a); added++; }
      const full = data.history.length >= PAGE_LIMIT || data.won.length >= PAGE_LIMIT;
      if (!added || !full) break; // the site ignores "page" for these lists, or there is nothing older
    }
    return { data: { history: [...history.values()], won: [...won.values()] }, pages };
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
    const timer = setTimeout(() => finish(new Error('wiki-masters.com took too long to load.')), TAB_LOAD_TIMEOUT_MS);
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
    throw new Error(`wiki-masters.com refused the request (HTTP ${status}). Log in on the site and try again.`);
  }
  if (status < 200 || status >= 300) throw new Error(`wiki-masters.com answered HTTP ${status}.`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Unexpected answer from wiki-masters.com (not JSON). Are you logged in?');
  }
}

/* ------------------------------------------------------------------------ */
/* Apps Script                                                              */
/* ------------------------------------------------------------------------ */

async function callScript(settings, payload) {
  const url = String(settings.scriptUrl || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
    throw new Error('The Apps Script URL must look like https://script.google.com/macros/s/…/exec');
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, payload, { secret: String(settings.secret || '').trim() })),
      redirect: 'follow',
      credentials: 'omit'
    });
  } catch (e) {
    throw new Error(`Could not reach the Apps Script (${(e && e.message) || e}).`);
  }
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!resp.ok) throw new Error(`The Apps Script answered HTTP ${resp.status}.`);
    throw new Error('The Apps Script did not answer JSON. Check that the web app is deployed with "Who has access: Anyone" and that you use the /exec URL.');
  }
}

async function pingScript(override) {
  try {
    const settings = Object.assign({}, await getSettings(), override || {});
    const res = await callScript(settings, { action: 'ping' });
    return res;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
