// محرك ترتيب وتجميع التنبيهات — مشترك بين الخادم والنسخة المحلية.
import { isMember, itemScore, daysBetween } from './rules.js';

export const DEFAULT_PREFS = {
  tz: 'Africa/Cairo',
  morning: '08:30',
  quiet_start: '21:00',
  quiet_end: '08:00',
  workdays: [0, 1, 2, 3, 4], // الأحد..الخميس
  daily_limit: 6,
  remind_before_days: 2,
  overdue_every_days: 2,
  client_every_days: 3,
  review_every_days: 1,
  weekly_day: 0,
  stale_days: 14,
  lock_privacy: true,
  kinds: { morning: true, due: true, overdue: true, client: true, review: true, weekly: true, escalation: true },
};

export function mergePrefs(p = {}) {
  return { ...DEFAULT_PREFS, ...p, kinds: { ...DEFAULT_PREFS.kinds, ...(p.kinds || {}) } };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export function cleanPrefs(cur, input) {
  const p = { ...cur, kinds: { ...cur.kinds } };
  for (const k of ['morning', 'quiet_start', 'quiet_end']) if (TIME.test(input[k] || '')) p[k] = input[k];
  const ints = { daily_limit: [1, 30], remind_before_days: [0, 14], overdue_every_days: [1, 14], client_every_days: [1, 30],
    review_every_days: [1, 14], weekly_day: [0, 6], stale_days: [3, 90] };
  for (const [k, [lo, hi]] of Object.entries(ints)) {
    if (k in input) p[k] = Math.max(lo, Math.min(hi, Math.round(Number(input[k]) || 0)));
  }
  if (Array.isArray(input.workdays)) p.workdays = [...new Set(input.workdays.map(Number).filter((d) => d >= 0 && d <= 6))];
  if ('lock_privacy' in input) p.lock_privacy = !!input.lock_privacy;
  if (input.tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: input.tz }); p.tz = input.tz; } catch { /* تجاهل */ }
  }
  if (input.kinds) for (const k of Object.keys(DEFAULT_PREFS.kinds)) if (k in input.kinds) p.kinds[k] = !!input.kinds[k];
  return p;
}

// ---------- الوقت المحلي للمستخدم ----------
export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: wd };
}
export function inQuiet(time, p) {
  const { quiet_start: s, quiet_end: e } = p;
  if (s === e) return false;
  return s < e ? time >= s && time < e : time >= s || time < e;
}

// هل حان وقت التنبيه لهذا البند بهذا النوع؟ (منع التكرار)
function due(store, item, kind, mark, today, everyDays) {
  const m = store.getMark(item, kind);
  if (!m) return true;
  if (mark != null && m.mark !== mark) return true;
  if (everyDays) return daysBetween(m.at, today) >= everyDays;
  return false;
}

const KIND_LABEL = {
  due_today: 'مستحق اليوم', due_soon: 'يستحق قريبًا', overdue: 'متأخر', client: 'متابعة طلب عميل',
  review: 'جاهز للمراجعة', escalation: 'تصعيد متأخر',
};

export function prepareData(engs, companies, items) {
  const engMap = new Map(engs.filter((e) => !e.deleted && e.status === 'active').map((e) => [e.id, e]));
  const open = items.filter((i) => !i.deleted && i.status !== 'closed' && engMap.has(i.engagement_id));
  const dependents = new Map();
  for (const i of open) for (const d of i.depends_on || []) dependents.set(d, (dependents.get(d) || 0) + 1);
  return { engMap, companies: new Map(companies.map((c) => [c.id, c])), items: open, dependents };
}

function engLabel(eng, companies, privacy) {
  const c = companies.get(eng.company_id);
  if (privacy) return `${c?.code || 'ملف'} ${eng.year}`;
  return `${c?.name || ''} ${eng.year}`;
}

