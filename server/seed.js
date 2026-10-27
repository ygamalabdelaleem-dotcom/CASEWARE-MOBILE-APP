// بيانات تجريبية للنسخة الأولى — تُنشأ فقط عند أول تشغيل بقاعدة فارغة.
import { db, insertRow, updateRow, uid, tx, getRow } from './db.js';
import { hashPassword } from './auth.js';
import { ensureDefaultTemplate, engagementFromTemplate } from './templates.js';
import { createItem, updateItem } from './sync.js';
import { addDays, todayStr } from '../docs/shared/rules.js';

export function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n) return false;
  if (process.env.SEED_DEMO === '0') {
    const email = process.env.ADMIN_EMAIL;
    const pass = process.env.ADMIN_PASSWORD;
    if (!email || !pass) throw new Error('حدد ADMIN_EMAIL و ADMIN_PASSWORD لإنشاء أول مستخدم');
    const id = uid();
    insertRow('users', { id, name: process.env.ADMIN_NAME || 'مدير النظام', email, role: 'admin', active: 1, pass: hashPassword(pass) }, id);
    ensureDefaultTemplate(id);
    return true;
  }
  tx(() => seedDemo());
  return true;
}

function seedDemo() {
  const pass = hashPassword('demo1234');
  const U = {};
  const people = [
    ['youssef', 'يوسف جمال', 'youssef@demo.local', 'admin'],
    ['ahmed', 'أحمد سمير', 'ahmed@demo.local', 'manager'],
    ['mona', 'منى خالد', 'mona@demo.local', 'senior'],
    ['karim', 'كريم عادل', 'karim@demo.local', 'staff'],
    ['sara', 'سارة محمود', 'sara@demo.local', 'staff'],
  ];
  for (const [k, name, email, role] of people) {
    U[k] = { id: uid(), name, email, role };
    insertRow('users', { ...U[k], active: 1, pass }, U[k].id);
  }
  ensureDefaultTemplate(U.youssef.id);
  const tpl = db.prepare('SELECT id FROM templates LIMIT 1').get().id;
  const T = todayStr();
  const d = (n) => addDays(T, n);

  const companies = [
    { name: 'شركة النيل للصناعات الغذائية', code: 'NIL' },
    { name: 'الدلتا للتجارة والتوزيع', code: 'DLT' },
    { name: 'القاهرة للاستثمار العقاري', code: 'CRE' },
  ].map((c) => insertRow('companies', { ...c, id: uid() }, U.youssef.id));

  const admin = U.youssef;
  const mk = (company, inCharge, team, reportIn) => engagementFromTemplate(admin, {
    templateId: tpl, company_id: company.id, year: 2026, in_charge_id: inCharge.id, manager_id: U.ahmed.id,
    team: team.map((x) => x.id), report_due: d(reportIn), caseware_url: null,
  });
  const e1 = mk(companies[0], U.youssef, [U.karim, U.sara], 12);
  const e2 = mk(companies[1], U.mona, [U.karim], 34);
  const e3 = mk(companies[2], U.mona, [U.sara], 70);
  updateRow('engagements', e1.id, { stage: 'D' }, admin.id);
  updateRow('engagements', e2.id, { stage: 'C' }, admin.id);

  const items = (e) => db.prepare('SELECT id, ref FROM items WHERE engagement_id = ?').all(e.id);
  const byRef = (e, ref) => items(e).find((i) => i.ref === ref).id;
  const set = (actor, e, ref, ch) => updateItem(actor, byRef(e, ref), ch, {});
  const approveAs = (e, ref, approver) => set(approver, e, ref, { status: 'closed' });

  // ملف النيل — في مرحلة مراجعة البنود، والتقرير خلال 12 يومًا
  for (const ref of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2']) {
    set(admin, e1, ref, { assignee_id: U.karim.id, progress: 100, status: 'ready_review' });
    approveAs(e1, ref, U.ahmed);
  }
  set(admin, e1, 'B4', { assignee_id: U.karim.id, status: 'in_progress', progress: 100, received_at: d(-20) });
  set(admin, e1, 'D1', { assignee_id: U.sara.id, status: 'waiting_client', due_date: d(-3), last_followup: d(-5),
    next_step: 'متابعة مصادقة بنك مصر والبنك الأهلي', progress: 40, blocks_report: 1 });
  set(admin, e1, 'D2', { assignee_id: U.karim.id, status: 'in_progress', due_date: d(0), progress: 60 });
  set(admin, e1, 'D3', { assignee_id: U.youssef.id, status: 'ready_review', due_date: d(-1), progress: 100, ref: 'D3', conclusion: 'تمت مطابقة الجرد مع الدفاتر' });
  set(admin, e1, 'D4', { assignee_id: U.sara.id, status: 'rework', due_date: d(1), progress: 80, next_step: 'تصحيح احتساب الإهلاك للإضافات' });
  set(admin, e1, 'D6', { assignee_id: U.karim.id, status: 'in_progress', due_date: d(2), progress: 30, priority: 'high' });
  set(admin, e1, 'D7', { assignee_id: U.youssef.id, status: 'not_started', due_date: d(5) });
  set(admin, e1, 'E3', { assignee_id: U.youssef.id, status: 'waiting_client', due_date: d(7), blocks_report: 1 });
  const note = createItem(admin, { engagement_id: e1.id, section_code: 'D', type: 'note', title: 'عدم وجود دراسة اضمحلال للعملاء المتأخرين',
    assignee_id: U.youssef.id, priority: 'high', status: 'waiting_client', due_date: d(-2), next_step: 'استلام رد الإدارة ودراسة الخسائر الائتمانية المتوقعة' });
  const diff = createItem(admin, { engagement_id: e1.id, section_code: 'E', type: 'difference', title: 'فرق مطابقة رصيد مورد رئيسي 185,000 ج',
    assignee_id: U.karim.id, priority: 'high', status: 'in_progress', due_date: d(3), depends_on: [byRef(e1, 'D1')] });
  updateItem(admin, byRef(e1, 'E4'), { depends_on: [diff.id, note.id], assignee_id: U.youssef.id, due_date: d(8) }, {});

  // ملف الدلتا — في التخطيط والمخاطر
  for (const ref of ['A1', 'A2']) { set(U.mona, e2, ref, { assignee_id: U.karim.id, progress: 100 }); approveAs(e2, ref, U.mona); }
  set(admin, e2, 'A3', { assignee_id: U.mona.id, status: 'waiting_client', due_date: d(-6), last_followup: d(-6) });
  set(admin, e2, 'B2', { assignee_id: U.karim.id, status: 'ready_review', progress: 100, due_date: d(-1) });
  set(admin, e2, 'B4', { assignee_id: U.karim.id, status: 'waiting_client', due_date: d(1), last_followup: d(-1) });
  set(admin, e2, 'C1', { assignee_id: U.mona.id, status: 'in_progress', due_date: d(4), progress: 20 });

  // ملف القاهرة — بداية الارتباط
  set(admin, e3, 'A1', { assignee_id: U.mona.id, status: 'in_progress', due_date: d(6), progress: 50 });

  createComment(U.karim, byRef(e1, 'D2'), 'تم إرسال 12 مصادقة من أصل 15، والباقي بانتظار العناوين من العميل.');
  createComment(U.ahmed, byRef(e1, 'D4'), 'برجاء مراجعة نسبة إهلاك خطوط الإنتاج الجديدة.');
}

function createComment(user, itemId, body) {
  insertRow('comments', { id: uid(), item_id: itemId, user_id: user.id, body }, user.id);
  return getRow('items', itemId);
}
