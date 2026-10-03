// Large imported images and recordings outgrow localStorage. Small documents
// remain synchronously available; large documents commit to IndexedDB first.
export const LARGE_STORAGE_MARKER = '{"orographStorage":"indexeddb"}';
let database = null;
const writes = new Map();
const revisions = new Map();
function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (database) return database;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  database = pending;
  let settled = false;
  const complete = (db) => {
    if (settled) { db?.close?.(); return; }
    settled = true;
    if (!db && database === pending) database = null;
    finish(db);
  };
  try {
    const request = indexedDB.open('orograph-data', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames?.contains('documents')) request.result.createObjectStore('documents');
    };
    request.onsuccess = () => {
      const db = request.result, invalidate = () => { if (database === pending) database = null; };
      db.onversionchange = () => { invalidate(); db.close(); };
      db.onclose = invalidate;
      complete(db);
    };
    request.onerror = request.onblocked = () => complete(null);
  } catch { complete(null); }
  return pending;
}
function mutate(db, key, raw, remove = false) {
  return new Promise(resolve => {
    try {
      const transaction = db.transaction('documents', 'readwrite');
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = transaction.onabort = () => resolve(false);
      const documents = transaction.objectStore('documents');
      if (remove) documents.delete(key); else documents.put(raw, key);
    } catch { database = null; resolve(false); }
  });
}
export async function readDurable(key, storage) {
  // A same-page read observes the latest queued save, including a large write
  // followed by a synchronous small replacement.
  let waited = null;
  while (writes.get(key) && writes.get(key) !== waited) {
    waited = writes.get(key); await waited.catch(() => {});
  }
  let raw = null;
  try { raw = storage?.getItem(key); } catch { /* IndexedDB can still work. */ }
  if (raw && raw !== LARGE_STORAGE_MARKER) return raw;
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const transaction = db.transaction('documents'), request = transaction.objectStore('documents').get(key);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = transaction.onabort = () => resolve(null);
    } catch { database = null; resolve(null); }
  });
}
export function writeDurable(key, raw, storage) {
  const revision = (revisions.get(key) || 0) + 1; revisions.set(key, revision);
  let immediate = false;
  try { if (storage) { storage.setItem(key, raw); immediate = true; } } catch { /* Try the larger store. */ }
  const previous = writes.get(key) || Promise.resolve();
  const done = previous.catch(() => {}).then(async () => {
    const db = await openDatabase();
    if (immediate) {
      // Cleanup follows older database writes so a stale large copy cannot
      // reappear after the current small document is cleared.
      if (db) await mutate(db, key, null, true);
      return true;
    }
    if (!db || !await mutate(db, key, raw)) return false;
    if (revisions.get(key) === revision) {
      try { storage?.removeItem?.(key); storage?.setItem?.(key, LARGE_STORAGE_MARKER); } catch { /* A missing entry still selects IndexedDB. */ }
      // A readable stale small entry must not hide a successful database save.
      try { const locator = storage?.getItem(key); if (locator && locator !== LARGE_STORAGE_MARKER) return false; } catch { /* The reader falls back to IndexedDB. */ }
    }
    return true;
  }).catch(() => false);
  writes.set(key, done);
  done.finally(() => { if (writes.get(key) === done) writes.delete(key); });
  return { immediate, done };
}
// v2.12 version history: remove a document written with writeDurable(key, raw, null).
export async function removeDurable(key) {
  const pending = writes.get(key);
  if (pending) await pending.catch(() => {});
  const db = await openDatabase();
  return db ? mutate(db, key, null, true) : false;
}
