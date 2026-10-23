// MedShelf UI. Views render from in-memory state; every change is saved to
// IndexedDB first and only then applied in memory.

import * as core from './core.js';
import * as db from './db.js';
import { sampleData } from './sample.js';

const main = document.getElementById('main');
const toastBox = document.getElementById('toast');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('medshelf') : null;
let state = { medicines: [], batches: [], movements: [], settings: { ...core.DEFAULT_SETTINGS } };
let askedToPersist = false;

/* ---------- helpers ---------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

const today = () => core.todayISO();
const ctx = () => ({ today: today(), now: new Date().toISOString(), newId });
const findMed = (id) => state.medicines.find((m) => m.id === id);
const label = (m) => core.medicineLabel(m);
const byName = (a, b) => label(a).localeCompare(label(b));

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const fmtNum = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const money = (n) => state.settings.currency + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, word, many = `${word}s`) => `${fmtNum(n)} ${n === 1 ? word : many}`;

function daysText(days) {
  if (days < 0) return `expired ${plural(-days, 'day')} ago`;
  if (days === 0) return 'last day today';
  return `in ${plural(days, 'day')}`;
}

function toast(message, kind = 'ok') {
  const item = h('div', { class: `toast ${kind}` }, message);
  toastBox.append(item);
  setTimeout(() => item.remove(), kind === 'bad' ? 6000 : 3500);
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong.', 'bad');
  }
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function commit(put, options) {
  await db.save(put, options);
  state = core.applyChanges(state, put);
  channel?.postMessage('changed');
  if (!askedToPersist) {
    askedToPersist = true;
    navigator.storage?.persist?.();
  }
}

async function saveSettings(changes) {
  const settings = core.cleanSettings({ ...state.settings, ...changes });
  await db.saveSettings(settings);
  state = { ...state, settings };
  channel?.postMessage('changed');
}

const field = (text, control, hint) => h('label', { class: 'field' }, h('span', {}, text), control, hint && h('small', { class: 'hint' }, hint));
const badge = (kind, text) => h('span', { class: `badge ${kind}` }, text);
const table = (heads, rows) => h('div', { class: 'table-wrap' },
  h('table', {}, h('thead', {}, h('tr', {}, heads.map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows)));

function medicineBadges(row) {
  const out = [];
  if (row.expiredUnits) out.push(badge('bad', 'Expired stock'));
  if (row.onHand === 0) out.push(badge('bad', 'Out of stock'));
  else if (row.low) out.push(badge('warn', 'Low'));
  if (row.expiringUnits) out.push(badge('warn', 'Expiring'));
  if (row.riskUnits) out.push(badge('warn', 'Waste risk'));
  return out.length ? out : [badge('ok', 'OK')];
}

/* ---------- Today ---------- */

