// الخادم المحلي للنسخة المستضافة على GitHub Pages: ينفّذ نفس واجهة /api داخل المتصفح،
// وكل البيانات محفوظة في IndexedDB على هذا الجهاز فقط.
import { S } from './store.js';
import * as idb from './idb.js';
import { ApiError } from './api.js';
import {
  isMember, canManageCompanies, canCreateEngagement, canEditEngagement, canDeleteItem, canApprove,
  applyItemUpdate, sameValue, STATUS, TYPE, PRIORITY, STATUSES, TYPES, PRIORITIES, ROLE, ITEM_SYSTEM_FIELDS,
  defaultBlocks, addDays, todayStr,
} from '../shared/rules.js';
import { DEFAULT_SECTIONS, DEFAULT_TASKS, LEGACY_TASK_COUNT } from '../shared/defaults.js';
import { mergePrefs, cleanPrefs, prepareData, buildForUser } from '../shared/engine.js';

class OpError extends Error {}
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const ITEM_FIELDS = ['engagement_id', 'section_code', 'type', 'ref', 'wp_url', 'title', 'description', 'assignee_id',
  'priority', 'due_date', 'last_followup', 'next_step', 'status', 'progress', 'conclusion', 'client_response',
  'received_at', 'approved_by', 'approved_at', 'blocks_report', 'depends_on', 'snooze_until', 'status_changed_at', 'created_by'];
const ENG_FIELDS = ['company_id', 'year', 'in_charge_id', 'manager_id', 'team', 'report_due', 'stage', 'caseware_url',
  'sections', 'status', 'escalation_enabled', 'escalation_days', 'notes'];

// ---------- التخزين ----------
let writes = [];
const live = (e) => [...S.server[e].values()].filter((r) => !r.deleted);
const get = (e, id) => { const r = S.server[e].get(id); return r && !r.deleted ? r : null; };
function save(entity, row) { writes.push([entity, row, S.server[entity].get(row.id)]); S.server[entity].set(row.id, row); return row; }
function rollback(mark) {
  for (const [e, r, prev] of writes.splice(mark).reverse()) {
    if (e === 'audit') continue;
    if (prev) S.server[e].set(r.id, prev); else S.server[e].delete(r.id);
  }
}
function insert(entity, data, userId = S.me?.id) {
  const t = now();
  return save(entity, { ...data, created_at: data.created_at || t, updated_at: t, updated_by: userId, rev: 1, version: 1, deleted: 0 });
}
function update(entity, id, patch, userId = S.me?.id) {
  const cur = S.server[entity].get(id);
  return save(entity, { ...cur, ...patch, updated_at: now(), updated_by: userId, version: (cur.version || 0) + 1 });
}
function audit(userId, entity, entityId, action, diff, engagementId = null) {
  writes.push(['audit', { id: uid(), at: now(), user_id: userId, entity, entity_id: entityId, engagement_id: engagementId, action, diff }]);
}
async function flush() {
  const by = new Map();
  for (const [e, r] of writes) { if (!by.has(e)) by.set(e, new Map()); by.get(e).set(r.id, r); }
  writes = [];
  for (const [e, m] of by) await idb.putMany(e, [...m.values()]);
}
const kvGet = async (k, d) => (await idb.get('kv', k))?.value ?? d;
const kvSet = (k, v) => idb.put('kv', { id: k, value: v });

