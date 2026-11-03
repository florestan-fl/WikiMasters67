/**
 * WikiMasters → Google Sheets sync endpoint (Google Apps Script web app).
 *
 * The Firefox extension sends the transactions it read from
 * https://www.wiki-masters.com/api/marketplace and this script merges them
 * into the "Achats" and "Ventes" tabs of the spreadsheet it is bound to.
 *
 *  - Rows are de-duplicated with the site's auction id, stored in a hidden
 *    "ID site" column. Re-sending the same transactions never adds them twice.
 *  - Rows entered by hand (no "ID site" yet) are matched on card + price and
 *    the closest date, and only get their "ID site" filled in.
 *  - New rows are inserted in chronological order (the FIFO and "N° achat"
 *    formulas depend on row order); existing rows keep their relative order.
 *  - Only the raw columns are written. Formula columns (ARRAYFORMULA in row 2,
 *    per-row formulas such as "ID achat (FIFO)") are left alone, and per-row
 *    formulas are copied down to the new rows.
 *
 * Setup: see README.md (run setup() once, then deploy as a web app).
 */

var SHEETS = {
  purchases: {
    key: 'purchases',
    name: 'Achats',
    prefix: 'A',
    fields: {
      id: 'ID',
      date: 'Date/heure',
      card: 'Carte',
      rarity: 'Rareté',
      price: 'Prix (W)',
      party: 'Vendeur',
      inclure: 'Inclure',
      siteId: 'ID site'
    },
    create: ['siteId'],
    hidden: ['siteId']
  },
  sales: {
    key: 'sales',
    name: 'Ventes',
    prefix: 'V',
    fields: {
      id: 'ID',
      date: 'Date/heure',
      card: 'Carte',
      rarity: 'Rareté',
      price: 'Prix (W)',
      status: 'Statut',
      party: 'Acheteur',
      siteId: 'ID site'
    },
    create: ['party', 'siteId'],
    hidden: ['siteId']
  }
};

var STATUS_SOLD = 'Vendue';
var STATUS_UNSOLD = 'Non vendue';
var HOUR_MS = 3600 * 1000;
// Matching penalties (in hours) used when pairing hand-entered rows with site data.
var PENALTY_STATUS = 6;
var PENALTY_PARTY = 4;
var MAX_LISTED_ROWS = 300;

/* ------------------------------------------------------------------------ */
/* Entry points                                                             */
/* ------------------------------------------------------------------------ */

function doGet() {
  return jsonOutput({ ok: true, service: 'wikimasters-sheets-sync', message: 'Use POST.' });
}

function doPost(e) {
  var result;
  try {
    var body = (e && e.postData && e.postData.contents) || '{}';
    var req = JSON.parse(body);
    checkSecret(req.secret);
    if (req.action === 'ping') {
      result = ping();
    } else {
      result = withLock(function () { return sync(req); });
    }
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  return jsonOutput(result);
}

/**
 * Run this once from the Apps Script editor (select "setup" and click Run).
 * It creates the shared secret and prints it in the execution log.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) props.setProperty('SPREADSHEET_ID', ss.getId());
  Logger.log('Secret to paste in the extension options:\n' + secret);
  return secret;
}

/** Forgets the "hand-entered period" cutoffs (see assignInclure). */
function resetSyncState() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('CUTOFF_' + SHEETS.purchases.name);
  props.deleteProperty('CUTOFF_' + SHEETS.sales.name);
  Logger.log('Sync state reset.');
}

/* ------------------------------------------------------------------------ */
/* Core                                                                     */
/* ------------------------------------------------------------------------ */

function sync(req) {
  var ss = getSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var hours = Number(req.matchWindowHours);
  var opts = {
    tz: tz,
    dryRun: !!req.dryRun,
    startMs: parseStartDate(req.startDate, tz),
    windowMs: (isFinite(hours) && hours >= 0 ? Math.min(hours, 24 * 14) : 24) * HOUR_MS,
    inclureDefault: ['Oui', 'Non', 'auto'].indexOf(req.inclureDefault) >= 0 ? req.inclureDefault : 'Oui',
    renumber: !!req.renumber
  };
  var warnings = [];
  var purchases = sanitizeItems(req.purchases, 'purchases', warnings);
  var sales = sanitizeItems(req.sales, 'sales', warnings);

  var res = { ok: true, dryRun: opts.dryRun, timeZone: tz, warnings: warnings };
  res.purchases = processSheet(ss, SHEETS.purchases, purchases, opts, warnings);
  res.sales = processSheet(ss, SHEETS.sales, sales, opts, warnings);
  if (!opts.dryRun) SpreadsheetApp.flush();
  return res;
}