function viewToday() {
  if (state.medicines.length === 0) return viewWelcome();
  const { rows, totals, expired, expiring } = core.summarize(state, today(), state.settings);
  const { warnDays } = state.settings;
  const low = rows.filter((r) => r.low).sort((a, b) => a.onHand - b.onHand || byName(a.medicine, b.medicine));
  const risky = rows.filter((r) => r.riskUnits > 0).sort((a, b) => b.riskValue - a.riskValue);
  const medLink = (m) => h('a', { href: `#/stock/${m.id}` }, label(m));

  const jump = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };
  const card = (kind, title, big, small, target) => h('a', { class: `card ${kind}`, href: `#${target}`, onclick: jump(target) },
    h('span', { class: 'card-title' }, title), h('strong', {}, big), h('span', { class: 'card-sub' }, small));

  return h('div', {},
    h('h1', {}, 'Today'),
    backupNudge(),
    h('div', { class: 'cards' },
      card(totals.expiredUnits ? 'bad' : 'ok', 'Expired on the shelf', plural(totals.expiredUnits, 'unit'), `${money(totals.expiredValue)} · take off the shelf`, 'expired'),
      card(totals.expiringUnits ? 'warn' : 'ok', `Expiring within ${warnDays} days`, plural(totals.expiringUnits, 'unit'), money(totals.expiringValue), 'expiring'),
      card(totals.riskUnits ? 'warn' : 'ok', 'Likely to expire unsold', plural(totals.riskUnits, 'unit'), `${money(totals.riskValue)} at your sales rate`, 'risk'),
      card(totals.lowCount ? 'warn' : 'ok', 'Need reordering', plural(totals.lowCount, 'medicine'), 'low or out of stock', 'reorder')),

    h('section', { id: 'expired' },
      h('h2', {}, 'Take off the shelf'),
      expired.length
        ? [h('p', { class: 'muted' }, 'These batches are past their expiry date. MedShelf will not dispense them. Remove them and write them off.'),
          table(['Medicine', 'Batch', 'Expired', 'Units', 'Value', ''], expired.map(({ medicine, batch }) => h('tr', {},
            h('td', {}, medLink(medicine)), h('td', {}, batch.batchNo || '—'), h('td', {}, fmtDate(batch.expiry)),
            h('td', { class: 'num' }, fmtNum(batch.qty)), h('td', { class: 'num' }, money(batch.qty * (batch.unitCost ?? 0))),
            h('td', {}, h('button', { class: 'small', onclick: () => openWriteOff(batch) }, 'Write off')))))]
        : h('p', { class: 'muted' }, 'Nothing expired. Good.')),

    h('section', { id: 'reorder' },
      h('div', { class: 'section-head' },
        h('h2', {}, 'Reorder'),
        low.length > 0 && h('button', { class: 'small', onclick: () => downloadReorder(low) }, 'Download order list (CSV)')),
      low.length
        ? table(['Medicine', 'In stock', 'Sells per day', 'Runs out', 'Suggested order'], low.map((r) => h('tr', {},
          h('td', {}, medLink(r.medicine)), h('td', { class: 'num' }, fmtNum(r.onHand)), h('td', { class: 'num' }, r.avgDaily ? fmtNum(r.avgDaily) : '—'),
          h('td', {}, r.onHand === 0 ? badge('bad', 'Out now') : r.daysLeft === null ? '—' : `in about ${plural(Math.floor(r.daysLeft), 'day')}`),
          h('td', { class: 'num' }, r.orderQty ? fmtNum(r.orderQty) : 'Set a reorder level'))))
        : h('p', { class: 'muted' }, 'Everything is above its reorder level.')),

    h('section', { id: 'risk' },
      h('h2', {}, 'Likely to expire unsold'),
      risky.length
        ? [h('p', { class: 'muted' }, 'At the rate these sold over the last 30 days, some units will expire before they sell. Put them at the front, return them to the supplier, or pass them to a branch that uses more.'),
          table(['Medicine', 'Batch', 'Expires', 'Units on shelf', 'Will not sell in time'], risky.flatMap((r) => r.risks.map((risk) => h('tr', {},
            h('td', {}, medLink(r.medicine)), h('td', {}, risk.batchNo || '—'), h('td', {}, fmtDate(risk.expiry)),
            h('td', { class: 'num' }, fmtNum(risk.qty)), h('td', { class: 'num' }, `about ${fmtNum(risk.atRisk)}`)))))]
        : h('p', { class: 'muted' }, 'No waste predicted. This needs two weeks of sales history for each medicine.')),

    h('section', { id: 'expiring' },
      h('h2', {}, `Expiring within ${warnDays} days`),
      expiring.length
        ? table(['Medicine', 'Batch', 'Expires', 'Units'], expiring.map(({ medicine, batch, daysLeft }) => h('tr', {},
          h('td', {}, medLink(medicine)), h('td', {}, batch.batchNo || '—'),
          h('td', {}, `${fmtDate(batch.expiry)} (${daysText(daysLeft)})`), h('td', { class: 'num' }, fmtNum(batch.qty)))))
        : h('p', { class: 'muted' }, 'Nothing expires soon.')));
}