export function buildForUser(user, now, data, prefs, store) {
  const lp = localParts(now, prefs.tz);
  const today = lp.date;
  if (!prefs.workdays.includes(lp.weekday)) return { skipped: 'weekend', out: [] };
  if (inQuiet(lp.time, prefs)) return { skipped: 'quiet', out: [] };
  if (lp.time < prefs.morning) return { skipped: 'before_morning', out: [] };

  const { engMap, companies, items, dependents } = data;
  const out = [];
  const myItems = items.filter((i) => i.assignee_id === user.id && isMember(user, engMap.get(i.engagement_id)));
  const snoozed = (i) => i.snooze_until && i.snooze_until > today;
  const score = (i) => itemScore(i, engMap.get(i.engagement_id), today, dependents.get(i.id) || 0);

  // 1) الملخص الصباحي
  if (prefs.kinds.morning && !store.runDone(`morning:${today}`)) {
    const reviewable = items.filter((i) => i.status === 'ready_review' && i.assignee_id !== user.id && isReviewer(user, engMap.get(i.engagement_id)));
    const c = {
      today: myItems.filter((i) => i.due_date === today).length,
      overdue: myItems.filter((i) => i.due_date && i.due_date < today).length,
      client: myItems.filter((i) => i.status === 'waiting_client').length,
      review: reviewable.length,
      rework: myItems.filter((i) => i.status === 'rework').length,
    };
    const blockers = [...engMap.values()].filter((e) => isMember(user, e) && e.report_due && daysBetween(today, e.report_due) <= 14)
      .map((e) => ({ e, n: items.filter((i) => i.engagement_id === e.id && i.blocks_report).length }))
      .filter((x) => x.n);
    const parts = [`اليوم ${c.today}`, `متأخر ${c.overdue}`, `طلبات عملاء ${c.client}`];
    if (c.review) parts.push(`للمراجعة ${c.review}`);
    if (c.rework) parts.push(`مطلوب تعديل ${c.rework}`);
    const lines = blockers.map((x) => `• ${engLabel(x.e, companies, false)}: ${x.n} مانع، التقرير بعد ${daysBetween(today, x.e.report_due)} يوم`);
    store.markRun(`morning:${today}`);
    if (c.today + c.overdue + c.client + c.review + c.rework + blockers.length > 0) {
      out.push({
        kind: 'morning', score: 1000, engagement_id: null, item_ids: [],
        title: 'ملخص الصباح', body: [parts.join(' · '), ...lines].join('\n'),
        lock_title: 'متابعة سيزون المراجعة', lock_body: parts.join(' · '),
        url: '#/', exemptLimit: true,
      });
    }
  }

  // 2) تذكيرات البنود — تُجمع لاحقًا حسب الملف
  const cands = [];
  const add = (i, kind, mark, every) => {
    if (!due(store, i.id, kind, mark, today, every)) return;
    cands.push({ i, kind, mark, s: score(i) });
  };
  for (const i of myItems) {
    if (snoozed(i)) continue;
    const active = !['waiting_client', 'ready_review'].includes(i.status);
    if (active && i.due_date && prefs.kinds.due) {
      const d = daysBetween(today, i.due_date);
      if (d === 0) add(i, 'due_today', `today:${i.due_date}`);
      else if (d > 0 && d <= prefs.remind_before_days) add(i, 'due_soon', `before:${i.due_date}`);
    }
    if (active && i.due_date && i.due_date < today && prefs.kinds.overdue) add(i, 'overdue', null, prefs.overdue_every_days);
    if (i.status === 'waiting_client' && prefs.kinds.client) {
      const since = i.last_followup ? daysBetween(i.last_followup, today) : 999;
      if (since >= prefs.client_every_days) add(i, 'client', null, prefs.client_every_days);
    }
  }
  if (prefs.kinds.review) {
    for (const i of items) {
      if (i.status !== 'ready_review' || i.assignee_id === user.id || snoozed(i)) continue;
      if (!isReviewer(user, engMap.get(i.engagement_id))) continue;
      add(i, 'review', i.status_changed_at || '', prefs.review_every_days);
    }
  }
  // تصعيد اختياري: يعمل فقط إذا فعّله المدير للملف.
  if (prefs.kinds.escalation) {
    for (const i of items) {
      const e = engMap.get(i.engagement_id);
      if (!e.escalation_enabled || e.manager_id !== user.id || i.assignee_id === user.id) continue;
      if (i.due_date && daysBetween(i.due_date, today) >= (e.escalation_days || 7)) add(i, 'escalation', null, 3);
    }
  }

  const groups = new Map();
  for (const c of cands) {
    const k = c.i.engagement_id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const [engId, list] of groups) {
    list.sort((a, b) => b.s - a.s);
    const e = engMap.get(engId);
    const counts = {};
    for (const c of list) counts[c.kind] = (counts[c.kind] || 0) + 1;
    const summary = Object.entries(counts).map(([k, n]) => `${KIND_LABEL[k]} ${n}`).join(' · ');
    const lines = list.slice(0, 6).map((c) => `• ${c.i.ref ? c.i.ref + ' ' : ''}${c.i.title} — ${KIND_LABEL[c.kind]}`);
    if (list.length > 6) lines.push(`و${list.length - 6} أخرى`);
    const ids = list.map((c) => c.i.id);
    out.push({
      kind: list.length === 1 ? list[0].kind : 'group',
      score: list[0].s, engagement_id: engId, item_ids: ids,
      title: `${engLabel(e, companies, false)}: ${list.length === 1 ? KIND_LABEL[list[0].kind] : `${list.length} تنبيهات`}`,
      body: [summary, ...lines].join('\n'),
      lock_title: 'متابعة سيزون المراجعة',
      lock_body: `${engLabel(e, companies, true)}: ${summary}`,
      url: list.length === 1 ? `#/item/${ids[0]}` : null,
      urgency: list.some((c) => c.kind === 'overdue' || c.kind === 'due_today') ? 'high' : 'normal',
      marks: list.map((c) => [c.i.id, c.kind, c.mark]),
    });
  }

  // 3) المراجعة الأسبوعية: بنود دون موعد أو دون تحديث
  if (prefs.kinds.weekly && lp.weekday === prefs.weekly_day && !store.runDone(`weekly:${today}`)) {
    store.markRun(`weekly:${today}`);
    const stale = myItems.filter((i) => !i.due_date || daysBetween(i.updated_at, today) >= prefs.stale_days);
    if (stale.length) {
      const noDate = stale.filter((i) => !i.due_date).length;
      const body = `دون موعد ${noDate} · دون تحديث منذ ${prefs.stale_days} يوم ${stale.length - noDate}`;
      out.push({
        kind: 'weekly', score: 5, engagement_id: null, item_ids: stale.map((i) => i.id),
        title: 'مراجعة أسبوعية للمهام', body, lock_title: 'متابعة سيزون المراجعة', lock_body: body,
        url: '#/tasks?f=stale',
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return { out, today, prefs };
}

export function isReviewer(user, eng) {
  if (!eng) return false;
  return eng.in_charge_id === user.id || eng.manager_id === user.id;
}
