// الحالة المحلية: نسخة الخادم + التعديلات المعلّقة (outbox) = ما يراه المستخدم.
import * as idb from './idb.js';
import { applyItemUpdate, todayStr, itemScore, isMember } from '/shared/rules.js';

export const ENT = ['users', 'companies', 'engagements', 'items', 'comments', 'attachments', 'templates'];

export const S = {
  me: null,
  server: {},
  data: {},
  outbox: [],
  meta: { rev: 0, lastSync: null },
  notifs: [],
  sync: { state: 'idle', error: null },
};
for (const e of ENT) { S.server[e] = new Map(); S.data[e] = new Map(); }

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let emitQueued = false;
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; for (const fn of listeners) fn(); });
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));

export async function load() {
  for (const e of ENT) S.server[e] = new Map((await idb.getAll(e)).map((r) => [r.id, r]));
  S.outbox = (await idb.getAll('outbox')).sort((a, b) => a.seq - b.seq);
  const meta = await idb.get('meta', 'meta');
  if (meta) S.meta = { ...S.meta, ...meta.value };
  const me = await idb.get('meta', 'me');
  S.me = me?.value || null;
  S.notifs = (await idb.getAll('notifs')).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  rebuildAll();
}
export async function saveMeta() { await idb.put('meta', { id: 'meta', value: S.meta }); }
export async function setMe(me) { S.me = me; await idb.put('meta', { id: 'me', value: me }); }

// ---------- إعادة البناء ----------
function applyLocal(entity, row, op) {
  if (op.action === 'create' || op.action === 'upload') {
    const base = entity === 'items'
      ? { type: 'task', priority: 'medium', status: 'not_started', progress: 0, depends_on: [], created_by: S.me?.id }
      : {};
    return { ...base, ...op.changes, id: op.id, created_at: op.at, updated_at: op.at, _pending: true, _local: op.action === 'upload' };
  }
  if (!row) return null;
  if (op.action === 'delete') return null;
  if (entity === 'items') {
    const eng = S.data.engagements.get(row.engagement_id);
    const r = applyItemUpdate(row, op.changes, S.me, eng, op.at);
    if (r.error) return row;
    return { ...r.next, updated_at: op.at, _pending: true };
  }
  return { ...row, ...op.changes, updated_at: op.at, _pending: true };
}

export function rebuildRow(entity, id) {
  const srv = S.server[entity].get(id);
  let row = srv && !srv.deleted ? srv : null;
  for (const op of S.outbox) {
    if (op.entity !== entity || op.id !== id || op.error) continue;
    row = applyLocal(entity, row, op);
  }
  if (row) {
    if (S.outbox.some((o) => o.entity === entity && o.id === id && o.conflict)) row = { ...row, _conflict: true };
    S.data[entity].set(id, row);
  } else S.data[entity].delete(id);
}
export function rebuildAll() {
  for (const e of ENT) {
    S.data[e] = new Map();
    for (const [id, r] of S.server[e]) if (!r.deleted) S.data[e].set(id, r);
  }
  const touched = new Set(S.outbox.map((o) => `${o.entity}\u0000${o.id}`));
  // ترتيب: الملفات أولًا لأن قواعد البنود تعتمد عليها
  const keys = [...touched].map((k) => k.split('\u0000')).sort((a, b) => ENT.indexOf(a[0]) - ENT.indexOf(b[0]));
  for (const [e, id] of keys) rebuildRow(e, id);
  indexCache = null;
}

// ---------- التعديل المحلي ----------
let syncHook = () => {};
export function onLocalChange(fn) { syncHook = fn; }

