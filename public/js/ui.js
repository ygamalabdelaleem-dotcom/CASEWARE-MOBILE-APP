import { STATUS, PRIORITY, TYPE, daysBetween } from '/shared/rules.js';
import { today } from './store.js';

// ---------- قوالب HTML آمنة ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const part = (v) => (v instanceof Raw ? v.s : v == null || v === false ? '' : Array.isArray(v) ? v.map(part).join('') : esc(v));
export function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += part(vals[i]); });
  return new Raw(out);
}

// ---------- التواريخ ----------
const dfShort = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'short' });
const dfLong = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
const tf = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' });
export const fmtDate = (d) => (d ? dfShort.format(new Date(d.slice(0, 10) + 'T12:00:00')) : '—');
export const fmtLong = (d) => dfLong.format(d ? new Date(d) : new Date());
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? tf.format(d) : `${dfShort.format(d)} ${tf.format(d)}`;
}
export function dueText(due, status) {
  if (!due) return { t: 'دون موعد', c: '' };
  if (status === 'closed') return { t: fmtDate(due), c: '' };
  const d = daysBetween(today(), due);
  if (d < 0) return { t: `متأخر ${-d} يوم`, c: 'late' };
  if (d === 0) return { t: 'اليوم', c: 'soon' };
  if (d === 1) return { t: 'غدًا', c: 'soon' };
  if (d <= 7) return { t: `بعد ${d} أيام`, c: '' };
  return { t: fmtDate(due), c: '' };
}
export function daysLeftText(d) {
  if (d == null) return '';
  if (d < 0) return `متأخر ${-d} يوم`;
  if (d === 0) return 'اليوم';
  return `بعد ${d} يوم`;
}

// ---------- عناصر ----------
export const statusChip = (s, attrs = '') => {
  const st = STATUS[s] || STATUS.not_started;
  return h`<button class="st c-${st.color}" ${raw(attrs)}>${st.label}</button>`;
};
export const statusLabel = (s) => STATUS[s]?.label || s;
export const prLabel = (p) => PRIORITY[p]?.label || p;
export const typeLabel = (t) => TYPE[t]?.label || t;

export function options(list, selected, { empty } = {}) {
  return raw((empty !== undefined ? `<option value="">${esc(empty)}</option>` : '')
    + list.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(selected ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join(''));
}

// ---------- إشعار عابر ----------
let toastTimer;
export function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = '';
  el.append(document.createTextNode(msg));
  if (action) {
    const a = document.createElement('a');
    a.href = action.href || '#';
    a.textContent = action.label;
    if (action.onClick) a.addEventListener('click', (e) => { e.preventDefault(); action.onClick(); });
    el.append(a);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 4500 : 2600);
}

// ---------- الورقة السفلية ----------
let sheetStack = 0;
export function openSheet(content, { onMount, onClose } = {}) {
  const root = document.getElementById('sheetRoot');
  const back = document.createElement('div');
  back.className = 'sheet-back';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.innerHTML = `<div class="grab"></div>${content}`;
  root.append(back, sheet);
  sheetStack++;
  const close = () => {
    back.remove();
    sheet.remove();
    sheetStack--;
    onClose?.();
  };
  back.addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  onMount?.(sheet, close);
  return close;
}
export const sheetOpen = () => sheetStack > 0;

export function confirmSheet(title, body, okLabel = 'تأكيد', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    openSheet(h`<h2>${title}</h2><p class="muted">${body}</p>
      <div class="btns"><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${okLabel}</button><button class="btn" data-close>إلغاء</button></div>`.s, {
      onMount: (el, close) => el.querySelector('[data-ok]').addEventListener('click', () => { ok = true; close(); }),
      onClose: () => resolve(ok),
    });
  });
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
