# SplitTrack — Bills with item-level splits

A lightweight, browser-only expense tracker built around **bills**: each bill is a group of items, and every item can be split among a different set of people, with a different split method. Tick Ali and Sara on the pizzas, tick only Ali on the beer, weight the shared dessert 2:1, and let tax follow everyone's share of the bill — all inside one bill.

No backend. Everything is stored locally in IndexedDB.

## What is in this version

* **Bills are first-class.** The main page lists compact bill cards; tap one to expand it into its items, edit them, settle the bill or delete the whole thing.
* **Every item is split separately.** Each item has its own people list and its own split method: Equal, Weights, Percentages, Custom amounts or Bill ratio.
* **Bill-ratio rows follow the bill by default.** Rows that look like tax, service charge, tip, delivery fee, discount, coupon, adjustment or round-off start in Bill ratio, so each person pays the same proportion as their share of the bill's normal items. Bill ratio is also available for any ordinary item, both while adding a bill and in the item editor.
* **Categories start empty.** There are no seeded Food/Travel/Stay defaults. Each bill owns its own categories, created fresh when you type one or when an imported CSV brings one in.
* **AI import carries splits.** Split With accepts plain names, weights (Ali:2;Sara:1) and percentages (Ali:60%;Sara:40%), and every item has mode buttons in the preview.
* **Fresh storage.** This build uses a new database (SplitTrackDB). Data from the old ExpenseTrackerDB version is not migrated.

## How to use it

1. **Add people** in the People tab. You are added automatically.
2. **Add a bill** from the Add Bill tab: give it a name (for example "Spice Route dinner"), a date and the payer. No payer is preselected - choose one explicitly every time.
3. **Add items** inside that bill. Each item gets a name, an amount, a category you type yourself, and its own row of people chips. Ticked people share that item equally by default; unticked people are skipped. Tax, discount, adjustment and round-off rows switch to Bill ratio automatically when you save, and the per-row Equal / Bill ratio selector lets you put any item on bill ratio immediately.
4. **Adjust a split** by tapping an item in the Bills tab: pick Equal, Weights, Percentages, Custom or Ratio. Weights, percentages and custom amounts show a live share per person and block invalid totals.
5. **Review bills** in the Bills tab. Each card shows the total, the payer, the item count and everyone involved. Tap to expand and see each item with every person's exact share.
6. **Settle up**: the check icon on an item marks just that item; "Settle all" marks the whole bill. Settled items are excluded from "who owes whom" but stay in the charts and history.

Every bill has one payer, and new bills start with no payer selected so the choice is never accidental. Changing the payer in Edit bill updates every item in that bill.

## Split methods

* **Equal** — item amount divided by the number of ticked people.
* **Weights** — shares proportional to each person's number. 2 and 1 means two-thirds and one-third.
* **Percentages** — shares by percentage; the entered percentages must add up to 100%.
* **Custom** — exact amount per person; the amounts must add up to the item amount.
* **Bill ratio** — allocates the row in proportion to each person's share of the bill's normal (non-ratio) items. This is the default for tax, discount, adjustment and round-off rows, is selectable for any item, and stays in sync when item amounts or splits change. If a bill has no normal items yet, ratio falls back to equal among all participants.

Tax/discount/adjustment rows are recognised from their name and category (GST, VAT, service charge, service fee, tip, gratuity, delivery/platform/convenience fee, surcharge, discount, coupon, promo, voucher, cashback, offer, rebate, adjustment, round-off...). Recognition is only a default: the split method always wins if you change it.

## AI bill import

Tap **Import AI Bill** on the Add Bill screen (or in Settings). Copy the prompt below into ChatGPT, Claude or Gemini along with a photo of the bill, then paste the CSV it returns (or upload the .csv file).

~~~text
Extract every line item from the bill/receipt shown and return a plain CSV.
Use exactly these columns: Date, Bill, Item, Category, Amount, Split With

