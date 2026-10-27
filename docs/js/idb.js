// غلاف بسيط لـ IndexedDB — التخزين المحلي الدائم للعمل دون اتصال.
const NAME = 'audit-season';
const VERSION = 2;
export const STORES = ['users', 'companies', 'engagements', 'items', 'comments', 'attachments', 'templates',
  'outbox', 'meta', 'blobs', 'notifs', 'audit', 'kv'];

let dbp;
function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        for (const s of STORES) {
          if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: s === 'outbox' ? 'opId' : 'id' });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function get(store, key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function putMany(store, rows) {
  if (!rows.length) return;
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  const os = t.objectStore(store);
  for (const r of rows) os.put(r);
  return done(t);
}
export const put = (store, row) => putMany(store, [row]);
export async function delMany(store, keys) {
  if (!keys.length) return;
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  for (const k of keys) t.objectStore(store).delete(k);
  return done(t);
}
export const del = (store, key) => delMany(store, [key]);
export async function clear(store) {
  const db = await open();
  const t = db.transaction(store, 'readwrite');
  t.objectStore(store).clear();
  return done(t);
}
export async function clearAll() {
  for (const s of STORES) await clear(s);
}
