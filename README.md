# WikiMasters Trading

A Firefox extension for [WikiMasters](https://www.wiki-masters.com/) players who trade on the marketplace. One click records your purchases and sales. A dashboard then shows how much you make per day, what your stock is worth, and which cards and times of day pay best. An export to Google Sheets is optional.

* **No account and no setup:** install it, choose the cards you trade, click **Mettre à jour** (Update).
* **Your data stays in your Firefox profile.** It only leaves it if you turn on the Google Sheets export, and then only to your own spreadsheet.
* **Every player configures their own cards** in the settings. Nothing in the code or the spreadsheet is specific to one player.

## How it works

```
wiki-masters.com/api/marketplace?mine=1  ──(your login, in a wiki-masters tab)──▶  extension
   won      → purchases                                                       │  local database (all transactions)
   history  → sales (sold / unsold)                                           │  + tracked-card settings
   selling  → your active listings                                            │  → statistics, dashboard
   auctions → other players' prices (stock valuation)                         │
   page     → your wikibidous balance                                         └──(optional)──▶ Google Sheets
```

* **Every** purchase and sale is recorded, whatever the card. The **tracked cards** only decide what counts in the statistics. So you can add a card later and its whole history is used.
* A finished auction never changes: records are added once, identified by the site's auction ID.
* The site only returns your **last 50** sales and your **last 50** won auctions (about 3 days of active trading). **Update at least every 2 days.** The extension warns you if it may have missed something.

## The figures

| Figure | Calculation |
|---|---|
| **Realized profit** | for each sale of a tracked card: sale price (minus the game's commission, if set) − cost of the **oldest** tracked purchase of that card not yet sold (FIFO). Exact. |
| **Stock** | tracked purchases not yet consumed by a sale. |
| **Estimated value of a card in stock** | median of your last 3 sales of that card over 14 days → otherwise the cheapest current listing seen on the market → otherwise your older sales → otherwise its purchase price. Minus the optional prudence discount. |
| **Estimated trading profit (per day)** | realized profit for the day + change in the stock's unrealized gain (estimated value − cost) over the day. This answers "how much did I really make today?". |
| **Estimated net worth** | wikibidous balance (read at each update) + estimated stock value. It also includes your non-trading income. |
| **Max buy price** | your average sale price ÷ (1 + target margin). |

"Tracked" transaction:
* the card is in your list (or its Wikipedia description contains one of your keywords);
* it is not earlier than the card's "tracked since" date;
* you have not excluded it.

A sale with no matching purchase (a card from a pack, or bought before you started tracking) is flagged. By default it is left out of the profit, or counted at cost 0 if you choose that.

### Dashboard tabs

* **Vue d'ensemble** (overview): today / 7 days / 30 days, profit per day (realized and estimated), cumulative profit, net worth (balance + stock), stock cost vs value, table per day.
* **Par carte** (per card): table, plus realized profit, average buy / sell price, average profit and margin per card (the 4 charts from the old "Par espèce" tab).
* **Par heure** (per hour): price index and sell-through rate by hour, best times to buy and sell.
* **Prix** (prices): successive purchase prices per card; purchases and sales over time for one card.
* **Stock**: inventory with cost, estimated value and its source; your active listings.
* **Transactions**: every purchase and sale, with an **Exclure** (exclude) box. Use it to remove, for example, a copy you keep for your collection.

## Installing

### Permanent install (recommended)

Firefox only installs signed extensions, but signing a private ("unlisted") extension is free and automatic:

1. Get the zip of the `extension/` folder. Use the one provided, or:
   ```bash
   cd extension && zip -r ../wikimasters-trading.zip . && cd ..
   ```
2. Go to <https://addons.mozilla.org/developers/addon/submit/distribution>, choose **On your own**, and upload the zip.
3. Download the signed `.xpi` and drag it into Firefox. Share that same file with other players.

To let everyone install it in one click with automatic updates, choose **On this site** instead (public listing, reviewed by Mozilla).

> ⚠️ A **temporary** extension (`about:debugging` → *Load Temporary Add-on*) **loses its data when Firefox restarts**. Only use it for testing, or download a backup (Settings → *Sauvegarde*) before closing Firefox.

### First run

1. Click the icon → **Paramètres** (Settings) → **Cartes suivies** (tracked cards). Click **+ Ajouter une carte** (add a card) and type the name exactly as on the site (the Wikipedia title, for example `Triceratops`). Names already seen in your transactions are suggested.
   * *Suivie depuis* (tracked since): optional, to ignore purchases made before you started trading that card.
   * *Mots-clés de catégorie* (category keywords): optional, for example `dinosaure`.
2. Be logged in on wiki-masters.com, then click **Mettre à jour** (Update). A tab does not need to be open.
3. Click **Tableau de bord** (dashboard).

## Google Sheets (optional)

The extension can copy all the data and statistics, with their charts, into a Google spreadsheet. **The spreadsheet is created by the script itself**, so there is no template to copy: an empty spreadsheet is enough.

1. Create a Google spreadsheet (or use your existing one) → **Extensions → Apps Script**.
2. Replace the content of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) → **Save**.
3. Select **`setup`** → **Run** → accept the authorization. If Google shows "unverified app": *Advanced → Go to…*. The **secret** appears in the **execution log**.
4. **Deploy → New deployment** → ⚙ **Web app**, *Execute as*: **Me**, *Who has access*: **Anyone** → **Deploy** → copy the URL (`…/exec`).
5. Extension settings → **Google Sheets**: paste the URL and the secret → **Tester la connexion** (test connection).

The script then writes these tabs: **Tableau de bord, Par jour, Inventaire, Par carte, Par heure, Inflation, Prix dans le temps, Achats, Ventes**, with their charts. They are rewritten at each update, so don't edit them. Add your own tabs next to them if you want.

If a tab with the same name already exists and was not created by the script, it is **kept** and renamed `… (v1)`.

When `Code.gs` changes: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

## Migrating from version 1 (your current spreadsheet)

1. In Apps Script, replace `Code.gs` with the new version, then **Deploy → Manage deployments → ✏️ → New version**. The URL and the secret stay the same.
2. Install the new extension. The URL and the secret carry over from your v1 settings.
3. Settings → **Importer l'historique de la feuille** (import the sheet's history). This reads your **Achats / Ventes** tabs once:
   * every row is imported, including those the site no longer shows (V01…);
   * `Inclure = Non` becomes an **exclusion** (A01, A02, A06, A12, A13 and the purchases added as "Non");
   * the cards marked `Oui` become your **tracked cards**.
