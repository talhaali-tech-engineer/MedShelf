import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/core.js';

const TODAY = '2026-10-23';
const day = (n) => core.addDays(TODAY, n);

function ctx() {
  let n = 0;
  return { today: TODAY, now: `${TODAY}T09:00:00.000Z`, newId: () => `id${++n}` };
}

const empty = () => ({ medicines: [], batches: [], movements: [], settings: core.DEFAULT_SETTINGS });

test('normalizeExpiry reads the formats printed on packs', () => {
  assert.equal(core.normalizeExpiry('2027-03-15'), '2027-03-15');
  assert.equal(core.normalizeExpiry('2027-03'), '2027-03-31');
  assert.equal(core.normalizeExpiry('03/2027'), '2027-03-31');
  assert.equal(core.normalizeExpiry('2/28'), '2028-02-29');
  assert.equal(core.normalizeExpiry(' 11/2026 '), '2026-11-30');
  assert.equal(core.normalizeExpiry('2027-02-30'), null);
  assert.equal(core.normalizeExpiry('13/2027'), null);
  assert.equal(core.normalizeExpiry('soon'), null);
  assert.equal(core.normalizeExpiry(''), null);
});

test('expiry date is the last day a batch can be dispensed', () => {
  assert.equal(core.expiryStatus(TODAY, TODAY, 90), 'expiring');
  assert.equal(core.expiryStatus(day(-1), TODAY, 90), 'expired');
  assert.equal(core.expiryStatus(day(90), TODAY, 90), 'expiring');
  assert.equal(core.expiryStatus(day(91), TODAY, 90), 'ok');
});

test('planDispense takes the earliest expiry first and skips expired stock', () => {
  const batches = [
    { id: 'late', batchNo: 'L', expiry: day(300), qty: 50 },
    { id: 'old', batchNo: 'X', expiry: day(-5), qty: 100 },
    { id: 'soon', batchNo: 'S', expiry: day(20), qty: 30 },
    { id: 'empty', batchNo: 'E', expiry: day(10), qty: 0 },
  ];
  assert.deepEqual(core.planDispense(batches, 40, TODAY).map((p) => [p.batchId, p.qty]), [['soon', 30], ['late', 10]]);
  assert.equal(core.stockOnHand(batches, TODAY), 80);
});

test('planDispense refuses more than the in-date stock', () => {
  const batches = [{ id: 'a', expiry: day(10), qty: 5 }, { id: 'b', expiry: day(-1), qty: 100 }];
  assert.throws(() => core.planDispense(batches, 6, TODAY), (e) => e instanceof core.StockError && e.available === 5);
  assert.throws(() => core.planDispense(batches, 0, TODAY), RangeError);
  assert.throws(() => core.planDispense(batches, 1.5, TODAY), RangeError);
});

test('averageDailyUse counts dispensing in the last 30 days only', () => {
  const moves = [{ type: 'receive', qty: 500, date: day(-60) }, { type: 'dispense', qty: 999, date: day(-31) }];
  for (let i = 0; i < 30; i++) moves.push({ type: 'dispense', qty: 3, date: day(-i) });
  assert.equal(core.averageDailyUse(moves, TODAY), 3);
  assert.equal(core.averageDailyUse([], TODAY), 0);
});

test('averageDailyUse spreads a new medicine over at least a week', () => {
  const moves = [{ type: 'receive', qty: 100, date: TODAY }, { type: 'dispense', qty: 14, date: TODAY }];
  assert.equal(core.averageDailyUse(moves, TODAY), 2);
});

test('wasteRisk finds stock that will expire before it sells', () => {
  const batches = [
    { id: 'a', batchNo: 'A', expiry: day(9), qty: 100, unitCost: 0.5 },
    { id: 'b', batchNo: 'B', expiry: day(29), qty: 100, unitCost: 0.5 },
  ];
  // 5 a day: batch A has 10 selling days, so 50 sell and 50 expire. B then has 20 days, enough for all 100.
  assert.deepEqual(core.wasteRisk(batches, 5, TODAY).map((r) => [r.batchId, r.atRisk]), [['a', 50]]);
  // Nothing selling: every in-date unit is at risk.
  assert.equal(core.wasteRisk(batches, 0, TODAY).reduce((s, r) => s + r.atRisk, 0), 200);
});

test('reorderAdvice orders enough for the delivery wait plus a month', () => {
  assert.deepEqual(core.reorderAdvice({ onHand: 20, avgDaily: 5, reorderLevel: 10, leadDays: 7, coverDays: 30 }), { low: true, daysLeft: 4, orderQty: 165 });
  assert.equal(core.reorderAdvice({ onHand: 500, avgDaily: 5, reorderLevel: 10 }).low, false);
  assert.deepEqual(core.reorderAdvice({ onHand: 8, avgDaily: 0, reorderLevel: 10 }), { low: true, daysLeft: null, orderQty: 12 });
  assert.equal(core.reorderAdvice({ onHand: 0, avgDaily: 0 }).low, true);
});

test('receive creates the medicine once and tops up a repeated batch', () => {
  const c = ctx();
  let state = empty();
  const item = { name: ' Paracetamol ', strength: '500 mg', form: 'Tablet', batchNo: 'P1', expiry: day(200), qty: 100, unitCost: 0.02, reorderLevel: 50 };
  state = core.applyChanges(state, core.receive(state, item, c));
  state = core.applyChanges(state, core.receive(state, { ...item, name: 'paracetamol', batchNo: 'p1', qty: 20, reorderLevel: null }, c));
  state = core.applyChanges(state, core.receive(state, { ...item, batchNo: 'P2', qty: 5 }, c));
  assert.equal(state.medicines.length, 1);
  assert.equal(state.medicines[0].name, 'Paracetamol');
  assert.equal(state.medicines[0].reorderLevel, 50);
  assert.deepEqual(state.batches.map((b) => [b.batchNo, b.qty]), [['P1', 120], ['P2', 5]]);
  assert.equal(state.movements.length, 3);
});

