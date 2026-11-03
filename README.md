# WikiMasters → Google Sheets

A Firefox extension with one button that adds your [WikiMasters](https://www.wiki-masters.com/) marketplace purchases and sales to your Google Sheets tracker (**Achats** and **Ventes** tabs).

```
Firefox extension ──reads──▶ wiki-masters.com/api/marketplace?mine=1   (with your login, in a wiki-masters tab)
        │
        └──POST JSON + secret──▶ Google Apps Script web app ──writes──▶ your spreadsheet
```

* **Achats** ← the *Won* tab (auctions you won)
* **Ventes** ← the *History* tab (your auctions that ended, sold → `Vendue` or unsold → `Non vendue`)

Each transaction is added once, whenever you click: the site's auction ID is stored in a hidden **ID site** column, so clicking twice never duplicates anything.

## What gets written

| Column | Achats | Ventes |
|---|---|---|
| ID | next number (`A22`, `V24`, …) | same |
| Date/heure | auction end time, Paris time | same |
| Carte | Wikipedia title of the card | same |
| Rareté | rarity at listing time (`C`, `PC`, `R`, `SR`, `UR`, `L`) | same |
| Prix (W) | final price | final price if sold, otherwise the listing price |
| Vendeur / Statut | seller name | `Vendue` / `Non vendue` |
| Inclure | `Oui` by default (configurable), see below | – |
| **Acheteur** (new, Q) | – | buyer name |
| **ID site** (new, hidden) | site auction ID | same |

Only these raw columns are written. Your formulas are left alone:

* the `ARRAYFORMULA`s in row 2 (Heure, Jour, Indice prix, Profit…);
* the per-row **ID achat (FIFO)** formula, which is copied down to the new rows.

New rows are inserted **in chronological order**, because the FIFO and "N° achat de l'espèce" formulas depend on row order. Your existing rows keep their order and their values. The filter range is extended to the new rows and columns.

### Rows you entered by hand

Rows without an **ID site** are linked to a site transaction with the **same card and same price**, at the closest date within 24 h. A different status or counterpart name counts against a candidate but does not rule it out. Only the hidden ID is written into them, plus the buyer for rows marked `Vendue`. Your dates, prices and statuses are never changed. The preview lists every link and its differences.

### Inclure

* Purchases dated **inside the period you had already tracked by hand** (up to your last hand-entered purchase, 03/11/2026 16:57) are added with **`Non`**. You had left them out, so they must not change your existing FIFO matching. Switch the ones that are investments to `Oui`.
* Later purchases get the default from the settings: `Oui` (default), `Non`, or *automatic* (`Oui` if that card already has an `Oui` purchase).

## Setup

### 1. Apps Script, inside the spreadsheet (one-time)

1. Open the spreadsheet → **Extensions → Apps Script**.
2. Replace the content of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) and click **Save**.
3. In the toolbar, select the function **`setup`** and click **Run**. Accept the authorization prompt: it is your own script accessing your own spreadsheet. If Google shows "unverified app", click *Advanced → Go to …*.
4. Open **Execution log**. It prints the **secret**: copy it.
5. **Deploy → New deployment** → gear icon → **Web app**:
   * *Execute as*: **Me**
   * *Who has access*: **Anyone**
   * **Deploy**, then copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

"Anyone" is needed because the extension does not log in to Google. Without the secret, the script refuses every request.

When `Code.gs` changes later: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

### 2. Install the extension in Firefox

* **Quick test:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `extension/manifest.json`. It is removed when Firefox restarts.
* **Permanent install:** Firefox only installs signed extensions, but signing a private ("unlisted") extension is free and automatic:
  1. Zip the *contents* of the `extension/` folder (`manifest.json` must be at the root of the zip):
     ```bash
     cd extension && zip -r ../wikimasters-sheets.zip . && cd ..
     ```
  2. Go to <https://addons.mozilla.org/developers/addon/submit/distribution>, choose **On your own** and upload the zip.
  3. Download the signed `.xpi` and drag it into Firefox.

  Or, with an AMO API key: `npx web-ext sign --source-dir extension --channel unlisted --api-key … --api-secret …`

When asked, allow access to *wiki-masters.com* and *script.google.com*. If the popup says access is missing, click **Grant access**.

### 3. Settings

Click the toolbar icon → **Settings**:

* paste the **Web app URL** and the **secret** → **Test connection** → **Save**;
* *Ignore transactions before*: `2026-10-30` (your first hand-entered row). Empty = everything the site still shows;
* *Inclure for new purchases*, *matching window*, *renumber IDs*: the defaults are fine.

## Daily use

1. Be logged in on wiki-masters.com. A tab does not need to be open: the extension opens one in the background if needed.
2. Click the toolbar icon → **Update sheet**. The popup lists the rows added, and the badge shows how many.

**Preview** shows the same report without writing anything. Use it for the first run.

The site only returns your **last 50** finished sales and **last 50** won auctions, about 3 days at your pace. Update at least every couple of days. The extension warns you if the site's list no longer reaches back to your previous update.

### What the first run will do on your current sheet

This was simulated with your real rows and a real API answer (see `test/`):

* **Achats:** your 21 rows are linked to their auctions. 13 purchases you had not entered are added with `Inclure = Non`: 4 dinosaurs from 30–31/10 (Gasproutine, MewiSecler, SURPRYZ, vedved) and 9 other cards (Allemagne, Norvège, Ryan Gosling, Diplodocus…).
* **Ventes:** 22 of your 23 rows are linked. **V01** (Tyrannosaurus, 31/10) is older than the site's history and stays as is. 28 sales are added, mostly collection cards, plus the unsold Velociraptor at 980 and the Diplodocus sold for 1,100.
* The preview flags differences such as **V05**: "Non vendue" in your sheet, sold to jomex according to the site. Your value is kept.

## Things to know

* Sales of cards that never went through an `Oui` purchase (cards from packs, collection cards left at `Non`) show **"Hors stock"** in *ID achat (FIFO)*, and *Contrôle* says "Aucun achat retenu disponible". That is expected: switch the purchase to `Oui` if it was a trade.
* **Par espèce** has a fixed list of cards (A5:A13). Add new species there yourself if you want them in the summary and the "Indice prix".
* Shiny cards are not distinguished from normal ones.
* If you rename tabs or headers, keep these exact names: `ID`, `Date/heure`, `Carte`, `Rareté`, `Prix (W)`, `Vendeur`, `Inclure` (Achats) and `Statut` (Ventes). Columns are found by header name, not by position.
* `resetSyncState()` in the Apps Script editor forgets the "tracked by hand" cutoff.

## Troubleshooting

| Message | Fix |
|---|---|
| *Wrong secret* | Copy the secret again from the `setup` execution log. |
| *did not answer JSON* | The deployment is not "Anyone", or the URL is not the `/exec` one. |
| *refused the request (HTTP 401)* / *no "history"/"won" lists* | Log in on wiki-masters.com. |
| *missing column(s)* | A header was renamed in row 1 of Achats/Ventes. |

## Development

```bash
node test/run-tests.js        # Apps Script logic on a fake spreadsheet, real data
node test/background-test.js  # extension background script end-to-end (mocked browser API)
npx web-ext lint --source-dir extension
```

```
extension/            Firefox extension (Manifest V3)
  manifest.json
  background.js       fetches the API in a wiki-masters tab, calls the Apps Script
  lib/extract.js      API answer → purchases / sales
  popup.*             Update / Preview button and report
  options.*           settings
apps-script/Code.gs   web app that merges the rows into the spreadsheet
test/                 Node tests (fake Apps Script runtime + fixtures from the real sheet)
```