// ---------- منطق البنود (مطابق للخادم) ----------
const pick = (o, f) => Object.fromEntries(f.filter((k) => o && k in o).map((k) => [k, o[k]]));
function diffOf(prev, next, fields) {
  const d = {};
  for (const f of fields) if (!sameValue(prev?.[f], next?.[f])) d[f] = [prev?.[f] ?? null, next?.[f] ?? null];
  return d;
}
function validateItem(data) {
  if ('status' in data && !STATUS[data.status]) throw new OpError('حالة غير معروفة');
  if ('type' in data && !TYPE[data.type]) throw new OpError('نوع غير معروف');
  if ('priority' in data && !PRIORITY[data.priority]) throw new OpError('أولوية غير معروفة');
  for (const f of ['due_date', 'last_followup', 'snooze_until']) if (data[f] && !/^\d{4}-\d{2}-\d{2}$/.test(data[f])) throw new OpError('تاريخ غير صالح');
  if (data.wp_url && !/^https?:\/\//i.test(data.wp_url)) throw new OpError('الرابط يجب أن يبدأ بـ http أو https');
}
const ctx = (itemId) => { const item = get('items', itemId); return { item, eng: item && get('engagements', item.engagement_id) }; };

function createItem(user, data, { skipPerm = false } = {}) {
  const eng = get('engagements', data.engagement_id);
  if (!eng) throw new OpError('الملف غير موجود');
  if (!skipPerm && !isMember(user, eng)) throw new OpError('لست ضمن فريق هذا الملف');
  const clean = pick(data, ITEM_FIELDS);
  for (const f of ITEM_SYSTEM_FIELDS) if (f !== 'engagement_id') delete clean[f];
  if (!String(clean.title || '').trim()) throw new OpError('الوصف المختصر مطلوب');
  validateItem(clean);
  const t = now();
  const row = { type: 'task', priority: 'medium', status: 'not_started', progress: 0, depends_on: [], ...clean,
    id: data.id || uid(), created_by: user.id, status_changed_at: t };
  if (!('blocks_report' in clean)) row.blocks_report = defaultBlocks(row.type, row.section_code, eng.sections);
  row.blocks_report = row.blocks_report ? 1 : 0;
  if (row.status === 'closed') {
    if (!canApprove(user, row, eng)) throw new OpError('الإقفال يتم باعتماد مراجع مخوّل فقط');
    row.approved_by = user.id; row.approved_at = t;
  }
  const saved = insert('items', row, user.id);
  audit(user.id, 'items', saved.id, 'create', diffOf({}, saved, ['title', 'status', 'assignee_id', 'due_date', 'section_code']), eng.id);
  return saved;
}

function updateItem(user, id, changes, { evidenceChanged = false, action = 'update' } = {}) {
  const { item, eng } = ctx(id);
  if (!item) throw new OpError('البند غير موجود أو محذوف');
  const clean = pick(changes, ITEM_FIELDS);
  validateItem(clean);
  if ('blocks_report' in clean) clean.blocks_report = clean.blocks_report ? 1 : 0;
  const r = applyItemUpdate(item, clean, user, eng, now(), { evidenceChanged });
  if (r.error) throw new OpError(r.error);
  const d = diffOf(item, r.next, ITEM_FIELDS);
  if (!Object.keys(d).length) return item;
  const saved = update('items', id, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v[1]])), user.id);
  audit(user.id, 'items', id, r.events.length ? r.events.join(',') : action, d, eng.id);
  return saved;
}

function createEngagement(user, data) {
  const company = get('companies', data.company_id);
  if (!company) throw new OpError('الشركة غير موجودة');
  const year = Number(data.year);
  if (!year || year < 2000 || year > 2100) throw new OpError('السنة غير صالحة');
  if (live('engagements').some((e) => e.company_id === company.id && e.year === year)) throw new OpError(`يوجد ملف ${year} لهذه الشركة بالفعل`);
  let sections = data.sections;
  if (!Array.isArray(sections) || !sections.length) sections = live('templates')[0]?.sections || DEFAULT_SECTIONS;
  const row = insert('engagements', { status: 'active', team: [], escalation_enabled: 0, escalation_days: 7,
    ...pick(data, ENG_FIELDS), id: data.id || uid(), year, sections, stage: data.stage || sections[0]?.code || null }, user.id);
  audit(user.id, 'engagements', row.id, 'create', diffOf({}, row, ['company_id', 'year', 'in_charge_id', 'manager_id']), row.id);
  return row;
}