4. **Mettre à jour** (Update). Your old tabs (Achats, Ventes, Par heure, Inflation) are renamed `… (v1)` and kept. **Par espèce** is not touched. The new tabs are created next to them.

## Backup and export

Settings → **Sauvegarde et export**:

* **Télécharger une sauvegarde** (download a backup) / **Restaurer** (restore): a JSON file with all your data and settings, for moving to another computer or keeping a safe copy;
* **CSV** (Excel, French format): Achats, Ventes, Par carte, Par jour, Inventaire.

## Development

```bash
node test/run-tests.js        # extraction, database, statistics, tables, Apps Script (fake runtime, real data)
node test/background-test.js  # background script end-to-end (mocked browser API)
npx web-ext lint --source-dir extension
```

```
extension/
  manifest.json
  background.js        reads wiki-masters.com, merges into the database, exports to Google Sheets
  lib/extract.js       API answer → records
  lib/store.js         local database (insert-only, v1 import, exclusions, backups)
  lib/stats.js         FIFO, stock valuation, per day / card / hour statistics
  lib/tables.js        tables for Google Sheets and CSV
  lib/time.js          Paris time
  lib/settings.js      settings and their defaults
  lib/charts.js        Chart.js conventions (palette, marks, tooltips)
  lib/format.js        DOM and number helpers
  popup.*  options.*  dashboard.*
  vendor/chart.umd.js  Chart.js 4.4.7 (MIT)
apps-script/Code.gs    web app that writes the tables and charts into the spreadsheet
test/                  Node tests (fixtures from a real spreadsheet and API answer)
```
