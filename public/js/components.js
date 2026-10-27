import { STATUSES, STATUS, TYPES, PRIORITIES, canApprove, canEditItem, addDays, isMember, defaultBlocks, daysBetween } from '/shared/rules.js';
import { S, mutate, eng, engName, userName, company, today, engStats, uuid } from './store.js';
import { h, raw, esc, dueText, statusChip, openSheet, toast, options, fmtDate, daysLeftText, prLabel } from './ui.js';

// صف بند في القوائم
export function itemRow(i, { showEng = true } = {}) {
  const st = STATUS[i.status] || STATUS.not_started;
  const due = dueText(i.due_date, i.status);
  const e = eng(i.engagement_id);
  return h`<div class="it ${i._pending ? 'pending' : ''}" style="--c: var(--s-${st.color})">
    <a class="body" href="#/item/${i.id}">
      <div class="title">${i.ref ? h`<span class="muted">${i.ref} · </span>` : ''}${i.title}</div>
      <div class="sub">
        ${showEng ? h`<span>${engName(e, true)}</span>` : ''}
        <span>${i.assignee_id ? userName(i.assignee_id) : 'غير مسند'}</span>
        <span class="${due.c}">${due.t}</span>
        ${i.type !== 'task' ? h`<span>${TYPES.find((t) => t.key === i.type)?.label}</span>` : ''}
        ${i.priority === 'high' ? h`<span class="late">● عالية</span>` : ''}
        ${i.blocks_report && i.status !== 'closed' ? h`<span>⛔ يمنع التقرير</span>` : ''}
        ${i._conflict ? h`<span class="late">تعارض</span>` : ''}
      </div>
    </a>
    ${statusChip(i.status, `data-qs="${esc(i.id)}"`)}
  </div>`;
}

export function itemList(items, opts) {
  if (!items.length) return h`<div class="empty">لا توجد بنود</div>`;
  return h`<div class="list">${items.map((i) => itemRow(i, opts))}</div>`;
}

// بطاقة ملف مع موانع إصدار التقرير
export function engCard(e, { blockersLimit = 3 } = {}) {
  const st = engStats(e.id);
  const left = e.report_due ? daysBetween(today(), e.report_due) : null;
  const sec = (e.sections || []).find((s) => s.code === e.stage);
  return h`<a class="card tap eng-card" href="#/eng/${e.id}" style="display:block;color:inherit">
    <div class="row"><h3 class="spacer">${engName(e)}</h3>
      ${left != null ? h`<span class="pill ${left <= 7 ? 'red' : left <= 14 ? 'amber' : ''}">التقرير ${daysLeftText(left)}</span>` : ''}</div>
    <div class="meta">${sec ? `${sec.code} ${sec.name}` : e.status === 'issued' ? 'صدر التقرير' : '—'} · المسؤول: ${userName(e.in_charge_id)}
      ${st.blockers.length ? h` · <b style="color:var(--s-red)">${st.blockers.length} مانع</b>` : ''}
      ${st.overdue ? h` · متأخر ${st.overdue}` : ''}</div>
    <div class="bars">
      <span>التنفيذ</span><div class="bar"><i style="width:${st.progress}%"></i></div><span>${st.progress}%</span>
      <span>الاعتماد</span><div class="bar approve"><i style="width:${st.approved}%"></i></div><span>${st.approved}%</span>
    </div>
    ${blockersLimit && st.blockers.length ? h`<ul class="blockers">${st.blockers
      .sort((a, b) => (a.due_date || '9') < (b.due_date || '9') ? -1 : 1).slice(0, blockersLimit)
      .map((i) => h`<li><span class="t">${i.ref ? i.ref + ' ' : ''}${i.title}</span><span class="muted">${userName(i.assignee_id)}</span>
        <span class="pill">${STATUS[i.status].label}</span></li>`)}
      ${st.blockers.length > blockersLimit ? h`<li class="muted">و${st.blockers.length - blockersLimit} أخرى…</li>` : ''}</ul>` : ''}
    <div class="hint">آخر تحديث: ${st.lastUpdate ? fmtDate(st.lastUpdate) : '—'}</div>
  </a>`;
}