function applyOp(user, op) {
  const { entity, id, action } = op;
  const ch = op.changes || {};
  if (entity === 'items') {
    if (action === 'create') return get('items', id) || createItem(user, { ...ch, id });
    if (action === 'update') return updateItem(user, id, ch);
    if (action === 'delete') {
      const { item, eng } = ctx(id);
      if (!item) return null;
      if (!canDeleteItem(user, item, eng)) throw new OpError('لا تملك صلاحية حذف البند');
      audit(user.id, 'items', id, 'delete', null, eng.id);
      return update('items', id, { deleted: 1 });
    }
  }
  if (entity === 'comments') {
    if (action === 'create') {
      if (get('comments', id)) return get('comments', id);
      const { item, eng } = ctx(ch.item_id);
      if (!item || !isMember(user, eng)) throw new OpError('لا يمكن التعليق على هذا البند');
      const body = String(ch.body || '').trim();
      if (!body) throw new OpError('التعليق فارغ');
      audit(user.id, 'comments', id, 'create', { body: [null, body.slice(0, 200)] }, eng.id);
      return insert('comments', { id, item_id: item.id, user_id: user.id, body: body.slice(0, 5000) });
    }
    if (action === 'delete') return get('comments', id) ? update('comments', id, { deleted: 1 }) : null;
  }
  if (entity === 'attachments' && action === 'delete') {
    const a = get('attachments', id);
    if (!a) return null;
    const { item, eng } = ctx(a.item_id);
    if (!item) throw new OpError('البند غير موجود');
    const row = update('attachments', id, { deleted: 1 });
    idb.del('blobs', id);
    audit(user.id, 'attachments', id, 'delete', { name: [a.name, null] }, eng.id);
    if (item.status === 'closed') updateItem(user, item.id, {}, { evidenceChanged: true, action: 'evidence' });
    return row;
  }
  if (entity === 'companies') {
    if (!canManageCompanies(user)) throw new OpError('لا تملك صلاحية إدارة الشركات');
    const data = pick(ch, ['name', 'code', 'notes']);
    if (action === 'create') {
      if (get('companies', id)) return get('companies', id);
      if (!String(data.name || '').trim()) throw new OpError('اسم الشركة مطلوب');
      audit(user.id, 'companies', id, 'create', null);
      return insert('companies', { ...data, id });
    }
    if (!get('companies', id)) throw new OpError('الشركة غير موجودة');
    if (action === 'update') { audit(user.id, 'companies', id, 'update', diffOf(get('companies', id), { ...get('companies', id), ...data }, ['name', 'code', 'notes'])); return update('companies', id, data); }
    if (action === 'delete') {
      if (live('engagements').some((e) => e.company_id === id)) throw new OpError('احذف ملفات الشركة أولًا');
      return update('companies', id, { deleted: 1 });
    }
  }
  if (entity === 'engagements') {
    const data = pick(ch, ENG_FIELDS);
    if (data.caseware_url && !/^https?:\/\//i.test(data.caseware_url)) throw new OpError('رابط Caseware يجب أن يبدأ بـ http أو https');
    if (action === 'create') {
      if (get('engagements', id)) return get('engagements', id);
      if (!canCreateEngagement(user)) throw new OpError('إنشاء الملفات للمدير فقط');
      return createEngagement(user, { ...data, id });
    }
    const row = get('engagements', id);
    if (!row) throw new OpError('الملف غير موجود');
    if (action === 'update') {
      if (!canEditEngagement(user, row)) throw new OpError('لا تملك صلاحية تعديل الملف');
      audit(user.id, 'engagements', id, 'update', diffOf(row, { ...row, ...data }, ENG_FIELDS), id);
      return update('engagements', id, data);
    }
    if (action === 'delete') { audit(user.id, 'engagements', id, 'delete', null, id); return update('engagements', id, { deleted: 1 }); }
  }
  throw new OpError('عملية غير مدعومة');
}

function processOps(user, ops) {
  return (ops || []).map((op) => {
    const mark = writes.length;
    try {
      return { opId: op.opId, ok: true, row: applyOp(user, op) };
    } catch (e) {
      rollback(mark); // تراجع عن أي كتابة جزئية لهذه العملية
      return { opId: op.opId, error: e instanceof OpError ? e.message : 'خطأ غير متوقع' };
    }
  });
}

// ---------- القوالب والترحيل ----------
function saveTemplate(user, { id, name, sections, tasks }) {
  if (!String(name || '').trim()) throw new OpError('اسم القالب مطلوب');
  const secs = (sections || []).map((s) => ({ code: String(s.code || '').trim(), name: String(s.name || '').trim() }));
  if (!secs.length || secs.some((s) => !s.code || !s.name)) throw new OpError('كل قسم يحتاج كودًا واسمًا');
  if (new Set(secs.map((s) => s.code)).size !== secs.length) throw new OpError('أكواد مكررة');
  const codes = new Set(secs.map((s) => s.code));
  const clean = (tasks || []).filter((t) => String(t.title || '').trim()).map((t) => ({
    section_code: codes.has(t.section_code) ? t.section_code : secs[0].code, ref: String(t.ref || '').trim() || null,
    title: String(t.title).trim(), type: TYPE[t.type] ? t.type : 'task', priority: PRIORITY[t.priority] ? t.priority : 'medium',
  }));
  const data = { name: String(name).trim(), sections: secs, tasks: clean };
  return id && get('templates', id) ? update('templates', id, data) : insert('templates', { ...data, id: uid() });
}
function engagementFromTemplate(user, b) {
  if (!canCreateEngagement(user)) throw new OpError('إنشاء الملفات للمدير فقط');
  const t = get('templates', b.templateId);
  if (!t) throw new OpError('القالب غير موجود');
  const eng = createEngagement(user, { company_id: b.company_id, year: b.year, in_charge_id: b.in_charge_id || null,
    manager_id: b.manager_id || null, team: b.team || [], report_due: b.report_due || null, caseware_url: b.caseware_url || null, sections: t.sections });
  for (const task of t.tasks) createItem(user, { ...task, engagement_id: eng.id, assignee_id: b.in_charge_id || null }, { skipPerm: true });
  return eng;
}
function rollover(user, engId, { year, report_due, includeNotes }) {
  const src = get('engagements', engId);
  if (!src) throw new OpError('الملف غير موجود');
  const types = includeNotes ? ['task', 'doc_request', 'note', 'difference'] : ['task', 'doc_request'];
  const items = live('items').filter((i) => i.engagement_id === engId && types.includes(i.type));
  const eng = createEngagement(user, { company_id: src.company_id, year: Number(year) || src.year + 1, in_charge_id: src.in_charge_id,
    manager_id: src.manager_id, team: src.team, sections: src.sections, report_due: report_due || null, caseware_url: null,
    escalation_days: src.escalation_days, notes: src.notes });
  const idMap = new Map(items.map((i) => [i.id, uid()]));
  for (const i of items) {
    createItem(user, { id: idMap.get(i.id), engagement_id: eng.id, section_code: i.section_code, type: i.type, ref: i.ref, title: i.title,
      description: i.description, assignee_id: i.assignee_id, priority: i.priority, blocks_report: i.blocks_report,
      depends_on: (i.depends_on || []).map((d) => idMap.get(d)).filter(Boolean) }, { skipPerm: true });
  }
  audit(user.id, 'engagements', eng.id, 'rollover', { from: [src.id, eng.id] }, eng.id);
  return eng;
}

// ---------- الإشعارات داخل التطبيق ----------
async function runEngine() {
  const user = S.me;
  const prefs = mergePrefs(await kvGet('prefs', {}));
  const marks = await kvGet('marks', {});
  const runs = await kvGet('runs', {});
  const data = prepareData(live('engagements'), live('companies'), live('items'));
  const { out, today } = buildForUser(user, new Date(), data, prefs, {
    runDone: (k) => !!runs[k], markRun: (k) => { runs[k] = now(); }, getMark: (item, kind) => marks[`${item}|${kind}`],
  });
  const list = [];
  for (const n of out || []) {
    const id = uid();
    for (const [itemId, kind, mark] of n.marks || []) marks[`${itemId}|${kind}`] = { mark, at: today };
    list.push({ id, user_id: user.id, kind: n.kind, title: n.title, body: n.body, url: n.url || `#/notif/${id}`, item_ids: n.item_ids,
      engagement_id: n.engagement_id, score: n.score, local_date: today, created_at: now(), push_status: 'local' });
  }
  await kvSet('marks', marks);
  await kvSet('runs', runs);
  if (list.length) await idb.putMany('notifs', list);
  const all = (await idb.getAll('notifs')).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  const old = all.slice(300).map((n) => n.id);
  if (old.length) await idb.delMany('notifs', old);
  return all.slice(0, 300);
}

// ---------- Excel ----------
let excelLoading;
function loadExcel() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/exceljs.min.js', import.meta.url).href;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new OpError('تعذر تحميل مكتبة Excel'));
    document.head.append(s);
  });
  return excelLoading;
}
const COLS = [
  ['id', 'المعرف (لا تعدّله)', 12], ['company', 'الشركة', 28], ['year', 'السنة', 8], ['section_code', 'البند/القسم', 10],
  ['ref', 'مرجع ورقة العمل', 12], ['type', 'النوع', 12], ['title', 'الوصف', 40], ['description', 'تفاصيل', 30],
  ['assignee', 'المسؤول', 18], ['priority', 'الأولوية', 10], ['due_date', 'الموعد', 12], ['status', 'الحالة', 16],
  ['progress', 'نسبة التنفيذ', 10], ['last_followup', 'آخر متابعة', 12], ['next_step', 'الخطوة التالية', 28],
  ['wp_url', 'رابط ورقة العمل', 24], ['blocks_report', 'يمنع التقرير', 10], ['approved', 'اعتمده', 16],
].map(([key, header, width]) => ({ key, header, width }));
const lbl = (list, k) => list.find((x) => x.key === k)?.label || k || '';
const fromLbl = (list, v) => { const s = String(v ?? '').trim(); if (!s) return undefined; return list.find((x) => x.label === s || x.key === s)?.key ?? null; };
const uname = (id) => S.server.users.get(id)?.name || '';

