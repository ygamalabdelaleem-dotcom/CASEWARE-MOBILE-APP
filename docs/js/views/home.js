import { S, activeItems, scoreOf, today, isReviewerOf, eng } from '../store.js';
import { h, fmtLong, fmtTime } from '../ui.js';
import { itemList, engCard } from '../components.js';
import { isMember, daysBetween, todayStr } from '../../shared/rules.js';
import { LOCAL } from '../config.js';

export function scopeMine() {
  try { return (localStorage.getItem('scope') || (['admin', 'manager'].includes(S.me.role) ? 'all' : 'mine')) === 'mine'; } catch { return true; }
}

export function buckets(mine) {
  const t = today();
  const all = activeItems().filter((i) => i.status !== 'closed');
  const scoped = mine ? all.filter((i) => i.assignee_id === S.me.id) : all;
  const reviewable = all.filter((i) => i.status === 'ready_review'
    && (mine ? isReviewerOf(eng(i.engagement_id)) && i.assignee_id !== S.me.id : true));
  return {
    today: scoped.filter((i) => i.due_date === t && i.status !== 'ready_review'),
    overdue: scoped.filter((i) => i.due_date && i.due_date < t && !['ready_review', 'waiting_client'].includes(i.status)),
    client: scoped.filter((i) => i.status === 'waiting_client'),
    review: reviewable,
    rework: scoped.filter((i) => i.status === 'rework'),
  };
}

export function render() {
  const mine = scopeMine();
  const b = buckets(mine);
  const focus = [...new Map([...b.overdue, ...b.today, ...b.rework].map((i) => [i.id, i])).values()]
    .sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, 8);
  const engs = [...S.data.engagements.values()].filter((e) => e.status === 'active' && isMember(S.me, e))
    .sort((a, c) => (a.report_due || '9999') < (c.report_due || '9999') ? -1 : 1);
  const tile = (k, n, label, cls) => h`<a class="tile ${n ? cls : ''}" href="#/tasks?b=${k}&mine=${mine ? 1 : 0}"><b>${n}</b><span>${label}</span></a>`;
  return {
    title: 'الرئيسية',
    html: h`
      ${LOCAL && S.data.items.size && (!S.lastBackup || daysBetween(S.lastBackup, todayStr()) >= 7)
        ? h`<a class="banner" href="#/settings/backup" style="display:block;color:inherit">بياناتك على هذا الجهاز فقط — ${S.lastBackup ? 'مر أسبوع على آخر نسخة احتياطية' : 'لم تأخذ نسخة احتياطية بعد'}. اضغط لتنزيل نسخة.</a>` : ''}
      <div class="hello"><b>مرحبًا ${S.me.name.split(' ')[0]}</b><span class="muted small">${fmtLong()} · آخر تحديث ${fmtTime(S.meta.lastSync)}</span></div>
      <form class="search" action="#/tasks" data-search><input type="search" name="q" placeholder="ابحث في البنود والشركات…" enterkeyhint="search"></form>
      <div class="chips"><button class="chip ${mine ? 'on' : ''}" data-scope="mine">مهامي</button><button class="chip ${!mine ? 'on' : ''}" data-scope="all">كل الفريق</button></div>
      <div class="tiles">
        ${tile('today', b.today.length, 'مهام اليوم', 'blue')}
        ${tile('overdue', b.overdue.length, 'متأخرة', 'red')}
        ${tile('client', b.client.length, 'طلبات العملاء', 'amber')}
        ${tile('review', b.review.length, 'جاهز للمراجعة', 'violet')}
        ${b.rework.length ? tile('rework', b.rework.length, 'مطلوب تعديل', 'red') : ''}
      </div>
      ${focus.length ? h`<div class="section-title"><span>الأهم الآن</span><a href="#/tasks?mine=${mine ? 1 : 0}&sort=score">الكل</a></div>${itemList(focus)}` : ''}
      <div class="section-title"><span>موانع إصدار التقارير</span><a href="#/companies">الشركات</a></div>
      ${engs.length ? engs.map((e) => engCard(e)) : h`<div class="empty">لا توجد ملفات نشطة</div>`}`,
    mount(root) {
      root.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
        try { localStorage.setItem('scope', b.dataset.scope); } catch { /* لا شيء */ }
        window.dispatchEvent(new Event('rerender'));
      }));
      root.querySelector('[data-search]').addEventListener('submit', (e) => {
        e.preventDefault();
        location.hash = `#/tasks?q=${encodeURIComponent(e.target.q.value.trim())}&mine=0`;
      });
    },
  };
}
