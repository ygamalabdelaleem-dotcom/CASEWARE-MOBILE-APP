import { S, mutate, eng, engName, engStats, itemsOf, userName, company, today, scoreOf } from '../store.js';
import { h, raw, openSheet, toast, fmtDate, daysLeftText, options, confirmSheet, downloadUrl, esc, fmtTime } from '../ui.js';
import { itemList } from '../components.js';
import { canEditEngagement, canCreateEngagement, daysBetween, ENG_STATUSES, ROLE, isMember } from '/shared/rules.js';
import { api } from '../api.js';
import { syncNow } from '../sync.js';
import { sectionsEditor, readSections } from './settings.js';

export function render(params, q) {
  const e = eng(params.id);
  if (!e) return { title: 'الملف', back: true, html: h`<div class="empty">الملف غير موجود أو لا تملك صلاحية</div>` };
  const st = engStats(e.id);
  const items = itemsOf(e.id);
  const left = e.report_due ? daysBetween(today(), e.report_due) : null;
  const sec = q.sec || 'all';
  let shown = items;
  if (sec === 'blockers') shown = st.blockers;
  else if (sec === 'open') shown = items.filter((i) => i.status !== 'closed');
  else if (sec !== 'all') shown = items.filter((i) => i.section_code === sec);
  const sections = e.sections || [];
  const secStats = (code) => {
    const list = items.filter((i) => i.section_code === code);
    if (!list.length) return '';
    const done = list.filter((i) => i.status === 'closed').length;
    return `${done}/${list.length}`;
  };
  const groups = sec === 'all' || sec === 'open'
    ? [...sections.map((s) => ({ s, list: shown.filter((i) => i.section_code === s.code) })),
      { s: { code: '', name: 'دون قسم' }, list: shown.filter((i) => !sections.some((s) => s.code === i.section_code)) }]
      .filter((g) => g.list.length)
    : [{ s: null, list: [...shown].sort((a, b) => scoreOf(b) - scoreOf(a)) }];
  const sortItems = (l) => [...l].sort((a, b) => (a.ref || '').localeCompare(b.ref || '', 'ar', { numeric: true }));
  const editable = canEditEngagement(S.me, e);
  const stageSec = sections.find((s) => s.code === e.stage);
  return {
    title: engName(e),
    back: true,
    fabEng: e.id,
    html: h`
      <div class="card">
        <div class="row"><b class="spacer" style="font-size:17px">${engName(e)}</b>
          ${left != null ? h`<span class="pill ${left <= 7 ? 'red' : left <= 14 ? 'amber' : ''}">التقرير ${daysLeftText(left)}</span>` : ''}</div>
        <dl class="kv" style="margin-top:10px">
          <dt>المرحلة</dt><dd>${editable ? h`<select class="inp" data-stage style="min-height:36px;padding:4px 8px">${options([...sections.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` })), { value: 'issued', label: 'صدر التقرير' }], e.status === 'issued' ? 'issued' : e.stage)}</select>`
            : (stageSec ? `${stageSec.code} — ${stageSec.name}` : e.status === 'issued' ? 'صدر التقرير' : '—')}</dd>
          <dt>المسؤول</dt><dd>${userName(e.in_charge_id)}</dd>
          <dt>المدير</dt><dd>${userName(e.manager_id)}</dd>
          <dt>الفريق</dt><dd>${(e.team || []).map(userName).join('، ') || '—'}</dd>
          <dt>موعد التقرير</dt><dd>${e.report_due ? fmtDate(e.report_due) : '—'}</dd>
          <dt>آخر تحديث</dt><dd>${fmtTime(st.lastUpdate)}</dd>
        </dl>
        <div class="btns" style="margin-top:12px">
          ${e.caseware_url ? h`<a class="btn primary" href="${e.caseware_url}" target="_blank" rel="noopener">فتح في Caseware ↗</a>` : h`<span class="muted small">لا يوجد رابط Caseware${editable ? ' — أضفه من «تعديل»' : ''}</span>`}
        </div>
      </div>
      <div class="tiles">
        <div class="tile"><b>${st.progress}%</b><span>نسبة التنفيذ</span></div>
        <div class="tile"><b style="color:var(--s-green)">${st.approved}%</b><span>نسبة الاعتماد</span></div>
        <a class="tile ${st.blockers.length ? 'red' : ''}" href="#/eng/${e.id}?sec=blockers"><b>${st.blockers.length}</b><span>موانع التقرير</span></a>
        <a class="tile ${st.overdue ? 'red' : ''}" href="#/tasks?eng=${e.id}&late=1&mine=0"><b>${st.overdue}</b><span>متأخر</span></a>
        <a class="tile ${st.waiting ? 'amber' : ''}" href="#/tasks?eng=${e.id}&st=waiting_client&mine=0"><b>${st.waiting}</b><span>بانتظار العميل</span></a>
        <a class="tile ${st.review ? 'violet' : ''}" href="#/tasks?eng=${e.id}&st=ready_review&mine=0"><b>${st.review}</b><span>جاهز للمراجعة</span></a>
      </div>
      <div class="chips" style="margin-top:12px">
        <a class="chip" href="#/eng/${e.id}/missing">✉︎ رسالة النواقص</a>
        ${editable ? h`<a class="chip" href="#/eng/${e.id}/edit">تعديل الملف</a>` : ''}
        <button class="chip" data-export>تصدير Excel</button>
        <a class="chip" href="#/eng/${e.id}/history">سجل التعديلات</a>
        ${canCreateEngagement(S.me) ? h`<button class="chip" data-rollover>ترحيل لسنة جديدة</button><button class="chip" data-tpl>حفظ كقالب</button>` : ''}
      </div>
      <div class="section-title">البنود</div>
      <div class="chips">
        <a class="chip ${sec === 'all' ? 'on' : ''}" href="#/eng/${e.id}">الكل<span class="n">${items.length}</span></a>
        <a class="chip ${sec === 'open' ? 'on' : ''}" href="#/eng/${e.id}?sec=open">المفتوح</a>
        <a class="chip ${sec === 'blockers' ? 'on' : ''}" href="#/eng/${e.id}?sec=blockers">⛔ الموانع<span class="n">${st.blockers.length}</span></a>
        ${sections.map((s) => h`<a class="chip ${sec === s.code ? 'on' : ''}" href="#/eng/${e.id}?sec=${encodeURIComponent(s.code)}">${s.code} ${s.name}<span class="n">${secStats(s.code)}</span></a>`)}
      </div>
      ${groups.length ? groups.map((g) => h`${g.s ? h`<div class="section-title"><span>${g.s.code} ${g.s.name}</span><span class="small">${secStats(g.s.code)}</span></div>` : ''}
        ${itemList(g.s ? sortItems(g.list) : g.list, { showEng: false })}`) : h`<div class="empty">لا توجد بنود</div>`}`,
    mount(root) {
      root.querySelector('[data-stage]')?.addEventListener('change', async (ev) => {
        const v = ev.target.value;
        try {
          await mutate('engagements', 'update', e.id, v === 'issued' ? { status: 'issued' } : { stage: v, status: 'active' });
          toast('تم تحديث المرحلة');
        } catch (err) { toast(err.message); }
      });
      root.querySelector('[data-export]').addEventListener('click', () => {
        if (!navigator.onLine) return toast('التصدير يحتاج اتصالًا');
        downloadUrl(`/api/export.xlsx?engagement=${e.id}`);
      });
      root.querySelector('[data-rollover]')?.addEventListener('click', () => rolloverSheet(e));
      root.querySelector('[data-tpl]')?.addEventListener('click', () => saveTemplateSheet(e));
    },
  };
}

function rolloverSheet(e) {
  openSheet(h`<h2>ترحيل ${engName(e)} لسنة جديدة</h2>
    <p class="muted small">يُنسخ الهيكل والفريق والمهام وطلبات المستندات والمراجع. يتم <b>مسح</b>: الحالات، نسب التنفيذ، الاعتمادات، المواعيد، النتائج، ردود العميل، روابط أوراق العمل، المرفقات والتعليقات، ورابط Caseware.</p>
    <form>
      <div class="grid2"><label class="field"><span>السنة</span><input name="year" type="number" inputmode="numeric" value="${e.year + 1}"></label>
      <label class="field"><span>موعد التقرير</span><input name="report_due" type="date"></label></div>
      <label class="check"><input type="checkbox" name="includeNotes"> نسخ الملاحظات والفروق أيضًا</label>
      <div class="btns"><button class="btn primary">ترحيل</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`.s, {
    onMount: (el, close) => el.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const r = await api(`/api/engagements/${e.id}/rollover`, { method: 'POST', body: { year: +f.year.value, report_due: f.report_due.value || null, includeNotes: f.includeNotes.checked } });
        close();
        await syncNow();
        toast('تم إنشاء الملف الجديد');
        location.hash = `#/eng/${r.id}`;
      } catch (err) { toast(err.message); }
    }),
  });
}

