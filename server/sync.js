import { db, SPECS, decode, getRow, insertRow, updateRow, touch, audit, currentRev, nowIso, tx, uid } from './db.js';
import {
  isMember, canManageCompanies, canCreateEngagement, canEditEngagement, canEditItem, canDeleteItem, canApprove,
  applyItemUpdate, sameValue, STATUS, TYPE, PRIORITY, ITEM_SYSTEM_FIELDS, defaultBlocks,
} from '../shared/rules.js';

export class OpError extends Error {}

// ---------- الرؤية ----------
export function visibleEngagements(user) {
  const rows = db.prepare('SELECT * FROM engagements WHERE deleted = 0').all().map((r) => decode('engagements', r));
  return rows.filter((e) => isMember(user, e));
}
export function getEngagement(id) {
  const e = getRow('engagements', id);
  return e && !e.deleted ? e : null;
}
export function itemContext(itemId) {
  const item = getRow('items', itemId);
  if (!item || item.deleted) return {};
  return { item, eng: getEngagement(item.engagement_id) };
}

function inList(ids) {
  return ids.length ? ids.map(() => '?').join(',') : "''";
}

export function pull(user, since = 0) {
  const engs = visibleEngagements(user);
  const engIds = engs.map((e) => e.id);
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const companyIds = [...new Set(engs.map((e) => e.company_id))];
  const seeAllCompanies = ['admin', 'manager', 'senior'].includes(user.role);
  const out = {
    rev: currentRev(),
    users: q('SELECT * FROM users WHERE rev > ?', since).map((r) => decode('users', r)),
    companies: (seeAllCompanies
      ? q('SELECT * FROM companies WHERE rev > ?', since)
      : q(`SELECT * FROM companies WHERE rev > ? AND id IN (${inList(companyIds)})`, since, ...companyIds))
      .map((r) => decode('companies', r)),
    engagements: q(`SELECT * FROM engagements WHERE rev > ? AND id IN (${inList(engIds)})`, since, ...engIds)
      .map((r) => decode('engagements', r)),
    items: q(`SELECT * FROM items WHERE rev > ? AND engagement_id IN (${inList(engIds)})`, since, ...engIds)
      .map((r) => decode('items', r)),
    comments: q(`SELECT c.* FROM comments c JOIN items i ON i.id = c.item_id WHERE c.rev > ? AND i.engagement_id IN (${inList(engIds)})`, since, ...engIds)
      .map((r) => decode('comments', r)),
    attachments: q(`SELECT a.* FROM attachments a JOIN items i ON i.id = a.item_id WHERE a.rev > ? AND i.engagement_id IN (${inList(engIds)})`, since, ...engIds)
      .map((r) => decode('attachments', r)),
    templates: q('SELECT * FROM templates WHERE rev > ?', since).map((r) => decode('templates', r)),
    visibleEngagementIds: engIds,
    visibleCompanyIds: seeAllCompanies ? null : companyIds,
  };
  return out;
}

// ---------- تطبيق العمليات ----------
function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && f in obj) out[f] = obj[f];
  return out;
}
function diffOf(prev, next, fields) {
  const d = {};
  for (const f of fields) if (!sameValue(prev?.[f], next?.[f])) d[f] = [prev?.[f] ?? null, next?.[f] ?? null];
  return d;
}

