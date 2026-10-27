import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { db, DATA_DIR, decode, nowIso, uid } from './db.js';
import { DEFAULT_PREFS, mergePrefs, cleanPrefs, buildForUser as build, localParts, inQuiet, prepareData } from '../docs/shared/engine.js';

export { DEFAULT_PREFS, localParts, inQuiet };

// ---------- الإعدادات ----------
export function getPrefs(userId) {
  const r = db.prepare('SELECT data FROM prefs WHERE user_id = ?').get(userId);
  let p = {};
  try { p = r ? JSON.parse(r.data) : {}; } catch { /* افتراضي */ }
  return mergePrefs(p);
}
export function savePrefs(userId, input) {
  const p = cleanPrefs(getPrefs(userId), input);
  db.prepare('INSERT INTO prefs(user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data')
    .run(userId, JSON.stringify(p));
  return p;
}

// ---------- VAPID ----------
let vapid = null;
export function getVapid() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const f = path.join(DATA_DIR, 'vapid.json');
    if (fs.existsSync(f)) vapid = JSON.parse(fs.readFileSync(f, 'utf8'));
    else {
      vapid = webpush.generateVAPIDKeys();
      fs.writeFileSync(f, JSON.stringify(vapid), { mode: 0o600 });
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
  return vapid;
}

// ---------- الإرسال ----------
let sender = async (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
export function setSender(fn) { sender = fn; }

export async function pushToUser(userId, payload, urgency = 'normal') {
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
  if (!subs.length) return { status: 'no_subscription', error: 'لا يوجد جهاز مفعّل للإشعارات' };
  let ok = 0;
  const errors = [];
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload),
        { TTL: 6 * 3600, urgency });
      ok++;
      db.prepare('UPDATE push_subs SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?').run(nowIso(), s.endpoint);
    } catch (e) {
      const code = e.statusCode || 0;
      errors.push(`${code || ''} ${e.body || e.message || ''}`.trim().slice(0, 200));
      if (code === 404 || code === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint);
      else db.prepare('UPDATE push_subs SET fail_count = fail_count + 1 WHERE endpoint = ?').run(s.endpoint);
    }
  }
  return ok ? { status: 'sent', error: errors.join(' | ') || null } : { status: 'failed', error: errors.join(' | ') };
}

// ---------- محرك الإشعارات ----------
const runDone = (u, key) => !!db.prepare('SELECT 1 FROM notif_runs WHERE user_id = ? AND key = ?').get(u, key);
const markRun = (u, key) => db.prepare('INSERT OR REPLACE INTO notif_runs(user_id, key, at) VALUES (?,?,?)').run(u, key, nowIso());
const getMark = (u, item, kind) => db.prepare('SELECT * FROM notif_marks WHERE user_id = ? AND item_id = ? AND kind = ?').get(u, item, kind);
const setMark = (u, item, kind, mark, date) => db.prepare('INSERT OR REPLACE INTO notif_marks(user_id, item_id, kind, mark, at) VALUES (?,?,?,?,?)').run(u, item, kind, mark, date);

function loadData() {
  const engs = db.prepare("SELECT * FROM engagements WHERE deleted = 0 AND status = 'active'").all().map((r) => decode('engagements', r));
  const companies = db.prepare('SELECT id, name, code FROM companies').all();
  const items = db.prepare("SELECT * FROM items WHERE deleted = 0 AND status != 'closed'").all().map((r) => decode('items', r));
  return prepareData(engs, companies, items);
}

export function buildForUser(user, now, data) {
  return build(user, now, data, getPrefs(user.id), {
    runDone: (key) => runDone(user.id, key),
    markRun: (key) => markRun(user.id, key),
    getMark: (item, kind) => getMark(user.id, item, kind),
  });
}

export async function runEngine(now = new Date()) {
  const users = db.prepare('SELECT id, name, role FROM users WHERE active = 1 AND deleted = 0').all();
  const data = loadData();
  const created = [];
  for (const user of users) {
    const { out, today, prefs } = buildForUser(user, now, data);
    if (!out.length) continue;
    let sent = db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND local_date = ? AND push_status = 'sent' AND kind != 'morning'")
      .get(user.id, today).n;
    for (const n of out) {
      const id = uid();
      const url = n.url || `#/notif/${id}`;
      db.prepare(`INSERT INTO notifications(id, user_id, kind, title, body, lock_title, lock_body, url, item_ids, engagement_id, score,
        local_date, created_at, push_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, user.id, n.kind, n.title, n.body, n.lock_title, n.lock_body, url, JSON.stringify(n.item_ids),
          n.engagement_id, n.score, today, nowIso(), 'pending');
      for (const [itemId, kind, mark] of n.marks || []) setMark(user.id, itemId, kind, mark, today);
      let res;
      if (!n.exemptLimit && sent >= prefs.daily_limit) {
        res = { status: 'held', error: 'تجاوز الحد اليومي — متاح في صندوق الإشعارات' };
      } else {
        const payload = prefs.lock_privacy
          ? { title: n.lock_title, body: n.lock_body, url, tag: n.engagement_id ? `eng-${n.engagement_id}` : n.kind, nid: id }
          : { title: n.title, body: n.body.split('\n').slice(0, 3).join('\n'), url, tag: n.engagement_id ? `eng-${n.engagement_id}` : n.kind, nid: id };
        res = await pushToUser(user.id, payload, n.urgency || 'normal');
        if (res.status === 'sent' && !n.exemptLimit) sent++;
      }
      db.prepare('UPDATE notifications SET push_status = ?, push_at = ?, push_error = ? WHERE id = ?')
        .run(res.status, nowIso(), res.error || null, id);
      created.push({ user_id: user.id, id, ...n, push_status: res.status });
    }
  }
  return created;
}

export function listNotifications(userId, limit = 100) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit)
    .map((n) => ({ ...n, item_ids: JSON.parse(n.item_ids || '[]') }));
}

