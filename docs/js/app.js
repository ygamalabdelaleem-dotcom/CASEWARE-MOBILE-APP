import { S, load, subscribe, setMe, onLocalChange, unreadCount } from './store.js';
import { syncNow, requestSync, startAutoSync, onAuthRequired } from './sync.js';
import { api } from './api.js';
import { h, toast, sheetOpen } from './ui.js';
import { quickStatus, addItemSheet, syncText } from './components.js';
import { refreshSubscription } from './push.js';
import * as idb from './idb.js';
import { LOCAL } from './config.js';
import * as home from './views/home.js';
import * as tasks from './views/tasks.js';
import * as companies from './views/companies.js';
import * as engagement from './views/engagement.js';
import * as item from './views/item.js';
import * as notifs from './views/notifs.js';
import * as missing from './views/missing.js';
import * as settings from './views/settings.js';

const routes = [
  [/^\/$/, home.render, 'home'],
  [/^\/tasks$/, tasks.render, 'tasks'],
  [/^\/companies$/, companies.render, 'companies'],
  [/^\/company\/(?<id>[\w-]+)$/, companies.renderCompany, 'companies'],
  [/^\/eng-new$/, engagement.renderForm, 'companies'],
  [/^\/eng\/(?<id>[\w-]+)$/, engagement.render, 'companies'],
  [/^\/eng\/(?<id>[\w-]+)\/edit$/, engagement.renderForm, 'companies'],
  [/^\/eng\/(?<id>[\w-]+)\/history$/, engagement.renderHistory, 'companies'],
  [/^\/eng\/(?<id>[\w-]+)\/missing$/, missing.render, 'companies'],
  [/^\/item\/(?<id>[\w-]+)$/, item.render, null],
  [/^\/notifs$/, notifs.render, 'notifs'],
  [/^\/notif\/(?<id>[\w-]+)$/, notifs.renderOne, 'notifs'],
  [/^\/settings$/, settings.render, null],
  [/^\/settings\/notifs$/, settings.renderNotifPrefs, null],
  [/^\/settings\/templates$/, settings.renderTemplates, null],
  [/^\/settings\/templates\/(?<id>[\w-]+)$/, settings.renderTemplates, null],
  [/^\/settings\/users$/, settings.renderUsers, null],
  [/^\/settings\/backup$/, settings.renderBackup, null],
  [/^\/import$/, settings.renderImport, null],
  [/^\/sync$/, settings.renderSync, null],
];

const $ = (id) => document.getElementById(id);
const view = $('view');
let current = null;
let fabEng = null;
let lastHash = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

function editingNow() {
  const a = document.activeElement;
  return a && view.contains(a) && (a.matches('input:not([type=checkbox]):not([type=range]), textarea') || a.isContentEditable);
}

let pendingRender = false;
function render({ force = false } = {}) {
  if (!S.me) return renderLogin();
  if (!force && (editingNow() || sheetOpen())) { pendingRender = true; return; }
  pendingRender = false;
  const { path, query } = parseHash();
  const sameRoute = location.hash === lastHash;
  const scroll = sameRoute ? window.scrollY : 0;
  let out;
  let tab = null;
  for (const [re, fn, t] of routes) {
    const m = path.match(re);
    if (m) { out = fn(m.groups || {}, query); tab = t; break; }
  }
  if (!out) out = { title: 'غير موجود', back: true, html: h`<div class="empty">الصفحة غير موجودة</div>` };
  current = out;
  fabEng = out.fabEng || null;
  $('pageTitle').textContent = out.title;
  document.title = `${out.title} — متابعة سيزون المراجعة`;
  $('backBtn').hidden = !out.back;
  $('tabbar').hidden = false;
  $('fab').hidden = false;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  view.innerHTML = out.html.s;
  out.mount?.(view);
  window.scrollTo(0, scroll);
  lastHash = location.hash;
  chrome();
}

function chrome() {
  const s = syncText();
  const pill = $('syncPill');
  pill.className = `sync-pill ${s.cls}`;
  pill.querySelector('.txt').textContent = s.t;
  pill.hidden = !S.me;
  $('settingsBtn').hidden = !S.me;
  const n = unreadCount();
  const b = $('notifBadge');
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
}