async function exportXlsx(engId) {
  const ExcelJS = await loadExcel();
  const engs = live('engagements').filter((e) => !engId || e.id === engId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('المتابعة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = COLS;
  ws.getRow(1).font = { bold: true };
  for (const e of engs) {
    const c = S.server.companies.get(e.company_id);
    for (const i of live('items').filter((x) => x.engagement_id === e.id).sort((a, b) => (a.ref || '').localeCompare(b.ref || '', 'ar', { numeric: true }))) {
      ws.addRow({ id: i.id, company: c?.name, year: e.year, section_code: i.section_code, ref: i.ref, type: lbl(TYPES, i.type), title: i.title,
        description: i.description, assignee: uname(i.assignee_id), priority: lbl(PRIORITIES, i.priority), due_date: i.due_date,
        status: lbl(STATUSES, i.status), progress: i.progress, last_followup: i.last_followup, next_step: i.next_step, wp_url: i.wp_url,
        blocks_report: i.blocks_report ? 'نعم' : 'لا', approved: i.approved_by ? `${uname(i.approved_by)} ${i.approved_at?.slice(0, 10) || ''}` : '' });
    }
  }
  const ws2 = wb.addWorksheet('الملفات', { views: [{ rightToLeft: true }] });
  ws2.columns = [['company', 'الشركة', 28], ['code', 'الكود', 10], ['year', 'السنة', 8], ['in_charge', 'المسؤول', 18], ['manager', 'المدير', 18],
    ['report_due', 'موعد التقرير', 12], ['stage', 'المرحلة', 10], ['caseware_url', 'رابط Caseware', 30]].map(([key, header, width]) => ({ key, header, width }));
  ws2.getRow(1).font = { bold: true };
  for (const e of engs) {
    const c = S.server.companies.get(e.company_id);
    ws2.addRow({ company: c?.name, code: c?.code, year: e.year, in_charge: uname(e.in_charge_id), manager: uname(e.manager_id),
      report_due: e.report_due, stage: e.stage, caseware_url: e.caseware_url });
  }
  const buf = await wb.xlsx.writeBuffer();
  return { blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name: `audit-followup-${todayStr()}.xlsx` };
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.result != null) return cellText(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.hyperlink) return String(v.hyperlink);
  }
  return String(v).trim();
}
function dateText(v) {
  const s = cellText(v);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

let pendingImport = null;
async function previewImport(file, createMissing) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(await file.arrayBuffer()); } catch { throw new OpError('ملف Excel غير صالح (xlsx فقط)'); }
  const ws = wb.worksheets[0];
  const map = {};
  ws.getRow(1).eachCell((cell, col) => {
    const t = cellText(cell.value);
    const c = COLS.find((x) => x.header === t || x.key === t || (x.key === 'id' && t.startsWith('المعرف')));
    if (c) map[col] = c.key;
  });
  if (!Object.values(map).includes('title')) throw new OpError('عمود «الوصف» غير موجود — استخدم ملف التصدير كقالب');
  const users = live('users');
  const rows = [];
  const plan = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => { if (map[col]) r[map[col]] = cell.value; });
    const title = cellText(r.title);
    if (!title && !cellText(r.company)) return;
    const res = { row: n, title };
    try {
      if (!title) throw new OpError('الوصف فارغ');
      const compTxt = cellText(r.company);
      const year = Number(cellText(r.year));
      const existing = cellText(r.id) ? get('items', cellText(r.id)) : null;
      const company = live('companies').find((c) => c.name === compTxt || (c.code && c.code === compTxt));
      const eng = existing ? get('engagements', existing.engagement_id) : company && live('engagements').find((e) => e.company_id === company.id && e.year === year);
      const data = { title };
      for (const k of ['section_code', 'ref', 'description', 'next_step', 'wp_url']) if (k in r) data[k] = cellText(r[k]) || null;
      for (const [k, list] of [['type', TYPES], ['priority', PRIORITIES], ['status', STATUSES]]) {
        if (k in r) { const v = fromLbl(list, cellText(r[k])); if (v === null) throw new OpError(`قيمة غير معروفة في عمود ${k}`); if (v) data[k] = v; }
      }
      for (const k of ['due_date', 'last_followup']) if (k in r) { const d = dateText(r[k]); if (d === null) throw new OpError('تاريخ غير مفهوم (yyyy-mm-dd)'); data[k] = d || null; }
      if ('progress' in r) data.progress = Number(cellText(r.progress)) || 0;
      if ('blocks_report' in r) data.blocks_report = ['نعم', '1', 'true', 'yes'].includes(cellText(r.blocks_report).toLowerCase()) ? 1 : 0;
      if ('assignee' in r) {
        const a = cellText(r.assignee);
        const u = a && users.find((x) => x.name === a || (x.email && x.email.toLowerCase() === a.toLowerCase()));
        if (a && !u) throw new OpError(`المسؤول «${a}» غير موجود`);
        data.assignee_id = u?.id || null;
      }
      if (existing) { res.action = 'update'; plan.push({ action: 'update', id: existing.id, data }); } else {
        if (!eng) {
          if (!compTxt || !year) throw new OpError('حدد الشركة والسنة');
          if (!createMissing) throw new OpError(`لا يوجد ملف «${compTxt} ${year}» — فعّل «إنشاء الملفات الناقصة»`);
          res.note = company ? `سيُنشأ ملف ${year}` : 'ستُنشأ الشركة والملف';
        }
        res.action = 'create';
        plan.push({ action: 'create', company: compTxt, year, engId: eng?.id, data });
      }
    } catch (e) { res.action = 'error'; res.error = e instanceof OpError ? e.message : 'خطأ في السطر'; }
    rows.push(res);
  });
  pendingImport = plan;
  return { token: 'local', rows, summary: { create: rows.filter((r) => r.action === 'create').length,
    update: rows.filter((r) => r.action === 'update').length, error: rows.filter((r) => r.action === 'error').length } };
}
function commitImport(user) {
  const plan = pendingImport || [];
  pendingImport = null;
  const out = { created: 0, updated: 0, failed: [] };
  for (const s of plan) {
    const mark = writes.length;
    try {
      if (s.action === 'update') { updateItem(user, s.id, s.data, { action: 'import' }); out.updated++; continue; }
      let engId = s.engId || live('engagements').find((e) => S.server.companies.get(e.company_id)?.name === s.company && e.year === s.year)?.id;
      if (!engId) {
        const c = live('companies').find((x) => x.name === s.company) || insert('companies', { id: uid(), name: s.company, code: null });
        engId = createEngagement(user, { company_id: c.id, year: s.year }).id;
      }
      createItem(user, { ...s.data, engagement_id: engId });
      out.created++;
    } catch (e) {
      rollback(mark);
      out.failed.push({ title: s.data.title, error: e.message });
    }
  }
  return out;
}

