// Sample stock for trying MedShelf out. Only loaded when someone presses
// "Try it with sample data" on an empty device.

import { addDays } from './core.js';

// name, strength, form, reorder level, cost per unit, units used per day, batches as [days to expiry, qty on shelf]
const MEDICINES = [
  ['Paracetamol', '500 mg', 'Tablet', 200, 0.02, 30, [[-10, 40], [120, 600], [400, 1000]]],
  ['Amoxicillin', '500 mg', 'Capsule', 100, 0.08, 12, [[45, 300], [300, 200]]],
  ['Metformin', '500 mg', 'Tablet', 150, 0.03, 20, [[200, 90]]],
  ['Salbutamol inhaler', '100 mcg', 'Inhaler', 10, 1.5, 0.5, [[60, 40]]],
  ['Oral rehydration salts', '20.5 g', 'Sachet', 50, 0.1, 6, [[20, 30], [500, 200]]],
  ['Cetirizine', '10 mg', 'Tablet', 60, 0.02, 4, [[25, 150], [700, 100]]],
  ['Omeprazole', '20 mg', 'Capsule', 80, 0.05, 5, [[-3, 28]]],
  ['Insulin glargine', '100 IU/ml', 'Pen', 5, 9, 0.3, [[30, 6], [180, 10]]],
];

export function sampleData(today, newId) {
  const medicines = [];
  const batches = [];
  const movements = [];
  const received = addDays(today, -35);

  for (const [name, strength, form, reorderLevel, unitCost, perDay, stock] of MEDICINES) {
    const med = { id: newId(), name, strength, form, reorderLevel, createdAt: `${received}T09:00:00.000Z` };
    medicines.push(med);
    const medBatches = stock.map(([days, qty], i) => ({
      id: newId(), medicineId: med.id, batchNo: `${name.slice(0, 3).toUpperCase()}${240 + i * 7}`,
      expiry: addDays(today, days), qty, unitCost, receivedAt: `${received}T09:00:00.000Z`,
    }));
    batches.push(...medBatches);

    // A month of dispensing, all taken from the first batch that is still in date.
    const source = medBatches.find((b) => b.expiry >= today) ?? medBatches[0];
    let carry = 0;
    let dispensed = 0;
    for (let d = 30; d >= 0; d--) {
      if (addDays(today, -d) > source.expiry) break;
      carry += perDay;
      const qty = Math.floor(carry);
      if (qty === 0) continue;
      carry -= qty;
      dispensed += qty;
      // Timestamps in the past, so anything the person does now lists above the sample history.
      const at = new Date(Date.now() - (d * 24 + 1) * 3_600_000).toISOString();
      movements.push({ id: newId(), medicineId: med.id, batchId: source.id, type: 'dispense', qty, date: addDays(today, -d), at, note: '' });
    }
    for (const b of medBatches) {
      const qty = b.qty + (b === source ? dispensed : 0);
      movements.push({ id: newId(), medicineId: med.id, batchId: b.id, type: 'receive', qty, date: received, at: `${received}T09:00:00.000Z`, note: 'Sample data' });
    }
  }
  return { medicines, batches, movements };
}