export async function mutate(entity, action, id, changes = {}) {
  const at = new Date().toISOString();
  if (entity === 'items' && action === 'update') {
    const cur = S.data.items.get(id);
    if (!cur) throw new Error('البند غير موجود');
    const r = applyItemUpdate(cur, changes, S.me, S.data.engagements.get(cur.engagement_id), at);
    if (r.error) throw new Error(r.error);
  }
  const srv = S.server[entity].get(id);
  const tail = S.outbox[S.outbox.length - 1];
  let op;
  if (action === 'update' && tail && tail.entity === entity && tail.id === id && !tail.inflight && !tail.conflict
      && !tail.error && (tail.action === 'update' || tail.action === 'create')) {
    op = tail;
    op.changes = { ...op.changes, ...changes };
    if (op.action === 'update') for (const k of Object.keys(changes)) if (!(k in op.base)) op.base[k] = srv ? srv[k] ?? null : null;
    op.at = at;
  } else {
    const base = {};
    if (srv) for (const k of Object.keys(changes)) base[k] = srv[k] ?? null;
    op = { opId: uuid(), seq: Date.now() + Math.random(), entity, action, id, changes, base, at };
    S.outbox.push(op);
  }
  await idb.put('outbox', stripOp(op));
  rebuildRow(entity, id);
  if (entity === 'items' || entity === 'engagements') indexCache = null;
  emit();
  syncHook();
  return S.data[entity].get(id);
}
export function stripOp(op) {
  const { inflight, ...rest } = op;
  return rest;
}

export async function addAttachment(itemId, file) {
  const id = uuid();
  await idb.put('blobs', { id, blob: file, name: file.name, type: file.type });
  const at = new Date().toISOString();
  const op = { opId: uuid(), seq: Date.now() + Math.random(), entity: 'attachments', action: 'upload', id,
    changes: { item_id: itemId, name: file.name || 'صورة.jpg', mime: file.type, size: file.size, uploaded_by: S.me.id }, base: {}, at };
  S.outbox.push(op);
  await idb.put('outbox', op);
  rebuildRow('attachments', id);
  emit();
  syncHook();
}

// ---------- استعلامات ----------
export const today = () => todayStr();
export const user = (id) => S.data.users.get(id);
export const userName = (id) => S.data.users.get(id)?.name || '—';
export const company = (id) => S.data.companies.get(id);
export const eng = (id) => S.data.engagements.get(id);
export function engName(e, short = false) {
  if (!e) return '—';
  const c = company(e.company_id);
  return `${short ? (c?.code || c?.name || '') : (c?.name || '')} ${e.year}`.trim();
}

let indexCache = null;
function index() {
  if (indexCache) return indexCache;
  const dependents = new Map();
  const byEng = new Map();
  for (const i of S.data.items.values()) {
    for (const d of i.depends_on || []) dependents.set(d, (dependents.get(d) || 0) + 1);
    if (!byEng.has(i.engagement_id)) byEng.set(i.engagement_id, []);
    byEng.get(i.engagement_id).push(i);
  }
  indexCache = { dependents, byEng };
  return indexCache;
}
export function invalidate() { indexCache = null; }
export const itemsOf = (engId) => index().byEng.get(engId) || [];
export function scoreOf(i) {
  return itemScore(i, eng(i.engagement_id), today(), index().dependents.get(i.id) || 0);
}
export const dependentsOf = (id) => index().dependents.get(id) || 0;

export function activeItems() {
  return [...S.data.items.values()].filter((i) => {
    const e = eng(i.engagement_id);
    return e && e.status !== 'archived' && isMember(S.me, e);
  });
}

export function isReviewerOf(e) {
  return !!e && (e.in_charge_id === S.me?.id || e.manager_id === S.me?.id);
}

export function engStats(engId) {
  const items = itemsOf(engId);
  const n = items.length || 1;
  const t = today();
  return {
    total: items.length,
    progress: Math.round(items.reduce((s, i) => s + (i.progress || 0), 0) / n),
    approved: Math.round((items.filter((i) => i.status === 'closed').length / n) * 100),
    blockers: items.filter((i) => i.status !== 'closed' && i.blocks_report),
    overdue: items.filter((i) => i.status !== 'closed' && i.due_date && i.due_date < t).length,
    waiting: items.filter((i) => i.status === 'waiting_client').length,
    review: items.filter((i) => i.status === 'ready_review').length,
    lastUpdate: items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), eng(engId)?.updated_at || ''),
  };
}

export const unreadCount = () => S.notifs.filter((n) => !n.read_at).length;