// ---------- النسخ الاحتياطي ----------
const TABLES = ['users', 'companies', 'engagements', 'items', 'comments', 'attachments', 'templates', 'audit', 'kv', 'notifs'];
const toB64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
async function backupFile() {
  const data = { app: 'audit-season-tracker', mode: 'local', at: now(), tables: {}, blobs: [] };
  for (const t of TABLES) data.tables[t] = await idb.getAll(t);
  for (const b of await idb.getAll('blobs')) data.blobs.push({ id: b.id, name: b.name, type: b.type, data: await toB64(b.blob) });
  await kvSet('lastBackup', now());
  S.lastBackup = now();
  return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), name: `backup-audit-${todayStr()}.json` };
}
async function restore(data) {
  if (data?.app !== 'audit-season-tracker' || !data.tables) throw new OpError('ملف نسخة احتياطية غير صالح');
  const isLocal = data.mode === 'local';
  for (const t of [...TABLES, 'blobs', 'outbox']) await idb.clear(t);
  if (isLocal) {
    for (const t of TABLES) await idb.putMany(t, data.tables[t] || []);
    for (const b of data.blobs || []) {
      const blob = await (await fetch(b.data)).blob();
      await idb.put('blobs', { id: b.id, name: b.name, type: b.type, blob });
    }
  } else {
    // نسخة من الخادم: نحوّل الصفوف (بدون المرفقات وكلمات المرور)
    const J = { engagements: ['team', 'sections'], items: ['depends_on'], templates: ['sections', 'tasks'] };
    for (const t of ['users', 'companies', 'engagements', 'items', 'comments', 'templates']) {
      const rows = (data.tables[t] || []).map((r) => {
        const o = { ...r };
        delete o.pass;
        for (const f of J[t] || []) { try { o[f] = typeof o[f] === 'string' ? JSON.parse(o[f]) : o[f] || []; } catch { o[f] = []; } }
        return o;
      });
      await idb.putMany(t, rows);
    }
  }
  const me = (await idb.getAll('users')).find((u) => u.role === 'admin' && !u.deleted && u.active !== 0);
  if (me) await idb.put('meta', { id: 'me', value: { id: me.id, name: me.name, email: me.email || '', role: 'admin', active: 1 } });
  return { ok: true, note: 'تمت الاستعادة' };
}