function saveTemplateSheet(e) {
  openSheet(h`<h2>حفظ الملف كقالب</h2><p class="muted small">يُحفظ الهيكل والمهام وطلبات المستندات فقط، دون نتائج أو تواريخ.</p>
    <form><label class="field"><span>اسم القالب</span><input name="name" required value="قالب ${company(e.company_id)?.name || ''}"></label>
    <div class="btns"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div></form>`.s, {
    onMount: (el, close) => el.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api(`/api/engagements/${e.id}/save-template`, { method: 'POST', body: { name: ev.target.name.value } });
        close(); await syncNow(); toast('تم حفظ القالب');
      } catch (err) { toast(err.message); }
    }),
  });
}

// ---------- إنشاء / تعديل ملف ----------
export function renderForm(params, q) {
  const isNew = !params.id;
  const e = isNew ? null : eng(params.id);
  if (!isNew && (!e || !canEditEngagement(S.me, e))) return { title: 'تعديل الملف', back: true, html: h`<div class="empty">لا تملك صلاحية</div>` };
  if (isNew && !canCreateEngagement(S.me)) return { title: 'ملف جديد', back: true, html: h`<div class="empty">إنشاء الملفات للمدير فقط</div>` };
  const users = [...S.data.users.values()].filter((u) => u.active);
  const companies = [...S.data.companies.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const templates = [...S.data.templates.values()];
  const team = new Set(e?.team || []);
  const uopts = (sel) => options(users.map((u) => ({ value: u.id, label: `${u.name} — ${ROLE[u.role]?.label || ''}` })), sel, { empty: '—' });
  const isMgr = ['admin', 'manager'].includes(S.me.role);
  return {
    title: isNew ? 'ملف مراجعة جديد' : `تعديل ${engName(e)}`,
    back: true,
    html: h`<form id="engForm">
      ${isNew ? h`
        <label class="field"><span>الشركة</span><select name="company_id" required>${options(companies.map((c) => ({ value: c.id, label: c.name })), q.company, { empty: 'اختر…' })}</select></label>
        <div class="grid2"><label class="field"><span>السنة المالية</span><input name="year" type="number" inputmode="numeric" required value="${new Date().getFullYear()}"></label>
        <label class="field"><span>القالب</span><select name="templateId">${options(templates.map((t) => ({ value: t.id, label: t.name })), templates[0]?.id)}</select></label></div>`
        : h`<div class="card"><b>${engName(e)}</b></div>`}
      <div class="grid2">
        <label class="field"><span>المسؤول (مراجع أول)</span><select name="in_charge_id" ${!isMgr ? raw('disabled') : ''}>${uopts(e?.in_charge_id)}</select></label>
        <label class="field"><span>المدير</span><select name="manager_id" ${!isMgr ? raw('disabled') : ''}>${uopts(e?.manager_id)}</select></label>
      </div>
      <div class="field"><span>الفريق</span><div class="chips" style="flex-wrap:wrap">${users.map((u) => h`<button type="button" class="chip ${team.has(u.id) ? 'on' : ''}" data-team="${u.id}">${u.name}</button>`)}</div></div>
      <label class="field"><span>موعد التقرير</span><input name="report_due" type="date" value="${e?.report_due || ''}"></label>
      <label class="field"><span>رابط الملف في Caseware</span><input name="caseware_url" type="url" inputmode="url" placeholder="https://…" value="${e?.caseware_url || ''}"></label>
      ${!isNew ? h`
        <label class="field"><span>حالة الملف</span><select name="status">${options(ENG_STATUSES.map((s) => ({ value: s.key, label: s.label })), e.status)}</select></label>
        <div class="field"><span>هيكل الأقسام وأكوادها (طابِق قالب Caseware)</span>${sectionsEditor(e.sections || [])}</div>
        ${isMgr ? h`<div class="card"><b>تصعيد المتأخرات (اختياري)</b>
          <p class="hint">لا يحدث تصعيد تلقائي إلا بموافقتك هنا. عند التفعيل يصل لمدير الملف تنبيه بالبنود المتأخرة أكثر من المدة المحددة. لا تُرسل أي رسالة للعميل.</p>
          <label class="check"><input type="checkbox" name="escalation_enabled" ${e.escalation_enabled ? raw('checked') : ''}> أوافق على تفعيل تنبيه التصعيد لهذا الملف</label>
          <label class="field"><span>بعد تأخير (أيام)</span><input name="escalation_days" type="number" min="1" max="60" value="${e.escalation_days || 7}"></label></div>` : ''}
        <label class="field"><span>ملاحظات</span><textarea name="notes">${e.notes || ''}</textarea></label>` : ''}
      <div class="btns"><button class="btn primary">${isNew ? 'إنشاء الملف' : 'حفظ'}</button><a class="btn" href="${isNew ? '#/companies' : `#/eng/${e.id}`}">إلغاء</a></div>
      ${isNew ? h`<p class="hint">إنشاء الملف من قالب يحتاج اتصالًا بالخادم.</p>` : ''}
    </form>`,
    mount(root) {
      const form = root.querySelector('form');
      root.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.team;
        if (team.has(id)) team.delete(id); else team.add(id);
        b.classList.toggle('on', team.has(id));
      }));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const url = form.caseware_url.value.trim();
        if (url && !/^https?:\/\//i.test(url)) return toast('رابط Caseware يجب أن يبدأ بـ https');
        const data = {
          report_due: form.report_due.value || null, caseware_url: url || null, team: [...team],
        };
        if (isMgr) { data.in_charge_id = form.in_charge_id.value || null; data.manager_id = form.manager_id.value || null; }
        try {
          if (isNew) {
            const r = await api('/api/engagements/from-template', { method: 'POST', body: {
              ...data, company_id: form.company_id.value, year: +form.year.value, templateId: form.templateId.value } });
            await syncNow();
            toast('تم إنشاء الملف');
            location.hash = `#/eng/${r.id}`;
          } else {
            const sections = readSections(root);
            if (sections.error) return toast(sections.error);
            Object.assign(data, { status: form.status.value, notes: form.notes.value.trim() || null, sections: sections.list });
            if (isMgr) { data.escalation_enabled = form.escalation_enabled.checked ? 1 : 0; data.escalation_days = +form.escalation_days.value || 7; }
            const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(e[k] ?? null)));
            if (Object.keys(changed).length) await mutate('engagements', 'update', e.id, changed);
            toast('تم الحفظ');
            location.hash = `#/eng/${e.id}`;
          }
        } catch (err) { toast(err.message); }
      });
    },
  };
}

