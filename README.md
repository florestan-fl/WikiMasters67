# WikiMasters Trading

A Firefox extension for [WikiMasters](https://www.wiki-masters.com/) players who trade on the marketplace:

* **Your trades:** every purchase and sale is recorded. You get the profit per day (realized and estimated), the value of your stock, and your best cards and hours.
* **Market prices:** the median sale price, price range and trend for the cards you follow. Directly under the auctions on the site, the extension shows how the current price compares with the median.
* **Deals:** auctions you see that cost well below the median are listed in the popup, with an optional Firefox notification.
* **Google Sheets (optional):** the extension fills in a spreadsheet, with charts, that you can read from anywhere.

Every player picks their own cards in the settings. Nothing in the code or the spreadsheet is specific to one player.

## Passive by default

By default the extension **never** makes a request to wiki-masters.com: no API call, no background tab, no automatic page reload. It only reads what **your** browser already receives while you play. The one exception is the optional automatic reading of final prices, described below, which is off by default.

| What | How | Visible to the site? |
|---|---|---|
| Your purchases (*Gagnées*), sales (*Historique*), active listings, auctions shown on the Marché | When **your** Marché page loads `/api/marketplace…`, Firefox gives the extension a copy of the response while passing it **unchanged** to the page (`webRequest.filterResponseData`) | No |
| Your wikibidous balance | Read from the page header by the content script (read only) | No |
| Market badge under the prices (optional) | Small elements **added** under "Mise actuelle / Mise de départ". The game's text is never modified | **Yes**: a change on the page. Turn it off in *Fonctionnalités* |
| Full art (optional, **off** by default) | A stylesheet that stretches the illustration over the whole card, for the rarities you choose. No element is added or moved; landscape pictures get a `data-wmt-wide` mark | **Yes**: the page looks different |
| Deals list and notifications | Computed from the auctions already received while you browse | No |
| Final prices of ended auctions (optional, **off** by default) | One request per auction of a followed card, at a fixed interval (see below) | **Yes**: these are requests sent by the extension |

So, to record your transactions, **open the Marché at least every 2 days**. The site only lists your last 50 purchases and 50 sales, and the extension warns you if some may have been missed.

> ⚠️ The game's rules (`/rules`) forbid scripts and "interception du trafic … pour obtenir un avantage". Making no requests keeps the extension invisible on the network side. But no extension is undetectable: the market badges are part of the page, and the extension reads the site's responses. If in doubt, ask the game's developer whether this kind of tool is allowed, or turn off the market badges.

### Where market prices come from

* **Your sales** (Historique).
* **Other players' sales** whose final price was seen: an ended auction you open, or the automatic reading below.
* **Estimates "≈"**: when an auction you saw with a bid less than 30 minutes before its end finishes without its final price being seen, that last bid is counted as an estimated sale. It is a minimum, since a last-second outbid is missed. Shown separately, and it can be left out of the median (*Paramètres → Prix du marché*).
* **Current listings** seen while browsing the Marché ("Moins chère à enchérir": the next minimum bid, or the starting price without a bid).

### Final prices of ended auctions

Every auction of a followed card that you see while browsing is queued. When it ends:

* **Automatic reading off (default):** the extension sends nothing. The auction appears in the **À vérifier** list of the Marché tab (end time, last bid seen, an "Ouvrir ↗" link). Opening it is enough to record the final price.
* **Automatic reading on** (*Fonctionnalités*, Firefox asks for the "scripting" permission). The extension asks the game itself for each ended auction:
  * one request per auction (`/api/marketplace/<id>`, the same data the auction page loads), sent from your open game tab with your session, never more than one at a time;
  * only while a game tab is open, with a **fixed** interval (60 s by default, 30 s minimum) and a daily cap (300 by default);
  * an auction extended by late bids is re-timed to its new end;
  * with no answer, it is retried 30 minutes later and dropped after 3 attempts.

  These requests do **not** try to look like a person: no random delays, no fake page views. If the game looks at timing, it can tell it is automated. The rules forbid scripts, so turning this on is your own risk for your account. Its status shows in the popup and in *Fonctionnalités*.

## Deals

An auction is a deal when what it costs to take it now (the next minimum bid, or the starting price with no bid) is at least **25 %** below the card's median. Only auctions seen while browsing the Marché in the last 2 hours count, and only if the median rests on at least 3 sales. Your own auctions and those where you are the highest bidder are left out. All three settings are in *Fonctionnalités*, along with the cards concerned: your followed cards (default) or every card with known prices.

* **List in the popup** (on by default): card, rarity, price to pay, median, the gap and a live countdown. Click a line to open the auction.
* **Notifications** (off by default, Firefox asks for the "notifications" permission): one notification per new deal, at most once per auction. Click it to open the auction.

Since the extension sends nothing to the game, a deal is only spotted when the Marché page you are browsing receives it.

## The screens

* **Popup** (toolbar icon). It shows the status: when your transactions were last read, the latest market data, your balance, and Google Sheets (with export progress). It also lists the deals in progress and the latest transactions recorded. Buttons: **Tableau de bord** (dashboard), **Prix du marché**, **Aller au Marché** (brings your Marché tab to the front, or opens it).
* **Dashboard**: everything opens in **a single tab**, including the settings. The browser's Back / Forward buttons work, and the extension reuses this tab instead of opening a new one.
  * *Vue d'ensemble* (overview): realized profit per day, estimated trading profit, cumulative profit, net worth (balance + stock), stock cost vs value.
  * *Marché*: median of observed sales, P25–P75, min / max, 7 and 30 day trends, "Moins chère à enchérir" (the lowest next minimum bid or starting price among the listings seen), suggested max buy price. Followed cards or all cards seen. Click a card for its chart: observed sales, your purchases and the daily median.
  * *Prix* (prices): the average purchase price per day and per card over time (inflation); your purchases and sales of one card.
  * *Par carte* (per card), *Par heure* (per hour), *Stock*, *Transactions* (with an **Exclure** box to remove one transaction from the stats).
  * *Fonctionnalités* (features): every option that changes something on the site or sends something, each with its own switch: the median under the prices, full art, deals (list and notifications), automatic reading of final prices.
  * *Paramètres* (settings): followed cards and excluded cards, market period, stock valuation, Google Sheets, backup.
* **On the site**, under each auction's price:
  * **Médiane 4 832**: click it to open the card's detail in the dashboard. Hover for the number of sales, P25–P75 and the trend.
  * A pill such as **−33 %**: what it costs to take the auction now, compared with the median. Green when it is at least 15 % below, red when it is at least 15 % above (the threshold is adjustable). That cost is:
    * with a bid, the **next minimum bid**: `ceil(current bid × 1.1)`, for example 750 → 825;
    * with no bid, the **starting price**.
  * **+ Suivre** (follow) for a card you don't follow yet.
* **Full art** (*Fonctionnalités*, off by default): the card's picture covers the whole card, the title and stats sit at the bottom on a dark gradient, the summary unfolds on hover, and a thin border shows the rarity colour. Choose the rarities (L and UR by default, Shiny too). Only cards shown with their picture change (not the Marché listings without one). Landscape pictures (wider than tall) would lose their sides, so you choose what to do with them: the whole picture over a blurred copy of itself (default), the normal card, or cropped. To tell them apart, the extension measures each card picture when it loads (only while full art is on). Same rules as the WM Tracker extension; the game re-renders the page often, so the extension puts the setting back each time.

## The figures

| Figure | Calculation |
|---|---|
| **Realized profit** | for each sale of a followed card: sale price (minus the commission, if set) − cost of the **oldest** unsold purchase of that card (FIFO). Exact. |
| **Stock** | followed purchases not yet consumed by a sale. |
| **Estimated value of a card in stock** | median of the card's last 3 observed sales over 14 days (yours and those seen on the market) → otherwise the cheapest current listing → otherwise older sales → otherwise the purchase price. Minus the optional prudence discount. |
| **Estimated trading profit (per day)** | realized profit for the day + change in the stock's unrealized gain over the day. |
| **Estimated net worth** | wikibidous balance (read on the site) + estimated stock value. |
| **Market median** | median of observed sales over the period you choose (30 days by default). Shiny copies are counted separately. |
| **Max buy price** | median ÷ (1 + target margin, 30 % by default). |

A transaction counts toward the stats when all of these hold:
* its card is followed (by name, or by a keyword in its Wikipedia description), and it is not on the exclusion list. "Ne plus suivre" on a card that a keyword selects puts it on that list, which you can edit in the settings;
* it is not earlier than the "Suivie depuis" (tracked since) date;
* it has not been excluded.

All transactions are still recorded, so a card you add later brings its whole history with it.

## Installing

### Permanent install (recommended)

Firefox only installs signed extensions, but signing a private ("unlisted") extension is free:

1. Zip the **contents** of the `extension/` folder (`manifest.json` at the root of the zip):
   ```bash
   cd extension && zip -r ../wikimasters-trading.zip . && cd ..
   ```
2. Go to <https://addons.mozilla.org/developers/addon/submit/distribution> → **On your own** → upload the zip.
3. Download the signed `.xpi` and drag it into Firefox. Share that file with other players.

For a public listing with automatic updates, choose **On this site** instead (reviewed by Mozilla).

> ⚠️ A **temporary** extension (`about:debugging`) **loses its data when Firefox restarts**. Download a backup (*Paramètres → Sauvegarde*) before closing Firefox.

### Permissions

* *wiki-masters.com*: to read the responses your pages receive, and to add the badges.
* *script.google.com*: only for the optional Google Sheets export.
* "Read and modify network requests" (`webRequest`): needed to copy the Marché responses. The extension only reads `/api/marketplace…` and forwards them unchanged.
* *scripting* (optional, requested only when you turn on the automatic reading of final prices): to send those requests from your game tab.
* *notifications* (optional, requested only when you turn on deal notifications).

### First run

1. Toolbar icon → **⚙ Paramètres** → **Cartes suivies**: add your cards (the exact title shown on the site), or click **+ Suivre** under an auction.
2. Open the **Marché** of WikiMasters. Your transactions and the prices you see are recorded straight away.
3. Toolbar icon → **Tableau de bord**.

## Google Sheets (optional)

The script creates the spreadsheet itself (tabs, formats and charts), so an empty spreadsheet is enough.

1. Create a Google spreadsheet → **Extensions → Apps Script**.
2. Replace the content of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) → **Save**.
3. Select **`setup`** → **Run** → allow it. If Google shows "unverified app": *Advanced → Go to…*. The **secret** appears in the execution log.
4. **Deploy → New deployment** → ⚙ **Web app**, *Execute as*: **Me**, *Who has access*: **Anyone** → **Deploy** → copy the URL (`…/exec`).
5. *Paramètres → Google Sheets*: paste the URL and the secret → **Tester la connexion** (test connection).

