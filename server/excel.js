import ExcelJS from 'exceljs';
import crypto from 'node:crypto';
import { db, decode, getRow, insertRow, audit, tx, uid } from './db.js';
import { OpError, createItem, updateItem, createEngagement, visibleEngagements } from './sync.js';
import { STATUSES, TYPES, PRIORITIES, isMember, canCreateEngagement, canManageCompanies } from '../docs/shared/rules.js';

const COLS = [
  { key: 'id', header: 'المعرف (لا تعدّله)', width: 12 },
  { key: 'company', header: 'الشركة', width: 28 },
  { key: 'year', header: 'السنة', width: 8 },
  { key: 'section_code', header: 'البند/القسم', width: 10 },
  { key: 'ref', header: 'مرجع ورقة العمل', width: 12 },
  { key: 'type', header: 'النوع', width: 12 },
  { key: 'title', header: 'الوصف', width: 40 },
  { key: 'description', header: 'تفاصيل', width: 30 },
  { key: 'assignee', header: 'المسؤول', width: 18 },
  { key: 'priority', header: 'الأولوية', width: 10 },
  { key: 'due_date', header: 'الموعد', width: 12 },
  { key: 'status', header: 'الحالة', width: 16 },
  { key: 'progress', header: 'نسبة التنفيذ', width: 10 },
  { key: 'last_followup', header: 'آخر متابعة', width: 12 },
  { key: 'next_step', header: 'الخطوة التالية', width: 28 },
  { key: 'wp_url', header: 'رابط ورقة العمل', width: 24 },
  { key: 'blocks_report', header: 'يمنع التقرير', width: 10 },
  { key: 'approved', header: 'اعتمده', width: 16 },
];

const label = (list, key) => list.find((x) => x.key === key)?.label || key || '';
const fromLabel = (list, v) => {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  return list.find((x) => x.label === s || x.key === s)?.key ?? null;
};

