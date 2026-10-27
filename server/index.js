import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, UPLOAD_DIR, BACKUP_DIR, getRow, insertRow, updateRow, audit, tx, uid, nowIso, publicUser, SPECS, decode } from './db.js';
import { authMiddleware, requireUser, requireRole, loginLimiter, verifyPassword, hashPassword, createSession, destroySession, sessionCookie } from './auth.js';
import { pull, processOps, itemContext, updateItem, OpError, getEngagement } from './sync.js';
import { saveTemplate, deleteTemplate, engagementFromTemplate, templateFromEngagement, rollover, ensureDefaultTemplate } from './templates.js';
import { getPrefs, savePrefs, getVapid, pushToUser, runEngine, listNotifications } from './notify.js';
import { exportXlsx, previewImport, commitImport } from './excel.js';
import { seedIfEmpty } from './seed.js';
import { isMember, ROLE } from '../shared/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const SECURE = process.env.COOKIE_SECURE !== '0';

seedIfEmpty();
ensureDefaultTemplate(null);
getVapid();

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(authMiddleware);

// حماية من CSRF: كل طلب معدِّل يجب أن يحمل الترويسة X-App (لا يرسلها نموذج خارجي)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('x-app') !== '1') return res.status(403).json({ error: 'طلب غير مسموح' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    if (e instanceof OpError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'خطأ غير متوقع في الخادم' });
  }
};

// ---------- الدخول ----------
app.post('/api/login', loginLimiter, wrap((req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND deleted = 0').get(String(email || '').trim());
  if (!u || !u.active || !verifyPassword(password || '', u.pass)) {
    res.status(401);
    return { error: 'البريد أو كلمة المرور غير صحيحة' };
  }
  const { token, exp } = createSession(u.id);
  res.setHeader('Set-Cookie', sessionCookie(token, exp, SECURE && (req.secure || process.env.FORCE_SECURE_COOKIE === '1')));
  return { user: publicUser(u) };
}));
app.post('/api/logout', wrap((req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return { ok: true };
}));
app.get('/api/me', requireUser, wrap((req) => ({ user: req.user })));
app.post('/api/me/password', requireUser, wrap((req) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT pass FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current || '', u.pass)) throw new OpError('كلمة المرور الحالية غير صحيحة');
  if (String(next || '').length < 8) throw new OpError('كلمة المرور الجديدة 8 أحرف على الأقل');
  updateRow('users', req.user.id, { pass: hashPassword(next) }, req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
  return { ok: true };
}));

// ---------- المزامنة ----------
app.get('/api/pull', requireUser, wrap((req) => pull(req.user, Number(req.query.since) || 0)));
app.post('/api/push', requireUser, wrap((req) => ({ results: processOps(req.user, req.body?.ops || []) })));

// ---------- المرفقات ----------
const ALLOWED = /^(image\/(jpeg|png|heic|heif|webp|gif)|application\/pdf|application\/vnd\.(openxmlformats-officedocument\.[a-z.]+|ms-excel|ms-word)|application\/msword|text\/(plain|csv)|application\/zip)$/;
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});
app.post('/api/items/:id/attachments', requireUser, upload.single('file'), wrap((req) => {
  const { item, eng } = itemContext(req.params.id);
  const cleanup = () => req.file && fs.rm(req.file.path, () => {});
  if (!item || !isMember(req.user, eng)) { cleanup(); throw new OpError('البند غير موجود'); }
  if (!req.file) throw new OpError('نوع الملف غير مسموح (صور، PDF، Office، نص)');
  const id = String(req.body.id || uid());
  const ex = getRow('attachments', id);
  if (ex) { cleanup(); return { row: ex }; }
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
  return tx(() => {
    const row = insertRow('attachments', {
      id, item_id: item.id, name, mime: req.file.mimetype, size: req.file.size, uploaded_by: req.user.id, file: req.file.filename,
    }, req.user.id);
    audit(req.user.id, 'attachments', id, 'create', { name: [null, name] }, eng.id);
    // إضافة دليل بعد الاعتماد تعيد فتح البند
    const r = updateItem(req.user, item.id, {}, { evidenceChanged: item.status === 'closed', action: 'evidence' });
    return { row, item: r.row };
  });
}));
app.get('/api/attachments/:id', requireUser, (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND deleted = 0').get(req.params.id);
  const ctx = a && itemContext(a.item_id);
  if (!a || !ctx.item || !isMember(req.user, ctx.eng)) return res.status(404).json({ error: 'غير موجود' });
  const inline = /^image\/(jpeg|png|webp|gif)$|^application\/pdf$/.test(a.mime);
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(path.join(UPLOAD_DIR, a.file));
});

