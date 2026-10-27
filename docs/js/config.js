// وضع التشغيل: «محلي» على GitHub Pages (كل البيانات على الجهاز، بدون خادم)، أو «خادم».
const q = new URLSearchParams(location.search);
try {
  if (q.get('mode') === 'local') localStorage.setItem('mode', 'local');
  if (q.get('mode') === 'server') localStorage.removeItem('mode');
} catch { /* لا شيء */ }
const stored = (() => { try { return localStorage.getItem('mode'); } catch { return null; } })();
export const LOCAL = location.hostname.endsWith('github.io') || stored === 'local';