function processSheet(ss, cfg, items, opts, warnings) {
  var sh = ss.getSheetByName(cfg.name);
  if (!sh) throw new Error('Sheet "' + cfg.name + '" not found.');

  var layout = readLayout(sh, cfg);
  var rows = readRows(sh, layout, opts.tz);
  var stats = { received: items.length, alreadyKnown: 0, beforeStart: 0, matched: 0, added: 0 };

  // 1. Drop what is already in the sheet (by site id) or before the start date.
  var known = {};
  rows.forEach(function (r) { if (r.values.siteId) known[String(r.values.siteId)] = true; });
  var seen = {};
  var fresh = [];
  items.forEach(function (it) {
    if (known[it.siteId]) { stats.alreadyKnown++; return; }
    if (seen[it.siteId]) return;
    seen[it.siteId] = true;
    if (opts.startMs !== null && it.time < opts.startMs) { stats.beforeStart++; return; }
    fresh.push(it);
  });

  // 2. Pair the remaining site items with hand-entered rows (no site id yet).
  var pairs = fuzzyMatch(rows, fresh, cfg, opts.windowMs);
  var matchedItem = {};
  var matchedRows = [];
  pairs.forEach(function (p) {
    var r = rows[p.row];
    var it = fresh[p.item];
    matchedItem[p.item] = true;
    r.values.siteId = it.siteId;
    r.dirty.siteId = true;
    var hasParty = layout.cols.party || layout.toCreate.indexOf('party') >= 0;
    // Fill the buyer only when the sheet also says "Vendue" (your row wins).
    if (cfg.key === 'sales' && hasParty && isBlank(r.values.party) && it.party &&
        normText(r.values.status) === normText(STATUS_SOLD)) {
      r.values.party = it.party;
      r.dirty.party = true;
    }
    matchedRows.push(describeMatch(r, it, cfg, opts.tz));
  });
  stats.matched = pairs.length;

  // 3. Everything else is new.
  var newItems = fresh.filter(function (it, i) { return !matchedItem[i]; });
  newItems.sort(function (a, b) { return a.time - b.time; });

  var newRows = newItems.map(function (it) { return makeNewRow(it, cfg); });
  if (cfg.key === 'purchases') assignInclure(newRows, rows, cfg, opts, warnings);

  var order = mergeOrder(rows, newRows);
  assignIds(order, rows, newRows, cfg, opts.renumber);
  stats.added = newRows.length;

  if (!opts.dryRun && (newRows.length || pairs.length || opts.renumber)) {
    writeSheet(sh, cfg, layout, rows, order, warnings);
  }

  return {
    sheet: cfg.name,
    stats: stats,
    added: newRows.slice(0, MAX_LISTED_ROWS).map(function (r) { return describeRow(r, cfg, opts.tz); }),
    matched: matchedRows.slice(0, MAX_LISTED_ROWS),
    newestTime: newestTime(rows.concat(newRows))
  };
}

/* ------------------------------------------------------------------------ */
/* Reading                                                                  */
/* ------------------------------------------------------------------------ */

function normHeader(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function readLayout(sh, cfg) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var byName = {};
  var lastHeaderCol = 0;
  headers.forEach(function (h, i) {
    var n = normHeader(h);
    if (n) {
      if (!(n in byName)) byName[n] = i + 1;
      lastHeaderCol = i + 1;
    }
  });
  var cols = {};
  var missing = [];
  var toCreate = [];
  Object.keys(cfg.fields).forEach(function (f) {
    var col = byName[normHeader(cfg.fields[f])];
    if (col) cols[f] = col;
    else if (cfg.create.indexOf(f) >= 0) toCreate.push(f);
    else missing.push(cfg.fields[f]);
  });
  if (missing.length) {
    throw new Error('Sheet "' + cfg.name + '": missing column(s) ' + missing.join(', ') + ' in row 1.');
  }
  return {
    cols: cols,
    toCreate: toCreate,
    lastHeaderCol: lastHeaderCol,
    lastCol: lastCol
  };
}