function backupNudge() {
  const last = state.settings.lastBackup;
  const days = last ? core.daysBetween(last.slice(0, 10), today()) : null;
  if (days !== null && days < 7) return null;
  return h('div', { class: 'notice' },
    h('span', {}, last ? `Your last backup was ${plural(days, 'day')} ago. ` : 'Your stock is saved only in this browser on this device. '),
    h('a', { href: '#/data' }, 'Download a backup'));
}

function downloadReorder(rows) {
  const lines = [['medicine', 'strength', 'form', 'in_stock', 'sells_per_day', 'suggested_order']];
  for (const r of rows) lines.push([r.medicine.name, r.medicine.strength, r.medicine.form, r.onHand, Math.round(r.avgDaily * 10) / 10, r.orderQty]);
  download(`medshelf-order-${today()}.csv`, core.toCSV(lines), 'text/csv');
}

function viewWelcome() {
  return h('div', { class: 'welcome' },
    h('h1', {}, 'Stop losing money to expired medicine'),
    h('p', {}, 'MedShelf tracks every batch you receive and its expiry date. It tells you what to take off the shelf, what will expire before it sells, and what to reorder. It sells the earliest-expiring stock first.'),
    h('p', { class: 'muted' }, 'It works without internet, and your stock stays in this browser on this device. Nothing is sent anywhere.'),
    h('div', { class: 'actions' },
      h('a', { class: 'button primary', href: '#/receive' }, 'Add your first delivery'),
      h('a', { class: 'button', href: '#/data' }, 'Import a spreadsheet'),
      h('button', { onclick: () => act(loadSample) }, 'Try it with sample data')));
}

async function loadSample() {
  const data = sampleData(today(), newId);
  await commit(data);
  toast('Sample data loaded. Erase it from the Data page when you are done.');
  render();
}

/* ---------- Stock ---------- */

function viewStock(id) {
  if (id) return viewMedicine(id);
  const { rows } = core.summarize(state, today(), state.settings);
  rows.sort((a, b) => byName(a.medicine, b.medicine));
  const tbody = h('tbody');
  const fill = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = rows.filter((r) => words.every((w) => label(r.medicine).toLowerCase().includes(w)));
    tbody.replaceChildren(...shown.map((r) => h('tr', {},
      h('td', {}, h('a', { href: `#/stock/${r.medicine.id}` }, label(r.medicine))),
      h('td', { class: 'num' }, fmtNum(r.onHand)),
      h('td', {}, fmtDate(r.nextExpiry)),
      h('td', { class: 'num' }, r.daysLeft === null ? '—' : fmtNum(Math.floor(r.daysLeft))),
      h('td', {}, medicineBadges(r)))));
    if (!shown.length) tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, rows.length ? 'No medicine matches.' : 'No stock yet.')));
  };
  fill('');
  return h('div', {},
    h('div', { class: 'section-head' }, h('h1', {}, 'Stock'), h('a', { class: 'button primary', href: '#/receive' }, 'Receive stock')),
    h('input', { type: 'search', class: 'search', placeholder: 'Search medicines', 'aria-label': 'Search medicines', oninput: (e) => fill(e.target.value) }),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Medicine', 'In stock', 'Next expiry', 'Days of stock', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
      tbody)));
}

