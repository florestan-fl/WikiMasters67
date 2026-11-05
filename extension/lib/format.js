/*
 * Small DOM and number-formatting helpers shared by the extension pages.
 * Text is always inserted with textContent (card and player names come from the site).
 */
(function (root) {
  'use strict';

  var NF0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  var NF1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var NF2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function ok(x) { return x !== null && x !== undefined && isFinite(x); }

  function w(x) { return ok(x) ? NF0.format(Math.round(x)) : '–'; }
  function wUnit(x) { return ok(x) ? NF0.format(Math.round(x)) + ' W' : '–'; }
  function signed(x) {
    if (!ok(x)) return '–';
    var r = Math.round(x);
    return (r > 0 ? '+' : r < 0 ? '−' : '') + NF0.format(Math.abs(r));
  }
  function signedUnit(x) { return ok(x) ? signed(x) + ' W' : '–'; }
  function pct(x) { return ok(x) ? NF1.format(x * 100) + ' %' : '–'; }
  function dec1(x) { return ok(x) ? NF1.format(x) : '–'; }
  function dec2(x) { return ok(x) ? NF2.format(x) : '–'; }
  function signClass(x) { return !ok(x) || Math.round(x) === 0 ? '' : x > 0 ? 'pos' : 'neg'; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  /** Stat tile: label, value, optional sub line. valueClass colours the value text (signed deltas). */
  function tile(label, value, sub, valueClass) {
    return el('div', { class: 'tile card' },
      el('div', { class: 'label', text: label }),
      el('div', { class: 'value ' + (valueClass || ''), text: value }),
      sub ? el('div', { class: 'sub', text: sub }) : null);
  }

  /**
   * columns: [{ label, value: row => any, format: fn, num: bool, cls: row => string }]
   */
  function table(columns, rows, opts) {
    opts = opts || {};
    return el('div', { class: 'table-wrap', style: opts.maxHeight ? 'max-height:' + opts.maxHeight : null },
      el('table', null,
        el('thead', null, el('tr', null, columns.map(function (c) {
          return el('th', { class: c.num ? 'num' : null, text: c.label, title: c.title || null });
        }))),
        el('tbody', null, rows.map(function (r) {
          return el('tr', { class: opts.rowClass ? opts.rowClass(r) : null }, columns.map(function (c) {
            var v = c.value(r);
            if (v instanceof Node) return el('td', { class: c.num ? 'num' : null }, v);
            var text = c.format ? c.format(v) : (v === null || v === undefined ? '' : String(v));
            var cls = [c.num ? 'num' : '', c.cls ? c.cls(r, v) : ''].join(' ').trim();
            return el('td', { class: cls || null, text: text });
          }));
        }))));
  }

  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  root.WMFormat = {
    w: w, wUnit: wUnit, signed: signed, signedUnit: signedUnit, pct: pct, dec1: dec1, dec2: dec2,
    signClass: signClass, el: el, tile: tile, table: table, download: download
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
