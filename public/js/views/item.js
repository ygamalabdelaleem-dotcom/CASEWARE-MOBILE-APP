import { S, mutate, eng, engName, userName, today, addAttachment, uuid, dependentsOf, itemsOf } from '../store.js';
import { h, raw, toast, fmtDate, fmtTime, options, confirmSheet, statusLabel, openSheet } from '../ui.js';
import { STATUSES, STATUS, TYPES, PRIORITIES, canApprove, canEditItem, canDeleteItem, addDays, daysBetween } from '/shared/rules.js';
import { api } from '../api.js';
import { historyHtml } from './engagement.js';
import { markRead } from '../sync.js';

export function render(params, q) {
  const i = S.data.items.get(params.id);
  if (q.nid) markRead([q.nid]);
  if (!i) return { title: 'البند', back: true, html: h`<div class="empty">البند غير موجود أو لا تملك صلاحية (قد يحتاج مزامنة)</div>` };
  const e = eng(i.engagement_id);
  const editable = canEditItem(S.me, i, e);
  const approver = canApprove(S.me, i, e);
  const t = today();
  const sec = (e?.sections || []).find((s) => s.code === i.section_code);
  const users = [...S.data.users.values()].filter((u) => u.active || u.id === i.assignee_id);
  const comments = [...S.data.comments.values()].filter((c) => c.item_id === i.id).sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
  const atts = [...S.data.attachments.values()].filter((a) => a.item_id === i.id);
  const deps = (i.depends_on || []).map((id) => S.data.items.get(id)).filter(Boolean);
  const blockedBy = deps.filter((d) => d.status !== 'closed');
  const nDependents = dependentsOf(i.id);
  const conflict = S.outbox.find((o) => o.entity === 'items' && o.id === i.id && o.conflict);
  const rejected = S.outbox.find((o) => o.entity === 'items' && o.id === i.id && o.error);
  const dis = editable ? '' : raw('disabled');
  const overdueDays = i.due_date && i.status !== 'closed' ? daysBetween(i.due_date, t) : 0;

  return {
    title: i.ref ? `${i.ref} — ${i.title}` : i.title,
    back: true,
    fabEng: i.engagement_id,
    html: h`
      ${conflict ? h`<a class="banner red" href="#/sync" style="display:block">تعارض مع تعديل آخر على الخادم — اضغط لحله</a>` : ''}
      ${rejected ? h`<a class="banner red" href="#/sync" style="display:block">رُفض تعديل: ${rejected.error}</a>` : ''}
      ${i._pending ? h`<div class="banner">تعديلات محفوظة على الجهاز بانتظار المزامنة</div>` : ''}
      <div class="card">
        <div class="muted small"><a href="#/eng/${e?.id}">${engName(e)}</a> · ${sec ? `${sec.code} ${sec.name}` : 'دون قسم'} · ${TYPES.find((x) => x.key === i.type)?.label}</div>
        <div style="font-size:18px;font-weight:700;margin:6px 0">${i.title}</div>
        ${i.next_step ? h`<div class="small"><span class="muted">الخطوة التالية:</span> ${i.next_step}</div>` : ''}
        <div class="row wrap small" style="margin-top:6px">
          ${overdueDays > 0 ? h`<span class="pill red">متأخر ${overdueDays} يوم</span>` : ''}
          ${i.blocks_report && i.status !== 'closed' ? h`<span class="pill red">⛔ يمنع إصدار التقرير</span>` : ''}
          ${blockedBy.length ? h`<span class="pill amber">معطّل بانتظار ${blockedBy.length} بند</span>` : ''}
          ${nDependents ? h`<span class="pill">يعتمد عليه ${nDependents} بند</span>` : ''}
          ${i.snooze_until && i.snooze_until > t ? h`<span class="pill">التذكير مؤجل حتى ${fmtDate(i.snooze_until)}</span>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0"><span>الحالة</span></div>
        <div class="status-grid">${STATUSES.map((s) => {
          const off = !editable || (s.key === 'closed' && i.status !== 'closed' && !approver) || (i.status === 'closed' && s.key !== 'closed' && !approver);
          return h`<button class="st c-${s.color} ${i.status === s.key ? 'on' : ''}" data-status="${s.key}" ${off ? raw('disabled') : ''}>${s.label}</button>`;
        })}</div>
        <div class="field" style="margin-top:14px"><span>نسبة التنفيذ: <b data-pv>${i.progress || 0}%</b> <span class="hint">(منفصلة عن الاعتماد)</span></span>
          <input type="range" min="0" max="100" step="10" value="${i.progress || 0}" data-progress ${dis}></div>
        ${i.status === 'closed'
          ? h`<div class="approval ok">✓ <div class="spacer">مقفل باعتماد <b>${userName(i.approved_by)}</b><div class="hint">${fmtTime(i.approved_at)} — أي تغيير في النتيجة أو الأدلة يعيد فتحه تلقائيًا</div></div></div>`
          : approver ? h`<button class="btn block primary" data-approve style="margin-top:10px" ${i.status !== 'ready_review' ? raw('data-warn') : ''}>اعتماد وإقفال</button>`
          : h`<div class="approval">الإقفال باعتماد مراجع مخوّل${i.assignee_id === S.me.id && S.me.role !== 'staff' ? '؛ لا يمكنك اعتماد بند مسند إليك' : ''}.</div>`}
        ${i.status === 'waiting_client' && editable ? h`<button class="btn block" data-follow style="margin-top:8px">✓ تمت المتابعة مع العميل اليوم</button>` : ''}
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0"><span>تأجيل</span></div>
        <div class="seg"><button data-snooze="1" ${dis}>ذكّرني غدًا</button><button data-snooze="3" ${dis}>بعد 3 أيام</button><button data-snooze="7" ${dis}>أسبوع</button></div>
        <div class="seg" style="margin-top:6px"><button data-due="1" ${dis}>الموعد +1</button><button data-due="3" ${dis}>+3</button><button data-due="7" ${dis}>+7</button></div>
      </div>

      <form class="card" id="itemForm" autocomplete="off">
        <div class="grid2">
          <label class="field"><span>المسؤول</span><select name="assignee_id" ${dis}>${options(users.map((u) => ({ value: u.id, label: u.name })), i.assignee_id, { empty: 'غير مسند' })}</select></label>
          <label class="field"><span>الموعد</span><input type="date" name="due_date" value="${i.due_date || ''}" ${dis}></label>
          <label class="field"><span>الأولوية</span><select name="priority" ${dis}>${options(PRIORITIES.map((p) => ({ value: p.key, label: p.label })), i.priority)}</select></label>
          <label class="field"><span>آخر متابعة</span><input type="date" name="last_followup" value="${i.last_followup || ''}" ${dis}></label>
        </div>
        <label class="field"><span>الخطوة التالية</span><input name="next_step" value="${i.next_step || ''}" ${dis} enterkeyhint="done"></label>
        ${i.type === 'doc_request' ? h`
          <div class="field"><span>استلام المستند</span>
            ${i.received_at ? h`<div class="row"><span class="pill green">استُلم ${fmtDate(i.received_at)}</span><button type="button" class="btn sm" data-unreceive ${dis}>إلغاء</button></div>`
              : h`<button type="button" class="btn block" data-receive ${dis}>تم استلام المستند</button>`}
            <div class="hint">وصول المستند لا يُكمل الإجراء؛ يظل البند مفتوحًا حتى فحصه واعتماده.</div></div>` : ''}
        ${i.type === 'note' || i.type === 'difference' ? h`
          <label class="field"><span>رد العميل / الإدارة</span><textarea name="client_response" ${dis}>${i.client_response || ''}</textarea>
          <div class="hint">الرد لا يُغلق الملاحظة؛ الإقفال باعتماد المراجع.</div></label>` : ''}
        <label class="field"><span>النتيجة / الاستنتاج</span><textarea name="conclusion" ${dis}>${i.conclusion || ''}</textarea></label>
        <div class="grid2">
          <label class="field"><span>مرجع ورقة العمل</span><input name="ref" value="${i.ref || ''}" ${dis}></label>
          <label class="field"><span>رابط ورقة العمل</span><input name="wp_url" type="url" inputmode="url" value="${i.wp_url || ''}" ${dis} placeholder="https://"></label>
        </div>
        ${i.wp_url ? h`<a class="btn sm" href="${i.wp_url}" target="_blank" rel="noopener" style="margin-bottom:12px">فتح ورقة العمل ↗</a>` : ''}
        ${e?.caseware_url ? h`<a class="btn sm" href="${e.caseware_url}" target="_blank" rel="noopener" style="margin:0 6px 12px">Caseware ↗</a>` : ''}
        <details><summary class="muted" style="padding:8px 0">تفاصيل أخرى</summary>
          <label class="field"><span>الوصف المختصر</span><input name="title" value="${i.title}" ${dis}></label>
          <label class="field"><span>تفاصيل</span><textarea name="description" ${dis}>${i.description || ''}</textarea></label>
          <div class="grid2">
            <label class="field"><span>النوع</span><select name="type" ${dis}>${options(TYPES.map((x) => ({ value: x.key, label: x.label })), i.type)}</select></label>
            <label class="field"><span>القسم</span><select name="section_code" ${dis}>${options((e?.sections || []).map((s) => ({ value: s.code, label: `${s.code} ${s.name}` })), i.section_code, { empty: '—' })}</select></label>
          </div>
          <label class="check"><input type="checkbox" name="blocks_report" ${i.blocks_report ? raw('checked') : ''} ${dis}> يمنع إصدار التقرير</label>
          <div class="field"><span>يعتمد على (لا يكتمل قبلها)</span>
            <div>${deps.map((d) => h`<div class="row small" style="padding:4px 0"><a class="spacer" href="#/item/${d.id}">${d.ref || ''} ${d.title}</a><span class="pill">${statusLabel(d.status)}</span>${editable ? h`<button type="button" class="btn sm" data-undep="${d.id}">✕</button>` : ''}</div>`)}</div>
            ${editable ? h`<button type="button" class="btn sm" data-dep>＋ ربط ببند</button>` : ''}</div>
          ${canDeleteItem(S.me, i, e) ? h`<button type="button" class="btn danger block" data-delete style="margin-top:10px">حذف البند</button>` : ''}
        </details>
      </form>

      <div class="card">
        <div class="section-title" style="margin-top:0"><span>المرفقات (${atts.length})</span></div>
        ${atts.map((a) => h`<div class="att">
          ${a.mime?.startsWith('image/') ? h`<img alt="" loading="lazy" data-img="${a.id}" ${a._local ? raw('data-local') : raw(`src="/api/attachments/${a.id}"`)}>` : h`<div class="ic">${(a.name || '').split('.').pop().slice(0, 4)}</div>`}
          <div class="nm">${a._local ? h`${a.name} <span class="pill amber">بانتظار الرفع</span>` : h`<a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${a.name}</a>`}
            <div class="hint">${userName(a.uploaded_by)} · ${fmtTime(a.created_at)}</div></div>
          ${!a._local && (a.uploaded_by === S.me.id || approver) ? h`<button class="btn sm" data-delatt="${a.id}">✕</button>` : ''}
        </div>`)}
        ${S.me ? h`<div class="btns" style="margin-top:10px">
          <label class="btn">📷 تصوير<input type="file" accept="image/*" capture="environment" data-file hidden></label>
          <label class="btn">📎 ملف<input type="file" accept="image/*,application/pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.zip" data-file hidden multiple></label></div>
          ${i.status === 'closed' ? h`<div class="hint">إضافة أو حذف مرفق بعد الاعتماد يعيد فتح البند.</div>` : ''}` : ''}
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0"><span>التعليقات (${comments.length})</span></div>
        ${comments.map((c) => h`<div class="comment"><div class="who">${userName(c.user_id)} · ${fmtTime(c.created_at)}${c._pending ? ' ⟳' : ''}</div>${c.body}</div>`)}
        <form class="row" data-comment style="margin-top:8px"><input class="inp" name="body" placeholder="اكتب تعليقًا…" enterkeyhint="send"><button class="btn primary">إرسال</button></form>
      </div>

      <div class="card"><button class="btn block" data-history>سجل تعديلات البند</button><div data-hist></div></div>
      <p class="hint" style="text-align:center">أُنشئ ${fmtTime(i.created_at)} · آخر تحديث ${fmtTime(i.updated_at)}</p>`,

    async mount(root) {
      const save = async (ch, msg) => {
        try { await mutate('items', 'update', i.id, ch); if (msg) toast(msg); } catch (err) { toast(err.message); window.dispatchEvent(new Event('rerender')); }
      };
      root.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => save({ status: b.dataset.status }, `الحالة: ${STATUS[b.dataset.status].label}`)));
      const range = root.querySelector('[data-progress]');
      range?.addEventListener('input', () => { root.querySelector('[data-pv]').textContent = `${range.value}%`; });
      range?.addEventListener('change', () => save({ progress: +range.value }));
      root.querySelector('[data-approve]')?.addEventListener('click', async (ev) => {
        if (ev.currentTarget.hasAttribute('data-warn') && !(await confirmSheet('اعتماد وإقفال', `حالة البند «${statusLabel(i.status)}» وليس «جاهز للمراجعة». هل راجعت العمل والأدلة؟`, 'اعتماد'))) return;
        if ((i.progress || 0) < 100 && !(await confirmSheet('نسبة التنفيذ أقل من 100%', 'الاعتماد منفصل عن نسبة التنفيذ. متابعة الاعتماد؟', 'اعتماد'))) return;
        save({ status: 'closed' }, 'تم الاعتماد والإقفال');
      });
      root.querySelector('[data-follow]')?.addEventListener('click', () => save({ last_followup: today() }, 'تم تسجيل المتابعة'));
      root.querySelectorAll('[data-snooze]').forEach((b) => b.addEventListener('click', () => {
        const d = addDays(today(), +b.dataset.snooze);
        save({ snooze_until: d }, `لا تذكير حتى ${fmtDate(d)}`);
      }));
      root.querySelectorAll('[data-due]').forEach((b) => b.addEventListener('click', () => {
        const d = addDays(i.due_date && i.due_date > today() ? i.due_date : today(), +b.dataset.due);
        save({ due_date: d }, `الموعد: ${fmtDate(d)}`);
      }));
      root.querySelector('[data-receive]')?.addEventListener('click', () => save({ received_at: today() }, 'تم تسجيل الاستلام — البند ما زال مفتوحًا للفحص'));
      root.querySelector('[data-unreceive]')?.addEventListener('click', () => save({ received_at: null }));

      const form = root.querySelector('#itemForm');
      form.addEventListener('submit', (ev) => ev.preventDefault());
      form.addEventListener('change', (ev) => {
        const el = ev.target;
        if (!el.name) return;
        let v = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value.trim();
        if (v === '') v = null;
        if (el.name === 'wp_url' && v && !/^https?:\/\//i.test(v)) { toast('الرابط يجب أن يبدأ بـ https'); return; }
        if (el.name === 'title' && !v) { toast('الوصف مطلوب'); el.value = i.title; return; }
        if (JSON.stringify(v) === JSON.stringify(i[el.name] ?? null)) return;
        const evidence = ['conclusion', 'ref', 'wp_url', 'client_response'].includes(el.name) && i.status === 'closed';
        save({ [el.name]: v }, evidence ? 'تم الحفظ — أُعيد فتح البند لأن النتيجة/الأدلة تغيّرت' : 'تم الحفظ');
      });
      root.querySelectorAll('[data-undep]').forEach((b) => b.addEventListener('click', () => save({ depends_on: (i.depends_on || []).filter((x) => x !== b.dataset.undep) })));
      root.querySelector('[data-dep]')?.addEventListener('click', () => {
        const others = itemsOf(i.engagement_id).filter((x) => x.id !== i.id && !(i.depends_on || []).includes(x.id));
        openSheet(h`<h2>يعتمد على…</h2><div class="list">${others.map((x) => h`<button class="it" style="width:100%;border-inline:0;border-bottom:0;background:none;text-align:start" data-pick="${x.id}"><div class="body"><div class="title">${x.ref || ''} ${x.title}</div><div class="sub">${statusLabel(x.status)}</div></div></button>`)}</div>`.s, {
          onMount: (el, close) => el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
            save({ depends_on: [...(i.depends_on || []), b.dataset.pick] }); close();
          })),
        });
      });
      root.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirmSheet('حذف البند', 'سيُحذف البند من المتابعة (يبقى في سجل التعديلات).', 'حذف', true))) return;
        await mutate('items', 'delete', i.id);
        toast('تم الحذف');
        history.back();
      });

      root.querySelectorAll('[data-file]').forEach((inp) => inp.addEventListener('change', async () => {
        const files = [...inp.files];
        for (const f of files) {
          if (f.size > 25 * 1024 * 1024) { toast(`${f.name}: أكبر من 25MB`); continue; }
          const file = f.type.startsWith('image/') && f.size > 1.5 * 1024 * 1024 ? await shrinkImage(f) : f;
          await addAttachment(i.id, file);
        }
        if (files.length) toast(navigator.onLine ? 'جارٍ رفع المرفق…' : 'حُفظ المرفق على الجهاز وسيُرفع عند الاتصال');
      }));
      root.querySelectorAll('[data-delatt]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmSheet('حذف المرفق', i.status === 'closed' ? 'حذف دليل بعد الاعتماد سيعيد فتح البند.' : 'حذف هذا المرفق؟', 'حذف', true))) return;
        await mutate('attachments', 'delete', b.dataset.delatt);
      }));
      // معاينة الصور المحلية التي لم تُرفع بعد
      const { get } = await import('../idb.js');
      for (const img of root.querySelectorAll('img[data-local]')) {
        const b = await get('blobs', img.dataset.img);
        if (b) img.src = URL.createObjectURL(b.blob);
      }

      root.querySelector('[data-comment]').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = ev.target.body.value.trim();
        if (!body) return;
        await mutate('comments', 'create', uuid(), { item_id: i.id, body, user_id: S.me.id });
        ev.target.body.value = '';
        ev.target.body.blur();
      });
      root.querySelector('[data-history]').addEventListener('click', async () => {
        const box = root.querySelector('[data-hist]');
        box.innerHTML = '<div class="loading">…</div>';
        try { box.innerHTML = historyHtml(await api(`/api/history?entity=items&id=${i.id}`)).s; } catch (err) {
          box.innerHTML = h`<div class="empty">${err.status === 0 ? 'السجل يحتاج اتصالًا' : err.message}</div>`.s;
        }
      });
    },
  };
}

// تصغير صور الكاميرا الكبيرة قبل الحفظ/الرفع
async function shrinkImage(file, max = 2000) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
