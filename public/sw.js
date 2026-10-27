// عامل الخدمة: تخزين واجهة التطبيق للعمل دون اتصال + استقبال إشعارات Web Push.
// بيانات العملاء لا تُخزَّن هنا؛ تُحفظ في IndexedDB وتُمسح عند تسجيل الخروج.
const VERSION = 'v1.0.0';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest',
  '/js/app.js', '/js/api.js', '/js/components.js', '/js/idb.js', '/js/push.js', '/js/store.js', '/js/sync.js', '/js/ui.js',
  '/js/views/companies.js', '/js/views/engagement.js', '/js/views/home.js', '/js/views/item.js', '/js/views/missing.js',
  '/js/views/notifs.js', '/js/views/settings.js', '/js/views/tasks.js',
  '/shared/rules.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/badge-72.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // الشبكة أولًا لصفحة التطبيق، ثم النسخة المخزنة دون اتصال
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put('/index.html', copy));
      return r;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  // الملفات الثابتة: من المخزن فورًا مع تحديث في الخلفية
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  const title = d.title || 'متابعة سيزون المراجعة';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || '',
      tag: d.tag,
      renotify: !!d.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      lang: 'ar',
      dir: 'rtl',
      data: { url: d.url || '#/notifs', nid: d.nid },
    }),
    self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null,
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url = '#/notifs', nid } = e.notification.data || {};
  let hash = url.startsWith('#') ? url : `#${url.replace(/^.*#/, '')}`;
  if (nid) hash += `${hash.includes('?') ? '&' : '?'}nid=${nid}`;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === location.origin) {
        await w.focus();
        w.postMessage({ type: 'navigate', url: hash });
        return;
      }
    }
    await self.clients.openWindow(`/${hash}`);
  })());
});