function readRows(sh, layout, tz) {
  var maxRows = sh.getMaxRows();
  if (maxRows < 2) return [];
  var c = layout.cols;
  var keyCols = [c.id, c.date, c.card];
  var width = Math.max.apply(null, Object.keys(c).map(function (k) { return c[k]; }));
  var block = sh.getRange(2, 1, maxRows - 1, width).getValues();

  var last = 0;
  for (var i = block.length - 1; i >= 0; i--) {
    var row = block[i];
    if (keyCols.some(function (col) { return !isBlank(row[col - 1]); })) { last = i + 1; break; }
  }
  if (!last) return [];

  var formulas = sh.getRange(2, 1, last, width).getFormulas();
  var rows = [];
  for (var r = 0; r < last; r++) {
    var values = {};
    var f = {};
    Object.keys(c).forEach(function (field) {
      values[field] = block[r][c[field] - 1];
      if (formulas[r][c[field] - 1]) f[field] = formulas[r][c[field] - 1];
    });
    rows.push({
      isNew: false,
      index: r,
      values: values,
      formulas: f,
      dirty: {},
      time: toTime(values.date, tz)
    });
  }
  return rows;
}

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function toTime(v, tz) {
  if (isDate(v)) return isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number' && isFinite(v)) {
    // Spreadsheet serial number (days since 1899-12-30), very unlikely with getValues().
    return Math.round((v - 25569) * 86400000);
  }
  if (typeof v === 'string' && v.trim()) {
    var m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m && typeof Utilities !== 'undefined' && Utilities.parseDate) {
      var s = pad(m[1], 2) + '/' + pad(m[2], 2) + '/' + m[3] + ' ' + pad(m[4] || '0', 2) + ':' + (m[5] || '00') + ':' + (m[6] || '00');
      try { return Utilities.parseDate(s, tz, 'dd/MM/yyyy HH:mm:ss').getTime(); } catch (e) { return null; }
    }
  }
  return null;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return NaN;
  var s = String(v).replace(/[\s  ]/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
}

function normText(s) {
  var t = String(s === null || s === undefined ? '' : s).trim().toLowerCase();
  return t.normalize ? t.normalize('NFC') : t;
}

/* ------------------------------------------------------------------------ */
/* Incoming data                                                            */
/* ------------------------------------------------------------------------ */

function sanitizeItems(list, kind, warnings) {
  if (!Array.isArray(list)) return [];
  var out = [];
  var bad = 0;
  list.forEach(function (it) {
    if (!it || !it.siteId || !isFinite(Number(it.time)) || !it.card || !isFinite(Number(it.price))) { bad++; return; }
    var item = {
      siteId: String(it.siteId),
      time: Number(it.time),
      card: String(it.card),
      rarity: it.rarity ? String(it.rarity) : '',
      price: Number(it.price),
      party: it.party ? String(it.party) : ''
    };
    if (kind === 'sales') item.status = it.status === STATUS_SOLD ? STATUS_SOLD : STATUS_UNSOLD;
    out.push(item);
  });
  if (bad) warnings.push(bad + ' ' + kind + ' item(s) ignored because they were incomplete.');
  return out;
}

function parseStartDate(s, tz) {
  if (!s) return null;
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Utilities.parseDate(m[3] + '/' + m[2] + '/' + m[1] + ' 00:00:00', tz, 'dd/MM/yyyy HH:mm:ss').getTime();
}

/* ------------------------------------------------------------------------ */
/* Matching hand-entered rows                                               */
/* ------------------------------------------------------------------------ */

/**
 * Pairs site items with existing rows that have no site id yet.
 * Same card and same price are required; the closest date wins, with
 * penalties when the status (sales) or the counterpart name differs.
 */