// تحديث سريع للحالة + تأجيل
export function quickStatus(itemId) {
  const i = S.data.items.get(itemId);
  if (!i) return;
  const e = eng(i.engagement_id);
  if (!canEditItem(S.me, i, e)) { toast('لا تملك صلاحية تعديل هذا البند'); return; }
  const approver = canApprove(S.me, i, e);
  const t = today();
  openSheet(h`<h2>${i.title}</h2>
    <div class="status-grid">${STATUSES.map((s) => {
      const dis = (s.key === 'closed' && i.status !== 'closed' && !approver) || (i.status === 'closed' && s.key !== 'closed' && !approver);
      return h`<button class="st c-${s.color} ${i.status === s.key ? 'on' : ''}" data-s="${s.key}" ${dis ? raw('disabled') : ''}>${s.label}</button>`;
    })}</div>
    ${!approver ? h`<p class="hint">الإقفال يتم باعتماد مراجع مخوّل${i.assignee_id === S.me.id && S.me.role !== 'staff' ? ' (لا تعتمد بندًا مسندًا إليك)' : ''}.</p>` : ''}
    ${i.status === 'waiting_client' ? h`<button class="btn block" data-follow style="margin-top:10px">✓ تمت المتابعة مع العميل اليوم</button>` : ''}
    <div class="section-title">تأجيل التذكير</div>
    <div class="seg">
      <button data-snooze="1">غدًا</button><button data-snooze="3">بعد 3 أيام</button><button data-snooze="7">أسبوع</button>
    </div>
    <div class="section-title">تغيير الموعد</div>
    <div class="seg">
      <button data-due="0">اليوم</button><button data-due="1">غدًا</button><button data-due="3">+3</button><button data-due="7">+7</button>
    </div>
    <div class="btns" style="margin-top:14px"><a class="btn" href="#/item/${i.id}" data-close>فتح التفاصيل</a><button class="btn" data-close>إغلاق</button></div>`.s, {
    onMount: (el, close) => {
      const run = async (ch, msg) => {
        try { await mutate('items', 'update', i.id, ch); toast(msg); close(); } catch (err) { toast(err.message); }
      };
      el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => run({ status: b.dataset.s }, `الحالة: ${STATUS[b.dataset.s].label}`)));
      el.querySelector('[data-follow]')?.addEventListener('click', () => run({ last_followup: t }, 'تم تسجيل المتابعة'));
      el.querySelectorAll('[data-snooze]').forEach((b) => b.addEventListener('click', () => run({ snooze_until: addDays(t, +b.dataset.snooze) }, `لا تذكير حتى ${fmtDate(addDays(t, +b.dataset.snooze))}`)));
      el.querySelectorAll('[data-due]').forEach((b) => b.addEventListener('click', () => run({ due_date: addDays(t, +b.dataset.due) }, `الموعد: ${fmtDate(addDays(t, +b.dataset.due))}`)));
    },
  });
}

