// قواعد المراجعة والصلاحيات — ملف مشترك بين الخادم والتطبيق.

export const STATUSES = [
  { key: 'not_started', label: 'لم يبدأ', color: 'gray' },
  { key: 'in_progress', label: 'جارٍ', color: 'blue' },
  { key: 'waiting_client', label: 'بانتظار العميل', color: 'amber' },
  { key: 'ready_review', label: 'جاهز للمراجعة', color: 'violet' },
  { key: 'rework', label: 'مطلوب تعديل', color: 'red' },
  { key: 'closed', label: 'مقفل باعتماد', color: 'green' },
];
export const STATUS = Object.fromEntries(STATUSES.map((s) => [s.key, s]));

export const TYPES = [
  { key: 'task', label: 'مهمة' },
  { key: 'doc_request', label: 'طلب مستند' },
  { key: 'note', label: 'ملاحظة' },
  { key: 'difference', label: 'فرق' },
];
export const TYPE = Object.fromEntries(TYPES.map((t) => [t.key, t]));

export const PRIORITIES = [
  { key: 'high', label: 'عالية', weight: 3 },
  { key: 'medium', label: 'متوسطة', weight: 2 },
  { key: 'low', label: 'منخفضة', weight: 1 },
];
export const PRIORITY = Object.fromEntries(PRIORITIES.map((p) => [p.key, p]));

export const ROLES = [
  { key: 'admin', label: 'مدير النظام' },
  { key: 'manager', label: 'مدير / شريك' },
  { key: 'senior', label: 'مراجع أول (مسؤول ملف)' },
  { key: 'staff', label: 'مساعد مراجع' },
];
export const ROLE = Object.fromEntries(ROLES.map((r) => [r.key, r]));

export const ENG_STATUSES = [
  { key: 'active', label: 'جارٍ' },
  { key: 'issued', label: 'صدر التقرير' },
  { key: 'archived', label: 'مؤرشف' },
];

// تغيير هذه الحقول بعد الاعتماد يعيد فتح البند (النتيجة أو الأدلة).
export const EVIDENCE_FIELDS = ['conclusion', 'ref', 'wp_url', 'client_response', 'received_at'];

// الحقول التي لا يعدّلها المستخدم مباشرة.
export const ITEM_SYSTEM_FIELDS = ['approved_by', 'approved_at', 'status_changed_at', 'created_by', 'engagement_id'];

export const ITEM_FIELDS = [
  'engagement_id', 'section_code', 'type', 'ref', 'wp_url', 'title', 'description', 'assignee_id',
  'priority', 'due_date', 'last_followup', 'next_step', 'status', 'progress', 'conclusion',
  'client_response', 'received_at', 'approved_by', 'approved_at', 'blocks_report', 'depends_on',
  'snooze_until', 'status_changed_at', 'created_by',
];

// ---------- التواريخ ----------
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// عدد الأيام من a إلى b (b - a)
export function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(b.slice(0, 10) + 'T12:00:00Z') - Date.parse(a.slice(0, 10) + 'T12:00:00Z')) / 86400000);
}

// ---------- الصلاحيات ----------
export function isMember(user, eng) {
  if (!user || !eng) return false;
  if (user.role === 'admin' || user.role === 'manager') return true;
  return eng.in_charge_id === user.id || eng.manager_id === user.id || (eng.team || []).includes(user.id);
}
export function canManageCompanies(user) {
  return ['admin', 'manager', 'senior'].includes(user?.role);
}
export function canCreateEngagement(user) {
  return ['admin', 'manager'].includes(user?.role);
}
export function canEditEngagement(user, eng) {
  if (['admin', 'manager'].includes(user?.role)) return true;
  return user?.role === 'senior' && eng?.in_charge_id === user.id;
}
export function canEditItem(user, item, eng) {
  if (!isMember(user, eng)) return false;
  if (['admin', 'manager', 'senior'].includes(user.role)) return true;
  return !item.assignee_id || item.assignee_id === user.id || item.created_by === user.id;
}
export function canDeleteItem(user, item, eng) {
  if (!isMember(user, eng)) return false;
  if (['admin', 'manager'].includes(user.role)) return true;
  return user.role === 'senior' || (item.created_by === user.id && item.status === 'not_started');
}
// الاعتماد للمراجع المخوّل فقط، ولا يعتمد أحد بندًا مسندًا إليه (فصل المهام)، عدا مدير النظام.
export function canApprove(user, item, eng) {
  if (!user || !isMember(user, eng)) return false;
  if (user.role === 'admin') return true;
  if (!['manager', 'senior'].includes(user.role)) return false;
  return item.assignee_id !== user.id;
}