The extension writes the tabs one by one: **Tableau de bord, Par jour, Inventaire, Par carte, Prix du marché, Par heure, Inflation (average purchase price per day and per card), Prix dans le temps, Achats, Ventes**. Progress is shown in the popup and the dashboard ("Remplissage de l'onglet « Achats » (9/10, 412 lignes)…").

With *Mettre à jour automatiquement* on, the export starts 90 seconds after new transactions arrive. The tabs are rewritten each time, so add your own tabs next to them. A tab with the same name that the script did not create is kept and renamed `… (v1)`.

When `Code.gs` changes: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Updating from an earlier version

* **From v2**: install the new zip. Data and settings are kept, as long as the extension was not temporary or you restore a backup. Also update `Code.gs` (new version) for the export progress and the "Prix du marché" tab.
* **From v1** (Apps Script that wrote Achats / Ventes directly):
  1. update `Code.gs`;
  2. *Paramètres → Google Sheets → Importer l'historique de la feuille*. All rows are imported once, `Inclure = Non` becomes an exclusion, and the `Oui` cards become your followed cards;
  3. open the Marché. The old tabs are kept as `… (v1)`.

## Development

```bash
node test/run-tests.js        # extraction, database, market, statistics, tables, Apps Script (fake runtime, real data)
node test/background-test.js  # end-to-end: passive capture (no request to the game allowed), optional resolver (spacing, cap, retries), deal notifications
npx web-ext lint --source-dir extension
```

