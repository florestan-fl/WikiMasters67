# WikiMasters Trading

A Firefox extension for [WikiMasters](https://www.wiki-masters.com/) players who trade on the marketplace:

* **Your trades:** every purchase and sale is recorded. You get the profit per day (realized and estimated), the value of your stock, and your best cards and hours.
* **Market prices:** the median sale price, price range and trend for the cards you follow. Directly under the auctions on the site, the extension shows how the current price compares with the median.
* **Google Sheets (optional):** the extension fills in a spreadsheet, with charts, that you can read from anywhere.

Every player picks their own cards in the settings. Nothing in the code or the spreadsheet is specific to one player.

## Passive: the extension sends nothing to the game

The extension **never** makes a request to wiki-masters.com: no API call, no background tab, no automatic page reload. It only reads what **your** browser already receives while you play:

| What | How | Visible to the site? |
|---|---|---|
| Your purchases (*Gagnées*), sales (*Historique*), active listings, auctions shown on the Marché | When **your** Marché page loads `/api/marketplace…`, Firefox gives the extension a copy of the response while passing it **unchanged** to the page (`webRequest.filterResponseData`) | No |
| Your wikibidous balance | Read from the page header by the content script (read only) | No |
| Market badge under the prices (optional) | Small elements **added** under "Mise actuelle / Mise de départ". The game's text is never modified | **Yes**: it's the only change on the page. Turn it off in *Paramètres → Prix du marché* |

So, to record your transactions, **open the Marché at least every 2 days**. The site only lists your last 50 purchases and 50 sales, and the extension warns you if some may have been missed.

> ⚠️ The game's rules (`/rules`) forbid scripts and "interception du trafic … pour obtenir un avantage". Making no requests keeps the extension invisible on the network side. But no extension is undetectable: the market badges are part of the page, and the extension reads the site's responses. If in doubt, ask the game's developer whether this kind of tool is allowed, or turn off the market badges.

### Where market prices come from

* **Your sales** (Historique).
* **Other players' sales** when you see them: an ended auction you open, a search, and so on.
* **Current listings** seen while browsing the Marché ("Moins chère en vente", the cheapest listing currently for sale).

Unlike tools that revisit ended auctions automatically, the extension only knows the sales you have seen. The median becomes reliable as you play.

## The screens

* **Popup** (toolbar icon). It shows the status: when your transactions were last read, the latest market data, your balance, and Google Sheets (with export progress). It also lists the latest transactions recorded. Buttons: **Tableau de bord** (dashboard), **Prix du marché**, **Aller au Marché** (brings your Marché tab to the front, or opens it).
* **Dashboard**: everything opens in **a single tab**, including the settings. The browser's Back / Forward buttons work, and the extension reuses this tab instead of opening a new one.
  * *Vue d'ensemble* (overview): realized profit per day, estimated trading profit, cumulative profit, net worth (balance + stock), stock cost vs value.
  * *Marché*: median of observed sales, P25–P75, min / max, 7 and 30 day trends, cheapest current listing, suggested max buy price. Followed cards or all cards seen. Click a card for its chart: observed sales and the daily median.
  * *Par carte* (per card), *Par heure* (per hour), *Prix* (prices), *Stock*, *Transactions* (with an **Exclure** box to remove one transaction from the stats).
  * *Paramètres* (settings): followed cards, market, stock valuation, Google Sheets, backup.
* **On the site**, under each auction's price:
  * **Médiane 4 832**: click it to open the card's detail in the dashboard. Hover for the number of sales, P25–P75 and the trend.
  * A pill such as **−33 %**: the current price compared with the median. Green when the price is at least 15 % below, red when it is at least 15 % above (the threshold is adjustable).
  * **+ Suivre** (follow) for a card you don't follow yet.

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
* its card is followed (by name, or by a keyword in its Wikipedia description);
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

The extension writes the tabs one by one: **Tableau de bord, Par jour, Inventaire, Par carte, Prix du marché, Par heure, Inflation, Prix dans le temps, Achats, Ventes**. Progress is shown in the popup and the dashboard ("Remplissage de l'onglet « Achats » (9/10, 412 lignes)…").

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
node test/background-test.js  # passive capture end-to-end: fake stream filter, no request to the game allowed
npx web-ext lint --source-dir extension
```

`test/mock/market.html` is a marketplace page that mimics the site's layout, for testing the badges in a browser.

```
extension/
  manifest.json
  background.js        passive capture (filterResponseData), database, export, tab reuse
  content/site.js      balance read, market badges under the prices (optional)
  lib/extract.js       your lists (won / history / selling) → records
  lib/market.js        auctions seen → market prices (median, P25–P75, trend, cheapest listing)
  lib/store.js         local database (insert-only, v1 import, exclusions, backups)
  lib/stats.js         FIFO, stock valuation, per day / card / hour statistics
  lib/tables.js        tables for Google Sheets and CSV
  lib/time.js, lib/settings.js, lib/format.js, lib/charts.js
  popup.*              status and shortcuts
  dashboard.*          dashboard (all tabs, including the settings), settings-panel.js
  vendor/chart.umd.js  Chart.js 4.4.7 (MIT)
apps-script/Code.gs    web app that writes the tables and charts into the spreadsheet
test/                  Node tests, fixtures from a real sheet and API answer, mock page
```
