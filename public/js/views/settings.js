import { S, setMe, mutate, uuid } from '../store.js';
import { h, raw, toast, options, confirmSheet, openSheet, fmtTime, downloadUrl, esc } from '../ui.js';
import { api } from '../api.js';
import { syncNow, resolveConflict, dismissOp } from '../sync.js';
import { ROLES, ROLE, TYPES, PRIORITIES } from '/shared/rules.js';
import { pushCard, mountPushCard } from './notifs.js';
import { disablePush } from '../push.js';
import * as idb from '../idb.js';

const isAdmin = () => S.me.role === 'admin';
const isMgr = () => ['admin', 'manager'].includes(S.me.role);

export function render() {
  return {
    title: 'الإعدادات',
    back: true,
    html: h`
      <div class="card"><b>${S.me.name}</b><div class="muted small">${S.me.email} · ${ROLE[S.me.role]?.label}</div></div>
      <div class="list">
        ${[
          ['#/settings/notifs', 'الإشعارات والتذكيرات'],
          ['#/sync', 'المزامنة والتعارضات'],
          ['#/import', 'استيراد من Excel'],
          ['export', 'تصدير كل المتابعة إلى Excel'],
          isMgr() && ['#/settings/templates', 'القوالب وهيكل الأقسام'],
          isAdmin() && ['#/settings/users', 'المستخدمون والصلاحيات'],
          isAdmin() && ['#/settings/backup', 'النسخ الاحتياطي'],
          ['password', 'تغيير كلمة المرور'],
        ].filter(Boolean).map(([href, label]) => href.startsWith('#')
          ? h`<a class="it" href="${href}"><div class="body"><div class="title">${label}</div></div><span class="muted">‹</span></a>`
          : h`<button class="it" style="width:100%;background:none;border-inline:0;border-bottom:0;text-align:start;cursor:pointer" data-act="${href}"><div class="body"><div class="title">${label}</div></div></button>`)}
      </div>
      <button class="btn block danger" data-logout>تسجيل الخروج</button>
      <p class="hint" style="text-align:center;margin-top:16px">متابعة سيزون المراجعة — للمتابعة فقط؛ Caseware يظل مكان تنفيذ وتوثيق المراجعة.</p>`,
    mount(root) {
      root.querySelector('[data-act=export]')?.addEventListener('click', () => {
        if (!navigator.onLine) return toast('التصدير يحتاج اتصالًا');
        downloadUrl('/api/export.xlsx');
      });
      root.querySelector('[data-act=password]').addEventListener('click', passwordSheet);
      root.querySelector('[data-logout]').addEventListener('click', async () => {
        const pending = S.outbox.length;
        if (!(await confirmSheet('تسجيل الخروج', pending ? `يوجد ${pending} تعديل لم يُرفع وسيُحذف من الجهاز.` : 'ستُحذف بيانات المتابعة من هذا الجهاز.', 'خروج', true))) return;
        await disablePush().catch(() => {});
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        await idb.clearAll();
        location.replace('/#/');
        location.reload();
      });
    },
  };
}

function passwordSheet() {
  openSheet(h`<h2>تغيير كلمة المرور</h2><form>
    <label class="field"><span>الحالية</span><input type="password" name="current" autocomplete="current-password" required></label>
    <label class="field"><span>الجديدة (8 أحرف على الأقل)</span><input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
    <div class="btns"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div></form>`.s, {
    onMount: (el, close) => el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/me/password', { method: 'POST', body: { current: e.target.current.value, next: e.target.next.value } }); close(); toast('تم التغيير'); } catch (err) { toast(err.message); }
    }),
  });
}

// ---------- إعدادات الإشعارات ----------
const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const KINDS = [['morning', 'ملخص صباحي'], ['due', 'تذكير قبل الاستحقاق ويومه'], ['overdue', 'متابعة المتأخر'],
  ['client', 'متابعة طلبات العملاء'], ['review', 'البنود الجاهزة للمراجعة'], ['weekly', 'مراجعة أسبوعية (دون موعد/تحديث)'],
  ['escalation', 'تصعيد المتأخرات (للمدير، إن فُعّل للملف)']];

