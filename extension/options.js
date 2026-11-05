/* global browser, WMExtract, WMStore, WMStats, WMSettings, WMTables, WMTime, WMFormat */
'use strict';

const F = WMFormat;
const $ = (id) => document.getElementById(id);
const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/;

let settings = WMSettings.normalize(null);
let db = WMStore.emptyDb();
let saveTimer = null;

/* ------------------------------------------------------------------ load */

async function load() {
  const data = await browser.storage.local.get(['settings', 'db']);
  settings = WMSettings.normalize(data.settings);
  db = WMStore.normalizeDb(data.db || WMStore.emptyDb());
  renderAll();
}

function renderAll() {
  renderKnownCards();
  renderCards();
  renderCategories();
  const v = settings.valuation;
  ['windowDays', 'sampleSize', 'haircutPct', 'commissionPct', 'targetMarginPct'].forEach((k) => { $(k).value = v[k]; });
  $('unmatched').value = v.unmatched;
  $('scriptUrl').value = settings.sheets.scriptUrl;
  $('secret').value = settings.sheets.secret;
  $('autoExport').checked = settings.sheets.autoExport;
  renderSummary();
}

/* -------------------------------------------------------- tracked cards */

function countsByCard() {
  const counts = {};
  const add = (r, field) => {
    const k = WMExtract.cardKey(r.card);
    counts[k] = counts[k] || { purchases: 0, sales: 0 };
    counts[k][field]++;
  };
  WMStore.values(db.purchases).forEach((r) => add(r, 'purchases'));
  WMStore.values(db.sales).forEach((r) => add(r, 'sales'));
  return counts;
}

function renderKnownCards() {
  const model = WMStats.compute(db, settings, Date.now());
  const list = $('known-cards');
  list.textContent = '';
  model.knownCards.forEach((name) => list.append(F.el('option', { value: name })));
}

function renderCards() {
  const box = $('cards');
  box.textContent = '';
  const counts = countsByCard();
  if (!settings.tracking.cards.length) {
    box.append(F.el('div', { class: 'small muted', text: 'Aucune carte pour l\'instant.' }));
  }
  settings.tracking.cards.forEach((c, i) => {
    const n = counts[WMExtract.cardKey(c.name)];
    const countText = !c.name.trim() ? ''
      : n ? `${n.purchases} achat(s) et ${n.sales} mise(s) en vente enregistrés pour cette carte`
        : 'Aucune transaction enregistrée sous ce nom pour l\'instant (vérifiez l\'orthographe).';
    const name = F.el('input', {
      type: 'text', value: c.name, list: 'known-cards', placeholder: 'ex. Triceratops', 'aria-label': 'Nom de la carte',
      oninput: (e) => { settings.tracking.cards[i].name = e.target.value; scheduleSave(); },
      onchange: () => { renderCards(); renderSummary(); }
    });
    const since = F.el('input', {
      type: 'date', value: c.since, 'aria-label': 'Suivie depuis',
      onchange: (e) => { settings.tracking.cards[i].since = e.target.value; scheduleSave(); renderSummary(); }
    });
    const remove = F.el('button', {
      class: 'link', title: 'Retirer cette carte', 'aria-label': 'Retirer cette carte', text: '✕',
      onclick: () => { settings.tracking.cards.splice(i, 1); scheduleSave(true); renderCards(); renderSummary(); }
    });
    box.append(F.el('div', { class: 'row' }, name, since, remove,
      countText ? F.el('div', { class: 'count small ' + (n ? 'muted' : 'neg'), text: countText }) : null));
  });
}

