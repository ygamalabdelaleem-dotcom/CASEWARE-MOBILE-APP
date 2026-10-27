import { S, mutate, uuid, engName, engStats, userName } from '../store.js';
import { h, openSheet, toast, fmtDate } from '../ui.js';
import { canManageCompanies, canCreateEngagement, isMember } from '/shared/rules.js';

export function render(params, q) {
  const term = (q.q || '').trim().toLowerCase();
  const companies = [...S.data.companies.values()]
    .filter((c) => !term || `${c.name} ${c.code || ''}`.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const engsOf = (cid) => [...S.data.engagements.values()].filter((e) => e.company_id === cid && isMember(S.me, e))
    .sort((a, b) => b.year - a.year);
  return {
    title: 'الشركات',
    html: h`
      <form class="search" data-search><input type="search" name="q" value="${q.q || ''}" placeholder="بحث عن شركة…" enterkeyhint="search"></form>
      ${canManageCompanies(S.me) ? h`<button class="btn block" data-add style="margin-bottom:12px">＋ شركة جديدة</button>` : ''}
      ${companies.length ? companies.map((c) => {
        const engs = engsOf(c.id);
        return h`<div class="card">
          <div class="row"><a class="spacer" href="#/company/${c.id}" style="color:inherit"><b>${c.name}</b> ${c.code ? h`<span class="pill">${c.code}</span>` : ''}</a></div>
          <div class="chips" style="margin-top:8px;padding-bottom:0">${engs.length ? engs.map((e) => {
            const st = engStats(e.id);
            return h`<a class="chip" href="#/eng/${e.id}">${e.year} · ${e.status === 'issued' ? 'صدر' : (e.stage || '—')} · ${st.progress}%${st.blockers.length ? h` · <b style="color:var(--s-red)">⛔${st.blockers.length}</b>` : ''}</a>`;
          }) : h`<span class="muted small">لا توجد ملفات</span>`}</div>
        </div>`;
      }) : h`<div class="empty">لا توجد شركات</div>`}`,
    mount(root) {
      root.querySelector('[data-search]').addEventListener('submit', (e) => {
        e.preventDefault();
        location.hash = `#/companies?q=${encodeURIComponent(e.target.q.value.trim())}`;
      });
      root.querySelector('[data-add]')?.addEventListener('click', () => companySheet());
    },
  };
}

export function companySheet(c = null) {
  openSheet(h`<h2>${c ? 'تعديل الشركة' : 'شركة جديدة'}</h2>
    <form>
      <label class="field"><span>اسم الشركة</span><input name="name" required value="${c?.name || ''}"></label>
      <label class="field"><span>كود مختصر (يظهر في إشعارات شاشة القفل بدل الاسم)</span><input name="code" value="${c?.code || ''}" maxlength="12" placeholder="مثال: NIL"></label>
      <label class="field"><span>ملاحظات</span><textarea name="notes">${c?.notes || ''}</textarea></label>
      <div class="btns"><button class="btn primary">حفظ</button><button class="btn" type="button" data-close>إلغاء</button></div>
    </form>`.s, {
    onMount: (el, close) => el.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const data = { name: f.name.value.trim(), code: f.code.value.trim() || null, notes: f.notes.value.trim() || null };
      if (!data.name) return;
      const id = c?.id || uuid();
      await mutate('companies', c ? 'update' : 'create', id, data);
      close();
      toast('تم الحفظ');
      if (!c) location.hash = `#/company/${id}`;
    }),
  });
}

export function renderCompany(params) {
  const c = S.data.companies.get(params.id);
  if (!c) return { title: 'الشركة', back: true, html: h`<div class="empty">غير موجودة أو لا تملك صلاحية</div>` };
  const engs = [...S.data.engagements.values()].filter((e) => e.company_id === c.id && isMember(S.me, e)).sort((a, b) => b.year - a.year);
  return {
    title: c.name,
    back: true,
    html: h`
      <div class="card"><div class="row"><b class="spacer">${c.name}</b>${c.code ? h`<span class="pill">${c.code}</span>` : ''}</div>
        ${c.notes ? h`<p class="muted small">${c.notes}</p>` : ''}
        ${canManageCompanies(S.me) ? h`<button class="btn sm" data-edit style="margin-top:8px">تعديل</button>` : ''}</div>
      ${canCreateEngagement(S.me) ? h`<a class="btn block primary" href="#/eng-new?company=${c.id}" style="margin-bottom:12px">＋ ملف سنة جديدة</a>` : ''}
      <div class="section-title">ملفات المراجعة</div>
      ${engs.length ? h`<div class="list">${engs.map((e) => {
        const st = engStats(e.id);
        return h`<a class="it" href="#/eng/${e.id}" style="--c:var(--s-${e.status === 'issued' ? 'green' : 'blue'})"><div class="body">
          <div class="title">${engName(e)}</div>
          <div class="sub"><span>التنفيذ ${st.progress}%</span><span>الاعتماد ${st.approved}%</span><span>التقرير ${fmtDate(e.report_due)}</span><span>${userName(e.in_charge_id)}</span></div></div></a>`;
      })}</div>` : h`<div class="empty">لا توجد ملفات بعد</div>`}`,
    mount(root) { root.querySelector('[data-edit]')?.addEventListener('click', () => companySheet(c)); },
  };
}
