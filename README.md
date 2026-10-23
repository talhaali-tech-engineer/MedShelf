<div align="center">

<img src="icons/icon.svg" width="84" alt="MedShelf logo">

# MedShelf

**Stop losing money to expired medicine.**

Free, offline-first stock and expiry tracking for small pharmacies and clinics,<br>with AI that reads your delivery invoices for you.

[**Live demo**](https://talhaali-tech-engineer.github.io/MedShelf/) &nbsp;·&nbsp; [**Watch the video**](docs/medshelf-demo.mp4) &nbsp;·&nbsp; [Quick start](#quick-start) &nbsp;·&nbsp; [Features](#features)

[![Tests](https://github.com/talhaali-tech-engineer/MedShelf/actions/workflows/test.yml/badge.svg)](https://github.com/talhaali-tech-engineer/MedShelf/actions/workflows/test.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-4f46e5)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-4f46e5)
![Works offline](https://img.shields.io/badge/works-offline-4f46e5)
![AI: OpenAI or Claude](https://img.shields.io/badge/AI-OpenAI%20or%20Claude-6d28d9)

<a href="docs/medshelf-demo.mp4"><img src="docs/demo-poster.jpg" alt="Watch the 2-minute MedShelf demo" width="860"></a>

</div>

## The problem

Small pharmacies and clinics run on thin margins and paper systems, and the same three things go wrong every week:

- **Medicine expires on the shelf.** Nobody notices a batch is close to its date until it has passed, and the money is gone.
- **The medicines people need run out.** Without a clear sales rate, reordering is guesswork, and a stock-out sends patients somewhere else.
- **Recording deliveries is slow.** Every invoice has batch numbers, expiry dates, pack sizes and prices. It is easy to mistype, so many shops stop recording batches at all, which makes the first two problems worse.

Large chains solve this with expensive inventory systems. Small independent shops and clinics, often with unreliable internet, usually can't.

## The solution

MedShelf tracks every batch and its expiry date, dispenses the oldest stock first, and tells you each morning what to remove, what to sell first and what to order. AI can read a photo of a delivery invoice into stock lines for you to check. It runs in any browser, keeps working offline, and keeps the shop's data on the shop's own device.

<img src="docs/dashboard.jpg" alt="The Today screen: expired stock, stock expiring soon, waste risk, reorders, a to-do list and an expiry chart">

## Features

### Stock and expiry

- **Batch tracking.** Every delivery is stored as batches, each with its own batch number, expiry date, quantity and cost.
- **Oldest stock first.** Dispensing always takes the in-date batch that expires soonest, and never touches expired stock.
- **A daily to-do list.** It shows what to take off the shelf, what to reorder and what to sell first, ranked by urgency.
- **Waste prediction.** From the last 30 days of sales, it works out which batches will expire before they sell, while there is still time to act.
- **Reorder suggestions.** Each suggestion covers the delivery wait plus a month of sales, and downloads as a CSV for your supplier.
- **Expiry outlook.** A chart shows the value of stock expiring each month for the next year.
- **Import, export and backup.** Import a spreadsheet (CSV), export stock and history, and back up and restore everything.

### AI (optional, with your own OpenAI or Claude key)

- **Invoice scanning.** Photograph a supplier invoice or upload a PDF. The AI copies every line exactly as printed. MedShelf then does the arithmetic itself, so "3 packs of 100 at £8.00" becomes 300 units at £0.08. It matches lines to medicines you already stock, and flags anything the AI couldn't read. **Nothing is saved until you have checked it.**
- **Daily briefing.** A short, ranked plan for the day, written from your real stock numbers.
- **Assistant.** Ask about your stock in plain English, for example "Which medicines are costing me the most in waste?" or "Make this week's order list within £500."

<table>
  <tr>
    <td><img src="docs/scan-review.jpg" alt="Checking lines the AI read from a delivery invoice"></td>
    <td><img src="docs/assistant.jpg" alt="The assistant, ready for a question"></td>
  </tr>
  <tr>
    <td align="center"><sub>Checking scanned invoice lines before they are saved</sub></td>
    <td align="center"><sub>The stock assistant</sub></td>
  </tr>
</table>

Try scanning yourself with the [sample invoice](docs/sample-invoice.png).

### Designed for real shops

- **Works offline.** It installs like an app on a phone or PC, and keeps working without internet. Only the optional AI features need a connection.
- **Light and dark mode**, and a layout that works on phones.
- **No server and no account.** Open it and start.

## Privacy and safety

- **Your data stays on your device.** Stock lives in the browser's own database (IndexedDB). There is no MedShelf server.
- **Your AI key stays in your browser.** It is never written into backups, and it is only ever sent to your AI provider.
- **The AI sees only what it needs, when you use it:** the stock list (names, quantities, expiry dates and costs), or the photo you scan. **Dispensing notes are never sent**, because they can hold prescription numbers or patient initials.
- **The AI only advises.** It can't change stock by itself, it is told not to give medical advice, and text on scanned paperwork is treated as data, not instructions.
- A Content Security Policy only lets the page talk to itself and the two AI providers.

## Quick start

**Try it now:** open the [live demo](https://talhaali-tech-engineer.github.io/MedShelf/) and press **Try it with sample data**.

**Run it on your own computer.** You need [Node.js](https://nodejs.org) 20 or newer; there is nothing else to install.

```bash
git clone https://github.com/talhaali-tech-engineer/MedShelf.git
cd MedShelf
npm start
```

Then open http://localhost:8080.

**Turn on AI (optional).** Open **Data → Assistant**, paste an [OpenAI](https://platform.openai.com/api-keys) or [Claude](https://console.anthropic.com/settings/keys) API key, press **Test connection**, then **Save**. MedShelf works out the provider from the key. The defaults are `gpt-4o` and `claude-opus-5-5`, and you can change them there.

**Host your own copy for free.** Fork this repository, go to **Settings → Pages**, choose **Deploy from a branch**, and pick `main` and `/ (root)`. Each person who opens it keeps their own data on their own device.

## How the numbers are worked out

| | |
| --- | --- |
| **Expiry** | The expiry date is the last day a batch can be dispensed. A month on its own, like `03/2027`, means the last day of that month. |
| **Sales rate** | Units dispensed in the last 30 days, divided by 30. A recently stocked medicine is averaged over the days it has been stocked, but never fewer than 7. |
| **Waste risk** | Batches are used in expiry order at the current sales rate. Units still left in a batch on its expiry date are at risk. This needs two weeks of history. |
| **Reorder** | Stock is low when it is zero, at or below the reorder level, or will last no longer than the delivery time. The suggested order covers the delivery time plus the cover period (30 days by default), and is never less than twice the reorder level. |

## Importing a spreadsheet

Save your stock list as CSV with these columns. Only `name`, `expiry` and `qty` are required.

| name | strength | form | batch | expiry | qty | unit_cost | reorder_level |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Paracetamol | 500 mg | Tablet | PCM2401 | 03/2027 | 500 | 0.02 | 200 |

Rows with problems are listed by row number and are not imported.

## Built with

Plain HTML, CSS and JavaScript modules: **no frameworks, no dependencies and no build step.** The stock logic and the AI requests are pure modules covered by tests that run on Node's built-in test runner. The AI tests use a fake server, so they need no key.

```bash
npm test        # logic and AI tests
npm start       # serves the app at http://localhost:8080
```

```
index.html              page shell and Content Security Policy
css/styles.css          design system, light and dark mode
js/core.js              stock, expiry, reorder, CSV and backup logic (tested)
js/ai.js                OpenAI and Claude requests, streaming, invoice reading (tested)
js/app.js               screens
js/chart.js             expiry outlook chart
js/ui.js, js/icons.js   DOM helpers, safe Markdown rendering, icons
js/db.js                IndexedDB storage
sw.js                   offline cache
tests/                  Node tests
```

## Limits

- One device per shop for now. Data is not synced between devices; use backups to move it.
- MedShelf is a stock tool. It is not a prescription record or a medical device, and it doesn't replace physical stock checks. AI readings can be wrong, which is why every scanned line needs your confirmation.

## Roadmap

- Sync between devices in the same shop
- Barcode scanning with the phone camera
- Supplier list and purchase orders
- Printable shelf labels and stock-count sheets

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a pull request.

## Author

Created by **Talha Ali** ([@talhaali-tech-engineer](https://github.com/talhaali-tech-engineer)).

## Licence

[MIT](LICENSE)