function renderCategories() {
  const box = $('categories');
  box.textContent = '';
  settings.tracking.categories.forEach((c, i) => {
    const kw = F.el('input', {
      type: 'text', value: c.keyword, placeholder: 'ex. dinosaure', 'aria-label': 'Mot-clé de catégorie',
      oninput: (e) => { settings.tracking.categories[i].keyword = e.target.value; scheduleSave(); },
      onchange: renderSummary
    });
    const remove = F.el('button', {
      class: 'link', title: 'Retirer ce mot-clé', 'aria-label': 'Retirer ce mot-clé', text: '✕',
      onclick: () => { settings.tracking.categories.splice(i, 1); scheduleSave(true); renderCategories(); renderSummary(); }
    });
    box.append(F.el('div', { class: 'row kw' }, kw, remove));
  });
}

function renderSummary() {
  const s = WMSettings.normalize(settings);
  const m = WMStats.compute(db, s, Date.now());
  const k = m.kpis;
  const cards = m.cards.filter((c) => c.purchases + c.listings > 0).map((c) => c.card);
  const box = $('match-summary');
  box.textContent = '';
  if (!s.tracking.cards.length && !s.tracking.categories.length) {
    box.textContent = 'Aucune règle : rien n\'est suivi pour l\'instant.';
    return;
  }
  box.append(`Suivi actuel : ${k.trackedPurchases} achat(s) et ${k.trackedSales} mise(s) en vente, sur ${cards.length} carte(s).`);
  if (s.tracking.categories.length && cards.length) {
    box.append(F.el('div', { class: 'muted', text: `Cartes concernées : ${cards.slice(0, 40).join(', ')}${cards.length > 40 ? '…' : ''}` }));
  }
}