// إضافة سريعة لبند
let lastEng = null;
export function addItemSheet(defaultEngId) {
  const engs = [...S.data.engagements.values()].filter((e) => isMember(S.me, e) && e.status === 'active')
    .sort((a, b) => engName(a).localeCompare(engName(b), 'ar'));
  if (!engs.length) { toast('لا توجد ملفات نشطة — أنشئ ملفًا من «الشركات»'); return; }
  let engId = [defaultEngId, lastEng].find((id) => id && engs.some((e) => e.id === id)) || engs[0].id;
  let type = 'task';
  let priority = 'medium';
  let due = '';
  const users = [...S.data.users.values()].filter((u) => u.active);
  const sectionsOpts = (id) => options((eng(id)?.sections || []).map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` })), eng(id)?.stage);
  const close = openSheet(h`<h2>إضافة بند</h2>
    <form id="addForm" autocomplete="off">
      <label class="field"><span>الملف</span><select name="engagement_id">${options(engs.map((e) => ({ value: e.id, label: engName(e) })), engId)}</select></label>
      <div class="field"><span>النوع</span><div class="seg" data-g="type">${TYPES.map((t) => h`<button type="button" data-v="${t.key}" class="${t.key === type ? 'on' : ''}">${t.label}</button>`)}</div></div>
      <label class="field"><span>الوصف</span><input name="title" required enterkeyhint="done" placeholder="مثال: مصادقة رصيد البنك الأهلي"></label>
      <div class="grid2">
        <label class="field"><span>البند/القسم</span><select name="section_code">${sectionsOpts(engId)}</select></label>
        <label class="field"><span>المسؤول</span><select name="assignee_id">${options(users.map((u) => ({ value: u.id, label: u.name })), S.me.id, { empty: 'غير مسند' })}</select></label>
      </div>
      <div class="field"><span>الموعد</span><div class="seg" data-g="due">
        <button type="button" data-v="" class="on">بدون</button><button type="button" data-v="0">اليوم</button><button type="button" data-v="1">غدًا</button>
        <button type="button" data-v="3">+3</button><button type="button" data-v="7">+7</button></div>
        <input type="date" name="due_custom" class="inp" style="margin-top:6px"></div>
      <div class="field"><span>الأولوية</span><div class="seg" data-g="priority">${PRIORITIES.map((p) => h`<button type="button" data-v="${p.key}" class="${p.key === priority ? 'on' : ''}">${p.label}</button>`)}</div></div>
      <details><summary class="muted" style="padding:8px 0">المزيد (مرجع ورقة العمل، الرابط، تفاصيل)</summary>
        <div class="grid2"><label class="field"><span>مرجع ورقة العمل</span><input name="ref" placeholder="D1.2"></label>
        <label class="field"><span>رابط ورقة العمل</span><input name="wp_url" type="url" inputmode="url" placeholder="https://"></label></div>
        <label class="field"><span>تفاصيل</span><textarea name="description"></textarea></label>
        <label class="field"><span>الخطوة التالية</span><input name="next_step"></label>
      </details>
      <div class="btns" style="margin-top:12px"><button class="btn primary" type="submit">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`.s, {
    onMount: (el, close) => {
      const form = el.querySelector('form');
      el.querySelectorAll('[data-g]').forEach((g) => g.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-v]');
        if (!b) return;
        g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        if (g.dataset.g === 'type') type = b.dataset.v;
        if (g.dataset.g === 'priority') priority = b.dataset.v;
        if (g.dataset.g === 'due') { due = b.dataset.v === '' ? '' : addDays(today(), +b.dataset.v); form.due_custom.value = due; }
      }));
      form.due_custom.addEventListener('change', () => { due = form.due_custom.value; el.querySelectorAll('[data-g=due] button').forEach((x) => x.classList.remove('on')); });
      form.engagement_id.addEventListener('change', () => { engId = form.engagement_id.value; form.section_code.innerHTML = sectionsOpts(engId).s; });
      setTimeout(() => form.title.focus(), 250);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const title = form.title.value.trim();
        if (!title) { form.title.focus(); return; }
        if (form.wp_url.value && !/^https?:\/\//i.test(form.wp_url.value)) { toast('الرابط يجب أن يبدأ بـ https'); return; }
        const e = eng(engId);
        const id = uuid();
        lastEng = engId;
        await mutate('items', 'create', id, {
          engagement_id: engId, title, type, priority, section_code: form.section_code.value || null,
          assignee_id: form.assignee_id.value || null, due_date: due || null, ref: form.ref.value.trim() || null,
          wp_url: form.wp_url.value.trim() || null, description: form.description.value.trim() || null,
          next_step: form.next_step.value.trim() || null, status: type === 'doc_request' ? 'waiting_client' : 'not_started',
          blocks_report: defaultBlocks(type, form.section_code.value, e.sections), depends_on: [],
        });
        close();
        toast('تمت الإضافة', { label: 'فتح', href: `#/item/${id}` });
      });
    },
  });
  return close;
}

export function syncText() {
  const pending = S.outbox.filter((o) => !o.error && !o.conflict).length;
  const conflicts = S.outbox.filter((o) => o.conflict).length;
  const errors = S.outbox.filter((o) => o.error).length;
  if (conflicts) return { cls: 'conflict', t: `تعارض ${conflicts}` };
  if (errors) return { cls: 'error', t: `مرفوض ${errors}` };
  if (S.sync.state === 'syncing') return { cls: 'syncing', t: 'مزامنة…' };
  if (S.sync.state === 'offline' || !navigator.onLine) return { cls: 'offline', t: pending ? `دون اتصال · ${pending}` : 'دون اتصال' };
  if (pending) return { cls: 'pending', t: `${pending} بانتظار الرفع` };
  if (S.sync.state === 'error') return { cls: 'error', t: 'خطأ مزامنة' };
  const ts = S.meta.lastSync ? new Date(S.meta.lastSync) : null;
  return { cls: '', t: ts ? `محدّث ${ts.toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' })}` : 'لم تتم المزامنة' };
}

export { prLabel, company };