function viewMedicine(id) {
  const med = findMed(id);
  if (!med) return h('div', {}, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/stock' }, 'Back to stock')));
  const t = today();
  const row = core.summarize({ ...state, medicines: [med] }, t, state.settings).rows[0];
  const batches = state.batches.filter((b) => b.medicineId === id && b.qty > 0).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const history = state.movements.filter((m) => m.medicineId === id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  const batchNo = (bid) => state.batches.find((b) => b.id === bid)?.batchNo || '—';
  const kinds = { receive: 'Received', dispense: 'Dispensed', writeoff: 'Written off' };
  const stat = (name, value) => h('div', { class: 'stat' }, h('span', {}, name), h('strong', {}, value));

  const levelForm = h('form', { class: 'inline', onsubmit: (e) => {
    e.preventDefault();
    act(async () => {
      const level = Number(e.target.level.value);
      if (!Number.isInteger(level) || level < 0) throw new RangeError('Reorder level must be a whole number, zero or more.');
      await commit({ medicines: [{ ...med, reorderLevel: level }] });
      toast('Reorder level saved.');
      render();
    });
  } },
  field('Reorder level', h('input', { name: 'level', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: med.reorderLevel ?? 0 })),
  h('button', {}, 'Save'));

  return h('div', {},
    h('p', {}, h('a', { href: '#/stock' }, '← All stock')),
    h('div', { class: 'section-head' }, h('h1', {}, label(med)), h('div', { class: 'badges' }, medicineBadges(row))),
    h('div', { class: 'stats' },
      stat('In stock (in date)', fmtNum(row.onHand)),
      stat('Sells per day', row.avgDaily ? fmtNum(row.avgDaily) : '—'),
      stat('Runs out', row.daysLeft === null ? '—' : `in about ${plural(Math.floor(row.daysLeft), 'day')}`),
      stat('Suggested order', row.orderQty ? fmtNum(row.orderQty) : '—')),
    h('div', { class: 'actions' },
      h('a', { class: 'button primary', href: `#/dispense/${id}` }, 'Dispense'),
      h('a', { class: 'button', href: `#/receive/${id}` }, 'Receive more')),
    levelForm,
    h('h2', {}, 'Batches on the shelf'),
    batches.length
      ? table(['Batch', 'Expiry', 'Units', 'Cost per unit', 'Status', ''], batches.map((b) => {
        const status = core.expiryStatus(b.expiry, t, state.settings.warnDays);
        const days = core.daysBetween(t, b.expiry);
        return h('tr', {},
          h('td', {}, b.batchNo || '—'),
          h('td', {}, `${fmtDate(b.expiry)} (${daysText(days)})`),
          h('td', { class: 'num' }, fmtNum(b.qty)),
          h('td', { class: 'num' }, money(b.unitCost ?? 0)),
          h('td', {}, badge(status === 'expired' ? 'bad' : status === 'expiring' ? 'warn' : 'ok', status === 'expired' ? 'Expired' : status === 'expiring' ? 'Expiring' : 'OK')),
          h('td', {}, h('button', { class: 'small', onclick: () => openWriteOff(b) }, 'Write off')));
      }))
      : h('p', { class: 'muted' }, 'No units on the shelf.'),
    h('h2', {}, 'History'),
    history.length
      ? table(['Date', 'What happened', 'Batch', 'Units', 'Note'], history.map((m) => h('tr', {},
        h('td', {}, fmtDate(m.date)), h('td', {}, kinds[m.type]), h('td', {}, batchNo(m.batchId)),
        h('td', { class: 'num' }, fmtNum(m.qty)), h('td', {}, m.note || ''))))
      : h('p', { class: 'muted' }, 'Nothing yet.'));
}

function openWriteOff(batch) {
  const med = findMed(batch.medicineId);
  const expired = core.expiryStatus(batch.expiry, today(), state.settings.warnDays) === 'expired';
  const reasons = ['Expired', 'Damaged', 'Recalled', 'Returned to supplier', 'Stock count correction'];
  const dialog = h('dialog', { class: 'dialog' });
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    act(async () => {
      const put = core.writeOff(state, batch.id, Number(form.qty.value), form.reason.value, ctx());
      await commit(put);
      dialog.close();
      toast(`Wrote off ${form.qty.value} of ${label(med)}.`);
      render();
    });
  } },
  h('h2', {}, 'Write off stock'),
  h('p', {}, `${label(med)}, batch ${batch.batchNo || '(no number)'}, expiry ${fmtDate(batch.expiry)}. ${plural(batch.qty, 'unit')} on the shelf.`),
  field('Units to remove', h('input', { name: 'qty', type: 'number', min: 1, max: batch.qty, step: 1, inputmode: 'numeric', required: true, value: batch.qty })),
  field('Reason', h('select', { name: 'reason', value: expired ? 'Expired' : 'Damaged' }, reasons.map((r) => h('option', {}, r)))),
  h('div', { class: 'actions' },
    h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
    h('button', { class: 'danger' }, 'Write off')));
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/* ---------- Receive ---------- */