// ---------- سجل التعديلات ----------
export function renderHistory(params) {
  const e = eng(params.id);
  return {
    title: 'سجل التعديلات',
    back: true,
    html: h`<div class="card"><b>${engName(e)}</b></div><div id="hist" class="card"><div class="loading">جارٍ التحميل…</div></div>`,
    async mount(root) {
      const box = root.querySelector('#hist');
      try {
        const rows = await api(`/api/history?entity=engagements&id=${params.id}`);
        box.innerHTML = historyHtml(rows).s;
      } catch (err) { box.innerHTML = h`<div class="empty">${err.status === 0 ? 'السجل يحتاج اتصالًا' : err.message}</div>`.s; }
    },
  };
}

const FIELD_LABEL = {
  status: 'الحالة', progress: 'التنفيذ', assignee_id: 'المسؤول', due_date: 'الموعد', title: 'الوصف', conclusion: 'النتيجة',
  ref: 'المرجع', wp_url: 'رابط الورقة', client_response: 'رد العميل', received_at: 'الاستلام', approved_by: 'اعتمده',
  approved_at: 'تاريخ الاعتماد', priority: 'الأولوية', next_step: 'الخطوة التالية', last_followup: 'آخر متابعة',
  snooze_until: 'تأجيل التذكير', section_code: 'القسم', stage: 'المرحلة', report_due: 'موعد التقرير', team: 'الفريق',
  caseware_url: 'رابط Caseware', blocks_report: 'يمنع التقرير', description: 'التفاصيل', name: 'الاسم', body: 'تعليق',
  in_charge_id: 'المسؤول', manager_id: 'المدير', escalation_enabled: 'التصعيد', depends_on: 'يعتمد على', type: 'النوع',
  status_changed_at: null, sections: 'الأقسام', notes: 'ملاحظات', year: 'السنة', company_id: null,
};
const ACTION_LABEL = { create: 'إنشاء', update: 'تعديل', delete: 'حذف', approved: 'اعتماد وإقفال', unlocked: 'فتح بعد الاعتماد',
  reopened: 'إعادة فتح تلقائي (تغيّرت النتيجة/الأدلة بعد الاعتماد)', client_replied: 'رد العميل/استلام مستند', evidence: 'تعديل الأدلة',
  import: 'استيراد Excel', rollover: 'ترحيل' };
