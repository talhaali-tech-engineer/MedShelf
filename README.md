# MedShelf

**A free medicine stock and expiry tracker for small pharmacies and clinics. It runs in the browser, works offline, and keeps your data on your own device.**

Small pharmacies and clinics lose real money to medicine that expires on the shelf. They also run out of the medicines people need most. Most of them track stock on paper or in a spreadsheet, and neither one warns you before it's too late. MedShelf does.

**Try it:** https://talhaali-tech-engineer.github.io/MedShelf/ (press *Try it with sample data*)

## What it does

- **Tracks every batch.** Each delivery is stored with its batch number, expiry date, quantity and cost.
- **Sells the oldest stock first.** When you dispense, MedShelf takes units from the in-date batch that expires soonest (first expiry, first out). It never uses expired stock.
- **Tells you what to take off the shelf.** Expired batches are listed with their value so you can remove and write them off.
- **Predicts waste before it happens.** From the last 30 days of sales, it works out which batches will expire before they sell. You get time to move them to the front, return them, or send them to a branch that uses more.
- **Tells you what to reorder, and how much.** Each medicine is flagged when it is out of stock, at its reorder level, or will run out before a delivery could arrive. The suggested order covers the delivery wait plus a month of sales, and you can download it as a CSV to send to your supplier.
- **Reads expiry dates the way packs print them.** `03/2027` and `2027-03` both mean the last day of March 2027.
- **Imports your existing spreadsheet** (CSV), and exports stock, history and backups.
- **Works offline.** Once opened, it runs without internet and can be installed like an app on a phone or PC.
- **Keeps data private.** No server, no account, no tracking. Your stock is stored in the browser's own database (IndexedDB) on your device.

## Screens

| Screen | What it is for |
| --- | --- |
| **Today** | Expired stock, stock expiring soon, likely waste, and what to reorder |
| **Stock** | Every medicine with stock level, next expiry and days of stock left. Open one to see its batches and full history |
| **Receive** | Add a delivery, one line per batch |
| **Dispense** | Take units out. The screen shows exactly which batches they come from |
| **Data** | Backup, restore, CSV import and export, settings |

## Run it on your own computer

You need [Node.js](https://nodejs.org) 20 or newer. There is nothing to install.

```bash
git clone https://github.com/talhaali-tech-engineer/MedShelf.git
cd MedShelf
npm start
```

Then open http://localhost:8080.

Any static web server works too, for example `python -m http.server 8080`. Opening `index.html` straight from the disk does not work, because browsers block JavaScript modules on `file://`.

## Put it online for free

MedShelf is static files only, so GitHub Pages can host it. Fork this repository, go to **Settings → Pages**, choose **Deploy from a branch**, then pick `main` and `/ (root)`. Each person who opens the link keeps their own data on their own device.

## Importing a spreadsheet

Save your stock list as CSV with these columns. Only `name`, `expiry` and `qty` are required.

| name | strength | form | batch | expiry | qty | unit_cost | reorder_level |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Paracetamol | 500 mg | Tablet | PCM2401 | 03/2027 | 500 | 0.02 | 200 |

`expiry` can be `2027-03-31`, `2027-03`, `03/2027` or `03/27`. Rows with problems are listed by row number and are not imported.

## Back up your data

Data lives in one browser on one device. Clearing the browser's site data, or losing the device, loses the stock. Go to **Data → Download backup** every week, and keep the file somewhere safe. The Today screen reminds you when your last backup is more than a week old.

## How the numbers are worked out

- **Expiry:** the expiry date is the last day a batch can be dispensed.
- **Sales rate:** units dispensed in the last 30 days, divided by 30. A medicine stocked more recently is averaged over the days it has been stocked, but never fewer than 7.
- **Waste risk:** batches are used in expiry order at the current sales rate. Units left in a batch on its expiry date are at risk. This needs two weeks of history for a medicine.
- **Reorder:** stock is low when it is zero, at or below the reorder level, or will last no longer than the delivery time. The suggested order is enough for the delivery time plus the cover period (30 days by default), and never less than twice the reorder level. Both periods can be changed in Settings.

All of this logic is in [`js/core.js`](js/core.js), with no browser code, and it is tested in [`tests/core.test.js`](tests/core.test.js).

## Development

```bash
npm test               # runs the logic tests with Node's built-in test runner
npm start              # serves the app at http://localhost:8080
python scripts/make_icons.py   # redraws the PNG icons
```

There are no dependencies and no build step. Plain HTML, CSS and JavaScript modules.

```
index.html            page shell
css/styles.css        styles, with light and dark mode
js/core.js            stock, expiry, reorder and CSV logic (pure, tested)
js/db.js              IndexedDB storage
js/app.js             screens
js/sample.js          sample data for trying it out
sw.js                 offline cache
tests/                Node tests
```

When you change any app file, bump `CACHE` in `sw.js`, so people's devices get the new version.

## Limits

- One device per shop. Data is not shared between devices yet; use backups to move it.
- It is a stock tool. It is not a dispensing record for prescriptions or a medical device, and it does not replace physical stock checks.

## Ideas for later

- Sync between devices in the same shop
- Barcode scanning with the phone camera
- Supplier list and purchase orders
- Printable shelf labels and stock-count sheets

Issues and pull requests are welcome.

## Licence

[MIT](LICENSE)
