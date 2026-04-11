# Expense Tracker & Bill Splitter

A lightweight, purely client-side web application designed to help you track personal expenses, split bills with friends, and manage shared group finances. Designed with a mobile-first approach, it feels like a native app right in your browser.

## 🌟 Key Features

* **No Backend Required:** Runs entirely in your browser. Your data is 100% private and stored locally on your device using `IndexedDB`.
* **Smart Bill Splitting:** Split expenses equally, by exact custom amounts, or by percentage.
* **Detailed Analytics Dashboard:** * View your total expenses and your personal share.
  * "Who owes whom" settlement algorithm to minimize the number of transactions needed to settle debts.
  * Interactive charts (powered by Chart.js): Daily Expenses Stacked Bar Chart, Overall Category Doughnut Chart, and Participants Pie Chart.
* **Advanced Filtering:** Powerful multi-filter system across both Analytics and Timeline views. Filter by:
  * Text Search (Cash Title/Description)
  * People Involved
  * Who Paid
  * Category
  * Specific Month
  * Exact Date
* **Debt Settlement Tracking:** Mark individual expenses as "Settled" using the checkmark icon. Settled expenses are removed from the "Who owes whom" calculation but remain visible in your historical analytics.
* **Math Transparency:** A "Show Math" button in the dashboard clearly explains exactly how each person's net balance was calculated (Total Paid - Total Share).
* **Receipt Attachments:** Upload and attach images or PDFs to any expense. Files are securely stored offline within your browser's database.
* **Data Portability:** * Export to CSV for viewing in Excel/Google Sheets.
  * Download/Import full `.json` backups (includes all receipt attachments) to transfer your data between devices.

## 🚀 How to Use

Since this is a client-side only application, there is no server setup or installation required.

1. **Open the App:** Simply double-click the `index.html` file to open it in any modern web browser (Chrome, Safari, Firefox, Safari on iOS, etc.).
2. **Add Participants:** Go to the "People" tab via the bottom navigation to add your friends or family members.
3. **Add Expenses:** Tap the "+" (Add) button. 
   * Enter a description, amount, and date.
   * *Note: You must explicitly select a Category and the person Who Paid.*
   * Choose how the bill should be split among the participants.
4. **View Balances:** Head to the "Analytics" tab to see exactly who owes whom and explore your spending charts.
5. **Settle Up:** When someone pays you back, find the original expense in the "Timeline" tab and click the checkmark icon to mark it as settled.

## 🛠️ Technologies Used

* **HTML5 / CSS3 / Vanilla JavaScript:** No heavy frontend frameworks like React or Angular, keeping the app incredibly fast and lightweight.
* **Tailwind CSS (CDN):** For rapid, responsive, and modern UI styling.
* **Chart.js (CDN):** For rendering beautiful, interactive data visualizations.
* **IndexedDB:** The browser's native database API used to store extensive structured data and file attachments persistently across sessions.

## 📁 File Structure

The entire application is bundled into a single file for maximum portability:
* `index.html`: Contains all the HTML structure, Tailwind CSS styling, application logic, and database management scripts.

## ⚠️ Important Note on Data Storage

If you clear your browser's history and website data (specifically "Cookies and other site data" or "Offline website data"), you will **permanently delete** your expenses. 

To prevent data loss, frequently go to **Settings -> Download Full Backup (.json)** to save a copy of your data locally to your hard drive or cloud storage.