// ---------- السجل ----------
app.get('/api/history', requireUser, wrap((req) => {
  const { entity, id } = req.query;
  let engId = null;
  if (entity === 'items') engId = itemContext(id).eng?.id;
  else if (entity === 'engagements') engId = id;
  const eng = engId && getEngagement(engId);
  if (!eng || !isMember(req.user, eng)) throw new OpError('غير موجود');
  const rows = entity === 'items'
    ? db.prepare(`SELECT * FROM audit WHERE (entity = 'items' AND entity_id = ?)
        OR (entity IN ('comments','attachments') AND entity_id IN (SELECT id FROM comments WHERE item_id = ? UNION SELECT id FROM attachments WHERE item_id = ?))
        ORDER BY id DESC LIMIT 200`).all(id, id, id)
    : db.prepare('SELECT * FROM audit WHERE engagement_id = ? ORDER BY id DESC LIMIT 300').all(id);
  return rows.map((r) => ({ ...r, diff: r.diff ? JSON.parse(r.diff) : null }));
}));

// ---------- القوالب والملفات ----------
app.post('/api/templates', requireUser, wrap((req) => saveTemplate(req.user, req.body || {})));
app.delete('/api/templates/:id', requireUser, wrap((req) => deleteTemplate(req.user, req.params.id)));
app.post('/api/engagements/from-template', requireUser, wrap((req) => engagementFromTemplate(req.user, req.body || {})));
app.post('/api/engagements/:id/rollover', requireUser, wrap((req) => rollover(req.user, req.params.id, req.body || {})));
app.post('/api/engagements/:id/save-template', requireUser, wrap((req) => templateFromEngagement(req.user, req.params.id, req.body?.name)));

// ---------- المستخدمون ----------
app.post('/api/users', requireRole('admin'), wrap((req) => {
  const { id, name, email, role, active, password } = req.body || {};
  if (!String(name || '').trim() || !/^\S+@\S+$/.test(email || '')) throw new OpError('الاسم والبريد مطلوبان');
  if (!ROLE[role]) throw new OpError('دور غير معروف');
  const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(email, id || '');
  if (dup) throw new OpError('البريد مستخدم بالفعل');
  if (id) {
    const u = getRow('users', id);
    if (!u) throw new OpError('غير موجود');
    if (id === req.user.id && (role !== 'admin' || !active)) throw new OpError('لا يمكنك إزالة صلاحيتك');
    const patch = { name: name.trim(), email: email.trim(), role, active: active ? 1 : 0 };
    if (password) {
      if (password.length < 8) throw new OpError('كلمة المرور 8 أحرف على الأقل');
      patch.pass = hashPassword(password);
    }
    audit(req.user.id, 'users', id, 'update', { role: [u.role, role], active: [u.active, patch.active] });
    if (!patch.active || password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return publicUser(updateRow('users', id, patch, req.user.id));
  }
  if (String(password || '').length < 8) throw new OpError('كلمة المرور 8 أحرف على الأقل');
  const row = insertRow('users', { id: uid(), name: name.trim(), email: email.trim(), role, active: 1, pass: hashPassword(password) }, req.user.id);
  audit(req.user.id, 'users', row.id, 'create', { role: [null, role] });
  return publicUser(row);
}));

// ---------- الإشعارات ----------
app.get('/api/push/vapid', wrap(() => ({ publicKey: getVapid().publicKey })));
app.post('/api/push/subscribe', requireUser, wrap((req) => {
  const s = req.body?.subscription;
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth || !/^https:\/\//.test(s.endpoint)) throw new OpError('اشتراك غير صالح');
  db.prepare(`INSERT INTO push_subs(endpoint, user_id, p256dh, auth, ua, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, fail_count = 0`)
    .run(s.endpoint, req.user.id, s.keys.p256dh, s.keys.auth, String(req.get('user-agent') || '').slice(0, 200), nowIso());
  return { ok: true };
}));
app.post('/api/push/unsubscribe', requireUser, wrap((req) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
  return { ok: true };
}));
app.get('/api/push/devices', requireUser, wrap((req) =>
  db.prepare('SELECT ua, created_at, last_ok_at, fail_count, substr(endpoint, 1, 40) AS endpoint_hint FROM push_subs WHERE user_id = ?').all(req.user.id)));