const FORMS = ['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Inhaler', 'Cream', 'Ointment', 'Drops', 'Sachet', 'Pen', 'Suppository'];

function viewReceive(prefillId) {
  const pre = findMed(prefillId);
  const names = [...new Set(state.medicines.map((m) => m.name))].sort();
  const expiryHint = h('small', { class: 'hint' }, 'As printed on the pack, for example 03/2027 or 2027-03-31.');

  // Named lookups, because form.name would otherwise be the form's own name.
  const input = (key) => form.elements.namedItem(key);

  const showExpiry = () => {
    const raw = input('expiry').value.trim();
    const iso = core.normalizeExpiry(raw);
    expiryHint.textContent = !raw ? 'As printed on the pack, for example 03/2027 or 2027-03-31.'
      : iso ? `Last day it can be sold: ${fmtDate(iso)}${iso < today() ? '. This is already expired.' : ''}`
        : 'Not a date MedShelf can read. Try 03/2027 or 2027-03-31.';
    expiryHint.className = `hint${raw && !iso ? ' error' : ''}`;
  };

  const fillFromName = () => {
    const matches = state.medicines.filter((m) => m.name.toLowerCase() === input('name').value.trim().toLowerCase());
    if (matches.length !== 1) return;
    const [m] = matches;
    if (!input('strength').value) input('strength').value = m.strength;
    if (!input('form').value) input('form').value = m.form;
    input('reorderLevel').placeholder = `Now ${m.reorderLevel ?? 0}`;
  };

  const form = h('form', { class: 'form', onsubmit: (e) => {
    e.preventDefault();
    act(async () => {
      const f = new FormData(form);
      const num = (k, blank) => (String(f.get(k)).trim() === '' ? blank : Number(f.get(k)));
      const item = {
        name: f.get('name'), strength: f.get('strength'), form: f.get('form'), batchNo: f.get('batchNo'),
        expiry: core.normalizeExpiry(f.get('expiry')), qty: num('qty', 0), unitCost: num('unitCost', 0), reorderLevel: num('reorderLevel', null),
      };
      const put = core.receive(state, item, ctx());
      await commit(put);
      toast(`Added ${fmtNum(item.qty)} × ${label(findMed(put.batches[0].medicineId))}.`);
      render();
      main.querySelector('input[name=name]')?.focus();
    });
  } },
  h('datalist', { id: 'med-names' }, names.map((n) => h('option', { value: n }))),
  h('datalist', { id: 'med-forms' }, FORMS.map((n) => h('option', { value: n }))),
  field('Medicine name', h('input', { name: 'name', required: true, list: 'med-names', autocomplete: 'off', value: pre?.name, onchange: fillFromName })),
  h('div', { class: 'row' },
    field('Strength', h('input', { name: 'strength', placeholder: '500 mg', autocomplete: 'off', value: pre?.strength })),
    field('Form', h('input', { name: 'form', placeholder: 'Tablet', list: 'med-forms', autocomplete: 'off', value: pre?.form }))),
  h('div', { class: 'row' },
    field('Batch number', h('input', { name: 'batchNo', autocomplete: 'off' })),
    field('Expiry', h('input', { name: 'expiry', required: true, autocomplete: 'off', inputmode: 'numeric', oninput: showExpiry }), null)),
  expiryHint,
  h('div', { class: 'row' },
    field('Units received', h('input', { name: 'qty', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true })),
    field('Cost per unit', h('input', { name: 'unitCost', type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: '0.00' }))),
  field('Reorder level', h('input', { name: 'reorderLevel', type: 'number', min: 0, step: 1, inputmode: 'numeric', placeholder: pre ? `Now ${pre.reorderLevel ?? 0}` : '0' }),
    'Warn me when stock falls to this many units. Leave blank to keep the current level.'),
  h('div', { class: 'actions' }, h('button', { class: 'primary' }, 'Add to stock')));

  return h('div', {}, h('h1', {}, 'Receive stock'), h('p', { class: 'muted' }, 'Enter each batch from the delivery. Use one line per batch number and expiry date.'), form);
}

