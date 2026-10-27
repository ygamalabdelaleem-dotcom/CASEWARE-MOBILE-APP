import { db, getRow, insertRow, updateRow, audit, tx, uid, decode } from './db.js';
import { OpError, createEngagement, createItem, getEngagement } from './sync.js';
import { canCreateEngagement, isMember } from '../docs/shared/rules.js';

import { DEFAULT_SECTIONS, DEFAULT_TASKS, LEGACY_TASK_COUNTS } from '../docs/shared/defaults.js';

export { DEFAULT_SECTIONS, DEFAULT_TASKS };

export function ensureDefaultTemplate(userId) {
  const n = db.prepare('SELECT COUNT(*) n FROM templates').get().n;
  if (n) {
    // ترقية القالب الافتراضي غير المعدّل إلى قائمة البنود الموسعة
    for (const t of db.prepare("SELECT * FROM templates WHERE name = 'قالب المكتب الافتراضي' AND deleted = 0").all().map((r) => decode('templates', r))) {
      if (LEGACY_TASK_COUNTS.includes(t.tasks.length)) updateRow('templates', t.id, { tasks: DEFAULT_TASKS }, userId);
    }
    return;
  }
  insertRow('templates', { id: uid(), name: 'قالب المكتب الافتراضي', sections: DEFAULT_SECTIONS, tasks: DEFAULT_TASKS }, userId);
}

function cleanSections(sections) {
  if (!Array.isArray(sections)) throw new OpError('هيكل الأقسام غير صالح');
  const seen = new Set();
  const out = [];
  for (const s of sections) {
    const code = String(s.code || '').trim();
    const name = String(s.name || '').trim();
    if (!code || !name) throw new OpError('كل قسم يحتاج كودًا واسمًا');
    if (seen.has(code)) throw new OpError(`الكود ${code} مكرر`);
    seen.add(code);
    out.push({ code, name });
  }
  if (!out.length) throw new OpError('أضف قسمًا واحدًا على الأقل');
  return out;
}
function cleanTasks(tasks, sections) {
  const codes = new Set(sections.map((s) => s.code));
  return (tasks || []).filter((t) => String(t.title || '').trim()).map((t) => ({
    section_code: codes.has(t.section_code) ? t.section_code : sections[0].code,
    ref: String(t.ref || '').trim() || null,
    title: String(t.title).trim(),
    type: ['task', 'doc_request', 'note', 'difference'].includes(t.type) ? t.type : 'task',
    priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
  }));
}

export function saveTemplate(user, { id, name, sections, tasks }) {
  if (!['admin', 'manager'].includes(user.role)) throw new OpError('إدارة القوالب للمدير فقط');
  if (!String(name || '').trim()) throw new OpError('اسم القالب مطلوب');
  const secs = cleanSections(sections);
  const data = { name: String(name).trim(), sections: secs, tasks: cleanTasks(tasks, secs) };
  return tx(() => {
    if (id && getRow('templates', id)) {
      audit(user.id, 'templates', id, 'update', null);
      return updateRow('templates', id, data, user.id);
    }
    const row = insertRow('templates', { ...data, id: uid() }, user.id);
    audit(user.id, 'templates', row.id, 'create', null);
    return row;
  });
}

export function deleteTemplate(user, id) {
  if (!['admin', 'manager'].includes(user.role)) throw new OpError('إدارة القوالب للمدير فقط');
  const n = db.prepare('SELECT COUNT(*) n FROM templates WHERE deleted = 0').get().n;
  if (n <= 1) throw new OpError('يجب الإبقاء على قالب واحد على الأقل');
  return updateRow('templates', id, { deleted: 1 }, user.id);
}

// ملف جديد من قالب
export function engagementFromTemplate(user, { templateId, company_id, year, in_charge_id, manager_id, team, report_due, caseware_url }) {
  if (!canCreateEngagement(user)) throw new OpError('إنشاء الملفات للمدير فقط');
  const t = getRow('templates', templateId);
  if (!t || t.deleted) throw new OpError('القالب غير موجود');
  return tx(() => {
    const eng = createEngagement(user, {
      company_id, year, in_charge_id: in_charge_id || null, manager_id: manager_id || null,
      team: Array.isArray(team) ? team : [], report_due: report_due || null, caseware_url: caseware_url || null,
      sections: t.sections,
    });
    for (const task of t.tasks) {
      createItem(user, { ...task, engagement_id: eng.id, assignee_id: in_charge_id || null }, { skipPerm: true });
    }
    return eng;
  });
}

// حفظ ملف كقالب (الأقسام والمهام فقط، دون نتائج)
export function templateFromEngagement(user, engId, name) {
  const eng = getEngagement(engId);
  if (!eng || !isMember(user, eng)) throw new OpError('الملف غير موجود');
  const items = db.prepare("SELECT * FROM items WHERE engagement_id = ? AND deleted = 0 AND type IN ('task','doc_request') ORDER BY section_code, ref")
    .all(engId).map((r) => decode('items', r));
  return saveTemplate(user, { name, sections: eng.sections, tasks: items });
}

// ترحيل الملف لسنة جديدة: ينسخ الهيكل والمهام ويمسح نتائج التنفيذ والاعتمادات والتواريخ.
export function rollover(user, engId, { year, report_due, includeNotes = false }) {
  if (!canCreateEngagement(user)) throw new OpError('الترحيل للمدير فقط');
  const src = getEngagement(engId);
  if (!src) throw new OpError('الملف غير موجود');
  const newYear = Number(year) || src.year + 1;
  const types = includeNotes ? ['task', 'doc_request', 'note', 'difference'] : ['task', 'doc_request'];
  const items = db.prepare(`SELECT * FROM items WHERE engagement_id = ? AND deleted = 0 AND type IN (${types.map(() => '?').join(',')})`)
    .all(engId, ...types).map((r) => decode('items', r));
  return tx(() => {
    const eng = createEngagement(user, {
      company_id: src.company_id, year: newYear, in_charge_id: src.in_charge_id, manager_id: src.manager_id,
      team: src.team, sections: src.sections, report_due: report_due || null, caseware_url: null,
      escalation_enabled: 0, escalation_days: src.escalation_days, notes: src.notes,
    });
    const idMap = new Map(items.map((i) => [i.id, uid()]));
    for (const i of items) {
      createItem(user, {
        id: idMap.get(i.id), engagement_id: eng.id, section_code: i.section_code, type: i.type, ref: i.ref,
        title: i.title, description: i.description, assignee_id: i.assignee_id, priority: i.priority,
        blocks_report: i.blocks_report, depends_on: (i.depends_on || []).map((d) => idMap.get(d)).filter(Boolean),
        // يتم مسح: الحالة، التنفيذ، الاعتماد، التواريخ، النتائج، ردود العميل، روابط أوراق العمل، المرفقات والتعليقات.
      }, { skipPerm: true });
    }
    audit(user.id, 'engagements', eng.id, 'rollover', { from: [src.id, eng.id] }, eng.id);
    return eng;
  });
}
