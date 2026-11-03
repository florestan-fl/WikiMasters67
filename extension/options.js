/* global browser */
'use strict';

const DEFAULTS = {
  scriptUrl: '',
  secret: '',
  startDate: '2026-10-30',
  inclureDefault: 'Oui',
  matchWindowHours: 24,
  renumber: false
};

const $ = (id) => document.getElementById(id);
const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/;

function show(kind, text) {
  const box = $('message');
  box.textContent = '';
  const d = document.createElement('div');
  d.className = `notice ${kind}`;
  d.textContent = text;
  box.appendChild(d);
}

function readForm() {
  const hours = Number($('matchWindowHours').value);
  return {
    scriptUrl: $('scriptUrl').value.trim(),
    secret: $('secret').value.trim(),
    startDate: $('startDate').value || '',
    inclureDefault: $('inclureDefault').value,
    matchWindowHours: Number.isFinite(hours) && hours >= 0 ? hours : DEFAULTS.matchWindowHours,
    renumber: $('renumber').checked
  };
}

function validate(s) {
  if (s.scriptUrl && !URL_RE.test(s.scriptUrl)) {
    return 'The URL must look like https://script.google.com/macros/s/…/exec';
  }
  return null;
}

async function load() {
  const { settings } = await browser.storage.local.get('settings');
  const s = Object.assign({}, DEFAULTS, settings || {});
  $('scriptUrl').value = s.scriptUrl;
  $('secret').value = s.secret;
  $('startDate').value = s.startDate;
  $('inclureDefault').value = s.inclureDefault;
  $('matchWindowHours').value = s.matchWindowHours;
  $('renumber').checked = !!s.renumber;
}

async function save() {
  const s = readForm();
  const err = validate(s);
  if (err) { show('err', err); return false; }
  await browser.storage.local.set({ settings: s });
  show('ok', 'Saved.');
  return true;
}

async function test() {
  const s = readForm();
  const err = validate(s) || (!s.scriptUrl || !s.secret ? 'Fill in the URL and the secret first.' : null);
  if (err) { show('err', err); return; }
  show('ok', 'Testing…');
  const res = await browser.runtime.sendMessage({ type: 'ping', settings: s });
  if (!res || !res.ok) {
    show('err', `Connection failed: ${(res && res.error) || 'no answer'}`);
    return;
  }
  const missing = (res.sheets || []).filter((x) => !x.found).map((x) => x.name);
  if (missing.length) {
    show('warn', `Connected to “${res.spreadsheet}”, but these tabs are missing: ${missing.join(', ')}.`);
  } else {
    show('ok', `Connected to “${res.spreadsheet}” (time zone ${res.timeZone}). Don't forget to Save.`);
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
