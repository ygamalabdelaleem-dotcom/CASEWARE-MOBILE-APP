// عامل الخدمة: تخزين واجهة التطبيق للعمل دون اتصال + استقبال إشعارات Web Push (نسخة الخادم).
// بيانات العملاء لا تُخزَّن هنا؛ تُحفظ في IndexedDB.
const VERSION = 'v1.3.0';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/components.js', 'js/config.js', 'js/idb.js', 'js/local.js', 'js/push.js', 'js/store.js',
  'js/sync.js', 'js/ui.js',
  'js/views/companies.js', 'js/views/engagement.js', 'js/views/home.js', 'js/views/item.js', 'js/views/missing.js',
  'js/views/notifs.js', 'js/views/settings.js', 'js/views/tasks.js',
  'shared/rules.js', 'shared/engine.js', 'shared/defaults.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/badge-72.png',
  'vendor/exceljs.min.js',
];
const scope = self.registration.scope;
const INDEX = new URL('index.html', scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((p) => new URL(p, scope).href))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  if (e.request.mode === 'navigate') {
    // الشبكة أولًا لصفحة التطبيق، ثم النسخة المخزنة دون اتصال
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(INDEX, copy)); }
      return r;
    }).catch(() => caches.match(INDEX)));
    return;
  }
  // الملفات الثابتة: من المخزن فورًا مع تحديث في الخلفية
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'متابعة سيزون المراجعة', {
      body: d.body || '', tag: d.tag, renotify: !!d.tag, lang: 'ar', dir: 'rtl',
      icon: new URL('icons/icon-192.png', scope).href, badge: new URL('icons/badge-72.png', scope).href,
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
      if (w.url.startsWith(scope)) {
        await w.focus();
        w.postMessage({ type: 'navigate', url: hash });
        return;
      }
    }
    await self.clients.openWindow(scope + hash);
  })());
});
