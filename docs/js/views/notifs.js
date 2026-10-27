import { S } from '../store.js';
import { h, raw, toast, fmtTime } from '../ui.js';
import { itemList } from '../components.js';
import { markRead, fetchNotifs } from '../sync.js';
import { api } from '../api.js';
import { pushState, enablePush, isIOS, hasSubscription, isStandalone } from '../push.js';
import { LOCAL } from '../config.js';

const PUSH_STATUS = {
  sent: ['أُرسل', 'green'], held: ['محجوز (الحد اليومي)', 'amber'], failed: ['فشل', 'red'],
  no_subscription: ['لا يوجد جهاز مفعّل', 'amber'], pending: ['قيد الإرسال', ''],
};
const KIND = { morning: 'ملخص الصباح', group: 'تنبيهات ملف', due_today: 'مستحق اليوم', due_soon: 'قريب الاستحقاق', overdue: 'متأخر',
  client: 'طلب عميل', review: 'جاهز للمراجعة', escalation: 'تصعيد', weekly: 'مراجعة أسبوعية', test: 'تجريبي' };

export function pushCard() {
  if (LOCAL) {
    return h`<div class="banner info">التنبيهات (الملخص الصباحي، الاستحقاق، المتأخر، طلبات العملاء، الجاهز للمراجعة) تُحسب وتظهر هنا <b>عند فتح التطبيق</b>.
      إشعارات شاشة القفل والتطبيق مغلق تحتاج نسخة الخادم.
      ${isIOS() && !isStandalone() ? h`<div style="margin-top:6px"><b>للتثبيت:</b> Safari ← زر المشاركة ← «إضافة إلى الشاشة الرئيسية».</div>` : ''}</div>`;
  }
  const st = pushState();
  if (st === 'needs_install') {
    return h`<div class="banner info"><b>لتفعيل الإشعارات على الآيفون</b>
      <ol class="steps"><li>افتح التطبيق من <b>Safari</b>.</li><li>اضغط زر المشاركة <b>⎋↑</b> أسفل الشاشة.</li>
      <li>اختر <b>«إضافة إلى الشاشة الرئيسية»</b> ثم «إضافة».</li><li>افتح التطبيق من الأيقونة الجديدة، وارجع لهذه الصفحة واضغط «تفعيل الإشعارات».</li></ol>
      <div class="hint">يتطلب iOS 16.4 أو أحدث. البيانات والعمل دون اتصال يعملان بدون هذه الخطوة.</div></div>`;
  }
  if (st === 'unsupported') return h`<div class="banner">هذا المتصفح لا يدعم إشعارات الويب. صندوق الإشعارات أدناه يعمل دائمًا.</div>`;
  if (st === 'denied') {
    return h`<div class="banner red">الإشعارات مرفوضة لهذا التطبيق. ${isIOS() ? 'فعّلها من: الإعدادات ← الإشعارات ← سيزون المراجعة.' : 'فعّلها من إعدادات المتصفح للموقع.'}</div>`;
  }
  if (st === 'default') {
    return h`<div class="banner info"><b>فعّل الإشعارات</b> لتصلك تذكيرات الاستحقاق والمتأخرات وطلبات العملاء والملخص الصباحي.
      <button class="btn primary block" data-enable style="margin-top:8px">تفعيل الإشعارات</button></div>`;
  }
  return h`<div class="card row"><span class="spacer">🔔 الإشعارات مفعّلة <span class="hint" data-subinfo></span></span>
    <button class="btn sm" data-test>إرسال تجريبي</button><a class="btn sm" href="#/settings/notifs">الإعدادات</a></div>`;
}