function validateItemFields(data) {
  if ('status' in data && !STATUS[data.status]) throw new OpError('حالة غير معروفة');
  if ('type' in data && !TYPE[data.type]) throw new OpError('نوع غير معروف');
  if ('priority' in data && !PRIORITY[data.priority]) throw new OpError('أولوية غير معروفة');
  for (const f of ['due_date', 'last_followup', 'snooze_until']) {
    if (data[f] && !/^\d{4}-\d{2}-\d{2}$/.test(data[f])) throw new OpError('تاريخ غير صالح');
  }
  for (const f of ['wp_url']) {
    if (data[f] && !/^https?:\/\//i.test(data[f])) throw new OpError('الرابط يجب أن يبدأ بـ http أو https');
  }
}

export function createItem(user, data, { now = nowIso(), skipPerm = false } = {}) {
  const eng = getEngagement(data.engagement_id);
  if (!eng) throw new OpError('الملف غير موجود');
  if (!skipPerm && !isMember(user, eng)) throw new OpError('لست ضمن فريق هذا الملف');
  const clean = pick(data, SPECS.items.fields);
  for (const f of ITEM_SYSTEM_FIELDS) if (f !== 'engagement_id') delete clean[f];
  if (!String(clean.title || '').trim()) throw new OpError('الوصف المختصر مطلوب');
  validateItemFields(clean);
  const row = {
    type: 'task', priority: 'medium', status: 'not_started', progress: 0, depends_on: [],
    ...clean,
    id: data.id || uid(),
    created_by: user.id,
    status_changed_at: now,
  };
  if (!('blocks_report' in clean)) row.blocks_report = defaultBlocks(row.type, row.section_code, eng.sections);
  row.blocks_report = row.blocks_report ? 1 : 0;
  if (row.status === 'closed') {
    if (!canApprove(user, row, eng)) throw new OpError('الإقفال يتم باعتماد مراجع مخوّل فقط');
    row.approved_by = user.id;
    row.approved_at = now;
  }
  const saved = insertRow('items', row, user.id);
  audit(user.id, 'items', saved.id, 'create', diffOf({}, saved, ['title', 'status', 'assignee_id', 'due_date', 'section_code']), eng.id);
  return saved;
}

export function updateItem(user, id, changes, { base = null, force = false, evidenceChanged = false, action = 'update' } = {}) {
  const { item, eng } = itemContext(id);
  if (!item) throw new OpError('البند غير موجود أو محذوف');
  const clean = pick(changes, SPECS.items.fields);
  validateItemFields(clean);
  if (base && !force) {
    const conflicts = conflictsOf(item, clean, base);
    if (conflicts.length) return { conflict: { entity: 'items', id, fields: conflicts, server: item } };
  }
  if ('blocks_report' in clean) clean.blocks_report = clean.blocks_report ? 1 : 0;
  const r = applyItemUpdate(item, clean, user, eng, nowIso(), { evidenceChanged });
  if (r.error) throw new OpError(r.error);
  const d = diffOf(item, r.next, SPECS.items.fields);
  if (!Object.keys(d).length) return { row: item, events: r.events };
  const saved = updateRow('items', id, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v[1]])), user.id);
  audit(user.id, 'items', id, r.events.length ? r.events.join(',') : action, d, eng.id);
  return { row: saved, events: r.events };
}

function conflictsOf(row, changes, base) {
  const out = [];
  for (const f of Object.keys(changes)) {
    if (!(f in base)) continue;
    if (!sameValue(row[f], base[f]) && !sameValue(row[f], changes[f])) {
      out.push({ field: f, base: base[f] ?? null, mine: changes[f] ?? null, theirs: row[f] ?? null });
    }
  }
  return out;
}

