import { api } from './api.js';

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function pushState() {
  if (isIOS() && !isStandalone()) return 'needs_install';
  if (!pushSupported()) return 'unsupported';
  return Notification.permission; // default | granted | denied
}

function keyToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// يجب استدعاؤها من ضغطة المستخدم (شرط iOS)
export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('لم يتم منح إذن الإشعارات');
  return subscribe();
}

export async function subscribe() {
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/vapid');
  let sub = await reg.pushManager.getSubscription();
  const key = keyToBytes(publicKey);
  if (sub) {
    const cur = sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (cur && (cur.length !== key.length || cur.some((b, i) => b !== key[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return sub;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
}

export async function hasSubscription() {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(reg && await reg.pushManager.getSubscription());
}

// عند فتح التطبيق: تحديث ربط الاشتراك بالمستخدم الحالي
export async function refreshSubscription() {
  if (pushState() === 'granted' && navigator.onLine) {
    try { await subscribe(); } catch { /* يعاد لاحقًا */ }
  }
}