export async function exportXlsx(user, engagementId) {
  const engs = visibleEngagements(user).filter((e) => !engagementId || e.id === engagementId);
  const companies = new Map(db.prepare('SELECT * FROM companies').all().map((c) => [c.id, c]));
  const users = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'متابعة سيزون المراجعة';
  const ws = wb.addWorksheet('المتابعة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = COLS;
  ws.getRow(1).font = { bold: true };
  for (const e of engs) {
    const items = db.prepare('SELECT * FROM items WHERE engagement_id = ? AND deleted = 0 ORDER BY section_code, ref').all(e.id)
      .map((r) => decode('items', r));
    for (const i of items) {
      ws.addRow({
        id: i.id, company: companies.get(e.company_id)?.name, year: e.year, section_code: i.section_code, ref: i.ref,
        type: label(TYPES, i.type), title: i.title, description: i.description, assignee: users.get(i.assignee_id) || '',
        priority: label(PRIORITIES, i.priority), due_date: i.due_date, status: label(STATUSES, i.status), progress: i.progress,
        last_followup: i.last_followup, next_step: i.next_step, wp_url: i.wp_url, blocks_report: i.blocks_report ? 'نعم' : 'لا',
        approved: i.approved_by ? `${users.get(i.approved_by) || ''} ${i.approved_at?.slice(0, 10) || ''}` : '',
      });
    }
  }
  const ws2 = wb.addWorksheet('الملفات', { views: [{ rightToLeft: true }] });
  ws2.columns = [
    { key: 'company', header: 'الشركة', width: 28 }, { key: 'code', header: 'الكود', width: 10 },
    { key: 'year', header: 'السنة', width: 8 }, { key: 'in_charge', header: 'المسؤول', width: 18 },
    { key: 'manager', header: 'المدير', width: 18 }, { key: 'report_due', header: 'موعد التقرير', width: 12 },
    { key: 'stage', header: 'المرحلة', width: 10 }, { key: 'caseware_url', header: 'رابط Caseware', width: 30 },
  ];
  ws2.getRow(1).font = { bold: true };
  for (const e of engs) {
    const c = companies.get(e.company_id);
    ws2.addRow({ company: c?.name, code: c?.code, year: e.year, in_charge: users.get(e.in_charge_id) || '',
      manager: users.get(e.manager_id) || '', report_due: e.report_due, stage: e.stage, caseware_url: e.caseware_url });
  }
  const lists = wb.addWorksheet('القيم المسموحة', { views: [{ rightToLeft: true }] });
  lists.addRow(['الحالة', 'النوع', 'الأولوية']);
  for (let r = 0; r < 6; r++) lists.addRow([STATUSES[r]?.label, TYPES[r]?.label, PRIORITIES[r]?.label]);
  return wb.xlsx.writeBuffer();
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
  if (/^\d{5}$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10);
  return null;
}

const pending = new Map();

export async function previewImport(user, buffer, { createMissing = false } = {}) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new OpError('ملف Excel غير صالح (xlsx فقط)'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new OpError('الملف فارغ');
  const headerMap = {};
  ws.getRow(1).eachCell((cell, col) => {
    const h = cellText(cell.value);
    const c = COLS.find((x) => x.header === h || x.key === h || (x.key === 'id' && h.startsWith('المعرف')));
    if (c) headerMap[col] = c.key;
  });
  if (!Object.values(headerMap).includes('title')) throw new OpError('عمود «الوصف» غير موجود — استخدم ملف التصدير كقالب');

  const engs = visibleEngagements(user);
  const companies = db.prepare('SELECT * FROM companies WHERE deleted = 0').all();
  const users = db.prepare('SELECT id, name, email FROM users WHERE deleted = 0').all();
  const rows = [];
  const plan = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => { if (headerMap[col]) r[headerMap[col]] = cell.value; });
    const title = cellText(r.title);
    if (!title && !cellText(r.company)) return;
    const res = { row: n, title };
    try {
      if (!title) throw new OpError('الوصف فارغ');
      const compTxt = cellText(r.company);
      const year = Number(cellText(r.year));
      const id = cellText(r.id);
      let existing = id ? getRow('items', id) : null;
      if (existing?.deleted) existing = null;
      const company = companies.find((c) => c.name === compTxt || (c.code && c.code === compTxt));
      let eng = existing ? engs.find((e) => e.id === existing.engagement_id)
        : company && engs.find((e) => e.company_id === company.id && e.year === year);
      const data = { title };
      for (const k of ['section_code', 'ref', 'description', 'next_step', 'wp_url']) {
        const v = cellText(r[k]);
        if (k in r) data[k] = v || null;
      }
      if ('type' in r) { const t = fromLabel(TYPES, cellText(r.type)); if (t === null) throw new OpError('نوع غير معروف'); if (t) data.type = t; }
      if ('priority' in r) { const p = fromLabel(PRIORITIES, cellText(r.priority)); if (p === null) throw new OpError('أولوية غير معروفة'); if (p) data.priority = p; }
      if ('status' in r) { const s = fromLabel(STATUSES, cellText(r.status)); if (s === null) throw new OpError('حالة غير معروفة'); if (s) data.status = s; }
      for (const k of ['due_date', 'last_followup']) {
        if (k in r) { const d = dateText(r[k]); if (d === null) throw new OpError('تاريخ غير مفهوم (استخدم yyyy-mm-dd)'); data[k] = d || null; }
      }
      if ('progress' in r) data.progress = Number(cellText(r.progress)) || 0;
      if ('blocks_report' in r) data.blocks_report = ['نعم', '1', 'true', 'yes'].includes(cellText(r.blocks_report).toLowerCase()) ? 1 : 0;
      if ('assignee' in r) {
        const a = cellText(r.assignee);
        if (a) {
          const u = users.find((x) => x.name === a || x.email.toLowerCase() === a.toLowerCase());
          if (!u) throw new OpError(`المسؤول «${a}» غير موجود`);
          data.assignee_id = u.id;
        } else data.assignee_id = null;
      }
      if (existing) {
        if (!eng) throw new OpError('لا تملك صلاحية على هذا الملف');
        res.action = 'update';
        plan.push({ action: 'update', id: existing.id, data });
      } else {
        if (!eng) {
          if (!compTxt || !year) throw new OpError('حدد الشركة والسنة');
          if (!createMissing) throw new OpError(`لا يوجد ملف «${compTxt} ${year}» — فعّل «إنشاء الملفات الناقصة»`);
          if (!canCreateEngagement(user) || (!company && !canManageCompanies(user))) throw new OpError('إنشاء الملفات للمدير فقط');
          res.note = company ? `سيُنشأ ملف ${year}` : 'ستُنشأ الشركة والملف';
        } else if (!isMember(user, eng)) throw new OpError('لست ضمن فريق الملف');
        res.action = 'create';
        plan.push({ action: 'create', company: compTxt, companyId: company?.id, year, engId: eng?.id, data });
      }
    } catch (e) {
      res.action = 'error';
      res.error = e instanceof OpError ? e.message : 'خطأ في السطر';
    }
    rows.push(res);
  });
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { userId: user.id, plan, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60000) pending.delete(k);
  return { token, rows, summary: {
    create: rows.filter((r) => r.action === 'create').length,
    update: rows.filter((r) => r.action === 'update').length,
    error: rows.filter((r) => r.action === 'error').length,
  } };
}

export function commitImport(user, token) {
  const p = pending.get(token);
  if (!p || p.userId !== user.id) throw new OpError('انتهت صلاحية المعاينة، أعد رفع الملف');
  pending.delete(token);
  const results = { created: 0, updated: 0, failed: [] };
  const engCache = new Map();
  for (const step of p.plan) {
    try {
      tx(() => {
        if (step.action === 'update') {
          const r = updateItem(user, step.id, step.data, { action: 'import' });
          if (r.conflict) throw new OpError('تعارض');
          results.updated++;
          return;
        }
        let engId = step.engId;
        const key = `${step.company}|${step.year}`;
        if (!engId) engId = engCache.get(key);
        if (!engId) {
          let companyId = step.companyId || db.prepare('SELECT id FROM companies WHERE name = ? AND deleted = 0').get(step.company)?.id;
          if (!companyId) {
            const c = insertRow('companies', { id: uid(), name: step.company, code: null }, user.id);
            audit(user.id, 'companies', c.id, 'import', null);
            companyId = c.id;
          }
          const existing = db.prepare('SELECT id FROM engagements WHERE company_id = ? AND year = ? AND deleted = 0').get(companyId, step.year);
          engId = existing?.id || createEngagement(user, { company_id: companyId, year: step.year }).id;
          engCache.set(key, engId);
        }
        createItem(user, { ...step.data, engagement_id: engId });
        results.created++;
      });
    } catch (e) {
      results.failed.push({ title: step.data.title, error: e instanceof OpError ? e.message : 'خطأ' });
    }
  }
  return results;
}