// ---------- الدخول ----------
function renderLogin() {
  $('tabbar').hidden = true;
  $('fab').hidden = true;
  $('backBtn').hidden = true;
  $('syncPill').hidden = true;
  $('settingsBtn').hidden = true;
  $('pageTitle').textContent = 'متابعة سيزون المراجعة';
  if (LOCAL) return renderOnboarding();
  view.innerHTML = h`<form class="login card" id="loginForm">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h2>تسجيل الدخول</h2><p class="muted small" style="text-align:center">متابعة الملفات والفريق والمعلقات</p>
    <label class="field"><span>البريد الإلكتروني</span><input name="email" type="email" autocomplete="username" required inputmode="email"></label>
    <label class="field"><span>كلمة المرور</span><input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary block">دخول</button>
    <p class="hint" data-err style="color:var(--s-red)"></p>
  </form>`.s;
  view.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('[data-err]');
    err.textContent = '';
    try {
      const { user } = await api('/api/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      if (S.me?.id && S.me.id !== user.id) await idb.clearAll();
      await setMe(user);
      await load();
      render({ force: true });
      startAutoSync();
      await syncNow({ full: true });
      refreshSubscription();
    } catch (ex) { err.textContent = ex.message; }
  });
}

// النسخة المحلية (GitHub Pages): لا حسابات؛ البيانات على هذا الجهاز فقط.
function renderOnboarding() {
  view.innerHTML = h`<form class="login card">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h2>أهلًا بك</h2>
    <p class="muted small" style="text-align:center">بياناتك تُحفظ على هذا الجهاز فقط. خذ نسخة احتياطية من الإعدادات بانتظام.</p>
    <label class="field"><span>اسمك</span><input name="name" required autocomplete="name"></label>
    <label class="check"><input type="checkbox" name="demo" checked> ابدأ ببيانات تجريبية (يمكن حذفها لاحقًا)</label>
    <button class="btn primary block">ابدأ</button>
    <label class="btn block" style="margin-top:8px">استعادة نسخة احتياطية<input type="file" accept="application/json,.json" data-restore hidden></label>
  </form>`.s;
  const start = async () => {
    await load();
    render({ force: true });
    startAutoSync();
    syncNow();
  };
  view.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.name.value.trim()) return;
    const { onboard } = await import('./local.js');
    await onboard(f.name.value, f.demo.checked);
    start();
  });
  view.querySelector('[data-restore]').addEventListener('change', async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      await api('/api/admin/restore', { method: 'POST', body: data });
      start();
    } catch (err) { toast(err.message || 'ملف غير صالح'); }
  });
}

// ---------- الأحداث العامة ----------
view.addEventListener('click', (e) => {
  const qs = e.target.closest('[data-qs]');
  if (qs) { e.preventDefault(); quickStatus(qs.dataset.qs); }
});
$('fab').addEventListener('click', () => addItemSheet(fabEng));
$('backBtn').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));
window.addEventListener('hashchange', () => render({ force: true }));
window.addEventListener('rerender', () => render({ force: true }));
document.addEventListener('focusin', (e) => { if (e.target.matches('input:not([type=checkbox]):not([type=range]):not([type=file]), textarea, select')) document.body.classList.add('kb'); });
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!document.activeElement?.matches?.('input, textarea, select')) document.body.classList.remove('kb');
    if (pendingRender && !editingNow() && !sheetOpen()) render();
  }, 120);
});
// إعادة الرسم بعد إغلاق الورقة السفلية إن تغيرت البيانات
new MutationObserver(() => { if (pendingRender && !sheetOpen() && !editingNow()) render(); }).observe($('sheetRoot'), { childList: true });

subscribe(() => { chrome(); render(); });
onLocalChange(() => requestSync());
onAuthRequired(() => {
  toast('انتهت الجلسة — سجّل الدخول مجددًا');
  S.me = null;
  render({ force: true });
});

// رسائل عامل الخدمة (الضغط على إشعار والتطبيق مفتوح)
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate' && e.data.url) location.hash = e.data.url.replace(/^.*#/, '#');
});

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  if (LOCAL) navigator.storage?.persist?.().catch(() => {});
  await load();
  if (LOCAL) S.lastBackup = await (await import('./local.js')).lastBackup();
  if (!S.me && !LOCAL) {
    // جلسة قائمة على الخادم دون بيانات محلية؟
    try { const { user } = await api('/api/me'); await setMe(user); } catch { /* يحتاج دخول */ }
  }
  render({ force: true });
  if (S.me) {
    startAutoSync();
    syncNow({ full: !S.meta.rev });
    refreshSubscription();
  }
}
boot();