function fmtVal(f, v) {
  if (v == null || v === '') return '—';
  if (['assignee_id', 'approved_by', 'in_charge_id', 'manager_id'].includes(f)) return userName(v);
  if (f === 'status') return { not_started: 'لم يبدأ', in_progress: 'جارٍ', waiting_client: 'بانتظار العميل', ready_review: 'جاهز للمراجعة', rework: 'مطلوب تعديل', closed: 'مقفل باعتماد' }[v] || v;
  if (Array.isArray(v)) return f === 'team' ? v.map(userName).join('، ') : `${v.length}`;
  if (typeof v === 'object') return '…';
  return String(v).length > 80 ? String(v).slice(0, 80) + '…' : String(v);
}
export function historyHtml(rows) {
  if (!rows.length) return h`<div class="empty">لا يوجد سجل</div>`;
  return h`<ul class="history">${rows.map((r) => {
    const acts = (r.action || '').split(',').map((a) => ACTION_LABEL[a] || a).join('، ');
    const d = r.diff && typeof r.diff === 'object' ? Object.entries(r.diff).filter(([f]) => FIELD_LABEL[f] !== null) : [];
    return h`<li><b>${userName(r.user_id)}</b> · ${acts} <span class="muted">${fmtTime(r.at)}</span>
      ${r.entity !== 'items' && r.entity !== 'engagements' ? h` <span class="pill">${r.entity === 'comments' ? 'تعليق' : r.entity === 'attachments' ? 'مرفق' : r.entity}</span>` : ''}
      ${d.length ? h`<div class="muted">${d.map(([f, v]) => h`<div>${FIELD_LABEL[f] || f}: ${fmtVal(f, Array.isArray(v) ? v[0] : null)} ← ${fmtVal(f, Array.isArray(v) ? v[1] : v)}</div>`)}</div>` : ''}</li>`;
  })}</ul>`;
}

export { esc, isMember };