Rules:
1. Date - bill date as YYYY-MM-DD (use today if the bill has no date).
2. Bill - one short name for the whole bill, repeated on every row (e.g. "Spice Route dinner", "Trek 2026").
3. Item - the clean item name, one row per billed line (e.g. "Paneer Tikka", "Parking").
4. Category - a short label you choose for that item, 1-2 words (e.g. "Starters", "Drinks", "Travel"). No fixed list: name categories freshly and keep them consistent within the bill.
5. Amount - numbers only: no currency symbols and no thousands separators (write 1234.50, not 1,234.50). Put tax, service charge, tip, delivery fee, adjustments and round-off on their own rows so the bill total stays exact. Put discounts as negative rows. Never include subtotal or grand total rows.
6. Split With - fill only if the bill itself says who had an item (e.g. "for Ali"); separate names with semicolons. If it also states per-person quantities, add weights (e.g. Ali:2;Sara:1); if it states per-person percentages, add a percent sign (e.g. Ali:60%;Sara:40%). Otherwise leave it empty - the app lets you tick people and pick equal, weights, percentages, custom amounts or bill-ratio per item.
7. Output only the CSV inside a code fence, no commentary.
~~~

### What happens after you paste

* The import modal always opens with an **empty paste box**, so a previous bill's CSV never lingers. Uploading a .csv file still loads that file into the fresh box.
* The CSV is grouped into **one card per bill** (name + date). A single paste can contain several bills. Every card's bill name is an editable field, so you can fix or shorten the AI's name before importing.
* **Who paid has no default.** The payer must be chosen before the Import Bills button unlocks; the same payer applies to every bill in the paste.
* Each item row has **mode buttons** (Equal / Weights / % / Custom / Ratio). Weights, percentages and custom amounts show an input per person; invalid totals are marked and block the import.
* The "Default: who shared?" chips seed every item without Split With; tapping a chip on a row changes only that row. All / None on a bill header resets that bill's items.
* Tax, discount, adjustment and round-off rows start in Ratio. Turn them to Equal or another mode to override, or put any ordinary item on Ratio; the preview recomputes shares as you change the other rows.
* Names in Split With that are not in People yet are listed as "Will add new participant(s)" and are created on import.
* The share totals under the preview show what each person owes before you commit.

## Data, backup and restore

* **Export to CSV** writes one row per item with the bill name, category, amount, payer, split method and every person's share.
* **Download Full Backup (.json)** writes a version 3 backup containing settings, bills, items, split inputs, shares and attachments.
* **Import Backup (.json) or CSV** restores a version 3 backup (replacing current data), or opens the AI importer when you pick a CSV.
* Old backups from the previous Expense Tracker format are not imported automatically. Send one over and it can be ported.
* **Erase All Data** clears the database and resets participants.

Storage lives in IndexedDB under SplitTrackDB. Clearing site data in the browser deletes everything, so keep JSON backups.

## Architecture

* Pure client-side HTML/CSS/vanilla JS.
* IndexedDB stores: metadata (settings), projects (bills), items (expense lines).
* Item splits are computed and stored as a per-person amount map; the raw weights/percentages/amounts are kept in splitInputs so the editor can reopen exactly what you typed.
* Tailwind is vendored for offline styling, Chart.js for the dashboard charts.
* No build step, no server.

## File structure

~~~text
Expense-Tracker/
├── index.html          # Views, modals, navigation
├── README.md
├── css/style.css
└── js/
    ├── app.js          # State, IndexedDB, bills, splits, importer, charts
    └── vendor/
        ├── chart.js
        └── tailwind.js
~~~

## Deploying

The site is published from the main branch with GitHub Pages. Commit the changed files and push; GitHub Pages then serves the new build at the project URL. If the browser still shows the old version, do a hard refresh (or clear the site cache) so the updated app.js is loaded.

## Known limits

* One payer per bill, applied to all its items.
* The AI importer has a single payer setting for the whole paste. When the bills in one paste were paid by different people, import them one at a time or edit each bill afterwards.
* Percentages must total 100% and custom amounts must total the item amount; the editor tells you the current total when they do not.
* Ratio allocation uses normal items only. A ratio row that is switched to Equal/Weights/Percent/Custom stops following the bill ratio.
* Tax/discount recognition is name/category based; an unusually named fee may need its split method changed by hand.
* Negative amounts (discounts) are allowed and split like any other item.

