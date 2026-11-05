/**
 * WikiMasters Trading → Google Sheets (Google Apps Script web app), version 2.
 *
 * The Firefox extension keeps the data and computes every statistic. This
 * script only writes what it receives into the spreadsheet it is bound to:
 *
 *   action "write"   creates/refreshes the tabs (Tableau de bord, Par jour,
 *                    Inventaire, Par carte, Par heure, Inflation, Prix dans le
 *                    temps, Achats, Ventes) with values, formats and charts.
 *                    Works on an empty spreadsheet: this is the template.
 *   action "readV1"  returns the rows of the Achats / Ventes tabs written by
 *                    version 1 (or by version 2), for the one-time import.
 *   action "ping"    connection test.
 *
 * Tabs written by this script are marked (developer metadata) and rewritten on
 * every export. A tab with the same name that was NOT written by it (your v1
 * tabs, for instance) is kept and renamed "<name> (v1)" the first time.
 *
 * Setup: see README.md (run setup() once, then deploy as a web app).
 */

var MARK_KEY = 'wikimasters-trading';
var MARK_VALUE = 'v2';

var COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
var HEADER_BG = '#1f4e3d';
var HEADER_FG = '#ffffff';

var NUMBER_FORMATS = {
  int: '#,##0',
  dec1: '0.0',
  dec2: '0.00',
  pct: '0.0%',
  datetime: 'dd/mm/yyyy hh:mm',
  date: 'dd/mm/yyyy'
};

/* ------------------------------------------------------------------------ */
/* Entry points                                                             */
/* ------------------------------------------------------------------------ */

function doGet() {
  return jsonOutput({ ok: true, service: 'wikimasters-trading', version: 2, message: 'Use POST.' });
}

