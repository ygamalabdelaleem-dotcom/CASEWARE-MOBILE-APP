// المزامنة: رفع التعديلات المعلّقة ثم جلب التغييرات. لا تعتمد على مؤقتات الخلفية؛
// تعمل عند فتح التطبيق، وعودة الاتصال، والعودة للواجهة، وبعد كل تعديل.
import { api, ApiError } from './api.js';
import * as idb from './idb.js';
import { S, ENT, emit, rebuildAll, rebuildRow, saveMeta, stripOp, invalidate } from './store.js';

let syncing = false;
let again = false;
let timer = null;
let authHandler = () => {};
export function onAuthRequired(fn) { authHandler = fn; }

function setSync(state, error = null) {
  S.sync = { state, error };
  emit();
}

export function requestSync(delay = 800) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), delay);
}

export async function syncNow({ full = false } = {}) {
  if (!S.me) return;
  if (syncing) { again = true; return; }
  if (!navigator.onLine) { setSync('offline'); return; }
  syncing = true;
  setSync('syncing');
  try {
    await pushOutbox();
    await pull(full);
    await fetchNotifs();
    S.meta.lastSync = new Date().toISOString();
    await saveMeta();
    setSync('ok');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setSync('error', 'انتهت الجلسة'); authHandler(); }
    else setSync(e.status === 0 ? 'offline' : 'error', e.message);
  } finally {
    for (const o of S.outbox) o.inflight = false;
    syncing = false;
    if (again) { again = false; requestSync(300); }
  }
}

async function pushOutbox() {
  const blocked = new Set();
  const key = (o) => `${o.entity}:${o.id}`;
  const queue = S.outbox.filter((o) => !o.conflict && !o.error);
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const sending = batch;
    batch = [];
    sending.forEach((o) => { o.inflight = true; });
    const { results } = await api('/api/push', { method: 'POST', body: { ops: sending.map(stripOp) } });
    for (const r of results) await handleResult(sending.find((o) => o.opId === r.opId), r, blocked);
  };
  for (const op of queue) {
    if (blocked.has(key(op))) continue;
    if (op.action === 'upload') {
      await flush();
      if (blocked.has(`items:${op.changes.item_id}`)) { blocked.add(key(op)); continue; }
      await upload(op, blocked);
    } else {
      batch.push(op);
      if (batch.length >= 50) await flush();
    }
  }
  await flush();
}

async function handleResult(op, r, blocked) {
  if (!op) return;
  op.inflight = false;
  if (r.ok) {
    await removeOp(op);
    if (r.row) {
      S.server[op.entity].set(r.row.id, r.row);
      await idb.put(op.entity, r.row);
    }
  } else if (r.conflict) {
    op.conflict = r.conflict;
    blocked.add(`${op.entity}:${op.id}`);
    if (r.conflict.server) {
      S.server[op.entity].set(op.id, r.conflict.server);
      await idb.put(op.entity, r.conflict.server);
    }
    await idb.put('outbox', stripOp(op));
  } else if (r.error) {
    op.error = r.error;
    blocked.add(`${op.entity}:${op.id}`);
    await idb.put('outbox', stripOp(op));
  }
  rebuildRow(op.entity, op.id);
  invalidate();
}

async function upload(op, blocked) {
  const b = await idb.get('blobs', op.id);
  if (!b) { op.error = 'الملف المحلي غير موجود'; await idb.put('outbox', stripOp(op)); return; }
  const form = new FormData();
  form.append('id', op.id);
  form.append('file', b.blob, b.name || 'photo.jpg');
  try {
    const r = await api(`/api/items/${op.changes.item_id}/attachments`, { method: 'POST', form });
    await removeOp(op);
    await idb.del('blobs', op.id);
    S.server.attachments.set(r.row.id, r.row);
    await idb.put('attachments', r.row);
    if (r.item) { S.server.items.set(r.item.id, r.item); await idb.put('items', r.item); rebuildRow('items', r.item.id); }
  } catch (e) {
    if (e.status === 0 || e.status === 401 || e.status >= 500) throw e;
    op.error = e.message;
    blocked.add(`attachments:${op.id}`);
    await idb.put('outbox', stripOp(op));
  }
  rebuildRow('attachments', op.id);
}

async function removeOp(op) {
  S.outbox = S.outbox.filter((o) => o !== op);
  await idb.del('outbox', op.opId);
}

async function pull(full) {
  const since = full ? 0 : S.meta.rev || 0;
  const res = await api(`/api/pull?since=${since}`);
  if (full) for (const e of ENT) { S.server[e] = new Map(); await idb.clear(e); }
  for (const e of ENT) {
    const rows = res[e] || [];
    for (const r of rows) S.server[e].set(r.id, r);
    await idb.putMany(e, rows);
  }
  // إزالة ما لم يعد مسموحًا برؤيته
  const visible = new Set(res.visibleEngagementIds);
  const drop = { engagements: [], items: [], comments: [], attachments: [], companies: [] };
  for (const [id] of S.server.engagements) if (!visible.has(id)) drop.engagements.push(id);
  const dropItems = new Set();
  for (const [id, i] of S.server.items) if (!visible.has(i.engagement_id)) { drop.items.push(id); dropItems.add(id); }
  for (const [id, c] of S.server.comments) if (dropItems.has(c.item_id)) drop.comments.push(id);
  for (const [id, a] of S.server.attachments) if (dropItems.has(a.item_id)) drop.attachments.push(id);
  if (res.visibleCompanyIds) {
    const vc = new Set(res.visibleCompanyIds);
    for (const [id] of S.server.companies) if (!vc.has(id)) drop.companies.push(id);
  }
  for (const [e, ids] of Object.entries(drop)) {
    for (const id of ids) S.server[e].delete(id);
    await idb.delMany(e, ids);
  }
  S.meta.rev = res.rev;
  rebuildAll();
}

export async function fetchNotifs() {
  const list = await api('/api/notifications?limit=150');
  S.notifs = list;
  await idb.clear('notifs');
  await idb.putMany('notifs', list);
  if ('setAppBadge' in navigator) {
    const n = list.filter((x) => !x.read_at).length;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
  emit();
}

export async function markRead(ids) {
  if (ids) ids = ids.filter((id) => S.notifs.some((n) => n.id === id && !n.read_at));
  if (ids ? !ids.length : !S.notifs.some((n) => !n.read_at)) return;
  const now = new Date().toISOString();
  for (const n of S.notifs) if (!ids || ids.includes(n.id)) n.read_at = n.read_at || now;
  emit();
  await idb.putMany('notifs', S.notifs);
  try { await api('/api/notifications/read', { method: 'POST', body: ids ? { ids } : {} }); } catch { /* يُعاد لاحقًا */ }
}

// ---------- التعارضات والعمليات المرفوضة ----------
export async function resolveConflict(opId, choice) {
  const op = S.outbox.find((o) => o.opId === opId);
  if (!op) return;
  if (choice === 'mine') {
    op.force = true;
    op.conflict = null;
    await idb.put('outbox', stripOp(op));
  } else {
    await removeOp(op);
  }
  rebuildRow(op.entity, op.id);
  invalidate();
  emit();
  requestSync(100);
}
export async function dismissOp(opId) {
  const op = S.outbox.find((o) => o.opId === opId);
  if (!op) return;
  await removeOp(op);
  if (op.action === 'upload') await idb.del('blobs', op.id);
  rebuildRow(op.entity, op.id);
  invalidate();
  emit();
}

let autoStarted = false;
export function startAutoSync() {
  if (autoStarted) return;
  autoStarted = true;
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setSync('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  // أثناء فتح التطبيق فقط
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60_000);
}