export function renderNotifPrefs() {
  return {
    title: 'الإشعارات والتذكيرات',
    back: true,
    html: h`${raw(pushCard().s)}<div id="prefs"><div class="loading">جارٍ التحميل…</div></div>`,
    async mount(root) {
      mountPushCard(root);
      const box = root.querySelector('#prefs');
      let p;
      try { p = await api('/api/prefs'); } catch (e) { box.innerHTML = h`<div class="empty">${e.status === 0 ? 'الإعدادات تحتاج اتصالًا' : e.message}</div>`.s; return; }
      const num = (name, label, min, max, hint = '') => h`<label class="field"><span>${label}</span><input type="number" inputmode="numeric" name="${name}" min="${min}" max="${max}" value="${p[name]}">${hint ? h`<div class="hint">${hint}</div>` : ''}</label>`;
      box.innerHTML = h`<form class="card">
        <div class="section-title" style="margin-top:0">الأنواع</div>
        ${KINDS.map(([k, l]) => h`<label class="check"><input type="checkbox" name="k_${k}" ${p.kinds[k] ? raw('checked') : ''}> ${l}</label>`)}
        <div class="section-title">التوقيت</div>
        <div class="grid2">
          <label class="field"><span>الملخص الصباحي</span><input type="time" name="morning" value="${p.morning}"></label>
          <label class="field"><span>المنطقة الزمنية</span><input name="tz" value="${p.tz}"></label>
          <label class="field"><span>بداية الهدوء</span><input type="time" name="quiet_start" value="${p.quiet_start}"></label>
          <label class="field"><span>نهاية الهدوء</span><input type="time" name="quiet_end" value="${p.quiet_end}"></label>
        </div>
        <div class="field"><span>أيام العمل</span><div class="chips" style="flex-wrap:wrap">${DAYS.map((d, i) => h`<button type="button" class="chip ${p.workdays.includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`)}</div></div>
        <div class="section-title">التكرار والحد</div>
        <div class="grid2">
          ${num('daily_limit', 'الحد اليومي للإشعارات', 1, 30, 'الزائد يبقى في الصندوق')}
          ${num('remind_before_days', 'التذكير قبل الاستحقاق (أيام)', 0, 14)}
          ${num('overdue_every_days', 'تكرار تذكير المتأخر (كل … يوم)', 1, 14)}
          ${num('client_every_days', 'متابعة طلبات العميل (كل … يوم)', 1, 30)}
          ${num('review_every_days', 'تذكير المراجعة (كل … يوم)', 1, 14)}
          ${num('stale_days', 'يعتبر البند راكدًا بعد (أيام)', 3, 90)}
        </div>
        <label class="field"><span>يوم المراجعة الأسبوعية</span><select name="weekly_day">${options(DAYS.map((d, i) => ({ value: i, label: d })), p.weekly_day)}</select></label>
        <div class="section-title">الخصوصية</div>
        <label class="check"><input type="checkbox" name="lock_privacy" ${p.lock_privacy ? raw('checked') : ''}> إخفاء التفاصيل في إشعارات شاشة القفل (كود الشركة وعدد التنبيهات فقط)</label>
        <p class="hint">التفاصيل الكاملة تظهر داخل التطبيق بعد فتحه. الإشعارات تُجدول على الخادم وتصل غالبًا خلال دقائق، لكن الوصول الفوري غير مضمون.</p>
        <button class="btn primary block">حفظ</button>
      </form>`.s;
      const form = box.querySelector('form');
      const days = new Set(p.workdays);
      form.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
        const d = +b.dataset.day;
        if (days.has(d)) days.delete(d); else days.add(d);
        b.classList.toggle('on', days.has(d));
      }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = form;
        const body = {
          morning: f.morning.value, tz: f.tz.value.trim(), quiet_start: f.quiet_start.value, quiet_end: f.quiet_end.value,
          workdays: [...days], weekly_day: +f.weekly_day.value, lock_privacy: f.lock_privacy.checked,
          kinds: Object.fromEntries(KINDS.map(([k]) => [k, f[`k_${k}`].checked])),
        };
        for (const k of ['daily_limit', 'remind_before_days', 'overdue_every_days', 'client_every_days', 'review_every_days', 'stale_days']) body[k] = +f[k].value;
        try { await api('/api/prefs', { method: 'PUT', body }); toast('تم الحفظ'); } catch (err) { toast(err.message); }
      });
    },
  };
}

// ---------- المزامنة والتعارضات ----------
const ENTITY = { items: 'بند', engagements: 'ملف', companies: 'شركة', comments: 'تعليق', attachments: 'مرفق' };
const ACTION = { create: 'إضافة', update: 'تعديل', delete: 'حذف', upload: 'رفع' };
const FLABEL = { status: 'الحالة', progress: 'التنفيذ', assignee_id: 'المسؤول', due_date: 'الموعد', title: 'الوصف', conclusion: 'النتيجة',
  next_step: 'الخطوة التالية', priority: 'الأولوية', last_followup: 'آخر متابعة', ref: 'المرجع', wp_url: 'رابط الورقة',
  description: 'التفاصيل', client_response: 'رد العميل', stage: 'المرحلة', report_due: 'موعد التقرير', name: 'الاسم' };
const show = (v) => (v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function renderSync() {
  const pending = S.outbox.filter((o) => !o.conflict && !o.error);
  const conflicts = S.outbox.filter((o) => o.conflict);
  const errors = S.outbox.filter((o) => o.error);
  const label = (o) => {
    const row = S.data[o.entity]?.get(o.id) || S.server[o.entity]?.get(o.id);
    return `${ACTION[o.action]} ${ENTITY[o.entity] || o.entity}: ${row?.title || row?.name || o.changes?.title || o.changes?.name || o.changes?.body || ''}`;
  };
  return {
    title: 'المزامنة',
    back: true,
    html: h`
      <div class="card"><dl class="kv">
        <dt>الحالة</dt><dd>${navigator.onLine ? (S.sync.state === 'error' ? `خطأ: ${S.sync.error}` : S.sync.state === 'syncing' ? 'جارٍ…' : 'متصل') : 'دون اتصال — التعديلات تُحفظ على الجهاز'}</dd>
        <dt>آخر مزامنة</dt><dd>${fmtTime(S.meta.lastSync)}</dd>
        <dt>بانتظار الرفع</dt><dd>${pending.length}</dd></dl>
        <div class="btns" style="margin-top:12px"><button class="btn primary" data-sync>مزامنة الآن</button><button class="btn" data-full>إعادة تحميل كامل</button></div></div>
      ${conflicts.length ? h`<div class="section-title">تعارضات (${conflicts.length})</div>
        ${conflicts.map((o) => h`<div class="card conflict"><b>${label(o)}</b>
          <p class="hint">عدّل شخص آخر نفس الحقل على الخادم بعد آخر مزامنة لك. اختر النسخة الصحيحة:</p>
          <table class="log"><tr><th>الحقل</th><th>نسختك</th><th>الخادم</th></tr>${o.conflict.fields.map((f) => h`<tr><td>${FLABEL[f.field] || f.field}</td><td>${show(f.mine)}</td><td>${show(f.theirs)}</td></tr>`)}</table>
          <div class="btns" style="margin-top:10px"><button class="btn primary" data-mine="${o.opId}">اعتماد نسختي</button><button class="btn" data-theirs="${o.opId}">اعتماد نسخة الخادم</button></div></div>`)}` : ''}
      ${errors.length ? h`<div class="section-title">تعديلات رفضها الخادم (${errors.length})</div>
        ${errors.map((o) => h`<div class="card"><b>${label(o)}</b><div class="hint" style="color:var(--s-red)">${o.error}</div>
          <button class="btn sm" data-dismiss="${o.opId}" style="margin-top:8px">تجاهل التعديل</button></div>`)}` : ''}
      ${pending.length ? h`<div class="section-title">بانتظار الرفع</div><div class="list">${pending.map((o) => h`<div class="it"><div class="body"><div class="title">${label(o)}</div><div class="sub">${fmtTime(o.at)}</div></div></div>`)}</div>` : ''}`,
    mount(root) {
      root.querySelector('[data-sync]').addEventListener('click', () => syncNow());
      root.querySelector('[data-full]').addEventListener('click', () => syncNow({ full: true }));
      root.querySelectorAll('[data-mine]').forEach((b) => b.addEventListener('click', () => resolveConflict(b.dataset.mine, 'mine')));
      root.querySelectorAll('[data-theirs]').forEach((b) => b.addEventListener('click', () => resolveConflict(b.dataset.theirs, 'theirs')));
      root.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => dismissOp(b.dataset.dismiss)));
    },
  };
}

// ---------- محرر الأقسام (مشترك) ----------
export function sectionsEditor(sections) {
  return h`<div data-sections>${sections.map((s) => secRow(s))}</div>
    <button type="button" class="btn sm" data-addsec>＋ قسم</button>`;
}
const secRow = (s = { code: '', name: '' }) => h`<div class="row" data-sec style="margin-bottom:6px">
  <input class="inp" style="width:80px" data-code value="${s.code}" placeholder="كود"><input class="inp" data-name value="${s.name}" placeholder="اسم القسم">
  <button type="button" class="btn sm" data-up>↑</button><button type="button" class="btn sm" data-del>✕</button></div>`;
export function readSections(root) {
  const list = [...root.querySelectorAll('[data-sec]')].map((r) => ({ code: r.querySelector('[data-code]').value.trim(), name: r.querySelector('[data-name]').value.trim() }))
    .filter((s) => s.code || s.name);
  if (!list.length) return { error: 'أضف قسمًا واحدًا على الأقل' };
  if (list.some((s) => !s.code || !s.name)) return { error: 'كل قسم يحتاج كودًا واسمًا' };
  if (new Set(list.map((s) => s.code)).size !== list.length) return { error: 'أكواد الأقسام مكررة' };
  return { list };
}
document.addEventListener('click', (e) => {
  const box = e.target.closest('[data-sections]')?.parentElement || e.target.closest('[data-addsec]')?.parentElement;
  if (!box) return;
  if (e.target.matches('[data-addsec]')) box.querySelector('[data-sections]').insertAdjacentHTML('beforeend', secRow().s);
  const row = e.target.closest('[data-sec]');
  if (row && e.target.matches('[data-del]')) row.remove();
  if (row && e.target.matches('[data-up]') && row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling);
});

// ---------- القوالب ----------
export function renderTemplates(params) {
  if (!isMgr()) return { title: 'القوالب', back: true, html: h`<div class="empty">للمدير فقط</div>` };
  const list = [...S.data.templates.values()];
  if (params.id) return templateForm(params.id === 'new' ? null : S.data.templates.get(params.id));
  return {
    title: 'القوالب وهيكل الأقسام',
    back: true,
    html: h`<p class="hint">طابِق أكواد الأقسام وأسماءها مع قالب Caseware في مكتبك. القالب يُستخدم عند إنشاء ملف جديد؛ ويمكن تعديل أقسام كل ملف من «تعديل الملف».</p>
      <div class="list">${list.map((t) => h`<a class="it" href="#/settings/templates/${t.id}"><div class="body"><div class="title">${t.name}</div>
        <div class="sub"><span>${(t.sections || []).map((s) => s.code).join(' · ')}</span><span>${(t.tasks || []).length} مهمة</span></div></div></a>`)}</div>
      <a class="btn block" href="#/settings/templates/new">＋ قالب جديد</a>`,
  };
}

function templateForm(t) {
  const tasks = t?.tasks || [];
  const taskRow = (x = {}) => h`<div class="card" data-task style="padding:10px">
    <input class="inp" data-title value="${x.title || ''}" placeholder="الوصف" style="margin-bottom:6px">
    <div class="row"><input class="inp" data-ref value="${x.ref || ''}" placeholder="مرجع" style="width:80px">
      <input class="inp" data-sc value="${x.section_code || ''}" placeholder="قسم" style="width:70px">
      <select class="inp" data-type>${options(TYPES.map((y) => ({ value: y.key, label: y.label })), x.type || 'task')}</select>
      <select class="inp" data-pr>${options(PRIORITIES.map((y) => ({ value: y.key, label: y.label })), x.priority || 'medium')}</select>
      <button type="button" class="btn sm" data-deltask>✕</button></div></div>`;
  return {
    title: t ? t.name : 'قالب جديد',
    back: true,
    html: h`<form>
      <label class="field"><span>اسم القالب</span><input name="name" required value="${t?.name || ''}"></label>
      <div class="field"><span>الأقسام والأكواد</span>${sectionsEditor(t?.sections || [{ code: 'A', name: 'القبول والاستمرار' }])}</div>
      <div class="section-title">المهام الافتراضية (${tasks.length})</div>
      <div data-tasks>${tasks.map((x) => taskRow(x))}</div>
      <button type="button" class="btn sm" data-addtask>＋ مهمة</button>
      <div class="btns" style="margin-top:16px"><button class="btn primary">حفظ القالب</button>
        ${t ? h`<button type="button" class="btn danger" data-deltpl>حذف</button>` : ''}</div>
    </form>`,
    mount(root) {
      const form = root.querySelector('form');
      root.querySelector('[data-addtask]').addEventListener('click', () => root.querySelector('[data-tasks]').insertAdjacentHTML('beforeend', taskRow().s));
      root.addEventListener('click', (e) => { if (e.target.matches('[data-deltask]')) e.target.closest('[data-task]').remove(); });
      root.querySelector('[data-deltpl]')?.addEventListener('click', async () => {
        if (!(await confirmSheet('حذف القالب', 'لن تتأثر الملفات التي أُنشئت منه.', 'حذف', true))) return;
        try { await api(`/api/templates/${t.id}`, { method: 'DELETE' }); await syncNow(); location.hash = '#/settings/templates'; } catch (err) { toast(err.message); }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const secs = readSections(root);
        if (secs.error) return toast(secs.error);
        const taskList = [...root.querySelectorAll('[data-task]')].map((r) => ({
          title: r.querySelector('[data-title]').value.trim(), ref: r.querySelector('[data-ref]').value.trim(),
          section_code: r.querySelector('[data-sc]').value.trim(), type: r.querySelector('[data-type]').value, priority: r.querySelector('[data-pr]').value,
        })).filter((x) => x.title);
        try {
          await api('/api/templates', { method: 'POST', body: { id: t?.id, name: form.name.value, sections: secs.list, tasks: taskList } });
          await syncNow();
          toast('تم حفظ القالب');
          location.hash = '#/settings/templates';
        } catch (err) { toast(err.message); }
      });
    },
  };
}

// ---------- المستخدمون ----------
export function renderUsers() {
  if (!isAdmin()) return { title: 'المستخدمون', back: true, html: h`<div class="empty">لمدير النظام فقط</div>` };
  const users = [...S.data.users.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return {
    title: 'المستخدمون والصلاحيات',
    back: true,
    html: h`<div class="card small">
        <b>الصلاحيات:</b><br>• <b>مدير النظام</b>: كل شيء، المستخدمون، النسخ الاحتياطي.<br>
        • <b>مدير/شريك</b>: كل الملفات، إنشاء وترحيل، القوالب، الاعتماد.<br>
        • <b>مراجع أول</b>: ملفاته فقط، تعديل كل بنودها، والاعتماد (ليس لبند مسند إليه).<br>
        • <b>مساعد</b>: ملفات فريقه، تعديل بنوده فقط، دون اعتماد.</div>
      <div class="list">${users.map((u) => h`<button class="it" style="width:100%;background:none;border-inline:0;border-bottom:0;text-align:start;cursor:pointer" data-user="${u.id}">
        <div class="body"><div class="title">${u.name}${!u.active ? ' (موقوف)' : ''}</div><div class="sub"><span>${u.email}</span><span>${ROLE[u.role]?.label}</span></div></div></button>`)}</div>
      <button class="btn block" data-new>＋ مستخدم</button>`,
    mount(root) {
      root.querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', () => userSheet(S.data.users.get(b.dataset.user))));
      root.querySelector('[data-new]').addEventListener('click', () => userSheet(null));
    },
  };
}
function userSheet(u) {
  openSheet(h`<h2>${u ? 'تعديل مستخدم' : 'مستخدم جديد'}</h2><form>
    <label class="field"><span>الاسم</span><input name="name" required value="${u?.name || ''}"></label>
    <label class="field"><span>البريد</span><input name="email" type="email" required value="${u?.email || ''}" autocomplete="off"></label>
    <label class="field"><span>الدور</span><select name="role">${options(ROLES.map((r) => ({ value: r.key, label: r.label })), u?.role || 'staff')}</select></label>
    <label class="field"><span>${u ? 'كلمة مرور جديدة (اتركها فارغة)' : 'كلمة المرور'}</span><input name="password" type="password" autocomplete="new-password" ${u ? '' : raw('required minlength="8"')}></label>
    ${u ? h`<label class="check"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> نشط</label>` : ''}
    <div class="btns"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div></form>`.s, {
    onMount: (el, close) => el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/users', { method: 'POST', body: { id: u?.id, name: f.name.value, email: f.email.value, role: f.role.value, password: f.password.value || undefined, active: u ? f.active.checked : true } });
        close(); await syncNow(); toast('تم الحفظ');
      } catch (err) { toast(err.message); }
    }),
  });
}

// ---------- النسخ الاحتياطي ----------
export function renderBackup() {
  if (!isAdmin()) return { title: 'النسخ الاحتياطي', back: true, html: h`<div class="empty">لمدير النظام فقط</div>` };
  return {
    title: 'النسخ الاحتياطي',
    back: true,
    html: h`<div class="card"><p class="small" style="margin-top:0">يحفظ الخادم نسخة تلقائية من قاعدة البيانات يوميًا (آخر 14 نسخة) في مجلد البيانات. يمكنك أيضًا تنزيل نسخة كاملة (JSON) للاحتفاظ بها خارج الخادم.</p>
        <div class="btns"><button class="btn primary" data-dl>تنزيل نسخة JSON</button><button class="btn" data-now>نسخة على الخادم الآن</button></div>
        <p class="hint">ملفات المرفقات تُنسخ من مجلد data/uploads على الخادم.</p></div>
      <div class="card"><b>النسخ على الخادم</b><div data-list class="small"><div class="loading">…</div></div></div>
      <div class="card"><b>استعادة من ملف JSON</b><p class="hint">تستبدل كل البيانات الحالية (تُحفظ نسخة قبل الاستعادة تلقائيًا).</p>
        <input type="file" accept="application/json,.json" data-restore></div>`,
    async mount(root) {
      root.querySelector('[data-dl]').addEventListener('click', () => downloadUrl('/api/admin/backup'));
      const loadList = async () => {
        try {
          const l = await api('/api/admin/backups');
          root.querySelector('[data-list]').innerHTML = (l.length ? h`${l.map((b) => h`<div>${b.name} — ${(b.size / 1024).toFixed(0)}KB</div>`)}` : h`<div class="muted">لا توجد بعد</div>`).s;
        } catch (e) { root.querySelector('[data-list]').textContent = e.message; }
      };
      loadList();
      root.querySelector('[data-now]').addEventListener('click', async () => { try { await api('/api/admin/backup-now', { method: 'POST' }); toast('تم'); loadList(); } catch (e) { toast(e.message); } });
      root.querySelector('[data-restore]').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f || !(await confirmSheet('استعادة النسخة', 'سيتم استبدال كل البيانات الحالية. متابعة؟', 'استعادة', true))) return;
        try {
          const data = JSON.parse(await f.text());
          const r = await api('/api/admin/restore', { method: 'POST', body: data });
          toast(r.note);
          await idb.clearAll();
          setTimeout(() => location.reload(), 1500);
        } catch (err) { toast(err.message || 'ملف غير صالح'); }
      });
    },
  };
}

// ---------- الاستيراد ----------
export function renderImport() {
  return {
    title: 'استيراد من Excel',
    back: true,
    html: h`<div class="card small"><b>الخطوات</b><ol class="steps">
        <li>نزّل ملف التصدير واستخدمه كقالب (نفس الأعمدة).</li><li>عدّل أو أضف صفوفًا. عمود «المعرف» يحدّث البند الموجود؛ تركه فارغًا يضيف بندًا جديدًا.</li>
        <li>ارفع الملف وراجع المعاينة ثم نفّذ.</li></ol>
        <p class="hint">لا توجد مزامنة تلقائية مع Caseware؛ الاستيراد يدوي. الإقفال بالاعتماد عبر الاستيراد يخضع لنفس صلاحيات الاعتماد.</p>
        <button class="btn sm" data-tpl>تنزيل القالب/التصدير الحالي</button></div>
      <form class="card" data-up>
        <label class="field"><span>ملف Excel (xlsx)</span><input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
        ${isMgr() ? h`<label class="check"><input type="checkbox" name="createMissing"> إنشاء الشركات/الملفات غير الموجودة</label>` : ''}
        <button class="btn primary block">معاينة</button></form>
      <div data-result></div>`,
    mount(root) {
      root.querySelector('[data-tpl]').addEventListener('click', () => downloadUrl('/api/export.xlsx'));
      const out = root.querySelector('[data-result]');
      root.querySelector('[data-up]').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!navigator.onLine) return toast('الاستيراد يحتاج اتصالًا');
        const form = new FormData();
        form.append('file', e.target.file.files[0]);
        form.append('createMissing', e.target.createMissing?.checked ? '1' : '0');
        out.innerHTML = '<div class="loading">جارٍ القراءة…</div>';
        try {
          const p = await api('/api/import/preview', { method: 'POST', form });
          const A = { create: ['إضافة', 'green'], update: ['تحديث', ''], error: ['خطأ', 'red'] };
          out.innerHTML = h`<div class="card"><b>المعاينة:</b> إضافة ${p.summary.create} · تحديث ${p.summary.update} · أخطاء ${p.summary.error}
            <table class="log">${p.rows.map((r) => h`<tr><td>${r.row}</td><td>${r.title}${r.error ? h`<div class="hint" style="color:var(--s-red)">${r.error}</div>` : ''}${r.note ? h`<div class="hint">${r.note}</div>` : ''}</td><td><span class="pill ${A[r.action][1]}">${A[r.action][0]}</span></td></tr>`)}</table>
            ${p.summary.create + p.summary.update ? h`<button class="btn primary block" data-commit style="margin-top:10px">تنفيذ (${p.summary.create + p.summary.update})${p.summary.error ? ' وتجاهل الأخطاء' : ''}</button>` : ''}</div>`.s;
          out.querySelector('[data-commit]')?.addEventListener('click', async () => {
            try {
              const r = await api('/api/import/commit', { method: 'POST', body: { token: p.token } });
              out.innerHTML = h`<div class="card"><b>تم:</b> أُضيف ${r.created} · حُدّث ${r.updated}${r.failed.length ? h`<div style="color:var(--s-red)">فشل ${r.failed.length}: ${r.failed.map((x) => `${x.title} (${x.error})`).join('، ')}</div>` : ''}</div>`.s;
              await syncNow();
            } catch (err) { toast(err.message); }
          });
        } catch (err) { out.innerHTML = h`<div class="banner red">${err.message}</div>`.s; }
      });
    },
  };
}

export { esc, uuid, mutate, setMe };