`test/mock/market.html` is a marketplace page that mimics the site's layout, for testing the badges in a browser. `test/mock/cards.html` does the same for full art.

```
extension/
  manifest.json
  background.js        passive capture (filterResponseData), optional final-price resolver, deal notifications, database, export, tab reuse
  content/site.js      balance read, market badges under the prices (optional), full-art switch
  content/fullart.css  full art, per rarity (active only when <html data-wmt-fullart> lists the rarity), pure CSS
  lib/extract.js       your lists (won / history / selling) → records
  lib/market.js        auctions seen → market prices (median, P25–P75, trend, cheapest listing), estimates, "À vérifier" queue, deals
  lib/store.js         local database (insert-only, v1 import, exclusions, backups)
  lib/stats.js         FIFO, stock valuation, per day / card / hour statistics
  lib/tables.js        tables for Google Sheets and CSV
  lib/time.js, lib/settings.js, lib/format.js, lib/charts.js
  popup.*              status, deals in progress, shortcuts
  dashboard.*          dashboard (all tabs, including the settings), settings-panel.js
  vendor/chart.umd.js  Chart.js 4.4.7 (MIT)
apps-script/Code.gs    web app that writes the tables and charts into the spreadsheet
test/                  Node tests, fixtures from a real sheet and API answer, mock page
```
