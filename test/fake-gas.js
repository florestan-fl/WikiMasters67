/*
 * Minimal in-memory fake of the Google Apps Script services used by Code.gs,
 * so the sync logic can be tested with Node (node test/run-tests.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const TZ = 'Europe/Paris';
const EMPTY_CELL = Object.freeze({ v: '', f: '', fmt: '', dv: '' });

/* ---------------------------------------------------------------- dates */

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Local wall-clock time in tz -> Date. */
function localDate(y, mo, d, h = 0, mi = 0, s = 0, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return new Date(t);
}

/** "30/10/2026 23:44" (Paris) -> Date */
function parisDate(s) {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  return localDate(+m[3], +m[2], +m[1], +m[4], +m[5]);
}

function formatDate(date, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return fmt.replace('dd', p.day).replace('MM', p.month).replace('yyyy', p.year)
    .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

function parseDate(str, tz, fmt) {
  if (fmt !== 'dd/MM/yyyy HH:mm:ss') throw new Error('fake parseDate: unsupported format ' + fmt);
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error('fake parseDate: bad input ' + str);
  return localDate(+m[3], +m[2], +m[1], +m[4], +m[5], +m[6], tz);
}

/* ---------------------------------------------------------------- sheets */

function colLetter(c) {
  let s = '';
  while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

/** Shifts relative row references of an A1 formula by dRow (enough for tests). */
function shiftFormula(f, dRow) {
  return f.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (all, d1, col, d2, row) =>
    d2 ? all : `${d1}${col}${d2}${Number(row) + dRow}`);
}

class FakeFilter {
  constructor(sheet, range) { this.sheet = sheet; this.range = range; this.criteria = {}; }
  getRange() { return this.range; }
  getColumnFilterCriteria(c) { return this.criteria[c] || null; }
  setColumnFilterCriteria(c, crit) { this.criteria[c] = crit; return this; }
  remove() { this.sheet.filter = null; }
}

class FakeRange {
  constructor(sheet, row, col, nr = 1, nc = 1) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${row},${col},${nr},${nc}`);
    if (row + nr - 1 > sheet.maxRows || col + nc - 1 > sheet.maxCols) {
      throw new Error(`range ${row},${col},${nr},${nc} outside sheet ${sheet.maxRows}x${sheet.maxCols}`);
    }
    Object.assign(this, { sheet, row, col, nr, nc });
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getLastRow() { return this.row + this.nr - 1; }
  getLastColumn() { return this.col + this.nc - 1; }
  getA1Notation() { return `${colLetter(this.col)}${this.row}`; }
  _map(fn) {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(fn(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValues() { return this._map((r, c) => { const v = this.sheet.peek(r, c).v; return v instanceof Date ? new Date(v) : v; }); }
  getValue() { return this.getValues()[0][0]; }
  getFormulas() { return this._map((r, c) => this.sheet.peek(r, c).f); }
  getFormula() { return this.getFormulas()[0][0]; }
  setValues(values) {
    if (values.length !== this.nr || values.some((l) => l.length !== this.nc)) throw new Error('setValues: size mismatch');
    values.forEach((line, r) => line.forEach((v, c) => {
      const cell = this.sheet.cell(this.row + r, this.col + c);
      if (typeof v === 'string' && v.startsWith('=')) { cell.f = v; cell.v = ''; } else { cell.v = v; cell.f = ''; }
    }));
    this.sheet.writes++;
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFormula(f) { const cell = this.sheet.cell(this.row, this.col); cell.f = f; cell.v = ''; return this; }
  copyTo(dest, type) {
    const T = CopyPasteType;
    for (let r = 0; r < dest.nr; r++) {
      for (let c = 0; c < dest.nc; c++) {
        const srcR = this.row + (r % this.nr);
        const srcC = this.col + (c % this.nc);
        const src = this.sheet.peek(srcR, srcC);
        const dst = dest.sheet.cell(dest.row + r, dest.col + c);
        if (type === T.PASTE_FORMAT) dst.fmt = src.fmt;
        else if (type === T.PASTE_DATA_VALIDATION) dst.dv = src.dv;
        else if (type === T.PASTE_FORMULA || type === T.PASTE_NORMAL) {
          if (src.f) { dst.f = shiftFormula(src.f, dest.row + r - srcR); dst.v = ''; } else if (type === T.PASTE_NORMAL) { dst.v = src.v; dst.f = ''; }
        }
      }
    }
  }
  createFilter() {
    if (this.sheet.filter) throw new Error('filter already exists');
    this.sheet.filter = new FakeFilter(this.sheet, this);
    return this.sheet.filter;
  }
}

class FakeSheet {
  constructor(name, maxRows, maxCols) {
    Object.assign(this, { name, maxRows, maxCols, cells: new Map(), hidden: new Set(), filter: null, writes: 0 });
  }
  cell(r, c) {
    const k = `${r},${c}`;
    if (!this.cells.has(k)) this.cells.set(k, { v: '', f: '', fmt: '', dv: '' });
    return this.cells.get(k);
  }
  /** Read access that does not create the cell. */
  peek(r, c) {
    return this.cells.get(`${r},${c}`) || EMPTY_CELL;
  }
  /** Non-empty cells, for before/after comparisons. */
  snapshot() {
    const out = [];
    for (const [k, cell] of this.cells) {
      if (cell.v !== '' || cell.f || cell.fmt || cell.dv) out.push([k, cell.v instanceof Date ? cell.v.getTime() : cell.v, cell.f, cell.fmt, cell.dv]);
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return JSON.stringify({ cells: out, hidden: [...this.hidden], filter: this.filter && [this.filter.range.getLastRow(), this.filter.range.getLastColumn()], maxRows: this.maxRows });
  }
  getName() { return this.name; }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr, nc); }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastColumn() {
    let last = 0;
    for (const [k, cell] of this.cells) if (cell.v !== '' || cell.f) last = Math.max(last, Number(k.split(',')[1]));
    return last;
  }
  insertRowsAfter(after, n) {
    if (after !== this.maxRows) throw new Error('fake: only appending rows is supported');
    this.maxRows += n;
  }
  insertColumnsAfter(after, n) {
    if (after !== this.maxCols) throw new Error('fake: only appending columns is supported');
    this.maxCols += n;
  }
  hideColumns(c) { this.hidden.add(c); }
  getFilter() { return this.filter; }
  /** Test helper: rows 2..lastData as arrays of displayed raw values. */
  dump(cols) {
    const out = [];
    for (let r = 2; r <= this.maxRows; r++) {
      const line = cols.map((c) => this.peek(r, c).v);
      if (line.every((v) => v === '')) break;
      out.push(line);
    }
    return out;
  }
}

class FakeSpreadsheet {
  constructor(name, sheets) { this.name = name; this.sheets = sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSpreadsheetTimeZone() { return TZ; }
  getName() { return this.name; }
  getId() { return 'fake-id'; }
}

const CopyPasteType = {
  PASTE_NORMAL: 'PASTE_NORMAL',
  PASTE_FORMAT: 'PASTE_FORMAT',
  PASTE_FORMULA: 'PASTE_FORMULA',
  PASTE_DATA_VALIDATION: 'PASTE_DATA_VALIDATION',
  PASTE_VALUES: 'PASTE_VALUES'
};

/* ---------------------------------------------------------------- runtime */

function loadCodeGs(spreadsheet) {
  const props = new Map();
  const logs = [];
  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: () => spreadsheet,
      flush: () => {},
      CopyPasteType
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } })
    },
    Utilities: { formatDate, parseDate, getUuid: () => crypto.randomUUID() },
    Logger: { log: (s) => logs.push(String(s)) }
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, context, { filename: 'Code.gs' });
  return {
    context,
    props,
    logs,
    post(body) {
      const out = context.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(out.content);
    }
  };
}

module.exports = { FakeSheet, FakeSpreadsheet, loadCodeGs, parisDate, formatDate, TZ, colLetter };