// ---------- بدء الاستخدام ----------
export async function onboard(name, demo) {
  const me = { id: uid(), name: name.trim(), email: '', role: 'admin', active: 1 };
  insert('users', me, me.id);
  S.me = me;
  insert('templates', { id: uid(), name: 'قالب المكتب الافتراضي', sections: DEFAULT_SECTIONS, tasks: DEFAULT_TASKS }, me.id);
  if (demo) seedDemo(me);
  await flush();
  await idb.put('meta', { id: 'me', value: me });
  return me;
}

function seedDemo(me) {
  const mk = (name, role) => insert('users', { id: uid(), name, email: '', role, active: 1 });
  const ahmed = mk('أحمد سمير', 'manager');
  const mona = mk('منى خالد', 'senior');
  const karim = mk('كريم عادل', 'staff');
  const sara = mk('سارة محمود', 'staff');
  const tpl = live('templates')[0].id;
  const T = todayStr();
  const d = (n) => addDays(T, n);
  const comp = [['شركة النيل للصناعات الغذائية', 'NIL'], ['الدلتا للتجارة والتوزيع', 'DLT'], ['القاهرة للاستثمار العقاري', 'CRE']]
    .map(([name, code]) => insert('companies', { id: uid(), name, code }));
  const mkEng = (c, inCharge, team, inDays) => engagementFromTemplate(me, { templateId: tpl, company_id: c.id, year: 2026,
    in_charge_id: inCharge.id, manager_id: ahmed.id, team: team.map((x) => x.id), report_due: d(inDays) });
  const e1 = mkEng(comp[0], me, [karim, sara], 12);
  const e2 = mkEng(comp[1], mona, [karim], 34);
  mkEng(comp[2], mona, [sara], 70);
  update('engagements', e1.id, { stage: 'D' });
  update('engagements', e2.id, { stage: 'C' });
  const ref = (e, r) => live('items').find((i) => i.engagement_id === e.id && i.ref === r).id;
  const set = (u, e, r, ch) => updateItem(u, ref(e, r), ch);
  for (const r of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2']) {
    set(me, e1, r, { assignee_id: karim.id, progress: 100, status: 'ready_review' });
    set(ahmed, e1, r, { status: 'closed' });
  }
  set(me, e1, 'D1', { assignee_id: sara.id, status: 'waiting_client', due_date: d(-3), last_followup: d(-5), next_step: 'متابعة مصادقة بنك مصر والبنك الأهلي', progress: 40, blocks_report: 1 });
  set(me, e1, 'D2', { assignee_id: karim.id, status: 'in_progress', due_date: T, progress: 60 });
  set(me, e1, 'D3', { assignee_id: me.id, status: 'ready_review', due_date: d(-1), progress: 100, conclusion: 'تمت مطابقة الجرد مع الدفاتر' });
  set(me, e1, 'D4', { assignee_id: sara.id, status: 'rework', due_date: d(1), progress: 80, next_step: 'تصحيح احتساب الإهلاك للإضافات' });
  set(me, e1, 'D6', { assignee_id: me.id, status: 'in_progress', due_date: d(2), progress: 30, priority: 'high' });
  set(me, e1, 'E3', { assignee_id: me.id, status: 'waiting_client', due_date: d(7), blocks_report: 1 });
  createItem(me, { engagement_id: e1.id, section_code: 'D', type: 'note', title: 'عدم وجود دراسة اضمحلال للعملاء المتأخرين', assignee_id: me.id,
    priority: 'high', status: 'waiting_client', due_date: d(-2), next_step: 'استلام رد الإدارة ودراسة الخسائر الائتمانية المتوقعة' });
  createItem(me, { engagement_id: e1.id, section_code: 'E', type: 'difference', title: 'فرق مطابقة رصيد مورد رئيسي 185,000 ج',
    assignee_id: karim.id, priority: 'high', status: 'in_progress', due_date: d(3), depends_on: [ref(e1, 'D1')] });
  set(me, e2, 'A3', { assignee_id: mona.id, status: 'waiting_client', due_date: d(-6), last_followup: d(-6) });
  set(me, e2, 'B2', { assignee_id: karim.id, status: 'ready_review', progress: 100, due_date: d(-1) });
  insert('comments', { id: uid(), item_id: ref(e1, 'D2'), user_id: karim.id, body: 'تم إرسال 12 مصادقة من أصل 15، والباقي بانتظار العناوين من العميل.' });
}

