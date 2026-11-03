/* global browser */
'use strict';

const ORIGINS = [
  'https://www.wiki-masters.com/*',
  'https://wiki-masters.com/*',
  'https://script.google.com/*',
  'https://script.googleusercontent.com/*'
];

const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtDateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('fr-FR') : String(n ?? '');
}

/* ------------------------------------------------------------------------ */

async function init() {
  $('open-options').addEventListener('click', openOptions);
  $('open-options-2').addEventListener('click', openOptions);
  $('grant').addEventListener('click', grant);
  $('preview').addEventListener('click', () => start(true));
  $('sync').addEventListener('click', () => start(false));

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.syncState) renderState(changes.syncState.newValue);
    if (changes.lastResult) renderResult(changes.lastResult.newValue);
    if (changes.lastSync) renderLastSync(changes.lastSync.newValue);
  });

  const { settings, syncState, lastResult, lastSync } =
    await browser.storage.local.get(['settings', 'syncState', 'lastResult', 'lastSync']);
  $('setup').hidden = !!(settings && settings.scriptUrl && settings.secret);
  await checkPermissions();
  renderState(syncState);
  renderResult(lastResult);
  renderLastSync(lastSync);
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

async function start(dryRun) {
  if (!(await checkPermissions())) return;
  renderState({ running: true, dryRun });
  try {
    await browser.runtime.sendMessage({ type: 'sync', dryRun });
  } catch (e) {
    renderResult({ ok: false, error: String((e && e.message) || e) });
    renderState({ running: false });
  }
}

/* ------------------------------------------------------------------------ */

function renderState(state) {
  const busy = !!(state && state.running);
  $('preview').disabled = busy;
  $('sync').disabled = busy;
  $('status').textContent = busy
    ? (state.dryRun ? 'Preparing preview…' : 'Updating the sheet…')
    : '';
}

function renderLastSync(lastSync) {
  $('last-sync').textContent = lastSync && lastSync.at
    ? `Last update: ${fmtDateTime(lastSync.at)}`
    : 'Never updated yet. Start with “Preview”.';
}

function renderResult(r) {
  const box = $('result');
  box.textContent = '';
  if (!r) return;

  if (!r.ok) {
    box.appendChild(el('div', { class: 'notice err', text: r.error || 'Unknown error.' }));
    return;
  }

  box.appendChild(el('div', { class: 'small muted' },
    `${r.dryRun ? 'Preview' : 'Update'} of ${fmtDateTime(r.finishedAt)} · read ${r.fetched.purchases} purchases and ${r.fetched.sales} sales from the site.`));

  if (r.dryRun) {
    box.appendChild(el('div', { class: 'notice ok' }, 'Preview only: nothing was written. Click “Update sheet” to apply.'));
  }

  for (const w of r.warnings || []) box.appendChild(el('div', { class: 'notice warn', text: w }));

  box.appendChild(sheetBlock(r.purchases, 'purchases', r.dryRun));
  box.appendChild(sheetBlock(r.sales, 'sales', r.dryRun));
}

function sheetBlock(s, kind, dryRun) {
  if (!s) return el('div');
  const st = s.stats;
  const verb = dryRun ? 'to add' : 'added';
  const counts = el('div', { class: 'counts' },
    el('b', { text: `${st.added} ${verb}` }),
    ` · ${st.matched} matched to existing rows · ${st.alreadyKnown} already in the sheet`,
    st.beforeStart ? ` · ${st.beforeStart} before the start date` : ''
  );

  const block = el('div', { class: 'sheet-summary' },
    el('div', { class: 'title' }, el('span', { text: s.sheet }), el('span', { class: 'muted small', text: `${st.received} read` })),
    counts
  );

  if (s.added && s.added.length) {
    const head = ['ID', 'Date', 'Card', 'Price', kind === 'sales' ? 'Status' : 'Inclure', kind === 'sales' ? 'Buyer' : 'Seller'];
    const rows = s.added.map((a) => [
      a.id, { nowrap: a.date }, a.card, { num: a.price },
      kind === 'sales' ? a.status : a.inclure, a.party
    ]);
    block.appendChild(details(`Rows ${verb} (${s.added.length})`, table(head, rows), true));
  }

  if (s.matched && s.matched.length) {
    const head = ['ID', 'Card', 'Price', 'Sheet date', 'Site date', 'Notes'];
    const rows = s.matched.map((m) => [m.id, m.card, { num: m.price }, { nowrap: m.sheetDate }, { nowrap: m.siteDate }, (m.notes || []).join('; ')]);
    const withNotes = s.matched.filter((m) => m.notes && m.notes.length).length;
    const label = `Existing rows linked to the site (${s.matched.length}${withNotes ? `, ${withNotes} with differences` : ''})`;
    block.appendChild(details(label, table(head, rows), false));
  }
  return block;
}

function details(label, content, open) {
  const d = el('details', null, el('summary', { text: label }), el('div', { class: 'table-wrap' }, content));
  if (open) d.open = true;
  return d;
}

function table(head, rows) {
  return el('table', null,
    el('thead', null, el('tr', null, ...head.map((h) => el('th', { text: h })))),
    el('tbody', null, ...rows.map((cells) => el('tr', null, ...cells.map((c) => {
      if (c && typeof c === 'object' && 'num' in c) return el('td', { class: 'num', text: fmtNum(c.num) });
      if (c && typeof c === 'object' && 'nowrap' in c) return el('td', { class: 'nowrap', text: String(c.nowrap || '') });
      return el('td', { text: c === null || c === undefined ? '' : String(c) });
    }))))
  );
}

init();