function doPost(e) {
  var result;
  try {
    var body = (e && e.postData && e.postData.contents) || '{}';
    var req = JSON.parse(body);
    checkSecret(req.secret);
    if (req.action === 'ping') result = ping();
    else if (req.action === 'write') result = withLock(function () { return writeAll(req.tables || [], Number(req.index) || 0); });
    else if (req.action === 'readV1') result = readSheetRows();
    else throw new Error('Action inconnue : ' + req.action + '. Mettez à jour le script (Code.gs version 2).');
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
  Logger.log('Secret à coller dans les paramètres de l\'extension :\n' + secret);
  return secret;
}

/* ------------------------------------------------------------------------ */
/* Writing                                                                  */
/* ------------------------------------------------------------------------ */

/** startIndex: tab position of the first table (the extension sends one table per request). */
function writeAll(tables, startIndex) {
  var ss = getSpreadsheet();
  var warnings = [];
  var written = [];
  tables.forEach(function (t, i) {
    validateTable(t);
    var sh = managedSheet(ss, t.name, (startIndex || 0) + i, warnings);
    writeTable(sh, t, warnings);
    written.push({ name: t.name, rows: t.rows.length });
  });
  SpreadsheetApp.flush();
  return { ok: true, spreadsheet: ss.getName(), url: ss.getUrl ? ss.getUrl() : '', written: written, warnings: warnings };
}

function validateTable(t) {
  if (!t || !t.name || !Array.isArray(t.headers) || !Array.isArray(t.rows)) throw new Error('Tableau invalide reçu.');
  if (!t.headers.length) throw new Error('Tableau "' + t.name + '" sans colonnes.');
  t.rows.forEach(function (row, i) {
    if (!Array.isArray(row) || row.length !== t.headers.length) {
      throw new Error('Tableau "' + t.name + '", ligne ' + (i + 2) + ' : nombre de colonnes incorrect.');
    }
  });
  t.formats = Array.isArray(t.formats) ? t.formats : [];
  t.charts = Array.isArray(t.charts) ? t.charts : [];
}

function isManaged(sh) {
  return sh.getDeveloperMetadata().some(function (m) { return m.getKey() === MARK_KEY; });
}

function uniqueName(ss, base) {
  var name = base;
  var n = 2;
  while (ss.getSheetByName(name)) name = base + ' ' + n++;
  return name;
}

/** Returns the tab written by this script, creating it (and archiving a same-name tab) if needed. */
function managedSheet(ss, name, index, warnings) {
  var sh = ss.getSheetByName(name);
  if (sh && isManaged(sh)) return sh;
  if (sh) {
    var archived = uniqueName(ss, name + ' (v1)');
    sh.setName(archived);
    warnings.push('Onglet existant "' + name + '" conservé sous le nom "' + archived + '".');
  }
  var created = ss.insertSheet(name, Math.min(index, ss.getSheets().length));
  created.addDeveloperMetadata(MARK_KEY, MARK_VALUE);
  return created;
}

function convert(v, fmt) {
  if (v === null || v === undefined) return '';
  if ((fmt === 'datetime' || fmt === 'date') && typeof v === 'number') return new Date(v);
  return v;
}

function writeTable(sh, t, warnings) {
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  var filter = sh.getFilter();
  if (filter) filter.remove();
  sh.clear();

  var nRows = t.rows.length + 1;
  var nCols = t.headers.length;
  if (sh.getMaxRows() < nRows + 1) sh.insertRowsAfter(sh.getMaxRows(), nRows + 1 - sh.getMaxRows());
  if (sh.getMaxColumns() < nCols) sh.insertColumnsAfter(sh.getMaxColumns(), nCols - sh.getMaxColumns());

  var data = [t.headers.slice()];
  t.rows.forEach(function (row) {
    data.push(row.map(function (v, c) { return convert(v, t.formats[c]); }));
  });
  sh.getRange(1, 1, nRows, nCols).setValues(data);

  sh.getRange(1, 1, 1, nCols)
    .setFontWeight('bold')
    .setBackground(HEADER_BG)
    .setFontColor(HEADER_FG)
    .setWrap(true)
    .setVerticalAlignment('middle');
  if (t.rows.length) {
    t.formats.forEach(function (f, c) {
      if (NUMBER_FORMATS[f]) sh.getRange(2, c + 1, t.rows.length, 1).setNumberFormat(NUMBER_FORMATS[f]);
    });
  }
  sh.setFrozenRows(1);
  sh.setFrozenColumns(t.freezeCols || 0);
  if (t.filter && t.rows.length) sh.getRange(1, 1, nRows, nCols).createFilter();
  sh.autoResizeColumns(1, nCols);

  if (!t.rows.length) return;
  t.charts.forEach(function (spec, i) {
    try {
      insertChart(sh, spec, nRows, nCols, i);
    } catch (e) {
      warnings.push('Graphique "' + spec.title + '" non créé : ' + ((e && e.message) || e));
    }
  });
}

function insertChart(sh, spec, nRows, nCols, i) {
  var types = {
    COLUMN: Charts.ChartType.COLUMN,
    LINE: Charts.ChartType.LINE,
    AREA: Charts.ChartType.AREA,
    SCATTER: Charts.ChartType.SCATTER
  };
  var type = types[spec.type];
  if (!type) throw new Error('type inconnu ' + spec.type);
  var b = sh.newChart()
    .setChartType(type)
    .setMergeStrategy(Charts.ChartMergeStrategy.MERGE_COLUMNS)
    .setNumHeaders(1)
    .addRange(sh.getRange(1, spec.domain + 1, nRows, 1));
  spec.series.forEach(function (c) { b.addRange(sh.getRange(1, c + 1, nRows, 1)); });
  b.setPosition(2 + i * 22, nCols + 2, 0, 0)
    .setOption('title', spec.title)
    .setOption('width', 640)
    .setOption('height', 380)
    .setOption('colors', COLORS)
    .setOption('legend', { position: spec.legend || 'bottom' });
  if (spec.stacked) b.setOption('isStacked', true);
  if (spec.type === 'SCATTER') b.setOption('pointSize', 6);
  if (spec.type === 'LINE') b.setOption('pointSize', 5).setOption('lineWidth', 2);
  sh.insertChart(b.build());
}

/* ------------------------------------------------------------------------ */
/* Reading (one-time import)                                                */
/* ------------------------------------------------------------------------ */

function normHeader(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function toTime(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v.getTime();
  return null;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  var s = String(v === null || v === undefined ? '' : v).replace(/[\s  ]/g, '').replace(',', '.');
  return s === '' ? null : Number(s);
}

/** Prefers the archived v1 tab, then a non-managed tab, then the v2 tab. */
function findSource(ss, base) {
  var candidates = [ss.getSheetByName(base + ' (v1)'), ss.getSheetByName(base)].filter(function (s) { return !!s; });
  var v1 = candidates.filter(function (s) { return !isManaged(s); })[0];
  return v1 || candidates[0] || null;
}

function readTab(sh, fields) {
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var cols = {};
  values[0].forEach(function (h, i) { cols[normHeader(h)] = i; });
  var get = function (row, name) {
    var c = cols[normHeader(name)];
    return c === undefined ? '' : row[c];
  };
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var card = String(get(row, 'Carte') || '').trim();
    if (!card) continue;
    var rec = {
      label: String(get(row, 'ID') || '').trim(),
      time: toTime(get(row, 'Date/heure')),
      card: card,
      rarity: String(get(row, 'Rareté') || ''),
      price: toNumber(get(row, 'Prix (W)')),
      siteId: String(get(row, 'ID site') || '').trim()
    };
    fields(rec, function (name) { return get(row, name); }, cols);
    out.push(rec);
  }
  return out;
}

function readSheetRows() {
  var ss = getSpreadsheet();
  var a = findSource(ss, 'Achats');
  var v = findSource(ss, 'Ventes');
  if (!a && !v) throw new Error('Aucun onglet "Achats" ou "Ventes" trouvé.');
  var purchases = a ? readTab(a, function (rec, get, cols) {
    rec.party = String(get('Vendeur') || '');
    if (cols[normHeader('Inclure')] !== undefined) rec.inclure = String(get('Inclure') || '');
    if (cols[normHeader('Exclue')] !== undefined) rec.excluded = String(get('Exclue')) === 'Oui';
  }) : [];
  var sales = v ? readTab(v, function (rec, get, cols) {
    rec.status = String(get('Statut') || '');
    rec.party = String(get('Acheteur') || '');
    if (cols[normHeader('Exclue')] !== undefined) rec.excluded = String(get('Exclue')) === 'Oui';
  }) : [];
  return {
    ok: true,
    sheets: [a ? a.getName() : null, v ? v.getName() : null].filter(function (n) { return !!n; }),
    purchases: purchases,
    sales: sales
  };
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function ping() {
  var ss = getSpreadsheet();
  return { ok: true, version: 2, spreadsheet: ss.getName(), timeZone: ss.getSpreadsheetTimeZone() };
}

function getSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Aucune feuille liée à ce script. Lancez setup() depuis l\'éditeur Apps Script de la feuille.');
  return SpreadsheetApp.openById(id);
}

function checkSecret(secret) {
  var expected = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!expected) throw new Error('Le script n\'a pas encore de secret : lancez setup() une fois dans l\'éditeur Apps Script.');
  if (!secret || String(secret) !== expected) throw new Error('Secret incorrect. Recopiez-le depuis le journal d\'exécution de setup().');
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Un autre export est en cours, réessayez dans un instant.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