app.post('/api/push/test', requireUser, wrap(async (req) => {
  const id = uid();
  const p = getPrefs(req.user.id);
  db.prepare(`INSERT INTO notifications(id, user_id, kind, title, body, lock_title, lock_body, url, item_ids, score, local_date, created_at, push_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.user.id, 'test', 'إشعار تجريبي', 'الإشعارات تعمل على هذا الجهاز.',
    'متابعة سيزون المراجعة', 'إشعار تجريبي', '#/notifs', '[]', 0, null, nowIso(), 'pending');
  const r = await pushToUser(req.user.id, { title: 'متابعة سيزون المراجعة', body: 'إشعار تجريبي — الإشعارات تعمل', url: '#/notifs', tag: 'test', nid: id }, 'high');
  db.prepare('UPDATE notifications SET push_status = ?, push_at = ?, push_error = ? WHERE id = ?').run(r.status, nowIso(), r.error || null, id);
  return { ...r, lock_privacy: p.lock_privacy };
}));
app.get('/api/prefs', requireUser, wrap((req) => getPrefs(req.user.id)));
app.put('/api/prefs', requireUser, wrap((req) => savePrefs(req.user.id, req.body || {})));
app.get('/api/notifications', requireUser, wrap((req) => listNotifications(req.user.id, Math.min(Number(req.query.limit) || 150, 500))));
app.post('/api/notifications/read', requireUser, wrap((req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (ids) for (const id of ids) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(nowIso(), id, req.user.id);
  else db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
  return { ok: true };
}));

// ---------- Excel ----------
app.get('/api/export.xlsx', requireUser, wrap(async (req, res) => {
  const buf = await exportXlsx(req.user, req.query.engagement || null);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="audit-followup-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.end(Buffer.from(buf));
}));
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/import/preview', requireUser, memUpload.single('file'), wrap((req) => {
  if (!req.file) throw new OpError('اختر ملف Excel');
  return previewImport(req.user, req.file.buffer, { createMissing: req.body.createMissing === '1' });
}));
app.post('/api/import/commit', requireUser, wrap((req) => commitImport(req.user, req.body?.token)));

// ---------- النسخ الاحتياطي ----------
const BACKUP_TABLES = ['users', 'companies', 'engagements', 'items', 'comments', 'attachments', 'templates', 'prefs', 'audit'];
app.get('/api/admin/backup', requireRole('admin'), wrap((req, res) => {
  const data = { app: 'audit-season-tracker', at: nowIso(), tables: {} };
  for (const t of BACKUP_TABLES) data.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader('Content-Disposition', `attachment; filename="backup-${nowIso().slice(0, 10)}.json"`);
  audit(req.user.id, 'system', 'backup', 'download', null);
  return data;
}));
app.get('/api/admin/backups', requireRole('admin'), wrap(() =>
  fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite')).sort().reverse()
    .map((f) => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size }))));
app.post('/api/admin/backup-now', requireRole('admin'), wrap(() => ({ name: snapshot() })));
app.post('/api/admin/restore', requireRole('admin'), express.json({ limit: '200mb' }), wrap((req) => {
  const data = req.body;
  if (data?.app !== 'audit-season-tracker' || !data.tables?.users?.length) throw new OpError('ملف نسخة احتياطية غير صالح');
  snapshot('pre-restore');
  tx(() => {
    for (const t of BACKUP_TABLES) {
      const rows = data.tables[t] || [];
      db.exec(`DELETE FROM ${t}`);
      for (const r of rows) {
        const cols = Object.keys(r).filter((c) => /^[a-z_]+$/.test(c));
        db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => r[c]));
      }
    }
    db.exec('DELETE FROM sessions; DELETE FROM applied_ops;');
    const maxRev = Math.max(0, ...['users', 'companies', 'engagements', 'items', 'comments', 'attachments', 'templates']
      .map((t) => db.prepare(`SELECT MAX(rev) m FROM ${t}`).get().m || 0));
    db.prepare("UPDATE meta SET value = ? WHERE key = 'rev'").run(String(maxRev + 1));
  });
  return { ok: true, note: 'تمت الاستعادة. سجّل الدخول مجددًا على كل الأجهزة.' };
}));

function snapshot(tag = 'auto') {
  const name = `db-${nowIso().replace(/[:.]/g, '-')}-${tag}.sqlite`;
  db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, name).replace(/'/g, "''")}'`);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('-auto.sqlite')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.rmSync(path.join(BACKUP_DIR, f));
  return name;
}

app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));

// ---------- الملفات الثابتة ----------
app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: 0 }));
app.use(express.static(path.join(ROOT, 'public'), {
  maxAge: 0,
  setHeaders: (res, p) => {
    if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    if (p.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
  },
}));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------- الجدولة على الخادم ----------
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await runEngine(new Date()); } catch (e) { console.error('notify engine', e); } finally { running = false; }
}
if (process.env.DISABLE_SCHEDULER !== '1') {
  setInterval(tick, 60_000);
  setTimeout(tick, 5_000);
  let lastBackup = '';
  setInterval(() => {
    const day = nowIso().slice(0, 10);
    if (day !== lastBackup && new Date().getUTCHours() === 0) { lastBackup = day; try { snapshot(); } catch (e) { console.error('backup', e); } }
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  }, 10 * 60_000);
}

if (process.env.TLS_CERT && process.env.TLS_KEY) {
  https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, app)
    .listen(PORT, () => console.log(`HTTPS على المنفذ ${PORT}`));
} else {
  app.listen(PORT, () => console.log(`يعمل على http://localhost:${PORT} — استخدم HTTPS عبر بروكسي في الإنتاج`));
}

export { app, SPECS, decode };
