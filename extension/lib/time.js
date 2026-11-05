/*
 * Date helpers working in a fixed time zone (Europe/Paris by default, like the
 * site). Days are identified by "YYYY-MM-DD" keys.
 */
(function (root) {
  'use strict';

  var TZ = 'Europe/Paris';
  var formatters = {};

  function partsFormatter(tz) {
    if (!formatters[tz]) {
      formatters[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    return formatters[tz];
  }

  function parts(ms, tz) {
    var out = {};
    partsFormatter(tz || TZ).formatToParts(new Date(ms)).forEach(function (p) { out[p.type] = p.value; });
    return {
      y: Number(out.year), mo: Number(out.month), d: Number(out.day),
      h: Number(out.hour), mi: Number(out.minute), s: Number(out.second)
    };
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** Offset (ms) of tz at instant ms: local wall clock - UTC. */
  function offset(ms, tz) {
    var p = parts(ms, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }

  /** Local wall-clock time in tz -> epoch ms. */
  function fromLocal(y, mo, d, h, mi, tz) {
    var guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, 0);
    var t = guess - offset(guess, tz);
    return guess - offset(t, tz);
  }

  function dayKey(ms, tz) {
    var p = parts(ms, tz);
    return p.y + '-' + pad(p.mo) + '-' + pad(p.d);
  }

  function parseKey(key) {
    var m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error('Bad day key ' + key);
    return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  }

  function dayStart(key, tz) {
    var k = parseKey(key);
    return fromLocal(k.y, k.mo, k.d, 0, 0, tz);
  }

  function nextDay(key) {
    var k = parseKey(key);
    var t = new Date(Date.UTC(k.y, k.mo - 1, k.d + 1, 12));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }

  function addDays(key, n) {
    var k = parseKey(key);
    var t = new Date(Date.UTC(k.y, k.mo - 1, k.d + n, 12));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }

  /** Last millisecond of the day. */
  function dayEnd(key, tz) {
    return dayStart(nextDay(key), tz) - 1;
  }

  function hourOf(ms, tz) {
    return parts(ms, tz).h;
  }

  /** 1 = Monday ... 7 = Sunday */
  function weekdayOf(ms, tz) {
    var p = parts(ms, tz);
    var wd = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
    return wd === 0 ? 7 : wd;
  }

  function formatDateTime(ms, tz) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '';
    var p = parts(ms, tz);
    return pad(p.d) + '/' + pad(p.mo) + '/' + p.y + ' ' + pad(p.h) + ':' + pad(p.mi);
  }

  function formatDay(key) {
    var k = parseKey(key);
    return pad(k.d) + '/' + pad(k.mo) + '/' + k.y;
  }

  /** "YYYY-MM-DD" (local midnight) -> ms, or null. */
  function parseDateInput(s, tz) {
    if (!s) return null;
    try { return dayStart(String(s), tz); } catch (e) { return null; }
  }

  var api = {
    TZ: TZ, dayKey: dayKey, dayStart: dayStart, dayEnd: dayEnd, nextDay: nextDay, addDays: addDays,
    hourOf: hourOf, weekdayOf: weekdayOf, formatDateTime: formatDateTime, formatDay: formatDay,
    parseDateInput: parseDateInput, fromLocal: fromLocal
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
