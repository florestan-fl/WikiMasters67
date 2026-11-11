/* global browser */
/*
 * Runs on wiki-masters.com pages. It never sends requests to the site.
 *  - Reads your wikibidous balance from the page header (read-only).
 *  - If enabled in the settings, adds a small market-price badge under the
 *    price of each auction ("Mise actuelle" / "Mise de départ"): median of
 *    observed sales and the gap with the current price. Only adds elements
 *    (class wmt-*), never changes the game's own text.
 */
(function () {
  'use strict';

  if (window.__wmtLoaded) return;
  window.__wmtLoaded = true;

  var LABEL_RE = /^\s*mise\s+(de\s+d[ée]part|actuelle)\s*$/i;
  var UUID_RE = /\/marketplace\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  var NF = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  var enabled = true;
  var timer = null;
  var lastBalance = null;
  var lastBalanceSent = 0;

  /* ----------------------------------------------------------- balance */

  function readBalance() {
    var el = document.querySelector('[title*="wikibidous" i]');
    if (!el) return null;
    var m = String(el.getAttribute('title')).match(/(\d[\d\s  .]*)\s*wikibidous/i);
    return m ? Number(m[1].replace(/\D/g, '')) : null;
  }

  function sendBalance() {
    var v = readBalance();
    if (v === null) return;
    var now = Date.now();
    if (v === lastBalance && now - lastBalanceSent < 10 * 60000) return;
    lastBalance = v;
    lastBalanceSent = now;
    browser.runtime.sendMessage({ type: 'balance', value: v }).catch(function () {});
  }

  /* ---------------------------------------------------------- full art */
  // One attribute on <html> lists the rarities drawn full art; content/fullart.css
  // does the rest. React 19 wipes every attribute of <html> when it (re)acquires
  // it, so an observer of those attributes puts them back.
  // Landscape pictures: CSS cannot see an image's proportions, so while full art
  // is on, each card picture (img[crossorigin]) is measured when it loads and a
  // wide one gets data-wmt-wide, plus its address in --wmt-fa-bg on its picture
  // zone for the blurred backdrop. data-wmt-fullart-wide on <html> picks what the
  // CSS does with them (fit / skip / crop).
  var FULL_ART = 'data-wmt-fullart';
  var FULL_ART_WIDE = 'data-wmt-fullart-wide';
  var WIDE = 'data-wmt-wide';
  var WIDE_RATIO = 1.1; // width / height above which a picture counts as landscape
  var fullArt = '';
  var fullArtWide = 'fit';
  var fullArtGuard = null;

  function putAttrs() {
    var root = document.documentElement;
    if (root.getAttribute(FULL_ART) !== fullArt) root.setAttribute(FULL_ART, fullArt);
    if (root.getAttribute(FULL_ART_WIDE) !== fullArtWide) root.setAttribute(FULL_ART_WIDE, fullArtWide);
  }

  function measure(img) {
    if (!img.naturalWidth || !img.naturalHeight) return;
    var wide = img.naturalWidth / img.naturalHeight > WIDE_RATIO;
    var zone = img.closest('[class*="h-[45%]"]');
    if (wide) {
      if (!img.hasAttribute(WIDE)) img.setAttribute(WIDE, '');
      var url = 'url("' + String(img.currentSrc || img.src).replace(/["\\\n]/g, encodeURIComponent) + '")';
      if (zone && zone.style.getPropertyValue('--wmt-fa-bg') !== url) zone.style.setProperty('--wmt-fa-bg', url);
    } else if (img.hasAttribute(WIDE)) {
      img.removeAttribute(WIDE);
    }
  }

  function onImageLoad(e) {
    var t = e.target;
    if (fullArt && t && t.tagName === 'IMG' && t.hasAttribute('crossorigin')) measure(t);
  }
  document.addEventListener('load', onImageLoad, true);

  function applyFullArt(settings) {
    var f = settings && settings.features;
    fullArt = f && f.fullArt && Array.isArray(f.fullArtRarities)
      ? f.fullArtRarities.map(function (r) { return String(r).toLowerCase(); }).join(' ') : '';
    fullArtWide = f && ['fit', 'skip', 'crop'].indexOf(f.fullArtWide) >= 0 ? f.fullArtWide : 'fit';
    var root = document.documentElement;
    if (fullArt) {
      putAttrs();
      if (!fullArtGuard) {
        fullArtGuard = new MutationObserver(function () { if (fullArt) putAttrs(); });
        fullArtGuard.observe(root, { attributes: true, attributeFilter: [FULL_ART, FULL_ART_WIDE] });
      }
      var imgs = document.querySelectorAll('img[crossorigin]');
      for (var i = 0; i < imgs.length; i++) if (imgs[i].complete) measure(imgs[i]);
    } else {
      if (fullArtGuard) fullArtGuard.disconnect();
      fullArtGuard = null;
      root.removeAttribute(FULL_ART);
      root.removeAttribute(FULL_ART_WIDE);
    }
  }

  browser.storage.local.get('settings').then(function (d) { applyFullArt(d.settings); }).catch(function () {});
  browser.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.settings) applyFullArt(changes.settings.newValue);
  });

  /* ----------------------------------------------------------- overlay */

  function isOurs(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest('.wmt-badge'));
  }

  function findLabels() {
    var out = [];
    if (!document.body) return out;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.nodeValue && n.nodeValue.length < 40 && LABEL_RE.test(n.nodeValue) && !isOurs(n)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    while (walker.nextNode()) out.push(walker.currentNode.parentElement);
    return out;
  }

  /** Largest ancestor of the label that contains no other price label: the auction tile. */
  function tileOf(label, labels) {
    var el = label;
    while (el.parentElement && el.parentElement !== document.body) {
      var p = el.parentElement;
      var count = 0;
      for (var i = 0; i < labels.length && count < 2; i++) if (p.contains(labels[i])) count++;
      if (count > 1) break;
      el = p;
    }
    return el;
  }

  function auctionIdOf(tile) {
    var a = tile.matches && tile.matches('a[href]') ? tile : tile.querySelector('a[href*="/marketplace/"]') || tile.closest('a[href*="/marketplace/"]');
    var m = a && String(a.getAttribute('href')).match(UUID_RE);
    if (m) return m[1].toLowerCase();
    // Auction page: the main price block belongs to the auction in the URL.
    var p = location.pathname.match(UUID_RE);
    if (p && !tile.closest('a[href]')) return p[1].toLowerCase();
    return null;
  }

  function pct(x) {
    var v = Math.round(x * 100);
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' %';
  }

  var groups = []; // your groups ({ id, name, color }), for the "+ Suivre" menu

  /** "+ Suivre" with groups: a small menu (in the badge) to choose the group. */
  function followMenu(info, button, stop) {
    var old = button.parentElement.querySelector('.wmt-menu');
    if (old) { old.remove(); return; }
    var menu = document.createElement('div');
    menu.className = 'wmt-menu';
    menu.setAttribute('role', 'menu');
    var choices = groups.map(function (g) { return { id: g.id, name: g.name, color: g.color }; })
      .concat([{ id: '', name: 'Sans groupe', color: '' }]);
    choices.forEach(function (c) {
      var item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      if (c.color) {
        var dot = document.createElement('span');
        dot.className = 'wmt-dot';
        dot.style.background = c.color;
        item.appendChild(dot);
      }
      item.appendChild(document.createTextNode(c.name));
      item.addEventListener('click', function (e) {
        stop(e);
        button.disabled = true;
        menu.remove();
        browser.runtime.sendMessage({ type: 'follow', card: info.card, group: c.id }).catch(function () {});
      });
      menu.appendChild(item);
    });
    button.insertAdjacentElement('afterend', menu);
  }

  function badgeFor(info) {
    var b = document.createElement('div');
    b.className = 'wmt-badge';
    b.dataset.wmtSig = signature(info);
    var stop = function (e) { e.preventDefault(); e.stopPropagation(); };
    if (info.group) {
      var gd = document.createElement('span');
      gd.className = 'wmt-dot';
      gd.style.background = info.group.color;
      gd.title = info.group.name;
      b.appendChild(gd);
    }

    if (info.median !== null && info.median !== undefined) {
      var med = document.createElement('button');
      med.type = 'button';
      med.className = 'wmt-median';
      med.textContent = 'Médiane ' + NF.format(Math.round(info.median));
      var tip = info.n + ' vente' + (info.n > 1 ? 's' : '') + ' observée' + (info.n > 1 ? 's' : '');
      if (info.p25 !== null) tip += ' · P25–P75 ' + NF.format(Math.round(info.p25)) + '–' + NF.format(Math.round(info.p75));
      if (info.trend7 !== null && info.trend7 !== undefined) tip += ' · tendance 7 j ' + pct(info.trend7);
      med.title = tip + ' · cliquer pour le détail';
      med.addEventListener('click', function (e) {
        stop(e);
        browser.runtime.sendMessage({ type: 'openDashboard', hash: '#market/' + encodeURIComponent(info.key) }).catch(function () {});
      });
      b.appendChild(med);
      if (info.diff !== null && info.diff !== undefined) {
        var pill = document.createElement('span');
        pill.className = 'wmt-pill wmt-' + info.deal;
        pill.textContent = pct(info.diff);
        pill.title = (info.hasBid
          ? 'Prochaine enchère minimale ' + NF.format(info.next) + ' (enchère actuelle + 10 %)'
          : 'Mise de départ ' + NF.format(info.next)) + ' par rapport à la médiane';
        b.appendChild(pill);
      }
    } else if (info.tracked) {
      var none = document.createElement('span');
      none.className = 'wmt-muted';
      none.textContent = 'Pas encore de vente observée';
      b.appendChild(none);
    }
    if (!info.tracked) {
      var f = document.createElement('button');
      f.type = 'button';
      f.className = 'wmt-follow';
      f.textContent = '+ Suivre';
      f.title = groups.length ? 'Suivre « ' + info.card + ' » : choisir son groupe' : 'Ajouter « ' + info.card + ' » à vos cartes suivies';
      f.addEventListener('click', function (e) {
        stop(e);
        if (groups.length) { followMenu(info, f, stop); return; }
        f.disabled = true;
        browser.runtime.sendMessage({ type: 'follow', card: info.card }).catch(function () {});
      });
      b.appendChild(f);
    }
    return b;
  }

  function signature(info) {
    return [info.id, info.price, info.next, Math.round(info.median || 0), info.n, info.tracked ? 1 : 0, info.group ? info.group.id + info.group.color : ''].join('|');
  }

  function insertionPoint(label, tile) {
    var block = label.parentElement && label.parentElement !== tile && tile.contains(label.parentElement) ? label.parentElement : label;
    return block;
  }

  async function scan() {
    timer = null;
    sendBalance();
    if (!enabled) { removeAll(); return; }
    var labels = findLabels();
    if (!labels.length) return;
    var tiles = labels.map(function (label, i) {
      var tile = tileOf(label, labels);
      return { ref: i, label: label, tile: tile, id: auctionIdOf(tile), text: tile.innerText ? tile.innerText.slice(0, 400) : tile.textContent.slice(0, 400) };
    });
    var res;
    try {
      res = await browser.runtime.sendMessage({
        type: 'overlayInfo',
        tiles: tiles.map(function (t) { return { ref: t.ref, id: t.id, text: t.id ? '' : t.text }; })
      });
    } catch (e) {
      return;
    }
    if (!res || !res.ok) return;
    if (!res.enabled) { enabled = false; removeAll(); return; }
    groups = Array.isArray(res.groups) ? res.groups : [];
    var byRef = {};
    (res.items || []).forEach(function (it) { byRef[it.ref] = it; });
    observer.disconnect();
    try {
      tiles.forEach(function (t) {
        var info = byRef[t.ref];
        var anchor = insertionPoint(t.label, t.tile);
        var existing = anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('wmt-badge') ? anchor.nextElementSibling : null;
        if (!info || !info.found) { if (existing) existing.remove(); return; }
        if (existing && existing.dataset.wmtSig === signature(info)) return;
        var badge = badgeFor(info);
        if (existing) existing.replaceWith(badge); else anchor.insertAdjacentElement('afterend', badge);
      });
    } finally {
      observe();
    }
  }

  function removeAll() {
    document.querySelectorAll('.wmt-badge').forEach(function (b) { b.remove(); });
  }

  function schedule(delay) {
    if (timer) return;
    timer = setTimeout(scan, delay === undefined ? 400 : delay);
  }

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (!isOurs(mutations[i].target)) { schedule(); return; }
    }
  });

  function observe() {
    if (document.body) observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  browser.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'marketUpdated') {
      enabled = true;
      document.querySelectorAll('.wmt-badge').forEach(function (b) { b.dataset.wmtSig = ''; });
      schedule(200);
    }
  });

  observe();
  schedule(800);
})();