/* ---------- Dispense ---------- */

function viewDispense(prefillId) {
  const t = today();
  const meds = [...state.medicines].sort(byName);
  if (!meds.length) return h('div', {}, h('h1', {}, 'Dispense'), h('p', {}, 'No stock yet. ', h('a', { href: '#/receive' }, 'Receive stock first.')));
  const onHand = (m) => core.stockOnHand(state.batches.filter((b) => b.medicineId === m.id), t);
  const preview = h('div', { class: 'preview', 'aria-live': 'polite' });
  const select = h('select', { name: 'medicine', required: true, onchange: () => update() },
    h('option', { value: '' }, 'Choose a medicine'),
    meds.map((m) => {
      const n = onHand(m);
      return h('option', { value: m.id, disabled: n === 0 }, `${label(m)}: ${n ? `${fmtNum(n)} in stock` : 'none in date'}`);
    }));
  if (prefillId && findMed(prefillId) && onHand(findMed(prefillId)) > 0) select.value = prefillId;
  const qty = h('input', { name: 'qty', type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true, oninput: () => update() });

  function update() {
    preview.replaceChildren();
    const q = Number(qty.value);
    if (!select.value || !qty.value) return;
    try {
      const plan = core.planDispense(state.batches.filter((b) => b.medicineId === select.value), q, t);
      preview.append(h('p', {}, 'Take from:'), h('ul', {}, plan.map((p) => h('li', {},
        `${fmtNum(p.qty)} from batch ${p.batchNo || '(no number)'}, expiry ${fmtDate(p.expiry)}`))));
    } catch (err) {
      preview.append(h('p', { class: 'error' }, err.message));
    }
  }

  const form = h('form', { class: 'form', onsubmit: (e) => {
    e.preventDefault();
    act(async () => {
      const med = findMed(select.value);
      const { put } = core.dispense(state, select.value, Number(qty.value), form.note.value, ctx());
      await commit(put);
      toast(`Dispensed ${qty.value} × ${label(med)}.`);
      render();
    });
  } },
  field('Medicine', select),
  field('Units', qty),
  field('Note (optional)', h('input', { name: 'note', autocomplete: 'off', placeholder: 'Prescription number, patient initials, or ward' })),
  preview,
  h('div', { class: 'actions' }, h('button', { class: 'primary' }, 'Dispense')));
  queueMicrotask(update);
  return h('div', {}, h('h1', {}, 'Dispense'), h('p', { class: 'muted' }, 'MedShelf takes the earliest-expiring in-date batch first, and never expired stock.'), form);
}

/* ---------- Data ---------- */