function applyOp(user, op) {
  const { entity, id, action } = op;
  const changes = op.changes || {};
  if (!id || typeof id !== 'string') throw new OpError('معرّف غير صالح');

  if (entity === 'items') {
    if (action === 'create') {
      const ex = getRow('items', id);
      if (ex) return { row: ex };
      return { row: createItem(user, { ...changes, id }) };
    }
    if (action === 'update') return updateItem(user, id, changes, { base: op.base || {}, force: op.force });
    if (action === 'delete') {
      const { item, eng } = itemContext(id);
      if (!item) return { row: null };
      if (!canDeleteItem(user, item, eng)) throw new OpError('لا تملك صلاحية حذف البند');
      const row = updateRow('items', id, { deleted: 1 }, user.id);
      audit(user.id, 'items', id, 'delete', null, eng.id);
      return { row };
    }
  }

  if (entity === 'comments') {
    if (action === 'create') {
      const ex = getRow('comments', id);
      if (ex) return { row: ex };
      const { item, eng } = itemContext(changes.item_id);
      if (!item || !isMember(user, eng)) throw new OpError('لا يمكن التعليق على هذا البند');
      const body = String(changes.body || '').trim();
      if (!body) throw new OpError('التعليق فارغ');
      const row = insertRow('comments', { id, item_id: item.id, user_id: user.id, body: body.slice(0, 5000) }, user.id);
      touch('items', 'id = ?', item.id);
      audit(user.id, 'comments', id, 'create', { body: [null, body.slice(0, 200)] }, eng.id);
      return { row };
    }
    if (action === 'delete') {
      const c = getRow('comments', id);
      if (!c) return { row: null };
      if (c.user_id !== user.id && user.role !== 'admin') throw new OpError('تحذف تعليقك فقط');
      return { row: updateRow('comments', id, { deleted: 1 }, user.id) };
    }
  }

  if (entity === 'attachments' && action === 'delete') {
    const a = getRow('attachments', id);
    if (!a || a.deleted) return { row: null };
    const { item, eng } = itemContext(a.item_id);
    if (!item) throw new OpError('البند غير موجود');
    if (a.uploaded_by !== user.id && !canApprove(user, item, eng)) throw new OpError('لا تملك صلاحية حذف المرفق');
    const row = updateRow('attachments', id, { deleted: 1 }, user.id);
    audit(user.id, 'attachments', id, 'delete', { name: [a.name, null] }, eng.id);
    // حذف دليل بعد الاعتماد يعيد فتح البند
    if (item.status === 'closed') updateItem(user, item.id, {}, { evidenceChanged: true, action: 'evidence' });
    else touch('items', 'id = ?', item.id);
    return { row };
  }

  if (entity === 'companies') {
    if (!canManageCompanies(user)) throw new OpError('لا تملك صلاحية إدارة الشركات');
    const data = pick(changes, SPECS.companies.fields);
    if (action === 'create') {
      const ex = getRow('companies', id);
      if (ex) return { row: ex };
      if (!String(data.name || '').trim()) throw new OpError('اسم الشركة مطلوب');
      const row = insertRow('companies', { ...data, id }, user.id);
      audit(user.id, 'companies', id, 'create', diffOf({}, row, ['name', 'code']));
      return { row };
    }
    const row = getRow('companies', id);
    if (!row || row.deleted) throw new OpError('الشركة غير موجودة');
    if (action === 'update') {
      if (!op.force) {
        const conflicts = conflictsOf(row, data, op.base || {});
        if (conflicts.length) return { conflict: { entity, id, fields: conflicts, server: row } };
      }
      const d = diffOf(row, { ...row, ...data }, SPECS.companies.fields);
      const saved = updateRow('companies', id, data, user.id);
      audit(user.id, 'companies', id, 'update', d);
      return { row: saved };
    }
    if (action === 'delete') {
      if (user.role !== 'admin') throw new OpError('الحذف لمدير النظام فقط');
      const n = db.prepare('SELECT COUNT(*) n FROM engagements WHERE company_id = ? AND deleted = 0').get(id).n;
      if (n) throw new OpError('احذف ملفات الشركة أولًا');
      audit(user.id, 'companies', id, 'delete', null);
      return { row: updateRow('companies', id, { deleted: 1 }, user.id) };
    }
  }

  if (entity === 'engagements') {
    const data = pick(changes, SPECS.engagements.fields);
    if ('caseware_url' in data && data.caseware_url && !/^https?:\/\//i.test(data.caseware_url)) {
      throw new OpError('رابط Caseware يجب أن يبدأ بـ http أو https');
    }
    if (action === 'create') {
      const ex = getRow('engagements', id);
      if (ex) return { row: ex };
      if (!canCreateEngagement(user)) throw new OpError('إنشاء الملفات للمدير فقط');
      return { row: createEngagement(user, { ...data, id }) };
    }
    const row = getEngagement(id);
    if (!row) throw new OpError('الملف غير موجود');
    if (action === 'update') {
      if (!canEditEngagement(user, row)) throw new OpError('لا تملك صلاحية تعديل الملف');
      if (!['admin', 'manager'].includes(user.role)) {
        for (const f of ['escalation_enabled', 'escalation_days', 'manager_id', 'in_charge_id']) delete data[f];
      }
      if (!op.force) {
        const conflicts = conflictsOf(row, data, op.base || {});
        if (conflicts.length) return { conflict: { entity, id, fields: conflicts, server: row } };
      }
      const d = diffOf(row, { ...row, ...data }, SPECS.engagements.fields);
      const saved = updateRow('engagements', id, data, user.id);
      if (d.team || d.in_charge_id || d.manager_id) {
        // أعضاء جدد يحتاجون كامل بيانات الملف في المزامنة القادمة
        touch('items', 'engagement_id = ?', id);
        touch('comments', 'item_id IN (SELECT id FROM items WHERE engagement_id = ?)', id);
        touch('attachments', 'item_id IN (SELECT id FROM items WHERE engagement_id = ?)', id);
        touch('companies', 'id = ?', row.company_id);
      }
      audit(user.id, 'engagements', id, 'update', d, id);
      return { row: saved };
    }
    if (action === 'delete') {
      if (user.role !== 'admin') throw new OpError('الحذف لمدير النظام فقط');
      audit(user.id, 'engagements', id, 'delete', null, id);
      return { row: updateRow('engagements', id, { deleted: 1 }, user.id) };
    }
  }

  throw new OpError('عملية غير مدعومة');
}

