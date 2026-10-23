// IndexedDB storage. Every save runs in one transaction, so a dispense either
// updates all its batches and history or none of them.

const NAME = 'medshelf';
const STORES = ['medicines', 'batches', 'movements', 'meta'];
let opening;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other MedShelf tabs and reload this one.'));
  });
  return opening;
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The save was cancelled.'));
  });
}

export async function loadAll() {
  const db = await open();
  const tx = db.transaction(STORES, 'readonly');
  const all = (store) => new Promise((resolve, reject) => {
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const [medicines, batches, movements, meta] = await Promise.all(STORES.map(all));
  const record = (key) => {
    const { id, ...rest } = meta.find((m) => m.id === key) ?? {};
    return rest;
  };
  // The AI key is its own record so it never ends up in a backup file.
  return { medicines, batches, movements, settings: record('settings'), ai: record('ai') };
}

/** Saves { storeName: [records] }. With `replace`, every store is emptied first. */
export async function save(put, { replace = false } = {}) {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  if (replace) for (const s of STORES) tx.objectStore(s).clear();
  for (const [store, items] of Object.entries(put)) {
    for (const item of items ?? []) tx.objectStore(store).put(item);
  }
  return finished(tx);
}

export function saveSettings(settings) {
  return save({ meta: [{ id: 'settings', ...settings }] });
}

export function saveAi(config) {
  return save({ meta: [{ id: 'ai', ...config }] });
}