function viewData() {
  const s = state.settings;
  const restoreInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => act(() => restore(e.target)) });
  const csvInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: (e) => act(() => previewImport(e.target)) });
  const importResult = h('div', { 'aria-live': 'polite' });

  async function previewImport(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const { items, errors } = core.readStockCSV(await file.text());
    importResult.replaceChildren(
      h('p', {}, `${file.name}: ${plural(items.length, 'row')} ready${errors.length ? `, ${plural(errors.length, 'row')} with problems` : ''}.`),
      errors.length > 0 && h('ul', { class: 'errors' }, errors.slice(0, 20).map((e) => h('li', {}, `Row ${e.row}: ${e.message}`))),
      items.length > 0 && h('button', { class: 'primary', onclick: () => act(async () => {
        await commit(core.receiveMany(state, items, ctx()));
        toast(`Imported ${plural(items.length, 'row')}.`);
        location.hash = '#/stock';
      }) }, `Add ${plural(items.length, 'row')} to stock`));
  }

  async function restore(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const data = core.readBackup(await file.text());
    const ok = confirm(`Replace everything on this device with this backup?\n\n${plural(data.medicines.length, 'medicine')}, ${plural(data.batches.length, 'batch', 'batches')}.\n\nWhat is on this device now will be lost.`);
    if (!ok) return;
    const { settings, ...records } = data;
    await db.save({ ...records, meta: [{ id: 'settings', ...settings }] }, { replace: true });
    state = { ...records, settings };
    channel?.postMessage('changed');
    toast('Backup restored.');
    location.hash = '#/dashboard';
  }

  const settingsForm = h('form', { class: 'form', onsubmit: (e) => {
    e.preventDefault();
    act(async () => {
      const f = e.target;
      const ints = { warnDays: [1, 730], leadDays: [0, 365], coverDays: [1, 365] };
      const changes = { currency: f.currency.value };
      for (const [k, [min, max]] of Object.entries(ints)) {
        const v = Number(f[k].value);
        if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${f[k].dataset.label} must be a whole number from ${min} to ${max}.`);
        changes[k] = v;
      }
      await saveSettings(changes);
      toast('Settings saved.');
      render();
    });
  } },
  h('div', { class: 'row' },
    field('Warn about expiry this many days ahead', h('input', { name: 'warnDays', 'data-label': 'Warning days', type: 'number', min: 1, max: 730, step: 1, value: s.warnDays })),
    field('Days a delivery takes', h('input', { name: 'leadDays', 'data-label': 'Delivery days', type: 'number', min: 0, max: 365, step: 1, value: s.leadDays }))),
  h('div', { class: 'row' },
    field('Order enough for this many days', h('input', { name: 'coverDays', 'data-label': 'Order cover days', type: 'number', min: 1, max: 365, step: 1, value: s.coverDays })),
    field('Currency symbol', h('input', { name: 'currency', maxlength: 5, placeholder: '£, $, Rs, ₦…', value: s.currency }))),
  h('div', { class: 'actions' }, h('button', { class: 'primary' }, 'Save settings')));

  const stockCSV = () => {
    const lines = [core.STOCK_COLUMNS];
    for (const b of state.batches.filter((x) => x.qty > 0)) {
      const m = findMed(b.medicineId);
      lines.push([m.name, m.strength, m.form, b.batchNo, b.expiry, b.qty, b.unitCost ?? 0, m.reorderLevel ?? 0]);
    }
    download(`medshelf-stock-${today()}.csv`, core.toCSV(lines), 'text/csv');
  };
  const historyCSV = () => {
    const lines = [['date', 'type', 'medicine', 'strength', 'form', 'batch', 'qty', 'note']];
    for (const mv of [...state.movements].sort((a, b) => a.at.localeCompare(b.at))) {
      const m = findMed(mv.medicineId);
      const b = state.batches.find((x) => x.id === mv.batchId);
      lines.push([mv.date, mv.type, m?.name, m?.strength, m?.form, b?.batchNo, mv.qty, mv.note]);
    }
    download(`medshelf-history-${today()}.csv`, core.toCSV(lines), 'text/csv');
  };
  const backup = () => act(async () => {
    const now = new Date().toISOString();
    download(`medshelf-backup-${today()}.json`, JSON.stringify(core.makeBackup(state, now), null, 1), 'application/json');
    await saveSettings({ lastBackup: now });
    render();
  });
  const erase = () => act(async () => {
    if (!confirm('Erase all MedShelf data on this device? This cannot be undone.\n\nDownload a backup first if you might need it.')) return;
    await db.save({}, { replace: true });
    state = { medicines: [], batches: [], movements: [], settings: { ...core.DEFAULT_SETTINGS } };
    channel?.postMessage('changed');
    toast('All data erased.');
    location.hash = '#/dashboard';
  });

  return h('div', {},
    h('h1', {}, 'Data and settings'),
    h('section', {},
      h('h2', {}, 'Backup'),
      h('p', {}, 'Your stock is stored only in this browser on this device. If the browser data is cleared or the device is lost, it is gone. Download a backup every week and keep it somewhere safe.'),
      h('p', { class: 'muted' }, s.lastBackup ? `Last backup: ${fmtDate(s.lastBackup.slice(0, 10))}.` : 'No backup yet.'),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: backup }, 'Download backup'),
        h('button', { onclick: () => restoreInput.click() }, 'Restore from backup'),
        restoreInput)),
    h('section', {},
      h('h2', {}, 'Import from a spreadsheet'),
      h('p', {}, 'Save your stock list as CSV with these columns: ', h('code', {}, core.STOCK_COLUMNS.join(', ')),
        '. Only name, expiry and qty are required. Each row is added as a delivery.'),
      h('div', { class: 'actions' },
        h('button', { onclick: () => csvInput.click() }, 'Choose CSV file'),
        h('button', { onclick: () => download('medshelf-template.csv', core.toCSV([core.STOCK_COLUMNS, ['Paracetamol', '500 mg', 'Tablet', 'PCM2401', '03/2027', 500, 0.02, 200]]), 'text/csv') }, 'Download template'),
        csvInput),
      importResult),
    h('section', {},
      h('h2', {}, 'Export'),
      h('div', { class: 'actions' },
        h('button', { onclick: stockCSV }, 'Stock list (CSV)'),
        h('button', { onclick: historyCSV }, 'Full history (CSV)'))),
    h('section', {}, h('h2', {}, 'Settings'), settingsForm),
    h('section', { class: 'danger-zone' },
      h('h2', {}, 'Erase everything'),
      h('p', {}, 'Removes all medicines, batches and history from this device.'),
      h('button', { class: 'danger', onclick: erase }, 'Erase all data')));
}

/* ---------- routing ---------- */

const VIEWS = { dashboard: viewToday, stock: viewStock, receive: viewReceive, dispense: viewDispense, data: viewData };
const TITLES = { dashboard: 'Today', stock: 'Stock', receive: 'Receive stock', dispense: 'Dispense', data: 'Data and settings' };

function currentRoute() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return VIEWS[name] ? { name, arg: decodeURIComponent(arg ?? '') } : { name: 'dashboard', arg: '' };
}

function render() {
  const { name, arg } = currentRoute();
  for (const a of document.querySelectorAll('[data-view]')) {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${TITLES[name]} · MedShelf`;
  main.replaceChildren(VIEWS[name](arg));
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

// Another tab saved something: reload so this tab never works from stale stock.
channel?.addEventListener('message', () => act(async () => {
  state = await loadState();
  const { name } = currentRoute();
  if (name === 'dashboard' || name === 'stock') render();
}));

async function loadState() {
  const data = await db.loadAll();
  return { ...data, settings: core.cleanSettings(data.settings) };
}

async function start() {
  try {
    state = await loadState();
  } catch (err) {
    main.replaceChildren(h('div', { class: 'notice bad' },
      h('strong', {}, 'MedShelf cannot open its storage. '),
      'Private browsing or blocked site data can cause this. Open MedShelf in a normal window. ',
      h('small', {}, `(${err.message})`)));
    return;
  }
  if (!location.hash.startsWith('#/')) history.replaceState(null, '', '#/dashboard');
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline mode unavailable:', err));
  }
}

start();