export function mountPushCard(root) {
  root.querySelector('[data-enable]')?.addEventListener('click', async () => {
    try { await enablePush(); toast('تم تفعيل الإشعارات'); window.dispatchEvent(new Event('rerender')); } catch (e) { toast(e.message); }
  });
  root.querySelector('[data-test]')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/push/test', { method: 'POST' });
      toast(r.status === 'sent' ? 'أُرسل — قد يستغرق الوصول لحظات' : `لم يُرسل: ${r.error || r.status}`);
      fetchNotifs();
    } catch (e) { toast(e.message); }
  });
  const info = root.querySelector('[data-subinfo]');
  if (info) hasSubscription().then((ok) => { if (!ok) info.textContent = '(لم يُربط هذا الجهاز بعد)'; });
}

export function render(params, q) {
  const tab = q.tab || 'inbox';
  const list = S.notifs;
  return {
    title: 'الإشعارات',
    html: h`
      ${raw(pushCard().s)}
      <div class="chips"><a class="chip ${tab === 'inbox' ? 'on' : ''}" href="#/notifs">الصندوق</a>${LOCAL ? '' : h`<a class="chip ${tab === 'log' ? 'on' : ''}" href="#/notifs?tab=log">سجل الإرسال</a>`}
        <span class="spacer"></span>${tab === 'inbox' && list.some((n) => !n.read_at) ? h`<button class="chip" data-readall>تعليم الكل كمقروء</button>` : ''}</div>
      ${tab === 'inbox'
        ? (list.length ? h`<div class="list">${list.map((n) => h`<a class="notif ${n.read_at ? 'read' : ''}" href="${n.url.startsWith('#/notif/') || n.url.startsWith('#/item/') ? `${n.url}${n.url.includes('?') ? '&' : '?'}nid=${n.id}` : n.url}" data-nid="${n.id}">
            <span class="dot"></span><div class="b"><b>${n.title}</b><div class="small">${n.body}</div><small>${fmtTime(n.created_at)}</small></div></a>`)}</div>`
          : h`<div class="empty">لا توجد تنبيهات بعد. تُنشأ حسب جدولك (أيام العمل، بعد موعد الملخص الصباحي، خارج ساعات الهدوء).</div>`)
        : h`<div class="card"><p class="hint" style="margin-top:0">الوصول الفوري غير مضمون؛ يعتمد على خدمة Apple/المتصفح وحالة الجهاز. كل التنبيهات محفوظة في الصندوق.</p>
          <table class="log"><tr><th>الوقت</th><th>النوع</th><th>الإرسال</th></tr>${list.map((n) => {
            const [label, cls] = PUSH_STATUS[n.push_status] || [n.push_status || '—', ''];
            return h`<tr><td>${fmtTime(n.created_at)}</td><td>${KIND[n.kind] || n.kind}<div class="hint">${n.title}</div></td>
              <td><span class="pill ${cls}">${label}</span>${n.push_error ? h`<div class="hint">${n.push_error}</div>` : ''}</td></tr>`;
          })}</table></div>`}`,
    mount(root) {
      mountPushCard(root);
      root.querySelector('[data-readall]')?.addEventListener('click', () => markRead(null));
      root.querySelectorAll('[data-nid]').forEach((a) => a.addEventListener('click', () => markRead([a.dataset.nid])));
    },
  };
}

// تفاصيل إشعار مجمّع: البنود مع تحديث سريع
export function renderOne(params, q) {
  const n = S.notifs.find((x) => x.id === params.id);
  if (n && !n.read_at) markRead([n.id]);
  if (!n) return { title: 'إشعار', back: true, html: h`<div class="empty">الإشعار غير موجود (قد يحتاج مزامنة)</div>` };
  const items = (n.item_ids || []).map((id) => S.data.items.get(id)).filter(Boolean);
  return {
    title: n.title,
    back: true,
    html: h`<div class="card"><b>${n.title}</b><div class="small" style="white-space:pre-line;margin-top:6px">${n.body}</div><div class="hint">${fmtTime(n.created_at)}</div></div>
      ${items.length ? h`<div class="section-title">حدّث الحالة أو أجّل من هنا</div>${itemList(items)}` : ''}`,
  };
}