test('receive rejects bad deliveries with a readable message', () => {
  const base = { name: 'X', expiry: day(10), qty: 1, unitCost: 0 };
  assert.throws(() => core.receive(empty(), { ...base, name: '  ' }, ctx()), /medicine name/);
  assert.throws(() => core.receive(empty(), { ...base, expiry: null }, ctx()), /expiry/);
  assert.throws(() => core.receive(empty(), { ...base, qty: -3 }, ctx()), /whole number/);
  assert.throws(() => core.receive(empty(), { ...base, unitCost: NaN }, ctx()), /Cost/);
});

test('dispense and writeOff reduce the right batches', () => {
  const c = ctx();
  let state = empty();
  state = core.applyChanges(state, core.receive(state, { name: 'Amoxicillin', batchNo: 'A', expiry: day(30), qty: 10, unitCost: 0 }, c));
  state = core.applyChanges(state, core.receive(state, { name: 'Amoxicillin', batchNo: 'B', expiry: day(90), qty: 10, unitCost: 0 }, c));
  const medId = state.medicines[0].id;
  const { put } = core.dispense(state, medId, 12, 'walk-in', c);
  state = core.applyChanges(state, put);
  assert.deepEqual(state.batches.map((b) => b.qty), [0, 8]);
  assert.deepEqual(state.movements.filter((m) => m.type === 'dispense').map((m) => m.qty), [10, 2]);

  const b = state.batches[1];
  assert.throws(() => core.writeOff(state, b.id, 9, 'Damaged', c), /1 to 8/);
  state = core.applyChanges(state, core.writeOff(state, b.id, 8, 'Damaged', c));
  assert.equal(core.stockOnHand(state.batches, TODAY), 0);
});

test('summarize flags expired, expiring, low and at-risk stock', () => {
  const c = ctx();
  let state = empty();
  state = core.applyChanges(state, core.receive(state, { name: 'Omeprazole', batchNo: 'O', expiry: day(-2), qty: 28, unitCost: 0.1, reorderLevel: 10 }, c));
  state = core.applyChanges(state, core.receive(state, { name: 'Cetirizine', batchNo: 'C', expiry: day(25), qty: 150, unitCost: 0.02 }, c));
  const cet = state.medicines[1].id;
  state.movements = state.movements.map((m) => ({ ...m, date: day(-40) }));
  for (let i = 0; i < 30; i++) state.movements.push({ id: `d${i}`, medicineId: cet, type: 'dispense', qty: 4, date: day(-i) });

  const s = core.summarize(state, TODAY, core.DEFAULT_SETTINGS);
  assert.equal(s.totals.expiredUnits, 28);
  assert.equal(s.totals.expiringUnits, 150);
  assert.equal(s.expired[0].medicine.name, 'Omeprazole');
  const ome = s.rows.find((r) => r.medicine.name === 'Omeprazole');
  assert.equal(ome.onHand, 0);
  assert.equal(ome.low, true);
  const cetRow = s.rows.find((r) => r.medicine.name === 'Cetirizine');
  assert.equal(cetRow.riskUnits, 150 - 26 * 4);
});

test('CSV round-trips and guards against spreadsheet formulas', () => {
  const rows = [['name', 'note'], ['Syrup, "kids"', '=HYPERLINK("x")'], ['Line\nbreak', '-5']];
  const csv = core.toCSV(rows);
  const back = core.parseCSV(csv);
  assert.deepEqual(back[1], ['Syrup, "kids"', `'=HYPERLINK("x")`]);
  assert.deepEqual(back[2], ['Line\nbreak', '-5']);
});

test('readStockCSV imports good rows and reports bad ones', () => {
  const csv = '﻿Name,Strength,Form,Batch,Expiry,Qty,Unit cost,Reorder level\r\n'
    + 'Paracetamol,500 mg,Tablet,P1,03/2027,100,0.02,50\r\n'
    + 'Ibuprofen,200 mg,Tablet,I1,someday,10,,\r\n'
    + ',,,,,,,\r\n'
    + 'ORS,,Sachet,,2027-01,abc,,\r\n';
  const { items, errors } = core.readStockCSV(csv);
  assert.equal(items.length, 1);
  assert.equal(items[0].expiry, '2027-03-31');
  assert.equal(items[0].reorderLevel, 50);
  assert.deepEqual(errors.map((e) => e.row), [3, 5]);
  assert.match(core.readStockCSV('foo,bar\n1,2').errors[0].message, /Missing column/);
});

test('readBackup accepts its own backups and rejects damaged ones', () => {
  const c = ctx();
  let state = empty();
  state = core.applyChanges(state, core.receive(state, { name: 'Metformin', batchNo: 'M', expiry: day(100), qty: 60, unitCost: 0.03 }, c));
  const json = JSON.stringify(core.makeBackup(state, c.now));
  const restored = core.readBackup(json);
  assert.deepEqual(restored.batches, state.batches);
  assert.equal(restored.settings.warnDays, 90);

  assert.throws(() => core.readBackup('not json'), /not a MedShelf backup/);
  assert.throws(() => core.readBackup('{"app":"other"}'), /not a MedShelf backup/);
  const bad = JSON.parse(json);
  bad.batches[0].qty = -1;
  assert.throws(() => core.readBackup(JSON.stringify(bad)), /batches item 1/);
  const orphan = JSON.parse(json);
  orphan.medicines = [];
  assert.throws(() => core.readBackup(JSON.stringify(orphan)), /not in the file/);
});
