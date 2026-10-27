import { S, activeItems, scoreOf, today, engName, eng, userName } from '../store.js';
import { h, esc } from '../ui.js';
import { itemList } from '../components.js';
import { STATUSES, TYPES, daysBetween } from '/shared/rules.js';
import { buckets } from './home.js';

const BUCKET_LABEL = { today: 'مهام اليوم', overdue: 'المتأخرة', client: 'طلبات العملاء', review: 'جاهز للمراجعة', rework: 'مطلوب تعديل', stale: 'دون موعد أو تحديث' };

export function render(params, q) {
  const mine = q.mine === '1' || (q.mine === undefined && !['admin', 'manager'].includes(S.me.role));
  const t = today();
  let items;
  if (q.b && q.b !== 'stale') items = buckets(mine)[q.b] || [];
  else {
    items = activeItems();
    if (mine) items = items.filter((i) => i.assignee_id === S.me.id);
    if (q.b === 'stale') items = items.filter((i) => i.status !== 'closed' && (!i.due_date || daysBetween(i.updated_at, t) >= 14));
  }
  if (q.st) items = items.filter((i) => i.status === q.st);
  else if (!q.closed) items = items.filter((i) => i.status !== 'closed');
  if (q.type) items = items.filter((i) => i.type === q.type);
  if (q.eng) items = items.filter((i) => i.engagement_id === q.eng);
  if (q.late) items = items.filter((i) => i.due_date && i.due_date < t && i.status !== 'closed');
  if (q.block) items = items.filter((i) => i.blocks_report && i.status !== 'closed');
  if (q.q) {
    const terms = q.q.toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter((i) => {
      const hay = `${i.title} ${i.ref || ''} ${i.description || ''} ${i.next_step || ''} ${engName(eng(i.engagement_id))} ${userName(i.assignee_id)}`.toLowerCase();
      return terms.every((w) => hay.includes(w));
    });
  }
  const sort = q.sort || 'score';
  items = [...items].sort(sort === 'due'
    ? (a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1
    : (a, b) => scoreOf(b) - scoreOf(a));

  const link = (patch) => {
    const n = { ...q, ...patch };
    for (const k of Object.keys(n)) if (n[k] === '' || n[k] == null) delete n[k];
    return '#/tasks?' + new URLSearchParams(n).toString();
  };
  const engs = [...S.data.engagements.values()].filter((e) => e.status !== 'archived');
  return {
    title: q.b ? BUCKET_LABEL[q.b] : 'المهام',
    back: !!q.b,
    html: h`
      <form class="search" data-search><input type="search" name="q" value="${q.q || ''}" placeholder="بحث بالوصف، المرجع، الشركة، المسؤول…" enterkeyhint="search"></form>
      <div class="chips">
        <a class="chip ${mine ? 'on' : ''}" href="${link({ mine: mine ? '0' : '1' })}">مهامي</a>
        <a class="chip ${q.late ? 'on' : ''}" href="${link({ late: q.late ? '' : '1' })}">متأخر</a>
        <a class="chip ${q.block ? 'on' : ''}" href="${link({ block: q.block ? '' : '1' })}">يمنع التقرير</a>
        <a class="chip ${q.b === 'stale' ? 'on' : ''}" href="${link({ b: q.b === 'stale' ? '' : 'stale' })}">دون موعد/تحديث</a>
        <a class="chip ${sort === 'due' ? 'on' : ''}" href="${link({ sort: sort === 'due' ? 'score' : 'due' })}">${sort === 'due' ? 'ترتيب: الموعد' : 'ترتيب: الأولوية'}</a>
      </div>
      <div class="chips">
        ${STATUSES.map((s) => h`<a class="chip ${q.st === s.key ? 'on' : ''}" href="${link({ st: q.st === s.key ? '' : s.key })}">${s.label}</a>`)}
      </div>
      <div class="chips">
        ${TYPES.map((x) => h`<a class="chip ${q.type === x.key ? 'on' : ''}" href="${link({ type: q.type === x.key ? '' : x.key })}">${x.label}</a>`)}
        <select class="chip" data-eng><option value="">كل الملفات</option>${engs.map((e) => h`<option value="${e.id}" ${q.eng === e.id ? 'selected' : ''}>${engName(e)}</option>`)}</select>
      </div>
      <div class="muted small" style="margin:0 4px 6px">${items.length} بند</div>
      ${itemList(items.slice(0, 300))}
      ${items.length > 300 ? h`<div class="empty">اعرض أقل عبر الفلاتر (${items.length - 300} إضافية)</div>` : ''}`,
    mount(root) {
      root.querySelector('[data-search]').addEventListener('submit', (e) => {
        e.preventDefault();
        e.target.q.blur();
        location.hash = link({ q: e.target.q.value.trim() });
      });
      root.querySelector('[data-eng]').addEventListener('change', (e) => { location.hash = link({ eng: e.target.value }); });
    },
  };
}

export { esc };
