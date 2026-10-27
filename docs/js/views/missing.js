// رسالة النواقص: تُجهّز للمراجعة والتعديل ثم يشاركها المستخدم بنفسه. لا إرسال تلقائي للعميل.
import { S, eng, company, itemsOf, mutate, today } from '../store.js';
import { h, raw, toast, fmtDate, confirmSheet } from '../ui.js';

export function render(params) {
  const e = eng(params.id);
  if (!e) return { title: 'رسالة النواقص', back: true, html: h`<div class="empty">الملف غير موجود</div>` };
  const c = company(e.company_id);
  const candidates = itemsOf(e.id).filter((i) => i.status !== 'closed'
    && ((i.type === 'doc_request' && !i.received_at) || (['note', 'difference'].includes(i.type) && i.status === 'waiting_client')
      || (i.type === 'task' && i.status === 'waiting_client')))
    .sort((a, b) => (a.section_code || '').localeCompare(b.section_code || '') || (a.ref || '').localeCompare(b.ref || '', 'ar', { numeric: true }));
  const selected = new Set(candidates.map((i) => i.id));

  const build = () => {
    const list = candidates.filter((i) => selected.has(i.id));
    const docs = list.filter((i) => i.type === 'doc_request' || i.type === 'task');
    const notes = list.filter((i) => i.type === 'note' || i.type === 'difference');
    const line = (i, n) => `${n}) ${i.title}${i.due_date ? ` — مطلوب قبل ${fmtDate(i.due_date)}` : ''}`;
    let t = `السادة/ ${c?.name || ''}\nتحية طيبة وبعد،\n\nفي إطار أعمال مراجعة القوائم المالية عن السنة المالية ${e.year}، نرجو التكرم بموافاتنا بما يلي:\n`;
    if (docs.length) t += `\nأولًا: المستندات المطلوبة\n${docs.map((i, k) => line(i, k + 1)).join('\n')}\n`;
    if (notes.length) t += `\n${docs.length ? 'ثانيًا' : 'أولًا'}: ملاحظات بانتظار ردكم\n${notes.map((i, k) => line(i, k + 1)).join('\n')}\n`;
    t += `\nشاكرين حسن تعاونكم،\n${S.me.name}`;
    return t;
  };

  return {
    title: 'رسالة النواقص',
    back: true,
    html: h`
      <div class="banner info">راجع الرسالة وعدّلها قبل المشاركة. لا يرسل التطبيق أي شيء للعميل تلقائيًا.</div>
      ${candidates.length ? h`
        <div class="list">${candidates.map((i) => h`<label class="it check" style="--c:var(--s-amber)"><input type="checkbox" data-pick="${i.id}" checked>
          <div class="body"><div class="title">${i.ref ? i.ref + ' · ' : ''}${i.title}</div><div class="sub"><span>${i.due_date ? 'مطلوب ' + fmtDate(i.due_date) : 'دون موعد'}</span>
          <span>آخر متابعة: ${i.last_followup ? fmtDate(i.last_followup) : '—'}</span></div></div></label>`)}</div>
        <label class="field"><span>نص الرسالة</span><textarea class="inp" data-msg rows="14" style="min-height:280px"></textarea></label>
        <div class="btns">
          <button class="btn primary" data-share>مشاركة…</button><button class="btn" data-copy>نسخ</button>
        </div>
        <button class="btn block" data-mark style="margin-top:8px">تسجيل «تمت المتابعة اليوم» للبنود المحددة</button>`
        : h`<div class="empty">لا توجد نواقص مفتوحة لدى العميل في هذا الملف</div>`}`,
    mount(root) {
      const ta = root.querySelector('[data-msg]');
      if (!ta) return;
      ta.value = build();
      let edited = false;
      ta.addEventListener('input', () => { edited = true; });
      root.querySelectorAll('[data-pick]').forEach((cb) => cb.addEventListener('change', async () => {
        if (cb.checked) selected.add(cb.dataset.pick); else selected.delete(cb.dataset.pick);
        if (edited && !(await confirmSheet('إعادة توليد النص؟', 'ستفقد تعديلاتك اليدوية على الرسالة.', 'إعادة توليد'))) return;
        ta.value = build();
        edited = false;
      }));
      const markFollowed = async () => {
        const t = today();
        for (const id of selected) await mutate('items', 'update', id, { last_followup: t }).catch(() => {});
        toast(`سُجّلت المتابعة لـ ${selected.size} بند`);
      };
      root.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(ta.value); toast('تم النسخ'); } catch { ta.select(); toast('حدد النص وانسخه'); }
      });
      root.querySelector('[data-share]').addEventListener('click', async () => {
        if (!navigator.share) { toast('المشاركة غير مدعومة — استخدم «نسخ»'); return; }
        try {
          await navigator.share({ title: 'نواقص المراجعة', text: ta.value });
          if (await confirmSheet('هل أرسلت الرسالة؟', 'تسجيل «تمت المتابعة اليوم» للبنود المحددة؟', 'نعم، سجّل')) await markFollowed();
        } catch { /* ألغى المستخدم */ }
      });
      root.querySelector('[data-mark]').addEventListener('click', markFollowed);
    },
  };
}

export { raw };
