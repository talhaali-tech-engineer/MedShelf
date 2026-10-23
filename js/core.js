// MedShelf core: pure stock and expiry logic.
// No DOM or storage in here, so the same code runs in the browser and in Node tests.

const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

/* ---------- dates ---------- */

/** Whole days since 1970-01-01 for a 'YYYY-MM-DD' string, ignoring time zones. */
export function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(iso, n) {
  return new Date((dayNumber(iso) + n) * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(fromISO, toISO) {
  return dayNumber(toISO) - dayNumber(fromISO);
}

function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Turns the expiry formats printed on packs into 'YYYY-MM-DD'.
 * A month-only expiry ("03/2027", "2027-03") means the last day of that month.
 * Returns null when the text is not a real date.
 */
export function normalizeExpiry(text) {
  const s = String(text ?? '').trim();
  let y, m, d, match;
  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = match.map(Number);
  else if ((match = s.match(/^(\d{4})-(\d{1,2})$/))) [, y, m] = match.map(Number);
  else if ((match = s.match(/^(\d{1,2})\/(\d{4})$/))) [, m, y] = match.map(Number);
  else if ((match = s.match(/^(\d{1,2})\/(\d{2})$/))) { [, m, y] = match.map(Number); y += 2000; }
  else return null;
  if (!(m >= 1 && m <= 12) || y < 2000 || y > 2100) return null;
  if (d === undefined) d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (!isRealDate(y, m, d)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/* ---------- small helpers ---------- */

export function clean(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

export function medicineKey(m) {
  return [m.name, m.strength, m.form].map((x) => clean(x).toLowerCase()).join('|');
}

export function medicineLabel(m) {
  return [m.name, m.strength].filter(Boolean).join(' ') + (m.form ? ` (${m.form})` : '');
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const list = map.get(item[key]);
    if (list) list.push(item);
    else map.set(item[key], [item]);
  }
  return map;
}

function earliestDate(movements) {
  return movements.reduce((min, m) => (m.date < min ? m.date : min), movements[0].date);
}

/* ---------- settings ---------- */

export function cleanSettings(raw = {}) {
  const int = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
  return {
    warnDays: int(raw.warnDays, 1, 730, 90),
    leadDays: int(raw.leadDays, 0, 365, 7),
    coverDays: int(raw.coverDays, 1, 365, 30),
    currency: typeof raw.currency === 'string' ? raw.currency.trim().slice(0, 5) : '',
    lastBackup: typeof raw.lastBackup === 'string' ? raw.lastBackup : null,
  };
}

export const DEFAULT_SETTINGS = Object.freeze(cleanSettings());

/* ---------- expiry and stock ---------- */

/** The expiry date is the last day a batch may be dispensed. */
export function expiryStatus(expiry, today, warnDays) {
  const left = daysBetween(today, expiry);
  if (left < 0) return 'expired';
  if (left <= warnDays) return 'expiring';
  return 'ok';
}

/** In-date batches with stock, in the order they should leave the shelf: first expiry, first out. */
export function usableBatches(batches, today) {
  return batches
    .filter((b) => b.qty > 0 && daysBetween(today, b.expiry) >= 0)
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));
}

export function stockOnHand(batches, today) {
  return usableBatches(batches, today).reduce((sum, b) => sum + b.qty, 0);
}

export class StockError extends Error {
  constructor(message, available) {
    super(message);
    this.name = 'StockError';
    this.available = available;
  }
}

/** Which batches to take `qty` units from, earliest expiry first. Expired stock is never used. */
export function planDispense(batches, qty, today) {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('Quantity must be a whole number above zero.');
  const plan = [];
  let left = qty;
  for (const b of usableBatches(batches, today)) {
    if (left === 0) break;
    const take = Math.min(b.qty, left);
    plan.push({ batchId: b.id, batchNo: b.batchNo, expiry: b.expiry, qty: take });
    left -= take;
  }
  if (left > 0) {
    const available = qty - left;
    throw new StockError(`Only ${available} in-date unit${available === 1 ? '' : 's'} in stock.`, available);
  }
  return plan;
}

/**
 * Average units dispensed per day over the last `windowDays`.
 * A medicine stocked only recently is averaged over the days it has been stocked
 * (at least a week, so one busy first day does not look like the normal rate).
 */
export function averageDailyUse(movements, today, windowDays = 30) {
  if (movements.length === 0) return 0;
  const since = addDays(today, -(windowDays - 1));
  const span = Math.min(windowDays, Math.max(7, daysBetween(earliestDate(movements), today) + 1));
  const used = movements
    .filter((m) => m.type === 'dispense' && m.date >= since && m.date <= today)
    .reduce((sum, m) => sum + m.qty, 0);
  return used / span;
}

/**
 * Units that will probably expire on the shelf at the current rate of use.
 * Batches are used first-expiry-first-out; each can only be sold until its
 * expiry date, and whatever is left by then is at risk.
 */
export function wasteRisk(batches, avgDaily, today) {
  const risks = [];
  let start = 0; // days from today when the next batch starts being used
  for (const b of usableBatches(batches, today)) {
    let canUse = 0;
    if (avgDaily > 0) {
      const sellableDays = daysBetween(today, b.expiry) + 1;
      canUse = Math.min(b.qty, Math.floor(Math.max(0, sellableDays - start) * avgDaily));
      start += canUse / avgDaily;
    }
    const atRisk = b.qty - canUse;
    if (atRisk > 0) {
      risks.push({ batchId: b.id, batchNo: b.batchNo, expiry: b.expiry, qty: b.qty, atRisk, unitCost: b.unitCost ?? 0 });
    }
  }
  return risks;
}

/**
 * Whether to reorder and how much. Stock is low when it is out, at or below the
 * reorder level, or will run out before a new delivery arrives. The suggested
 * order covers the delivery wait plus `coverDays` of sales, and never less than
 * twice the reorder level.
 */
export function reorderAdvice({ onHand, avgDaily, reorderLevel = 0, leadDays = 7, coverDays = 30 }) {
  const daysLeft = avgDaily > 0 ? onHand / avgDaily : null;
  const low = onHand === 0 || (reorderLevel > 0 && onHand <= reorderLevel) || (daysLeft !== null && daysLeft <= leadDays);
  const target = Math.max(reorderLevel * 2, Math.ceil(avgDaily * (leadDays + coverDays)));
  return { low, daysLeft, orderQty: low ? Math.max(0, target - onHand) : 0 };
}

/** Everything the Today screen needs, per medicine and in total. */
export function summarize(state, today, settings = DEFAULT_SETTINGS) {
  const { warnDays, leadDays, coverDays } = cleanSettings(settings);
  const batchesBy = groupBy(state.batches, 'medicineId');
  const movesBy = groupBy(state.movements, 'medicineId');
  const totals = { stockValue: 0, expiredUnits: 0, expiredValue: 0, expiringUnits: 0, expiringValue: 0, riskUnits: 0, riskValue: 0, lowCount: 0 };
  const expired = [];
  const expiring = [];

  const rows = state.medicines.map((medicine) => {
    const batches = batchesBy.get(medicine.id) ?? [];
    const moves = movesBy.get(medicine.id) ?? [];
    const onHand = stockOnHand(batches, today);
    const avgDaily = averageDailyUse(moves, today);
    const { low, daysLeft, orderQty } = reorderAdvice({ onHand, avgDaily, reorderLevel: medicine.reorderLevel ?? 0, leadDays, coverDays });

    let expiredUnits = 0;
    let expiringUnits = 0;
    for (const batch of batches) {
      if (batch.qty <= 0) continue;
      const value = batch.qty * (batch.unitCost ?? 0);
      const status = expiryStatus(batch.expiry, today, warnDays);
      const item = { medicine, batch, daysLeft: daysBetween(today, batch.expiry) };
      if (status === 'expired') {
        expiredUnits += batch.qty;
        totals.expiredValue += value;
        expired.push(item);
        continue;
      }
      totals.stockValue += value;
      if (status === 'expiring') {
        expiringUnits += batch.qty;
        totals.expiringValue += value;
        expiring.push(item);
      }
    }

    // Only trust a usage rate once the medicine has two weeks of history. With no
    // sales at all, only flag stock that is already inside the warning window.
    const historyDays = moves.length ? daysBetween(earliestDate(moves), today) : 0;
    const risks = historyDays >= 14
      ? wasteRisk(batches, avgDaily, today).filter((r) => avgDaily > 0 || daysBetween(today, r.expiry) <= warnDays)
      : [];
    const riskUnits = risks.reduce((sum, r) => sum + r.atRisk, 0);
    const riskValue = risks.reduce((sum, r) => sum + r.atRisk * r.unitCost, 0);

    totals.expiredUnits += expiredUnits;
    totals.expiringUnits += expiringUnits;
    totals.riskUnits += riskUnits;
    totals.riskValue += riskValue;
    if (low) totals.lowCount += 1;

    const next = usableBatches(batches, today)[0];
    return { medicine, onHand, avgDaily, daysLeft, low, orderQty, nextExpiry: next?.expiry ?? null, expiredUnits, expiringUnits, risks, riskUnits, riskValue };
  });

  const byExpiry = (a, b) => a.batch.expiry.localeCompare(b.batch.expiry);
  return { rows, totals, expired: expired.sort(byExpiry), expiring: expiring.sort(byExpiry) };
}

/* ---------- changes ---------- */
// Actions return the records to save, as { storeName: [records] }. The app saves
// them to IndexedDB and then folds them into memory with applyChanges.

export function applyChanges(state, put) {
  const next = { ...state };
  for (const [store, items] of Object.entries(put)) {
    if (!items?.length) continue;
    const byId = new Map(state[store].map((x) => [x.id, x]));
    for (const x of items) byId.set(x.id, x);
    next[store] = [...byId.values()];
  }
  return next;
}

export function mergeChanges(a, b) {
  const out = { ...a };
  for (const [store, items] of Object.entries(b)) {
    const byId = new Map((out[store] ?? []).map((x) => [x.id, x]));
    for (const x of items ?? []) byId.set(x.id, x);
    out[store] = [...byId.values()];
  }
  return out;
}

/** Returns a message describing what is wrong with a delivery, or null when it is fine. */
export function checkReceipt({ name, expiry, qty, unitCost, reorderLevel }) {
  if (!clean(name)) return 'Enter the medicine name.';
  if (!expiry) return 'Enter a real expiry date, for example 03/2027 or 2027-03-31.';
  if (!Number.isInteger(qty) || qty <= 0) return 'Quantity must be a whole number above zero.';
  if (!(Number.isFinite(unitCost) && unitCost >= 0)) return 'Cost per unit must be zero or more.';
  if (reorderLevel != null && !isCount(reorderLevel)) return 'Reorder level must be a whole number, zero or more.';
  return null;
}

/**
 * Adds a delivery. A new name/strength/form creates the medicine; the same batch
 * number with the same expiry tops up the existing batch.
 */
export function receive(state, item, ctx) {
  const problem = checkReceipt(item);
  if (problem) throw new RangeError(problem);
  const put = { medicines: [], batches: [], movements: [] };

  let med = state.medicines.find((m) => medicineKey(m) === medicineKey(item));
  if (!med) {
    med = { id: ctx.newId(), name: clean(item.name), strength: clean(item.strength), form: clean(item.form), reorderLevel: item.reorderLevel ?? 0, createdAt: ctx.now };
    put.medicines.push(med);
  } else if (item.reorderLevel != null && item.reorderLevel !== med.reorderLevel) {
    med = { ...med, reorderLevel: item.reorderLevel };
    put.medicines.push(med);
  }

  const batchNo = clean(item.batchNo);
  const existing = batchNo && state.batches.find(
    (b) => b.medicineId === med.id && b.batchNo.toLowerCase() === batchNo.toLowerCase() && b.expiry === item.expiry,
  );
  const batch = existing
    ? { ...existing, qty: existing.qty + item.qty, unitCost: item.unitCost || existing.unitCost }
    : { id: ctx.newId(), medicineId: med.id, batchNo, expiry: item.expiry, qty: item.qty, unitCost: item.unitCost, receivedAt: ctx.now };
  put.batches.push(batch);
  put.movements.push({ id: ctx.newId(), medicineId: med.id, batchId: batch.id, type: 'receive', qty: item.qty, date: ctx.today, at: ctx.now, note: '' });
  return put;
}

export function receiveMany(state, items, ctx) {
  let current = state;
  let put = {};
  for (const item of items) {
    const changes = receive(current, item, ctx);
    current = applyChanges(current, changes);
    put = mergeChanges(put, changes);
  }
  return put;
}

export function dispense(state, medicineId, qty, note, ctx) {
  const batches = state.batches.filter((b) => b.medicineId === medicineId);
  const plan = planDispense(batches, qty, ctx.today);
  const put = { batches: [], movements: [] };
  for (const step of plan) {
    const b = batches.find((x) => x.id === step.batchId);
    put.batches.push({ ...b, qty: b.qty - step.qty });
    put.movements.push({ id: ctx.newId(), medicineId, batchId: b.id, type: 'dispense', qty: step.qty, date: ctx.today, at: ctx.now, note: clean(note) });
  }
  return { plan, put };
}

/** Removes units from a batch: expired, damaged, recalled, returned, or a count correction. */
export function writeOff(state, batchId, qty, reason, ctx) {
  const b = state.batches.find((x) => x.id === batchId);
  if (!b) throw new RangeError('That batch no longer exists.');
  if (!Number.isInteger(qty) || qty <= 0 || qty > b.qty) throw new RangeError(`Enter a whole number from 1 to ${b.qty}.`);
  return {
    batches: [{ ...b, qty: b.qty - qty }],
    movements: [{ id: ctx.newId(), medicineId: b.medicineId, batchId, type: 'writeoff', qty, date: ctx.today, at: ctx.now, note: clean(reason) }],
  };
}

/* ---------- CSV ---------- */

export function parseCSV(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Spreadsheet apps run cells that start with these characters as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const STOCK_COLUMNS = ['name', 'strength', 'form', 'batch', 'expiry', 'qty', 'unit_cost', 'reorder_level'];

/** Reads a stock spreadsheet. Good rows become deliveries; bad rows are reported by row number. */
export function readStockCSV(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { items: [], errors: [{ row: 1, message: 'The file is empty.' }] };
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = Object.fromEntries(STOCK_COLUMNS.map((c) => [c, header.indexOf(c)]));
  const missing = ['name', 'expiry', 'qty'].filter((c) => col[c] < 0);
  if (missing.length) return { items: [], errors: [{ row: 1, message: `Missing column: ${missing.join(', ')}.` }] };

  const items = [];
  const errors = [];
  rows.slice(1).forEach((r, i) => {
    if (r.every((f) => f.trim() === '')) return;
    const get = (c) => (col[c] >= 0 ? (r[col[c]] ?? '').trim() : '');
    const num = (c, blank) => (get(c) === '' ? blank : Number(get(c)));
    const item = {
      name: get('name'),
      strength: get('strength'),
      form: get('form'),
      batchNo: get('batch'),
      expiry: normalizeExpiry(get('expiry')),
      qty: num('qty', 0),
      unitCost: num('unit_cost', 0),
      reorderLevel: num('reorder_level', null),
    };
    const problem = checkReceipt(item);
    if (problem) errors.push({ row: i + 2, message: problem });
    else items.push(item);
  });
  return { items, errors };
}

/* ---------- backup ---------- */

export function makeBackup(state, now) {
  return { app: 'medshelf', version: 1, exportedAt: now, settings: state.settings, medicines: state.medicines, batches: state.batches, movements: state.movements };
}

const str = (v) => (typeof v === 'string' ? v : '');
const isDay = (v) => typeof v === 'string' && normalizeExpiry(v) === v;
export const MOVEMENT_TYPES = ['receive', 'dispense', 'writeoff'];

/** Parses and checks a backup file. Throws a readable error instead of loading damaged data. */
export function readBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RangeError('This is not a MedShelf backup file.');
  }
  if (!data || data.app !== 'medshelf' || data.version !== 1) throw new RangeError('This is not a MedShelf backup file.');

  const cleaners = {
    medicines: (m) => (typeof m.id === 'string' && clean(m.name)
      ? { id: m.id, name: clean(m.name), strength: clean(str(m.strength)), form: clean(str(m.form)), reorderLevel: isCount(m.reorderLevel) ? m.reorderLevel : 0, createdAt: str(m.createdAt) }
      : null),
    batches: (b) => (typeof b.id === 'string' && typeof b.medicineId === 'string' && isDay(b.expiry) && isCount(b.qty)
      ? { id: b.id, medicineId: b.medicineId, batchNo: clean(str(b.batchNo)), expiry: b.expiry, qty: b.qty, unitCost: Number.isFinite(b.unitCost) && b.unitCost >= 0 ? b.unitCost : 0, receivedAt: str(b.receivedAt) }
      : null),
    movements: (m) => (typeof m.id === 'string' && typeof m.medicineId === 'string' && MOVEMENT_TYPES.includes(m.type) && isCount(m.qty) && isDay(m.date)
      ? { id: m.id, medicineId: m.medicineId, batchId: str(m.batchId), type: m.type, qty: m.qty, date: m.date, at: str(m.at), note: clean(str(m.note)) }
      : null),
  };

  const out = { settings: cleanSettings(data.settings ?? {}) };
  for (const [store, cleanOne] of Object.entries(cleaners)) {
    if (!Array.isArray(data[store])) throw new RangeError(`This backup is damaged: "${store}" is missing.`);
    out[store] = data[store].map((x, i) => {
      const record = x && typeof x === 'object' ? cleanOne(x) : null;
      if (!record) throw new RangeError(`This backup is damaged: ${store} item ${i + 1} is not valid.`);
      return record;
    });
  }
  const medIds = new Set(out.medicines.map((m) => m.id));
  if (![...out.batches, ...out.movements].every((x) => medIds.has(x.medicineId))) {
    throw new RangeError('This backup is damaged: some stock belongs to a medicine that is not in the file.');
  }
  return out;
}