export function createEngagement(user, data) {
  const company = getRow('companies', data.company_id);
  if (!company || company.deleted) throw new OpError('الشركة غير موجودة');
  const year = Number(data.year);
  if (!year || year < 2000 || year > 2100) throw new OpError('السنة غير صالحة');
  const dup = db.prepare('SELECT id FROM engagements WHERE company_id = ? AND year = ? AND deleted = 0').get(company.id, year);
  if (dup) throw new OpError(`يوجد ملف ${year} لهذه الشركة بالفعل`);
  let sections = data.sections;
  if (!Array.isArray(sections) || !sections.length) {
    const t = db.prepare('SELECT sections FROM templates WHERE deleted = 0 ORDER BY created_at LIMIT 1').get();
    sections = t ? JSON.parse(t.sections) : [];
  }
  const row = insertRow('engagements', {
    status: 'active', team: [], escalation_enabled: 0, escalation_days: 7,
    ...data, id: data.id || uid(), year, sections, stage: data.stage || sections[0]?.code || null,
  }, user.id);
  audit(user.id, 'engagements', row.id, 'create', diffOf({}, row, ['company_id', 'year', 'in_charge_id', 'manager_id']), row.id);
  return row;
}

export function processOps(user, ops) {
  const results = [];
  const blockedIds = new Set();
  for (const op of (ops || []).slice(0, 200)) {
    const key = `${op.entity}:${op.id}`;
    if (blockedIds.has(key)) { results.push({ opId: op.opId, skipped: true }); continue; }
    const done = db.prepare('SELECT result FROM applied_ops WHERE op_id = ?').get(op.opId);
    if (done) { results.push(JSON.parse(done.result)); continue; }
    let res;
    try {
      res = tx(() => {
        const r = applyOp(user, op);
        if (r.conflict) return { opId: op.opId, conflict: r.conflict };
        const out = { opId: op.opId, ok: true, row: r.row || null, events: r.events || [] };
        db.prepare('INSERT INTO applied_ops(op_id, user_id, at, result) VALUES (?,?,?,?)')
          .run(op.opId, user.id, nowIso(), JSON.stringify({ opId: op.opId, ok: true }));
        return out;
      });
    } catch (e) {
      if (!(e instanceof OpError)) console.error('op failed', op, e);
      res = { opId: op.opId, error: e instanceof OpError ? e.message : 'خطأ غير متوقع في الخادم' };
    }
    if (res.conflict || res.error) blockedIds.add(key);
    results.push(res);
  }
  return results;
}