$('add-card').addEventListener('click', () => {
  settings.tracking.cards.push({ name: '', since: '' });
  renderCards();
  const inputs = $('cards').querySelectorAll('input[type=text]');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('add-category').addEventListener('click', () => {
  settings.tracking.categories.push({ keyword: '' });
  renderCategories();
  const inputs = $('categories').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

/* --------------------------------------------------------------- saving */

function readForm() {
  const v = settings.valuation;
  ['windowDays', 'sampleSize', 'haircutPct', 'commissionPct', 'targetMarginPct'].forEach((k) => { v[k] = $(k).value; });
  v.unmatched = $('unmatched').value;
  settings.sheets.scriptUrl = $('scriptUrl').value.trim();
  settings.sheets.secret = $('secret').value.trim();
  settings.sheets.autoExport = $('autoExport').checked;
}

function scheduleSave(now) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, now ? 0 : 400);
}

async function save() {
  readForm();
  // Keep empty rows on screen while typing, but store only meaningful ones.
  const toStore = WMSettings.normalize(settings);
  await browser.storage.local.set({ settings: toStore });
  $('saved').textContent = `Enregistré à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

['windowDays', 'sampleSize', 'haircutPct', 'commissionPct', 'targetMarginPct', 'unmatched', 'scriptUrl', 'secret', 'autoExport']
  .forEach((id) => {
    $(id).addEventListener('input', () => scheduleSave());
    $(id).addEventListener('change', () => { scheduleSave(); renderSummary(); });
  });

/* ---------------------------------------------------------------- Sheets */

function msg(boxId, kind, text) {
  const box = $(boxId);
  box.textContent = '';
  box.append(F.el('div', { class: `notice ${kind}`, text }));
}

function sheetsForm() {
  const sheets = { scriptUrl: $('scriptUrl').value.trim(), secret: $('secret').value.trim() };
  if (!sheets.scriptUrl || !sheets.secret) return { error: 'Renseignez l\'URL et le secret.' };
  if (!URL_RE.test(sheets.scriptUrl)) return { error: 'L\'URL doit ressembler à https://script.google.com/macros/s/…/exec' };
  return { sheets };
}

$('test').addEventListener('click', async () => {
  const f = sheetsForm();
  if (f.error) return msg('sheets-msg', 'err', f.error);
  msg('sheets-msg', 'ok', 'Test en cours…');
  const res = await browser.runtime.sendMessage({ type: 'ping', sheets: f.sheets });
  if (!res || !res.ok) return msg('sheets-msg', 'err', `Échec : ${(res && res.error) || 'pas de réponse'}`);
  if (res.version !== 2) return msg('sheets-msg', 'warn', `Connecté à « ${res.spreadsheet} », mais le script est l'ancienne version : remplacez Code.gs par la version 2 et redéployez (nouvelle version).`);
  msg('sheets-msg', 'ok', `Connecté à « ${res.spreadsheet} » (fuseau ${res.timeZone}).`);
});

$('export').addEventListener('click', async () => {
  await save();
  msg('sheets-msg', 'ok', 'Envoi en cours…');
  const res = await browser.runtime.sendMessage({ type: 'export' });
  if (!res || !res.ok) return msg('sheets-msg', 'err', `Échec : ${(res && res.error) || 'pas de réponse'}`);
  const extra = (res.warnings || []).length ? `\n${res.warnings.join('\n')}` : '';
  msg('sheets-msg', 'ok', `Feuille « ${res.spreadsheet} » mise à jour (${res.written.length} onglets).${extra}`);
});

$('import-v1').addEventListener('click', async () => {
  await save();
  msg('sheets-msg', 'ok', 'Import en cours…');
  const res = await browser.runtime.sendMessage({ type: 'importV1' });
  if (!res || !res.ok) return msg('sheets-msg', 'err', `Échec : ${(res && res.error) || 'pas de réponse'}`);
  const lines = [
    `Import depuis ${res.sheets.join(' et ')} : ${res.purchases} achat(s) et ${res.sales} vente(s) ajoutés, ${res.skipped} déjà présents, ${res.excluded} exclusion(s).`
  ];
  if (res.addedCards.length) lines.push(`Cartes suivies ajoutées : ${res.addedCards.join(', ')}.`);
  msg('sheets-msg', 'ok', lines.join('\n'));
  await load();
});

/* ------------------------------------------------------- backup & export */

function stamp() {
  return WMTime.dayKey(Date.now());
}

$('backup').addEventListener('click', async () => {
  const data = await browser.storage.local.get(['settings', 'db']);
  const backup = WMStore.makeBackup(WMStore.normalizeDb(data.db || WMStore.emptyDb()), WMSettings.normalize(data.settings));
  F.download(`wikimasters-sauvegarde-${stamp()}.json`, JSON.stringify(backup), 'application/json');
});

$('restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    WMStore.readBackup(backup); // validates before replacing anything
    if (!confirm('Remplacer toutes les données et les paramètres actuels par cette sauvegarde ?')) return;
    const res = await browser.runtime.sendMessage({ type: 'restore', backup });
    if (!res || !res.ok) throw new Error((res && res.error) || 'pas de réponse');
    msg('data-msg', 'ok', 'Sauvegarde restaurée.');
    await load();
  } catch (err) {
    msg('data-msg', 'err', `Restauration impossible : ${err.message}`);
  }
});

document.querySelectorAll('[data-csv]').forEach((b) => {
  b.addEventListener('click', () => {
    const m = WMStats.compute(db, WMSettings.normalize(settings), Date.now());
    const t = WMTables.build(m).find((x) => x.name === b.dataset.csv);
    F.download(`wikimasters-${t.name.toLowerCase().replace(/\s+/g, '-')}-${stamp()}.csv`, WMTables.toCsv(t), 'text/csv;charset=utf-8');
  });
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Effacer toutes les transactions enregistrées ? Pensez à télécharger une sauvegarde avant.')) return;
  const res = await browser.runtime.sendMessage({ type: 'resetData' });
  if (!res || !res.ok) return msg('data-msg', 'err', `Échec : ${(res && res.error) || 'pas de réponse'}`);
  msg('data-msg', 'ok', 'Données effacées.');
  await load();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.db) {
    db = WMStore.normalizeDb(changes.db.newValue || WMStore.emptyDb());
    renderKnownCards();
    renderSummary();
  }
});

load();
