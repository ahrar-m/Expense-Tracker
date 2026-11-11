# SplitTrack — Bills with item-level splits

A lightweight, browser-only expense tracker built around **bills**: each bill is a group of items, and every item can be split among a different set of people. Tick Ali and Sara on the pizzas, tick only Ali on the beer, and leave Sara out of it — all inside one bill.

No backend. Everything is stored locally in IndexedDB.

## What is new in this version

* **Bills are first-class.** The main page lists compact bill cards; tap one to expand it into its items, edit them, settle the bill or delete the whole thing.
* **Every item is split separately.** Each item has its own people list. Unticked people are skipped for that item; the item amount is divided equally among the ticked people.
* **Categories start empty.** There are no seeded Food/Travel/Stay defaults. Each bill owns its own categories, created fresh when you type one or when an imported CSV brings one in.
* **New AI import format.** The prompt now asks for Date, Bill, Item, Category, Amount and an optional Split With column, and the preview lets you tick people item by item.
* **Fresh storage.** This build uses a new database (SplitTrackDB). Data from the old ExpenseTrackerDB version is not migrated.

## How to use it

1. **Add people** in the People tab. You are added automatically.
2. **Add a bill** from the Add Bill tab: give it a name (for example "Spice Route dinner"), a date and the payer.
3. **Add items** inside that bill. Each item gets a name, an amount, a category you type yourself, and its own row of people chips. Ticked people share that item equally; unticked people are skipped.
4. **Review bills** in the Bills tab. Each card shows the total, the payer, the item count and everyone involved. Tap to expand and see each item with every person's exact share.
5. **Settle up**: the check icon on an item marks just that item; "Settle all" marks the whole bill. Settled items are excluded from "who owes whom" but stay in the charts and history.

Every bill has one payer. Changing the payer in Edit bill updates every item in that bill.

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
5. Amount - numbers only: no currency symbols and no thousands separators (write 1234.50, not 1,234.50). Put tax, service charge, tip and delivery fee on their own rows so the bill total stays exact. Put discounts as negative rows. Never include subtotal or grand total rows.
6. Split With - fill only if the bill itself says who had an item (e.g. "for Ali"); separate names with semicolons. Otherwise leave it empty - the app lets you tick people per item.
7. Output only the CSV inside a code fence, no commentary.
~~~

### What happens after you paste

* The CSV is grouped into **one card per bill** (name + date). A single paste can contain several bills.
* Each item row gets its own chip list. The "Default: who shared?" chips seed every item that had no Split With; tapping a chip on a row only changes that row. Use All / None on a bill header to reset that bill's items.
* Names in Split With that are not in People yet are listed as "Will add new participant(s)" and are created on import.
* The share totals under the preview show what each person owes before you commit.
* Tax, service charge, tip and delivery rows are imported as normal items, so the bill total matches the receipt. Discounts are imported as negative amounts.

## Data, backup and restore

* **Export to CSV** writes one row per item with the bill name, category, amount, payer and every person's share.
* **Download Full Backup (.json)** writes a version 3 backup containing settings, bills, items, shares and attachments.
* **Import Backup (.json) or CSV** restores a version 3 backup (replacing current data), or opens the AI importer when you pick a CSV.
* Old backups from the previous Expense Tracker format are not imported automatically. Send one over and it can be ported.
* **Erase All Data** clears the database and resets participants.

Storage lives in IndexedDB under SplitTrackDB. Clearing site data in the browser deletes everything, so keep JSON backups.

## Architecture

* Pure client-side HTML/CSS/vanilla JS.
* IndexedDB stores: metadata (settings), projects (bills), items (expense lines).
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

* Splits are equal shares among the people ticked on an item; weighted or custom per-person amounts are not part of this version.
* One payer per bill, applied to all its items.
* The AI importer has a single payer setting for the whole paste. When the bills in one paste were paid by different people, import them one at a time or edit each bill afterwards.
* Negative amounts (discounts) are allowed and split like any other item.

