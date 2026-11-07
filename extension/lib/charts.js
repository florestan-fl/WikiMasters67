/* global Chart */
/*
 * Thin layer over Chart.js applying one set of conventions to every chart:
 * validated categorical palette (fixed slot order), bars <= 24px with a 4px
 * rounded end, 2px lines, 8px points with a surface ring, hairline grid,
 * legend only from 2 series, tooltips on hover, French number format.
 */
(function (root) {
  'use strict';

  var NF = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  var NF2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
  var registry = {};

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function theme() {
    var series = [];
    for (var i = 1; i <= 8; i++) series.push(css('--series-' + i));
    return {
      series: series,
      surface: css('--surface'),
      text: css('--fg'),
      text2: css('--fg-2'),
      muted: css('--muted'),
      grid: css('--grid'),
      axis: css('--axis')
    };
  }

  function fmtValue(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    if (unit === 'pct') return NF2.format(Math.round(v * 1000) / 10) + ' %';
    if (unit === 'idx') return NF2.format(v);
    return NF.format(Math.round(v)) + (unit === 'W' ? ' W' : '');
  }

  function compactTick(v, unit) {
    if (unit === 'pct') return Math.round(v * 100) + ' %';
    if (unit === 'idx') return NF2.format(v);
    var a = Math.abs(v);
    if (a >= 10000) return NF.format(v / 1000) + ' k';
    return NF.format(v);
  }

  function destroy(id) {
    if (registry[id]) {
      registry[id].destroy();
      delete registry[id];
    }
  }

  function baseOptions(t, opts) {
    var multi = opts.datasets.length > 1;
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: opts.type === 'scatter' ? 'nearest' : 'index', intersect: opts.type === 'scatter' },
      plugins: {
        legend: {
          display: multi,
          position: 'bottom',
          labels: { color: t.text2, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 14 }
        },
        tooltip: {
          backgroundColor: t.surface,
          titleColor: t.text,
          bodyColor: t.text2,
          borderColor: t.axis,
          borderWidth: 1,
          padding: 10,
          boxPadding: 4,
          usePointStyle: true,
          callbacks: {
            title: opts.tooltipTitle || undefined,
            label: function (ctx) {
              var v = opts.type === 'scatter' ? ctx.parsed.y : (opts.horizontal ? ctx.parsed.x : ctx.parsed.y);
              return ' ' + ctx.dataset.label + ' : ' + fmtValue(v, opts.unit);
            }
          }
        }
      },
      indexAxis: opts.horizontal ? 'y' : 'x',
      scales: opts.horizontal ? {
        y: {
          type: 'category',
          grid: { display: false, drawTicks: false },
          border: { color: t.axis },
          ticks: { color: t.text2, autoSkip: false, padding: 6 }
        },
        x: {
          beginAtZero: true,
          grid: { color: t.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: t.muted, padding: 6, callback: function (v) { return compactTick(v, opts.unit); } }
        }
      } : {
        x: {
          type: opts.xType || 'category',
          stacked: !!opts.stacked,
          grid: { display: opts.type === 'scatter', color: t.grid, drawTicks: false },
          border: { color: t.axis },
          ticks: Object.assign({ color: t.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, opts.xTicks || {})
        },
        y: {
          stacked: !!opts.stacked,
          beginAtZero: opts.type !== 'scatter' && opts.type !== 'line' ? true : !!opts.beginAtZero,
          grid: { color: t.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: t.muted, padding: 6, callback: function (v) { return compactTick(v, opts.unit); } }
        }
      }
    };
  }

  /**
   * opts: { type: 'bar'|'line'|'scatter', labels, datasets: [{ label, data, slot }],
   *         unit: 'W'|'pct'|'idx'|'', stacked, xType, xTicks, tooltipTitle }
   * slot = palette slot (0-based), fixed per entity so colours never move.
   */
  function render(canvasId, opts) {
    destroy(canvasId);
    var canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    var wrap = canvas.parentNode;
    var empty = wrap.querySelector('.chart-empty');
    var hasData = opts.datasets.some(function (d) {
      return d.data.some(function (v) { return v !== null && v !== undefined && (typeof v !== 'object' || v.y !== null); });
    });
    if (empty) empty.hidden = hasData;
    canvas.hidden = !hasData;
    if (opts.horizontal) {
      var bands = (opts.labels || []).length * Math.max(1, opts.datasets.length);
      wrap.style.height = Math.max(160, 40 + bands * 22 + (opts.datasets.length > 1 ? 30 : 0)) + 'px';
    }
    if (!hasData) return null;

    var t = theme();
    var datasets = opts.datasets.map(function (d, i) {
      var color = t.series[(d.slot === undefined ? i : d.slot) % t.series.length];
      var base = { label: d.label, data: d.data };
      if (opts.type === 'bar') {
        return Object.assign(base, {
          backgroundColor: color,
          borderColor: opts.stacked ? t.surface : color,
          borderWidth: opts.stacked ? { top: 2, bottom: 0, left: 0, right: 0 } : 0,
          borderRadius: opts.stacked ? 0 : 4,
          borderSkipped: 'start',
          maxBarThickness: 24,
          categoryPercentage: 0.8,
          barPercentage: 0.9
        });
      }
      if (opts.type === 'scatter' && d.line) {
        return Object.assign(base, {
          showLine: true,
          borderColor: color,
          backgroundColor: color,
          borderWidth: 2,
          pointRadius: d.points ? 4 : 0,
          pointHoverRadius: d.points ? 6 : 4,
          pointHitRadius: 8,
          pointBorderColor: t.surface,
          pointBorderWidth: d.points ? 2 : 0,
          pointStyle: d.pointStyle || 'circle',
        });
      }
      if (opts.type === 'scatter') {
        return Object.assign(base, {
          backgroundColor: color,
          borderColor: t.surface,
          borderWidth: 2,
          pointRadius: d.pointStyle && d.pointStyle !== 'circle' ? 7 : 5,
          pointHoverRadius: d.pointStyle && d.pointStyle !== 'circle' ? 9 : 7,
          pointStyle: d.pointStyle || 'circle'
        });
      }
      return Object.assign(base, {
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        pointRadius: opts.points === false ? 0 : 4,
        pointHoverRadius: 6,
        pointBorderColor: t.surface,
        pointBorderWidth: 2,
        spanGaps: true,
        tension: 0
      });
    });
    var config = {
      type: opts.type,
      data: { labels: opts.labels, datasets: datasets },
      options: baseOptions(t, opts)
    };
    registry[canvasId] = new Chart(canvas, config);
    return registry[canvasId];
  }

  function destroyAll() {
    Object.keys(registry).forEach(destroy);
  }

  root.WMCharts = { render: render, destroy: destroy, destroyAll: destroyAll, fmtValue: fmtValue };
})(typeof globalThis !== 'undefined' ? globalThis : this);