function fuzzyMatch(rows, items, cfg, windowMs) {
  var pairs = [];
  if (!windowMs) return pairs;
  var candidates = [];
  rows.forEach(function (r, j) {
    if (isBlank(r.values.siteId) && r.time !== null) {
      candidates.push({
        j: j,
        card: normText(r.values.card),
        price: toNumber(r.values.price),
        status: normText(r.values.status),
        party: normText(r.values.party),
        time: r.time
      });
    }
  });
  items.forEach(function (it, i) {
    var card = normText(it.card);
    var party = normText(it.party);
    var status = normText(it.status);
    candidates.forEach(function (c) {
      if (c.card !== card || c.price !== it.price) return;
      var dt = Math.abs(c.time - it.time);
      if (dt > windowMs) return;
      var cost = dt / HOUR_MS;
      if (cfg.key === 'sales' && c.status && c.status !== status) cost += PENALTY_STATUS;
      if (c.party && party && c.party !== party) cost += PENALTY_PARTY;
      pairs.push({ row: c.j, item: i, cost: cost });
    });
  });
  pairs.sort(function (a, b) { return a.cost - b.cost || a.row - b.row || a.item - b.item; });
  var usedRow = {};
  var usedItem = {};
  var out = [];
  pairs.forEach(function (p) {
    if (usedRow[p.row] || usedItem[p.item]) return;
    usedRow[p.row] = true;
    usedItem[p.item] = true;
    out.push(p);
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* New rows                                                                 */
/* ------------------------------------------------------------------------ */

function makeNewRow(it, cfg) {
  var values = {
    id: '',
    date: new Date(it.time),
    card: it.card,
    rarity: it.rarity,
    price: it.price,
    party: it.party,
    siteId: it.siteId
  };
  if (cfg.key === 'sales') values.status = it.status;
  if (cfg.key === 'purchases') values.inclure = '';
  return { isNew: true, values: values, formulas: {}, dirty: {}, time: it.time };
}

/**
 * Purchases dated inside the period you already tracked by hand (up to the
 * latest hand-entered row at the time of the first sync) were left out on
 * purpose, so they get "Non" and do not disturb the existing FIFO matching.
 * Later purchases get the default chosen in the extension options.
 */
function assignInclure(newRows, rows, cfg, opts, warnings) {
  if (!newRows.length) return;
  var props = PropertiesService.getScriptProperties();
  var key = 'CUTOFF_' + cfg.name;
  var stored = props.getProperty(key);
  var cutoff;
  if (stored === null || stored === undefined) {
    cutoff = rows.length ? newestTime(rows) : null;
    if (!opts.dryRun) props.setProperty(key, cutoff === null ? 'none' : String(cutoff));
  } else {
    cutoff = stored === 'none' ? null : Number(stored);
  }
  var included = {};
  rows.forEach(function (r) {
    if (normText(r.values.inclure) === 'oui') included[normText(r.values.card)] = true;
  });
  var backfilled = 0;
  newRows.forEach(function (r) {
    if (cutoff !== null && r.time <= cutoff) {
      r.values.inclure = 'Non';
      backfilled++;
    } else if (opts.inclureDefault === 'auto') {
      r.values.inclure = included[normText(r.values.card)] ? 'Oui' : 'Non';
    } else {
      r.values.inclure = opts.inclureDefault;
    }
  });
  if (backfilled) {
    warnings.push(backfilled + ' purchase(s) dated inside the period you tracked by hand were added with Inclure = "Non". Switch them to "Oui" if they are investments.');
  }
}

/**
 * Inserts the new rows (sorted by date) after the last existing row whose date
 * is not later than theirs. Existing rows keep their current relative order.
 */
function mergeOrder(rows, newRows) {
  var n = rows.length;
  var buckets = [];
  for (var k = 0; k <= n; k++) buckets.push([]);
  newRows.forEach(function (nr) {
    var pos = 0;
    for (var j = n - 1; j >= 0; j--) {
      if (rows[j].time !== null && rows[j].time <= nr.time) { pos = j + 1; break; }
    }
    buckets[pos].push(nr);
  });
  var order = [];
  for (var b = 0; b <= n; b++) {
    buckets[b].forEach(function (nr) { order.push(nr); });
    if (b < n) order.push(rows[b]);
  }
  return order;
}

function assignIds(order, rows, newRows, cfg, renumber) {
  var re = new RegExp('^' + cfg.prefix + '(\\d+)$', 'i');
  var width = 2;
  var max = 0;
  rows.forEach(function (r) {
    var m = String(r.values.id || '').trim().match(re);
    if (m) {
      max = Math.max(max, Number(m[1]));
      width = Math.max(width, m[1].length);
    }
  });
  if (renumber) {
    width = Math.max(width, String(order.length).length);
    order.forEach(function (r, i) {
      var id = cfg.prefix + pad(i + 1, width);
      if (r.values.id !== id) {
        r.values.id = id;
        r.dirty.id = true;
      }
    });
    return;
  }
  newRows.forEach(function (r) {
    max++;
    r.values.id = cfg.prefix + pad(max, width);
  });
}

function pad(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function newestTime(rows) {
  var t = null;
  rows.forEach(function (r) { if (r.time !== null && (t === null || r.time > t)) t = r.time; });
  return t;
}

/* ------------------------------------------------------------------------ */
/* Writing                                                                  */
/* ------------------------------------------------------------------------ */

function writeSheet(sh, cfg, layout, rows, order, warnings) {
  var cols = layout.cols;

  // Formula columns that must be copied down to new rows (row 2 holds a
  // per-row formula that is not an ARRAYFORMULA). Detected before any write.
  var rawCols = {};
  Object.keys(cols).forEach(function (f) { rawCols[cols[f]] = true; });
  var perRowFormulaCols = [];
  if (rows.length && layout.lastCol >= 1) {
    var row2 = sh.getRange(2, 1, 1, layout.lastCol).getFormulas()[0];
    row2.forEach(function (f, i) {
      if (f && !rawCols[i + 1] && !/^=\s*ARRAYFORMULA\s*\(/i.test(f)) perRowFormulaCols.push(i + 1);
    });
  }

  // Create the missing helper columns ("Acheteur", "ID site").
  var nextCol = layout.lastHeaderCol;
  layout.toCreate.forEach(function (f) {
    nextCol++;
    var cell = sh.getRange(1, nextCol);
    if (!isBlank(cell.getValue())) {
      throw new Error('Sheet "' + cfg.name + '": cannot create column "' + cfg.fields[f] + '", cell ' + cell.getA1Notation() + ' is not empty.');
    }
    if (sh.getMaxColumns() < nextCol) sh.insertColumnsAfter(sh.getMaxColumns(), nextCol - sh.getMaxColumns());
    cell.setValue(cfg.fields[f]);
    if (layout.lastHeaderCol >= 1) {
      sh.getRange(1, layout.lastHeaderCol).copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    cols[f] = nextCol;
  });
  layout.toCreate = [];

  var oldN = rows.length;
  var N = order.length;
  if (sh.getMaxRows() < N + 1) sh.insertRowsAfter(sh.getMaxRows(), N + 1 - sh.getMaxRows() + 50);

  // First position whose row changed (everything after it shifts).
  var firstMoved = N;
  for (var k = 0; k < N; k++) {
    if (k >= oldN || order[k] !== rows[k]) { firstMoved = k; break; }
  }

  Object.keys(cols).forEach(function (field) {
    var col = cols[field];
    var start = firstMoved;
    for (var i = 0; i < Math.min(firstMoved, N); i++) {
      if (order[i].dirty[field]) { start = i; break; }
    }
    if (start >= N) return;
    var values = [];
    for (var r = start; r < N; r++) {
      var v = order[r].values[field];
      values.push([v === null || v === undefined ? '' : v]);
    }
    sh.getRange(2 + start, col, N - start, 1).setValues(values);
    for (var r2 = start; r2 < N; r2++) {
      var f = order[r2].formulas[field];
      if (f) sh.getRange(2 + r2, col).setFormula(f);
    }
  });

  // Formatting, data validation and per-row formulas for the extra rows.
  if (N > oldN && oldN > 0) {
    var width = Math.max(sh.getLastColumn(), 1);
    var template = sh.getRange(oldN + 1, 1, 1, width);
    var target = sh.getRange(oldN + 2, 1, N - oldN, width);
    template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    template.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    perRowFormulaCols.forEach(function (col) {
      sh.getRange(2, col).copyTo(sh.getRange(oldN + 2, col, N - oldN, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
    });
  }

  cfg.hidden.forEach(function (f) { if (cols[f]) sh.hideColumns(cols[f]); });
  try {
    expandFilter(sh, N + 1);
  } catch (e) {
    warnings.push('Sheet "' + cfg.name + '": data written, but the filter could not be extended (' + ((e && e.message) || e) + '). Recreate the filter by hand if needed.');
  }
}

/** Makes the basic filter cover every data row and every column. */
function expandFilter(sh, lastRow) {
  var filter = sh.getFilter();
  if (!filter) return;
  var range = filter.getRange();
  var lastCol = Math.max(sh.getLastColumn(), range.getLastColumn());
  if (range.getLastRow() >= lastRow && range.getLastColumn() >= lastCol && range.getRow() === 1) return;
  var criteria = {};
  for (var c = range.getColumn(); c <= range.getLastColumn(); c++) {
    var crit = filter.getColumnFilterCriteria(c);
    if (crit) criteria[c] = crit;
  }
  filter.remove();
  var newFilter = sh.getRange(range.getRow(), range.getColumn(), Math.max(lastRow, range.getLastRow()) - range.getRow() + 1, lastCol - range.getColumn() + 1).createFilter();
  Object.keys(criteria).forEach(function (c) {
    try { newFilter.setColumnFilterCriteria(Number(c), criteria[c]); } catch (e) { /* empty criteria cannot be re-applied */ }
  });
}

/* ------------------------------------------------------------------------ */
/* Reporting                                                                */
/* ------------------------------------------------------------------------ */

function fmtTime(t, tz) {
  if (t === null || t === undefined) return '';
  return Utilities.formatDate(new Date(t), tz, 'dd/MM/yyyy HH:mm');
}

function describeRow(r, cfg, tz) {
  var d = {
    id: r.values.id,
    date: fmtTime(r.time, tz),
    card: r.values.card,
    rarity: r.values.rarity,
    price: r.values.price,
    party: r.values.party
  };
  if (cfg.key === 'sales') d.status = r.values.status;
  else d.inclure = r.values.inclure;
  return d;
}

function describeMatch(r, it, cfg, tz) {
  var notes = [];
  if (cfg.key === 'sales' && normText(r.values.status) !== normText(it.status)) {
    notes.push('status: sheet "' + r.values.status + '", site "' + it.status + '"');
  }
  var diffMin = Math.round(Math.abs(r.time - it.time) / 60000);
  if (diffMin >= 60) notes.push('time differs by ' + Math.floor(diffMin / 60) + 'h' + pad(diffMin % 60, 2));
  if (r.values.party && it.party && normText(r.values.party) !== normText(it.party)) {
    notes.push('name: sheet "' + r.values.party + '", site "' + it.party + '"');
  }
  return {
    id: r.values.id,
    row: r.index + 2,
    card: r.values.card,
    price: r.values.price,
    sheetDate: fmtTime(r.time, tz),
    siteDate: fmtTime(it.time, tz),
    notes: notes
  };
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function ping() {
  var ss = getSpreadsheet();
  return {
    ok: true,
    spreadsheet: ss.getName(),
    timeZone: ss.getSpreadsheetTimeZone(),
    sheets: [SHEETS.purchases.name, SHEETS.sales.name].map(function (n) {
      return { name: n, found: !!ss.getSheetByName(n) };
    })
  };
}

function getSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('No spreadsheet bound to this script. Run setup() from the spreadsheet\'s Apps Script editor.');
  return SpreadsheetApp.openById(id);
}

function checkSecret(secret) {
  var expected = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!expected) throw new Error('The script has no secret yet: run setup() once in the Apps Script editor.');
  if (!secret || String(secret) !== expected) throw new Error('Wrong secret. Copy it again from the Apps Script execution log.');
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another sync is running, try again in a moment.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