// ---------- تطبيق التعديل على بند بقواعد المراجعة ----------
function same(a, b) {
  const n = (v) => (v === undefined || v === '' ? null : v);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
}
export { same as sameValue };

export function applyItemUpdate(prev, rawChanges, user, eng, nowIso, opts = {}) {
  const changes = { ...rawChanges };
  for (const f of ITEM_SYSTEM_FIELDS) delete changes[f];
  if (!canEditItem(user, prev, eng)) return { error: 'لا تملك صلاحية تعديل هذا البند' };
  if ('progress' in changes) {
    const p = Math.round(Number(changes.progress) || 0);
    changes.progress = Math.max(0, Math.min(100, p));
  }
  if ('status' in changes && !STATUS[changes.status]) return { error: 'حالة غير معروفة' };
  if ('priority' in changes && !PRIORITY[changes.priority]) return { error: 'أولوية غير معروفة' };
  if ('type' in changes && !TYPE[changes.type]) return { error: 'نوع غير معروف' };
  if ('title' in changes && !String(changes.title || '').trim()) return { error: 'الوصف المختصر مطلوب' };

  const next = { ...prev, ...changes };
  const events = [];
  const wasClosed = prev.status === 'closed';
  const statusChanged = 'status' in changes && changes.status !== prev.status;

  if (statusChanged && changes.status === 'closed') {
    if (!canApprove(user, prev, eng)) {
      return { error: prev.assignee_id === user.id && user.role !== 'staff'
        ? 'لا يمكنك اعتماد بند مسند إليك؛ يعتمده مراجع آخر'
        : 'الإقفال يتم باعتماد مراجع مخوّل فقط' };
    }
    next.approved_by = user.id;
    next.approved_at = nowIso;
    events.push('approved');
  } else if (wasClosed && statusChanged) {
    if (!canApprove(user, prev, eng)) return { error: 'فتح بند معتمد يتم بواسطة مراجع مخوّل' };
    next.approved_by = null;
    next.approved_at = null;
    events.push('unlocked');
  } else if (wasClosed) {
    const evidenceChanged = opts.evidenceChanged || EVIDENCE_FIELDS.some((f) => f in changes && !same(changes[f], prev[f]));
    if (evidenceChanged) {
      next.status = 'in_progress';
      next.approved_by = null;
      next.approved_at = null;
      events.push('reopened');
    }
  }

  // وصول المستند أو رد العميل لا يُكمل الإجراء ولا يُغلق الملاحظة.
  if (!statusChanged && prev.status === 'waiting_client') {
    const arrived = ('received_at' in changes && changes.received_at && !prev.received_at)
      || ('client_response' in changes && changes.client_response && !same(changes.client_response, prev.client_response));
    if (arrived) {
      next.status = 'in_progress';
      events.push('client_replied');
    }
  }

  if (next.status !== prev.status) next.status_changed_at = nowIso;
  return { next, events };
}

// ---------- ترتيب الأولوية ----------
// يجمع: الأهمية، التأخير، قرب موعد التقرير، تأثير البند على غيره، ومنعه لإصدار التقرير.
export function itemScore(item, eng, today, dependents = 0) {
  if (item.status === 'closed') return 0;
  let s = (PRIORITY[item.priority]?.weight || 2) * 10;
  if (item.due_date) {
    const d = daysBetween(today, item.due_date);
    if (d < 0) s += Math.min(-d, 15) * 2 + 10;
    else if (d === 0) s += 12;
    else if (d <= 2) s += 6;
  }
  if (eng?.report_due) {
    const r = daysBetween(today, eng.report_due);
    if (r <= 7) s += 15;
    else if (r <= 14) s += 8;
    else if (r <= 30) s += 3;
  }
  s += Math.min(dependents, 5) * 5;
  if (item.blocks_report) s += 10;
  if (item.status === 'rework') s += 5;
  return s;
}

export function isOverdue(item, today) {
  return item.status !== 'closed' && item.due_date && item.due_date < today;
}

// موانع إصدار التقرير: بنود مفتوحة مؤشَّرة كمانعة.
export function isBlocker(item) {
  return item.status !== 'closed' && !!item.blocks_report;
}

// القيمة الافتراضية لـ«يمنع التقرير»: الملاحظات والفروق وبنود الاستكمال والتقرير.
export function defaultBlocks(type, sectionCode, sections) {
  if (type === 'note' || type === 'difference') return 1;
  const idx = (sections || []).findIndex((s) => s.code === sectionCode);
  return idx >= 0 && idx >= (sections.length - 2) ? 1 : 0;
}