// ---------- الموجّه ----------
const NO_PUSH = 'إشعارات شاشة القفل تحتاج نسخة الخادم؛ هذه النسخة تعرض التنبيهات داخل التطبيق.';

export async function handle(path, { method = 'GET', body, form } = {}) {
  const url = new URL(path, location.origin);
  const p = url.pathname.replace(/^\/api/, '');
  const q = Object.fromEntries(url.searchParams);
  const user = S.me;
  const done = async (v) => { await flush(); return v; };
  try {
    if (p === '/me') { if (!user) throw new ApiError('', 401); return { user }; }
    if (p === '/admin/restore') return await restore(body); // متاحة أيضًا من شاشة البداية
    if (!user) throw new ApiError('', 401);
    if (p === '/pull') {
      // ترقية القالب الافتراضي غير المعدّل إلى قائمة البنود الموسعة
      const old = live('templates').find((t) => t.name === 'قالب المكتب الافتراضي' && (t.tasks || []).length === LEGACY_TASK_COUNT);
      const templates = old ? [update('templates', old.id, { tasks: DEFAULT_TASKS })] : [];
      await flush();
      return { rev: 1, users: [], companies: [], engagements: [], items: [], comments: [], attachments: [], templates,
        visibleEngagementIds: live('engagements').map((e) => e.id), visibleCompanyIds: null };
    }
    if (p === '/push') return done({ results: processOps(user, body.ops) });
    let m = p.match(/^\/items\/([\w-]+)\/attachments$/);
    if (m) {
      const { item, eng } = ctx(m[1]);
      if (!item) throw new OpError('البند غير موجود');
      const file = form.get('file');
      const id = form.get('id') || uid();
      if (get('attachments', id)) return { row: get('attachments', id) };
      const row = insert('attachments', { id, item_id: item.id, name: file.name || 'photo.jpg', mime: file.type, size: file.size, uploaded_by: user.id });
      audit(user.id, 'attachments', id, 'create', { name: [null, row.name] }, eng.id);
      const it = updateItem(user, item.id, {}, { evidenceChanged: item.status === 'closed', action: 'evidence' });
      return done({ row, item: it });
    }
    if (p === '/history') {
      const all = await idb.getAll('audit');
      let rows;
      if (q.entity === 'items') {
        const sub = new Set([...live('comments'), ...[...S.server.attachments.values()]].filter((x) => x.item_id === q.id).map((x) => x.id));
        rows = all.filter((a) => (a.entity === 'items' && a.entity_id === q.id) || sub.has(a.entity_id));
      } else rows = all.filter((a) => a.engagement_id === q.id);
      return rows.sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, 300);
    }
    if (p === '/templates' && method === 'POST') return done(saveTemplate(user, body));
    if ((m = p.match(/^\/templates\/([\w-]+)$/)) && method === 'DELETE') {
      if (live('templates').length <= 1) throw new OpError('يجب الإبقاء على قالب واحد على الأقل');
      return done(update('templates', m[1], { deleted: 1 }));
    }
    if (p === '/engagements/from-template') return done(engagementFromTemplate(user, body));
    if ((m = p.match(/^\/engagements\/([\w-]+)\/rollover$/))) return done(rollover(user, m[1], body || {}));
    if ((m = p.match(/^\/engagements\/([\w-]+)\/save-template$/))) {
      const e = get('engagements', m[1]);
      const tasks = live('items').filter((i) => i.engagement_id === e.id && ['task', 'doc_request'].includes(i.type));
      return done(saveTemplate(user, { name: body.name, sections: e.sections, tasks }));
    }
    if (p === '/users' && method === 'POST') {
      const { id, name, email, role, active } = body;
      if (!String(name || '').trim()) throw new OpError('الاسم مطلوب');
      if (!ROLE[role]) throw new OpError('دور غير معروف');
      if (id === user.id && (role !== 'admin' || !active)) throw new OpError('لا يمكنك إزالة صلاحيتك');
      const data = { name: name.trim(), email: (email || '').trim(), role, active: active ? 1 : 0 };
      const row = id && get('users', id) ? update('users', id, data) : insert('users', { ...data, id: uid(), active: 1 });
      if (row.id === user.id) { S.me = { ...user, name: row.name }; await idb.put('meta', { id: 'me', value: S.me }); }
      return done(row);
    }
    if (p === '/prefs') {
      if (method === 'PUT') { const v = cleanPrefs(mergePrefs(await kvGet('prefs', {})), body); await kvSet('prefs', v); return v; }
      return mergePrefs(await kvGet('prefs', {}));
    }
    if (p === '/notifications') return await runEngine();
    if (p === '/notifications/read' || p === '/logout') return { ok: true };
    if (p === '/import/preview') return await previewImport(form.get('file'), form.get('createMissing') === '1');
    if (p === '/import/commit') return done(commitImport(user));
    if (p === '/admin/backups') return [];
    if (p.startsWith('/push/')) throw new OpError(NO_PUSH);
    throw new OpError('غير متاح في النسخة المحلية');
  } catch (e) {
    rollback(0);
    if (e instanceof ApiError) throw e;
    throw new ApiError(e.message || 'خطأ', 400);
  }
}

// ملفات للتنزيل
export async function file(path) {
  const url = new URL(path, location.origin);
  if (url.pathname === '/api/export.xlsx') return exportXlsx(url.searchParams.get('engagement'));
  if (url.pathname === '/api/admin/backup') return backupFile();
  throw new ApiError('غير متاح', 404);
}

export const lastBackup = () => kvGet('lastBackup', null);
