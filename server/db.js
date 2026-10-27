import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');

const COMMON = `created_at TEXT, updated_at TEXT, updated_by TEXT, rev INTEGER DEFAULT 0, version INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0`;

db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO meta(key, value) VALUES ('rev', '0');
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
  pass TEXT NOT NULL, active INTEGER DEFAULT 1, ${COMMON});
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, expires_at TEXT);
CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, notes TEXT, ${COMMON});
CREATE TABLE IF NOT EXISTS engagements(id TEXT PRIMARY KEY, company_id TEXT NOT NULL, year INTEGER NOT NULL,
  in_charge_id TEXT, manager_id TEXT, team TEXT DEFAULT '[]', report_due TEXT, stage TEXT, caseware_url TEXT,
  sections TEXT DEFAULT '[]', status TEXT DEFAULT 'active', escalation_enabled INTEGER DEFAULT 0,
  escalation_days INTEGER DEFAULT 7, notes TEXT, ${COMMON});
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, section_code TEXT, type TEXT DEFAULT 'task',
  ref TEXT, wp_url TEXT, title TEXT NOT NULL, description TEXT, assignee_id TEXT, priority TEXT DEFAULT 'medium',
  due_date TEXT, last_followup TEXT, next_step TEXT, status TEXT DEFAULT 'not_started', progress INTEGER DEFAULT 0,
  conclusion TEXT, client_response TEXT, received_at TEXT, approved_by TEXT, approved_at TEXT,
  blocks_report INTEGER DEFAULT 0, depends_on TEXT DEFAULT '[]', snooze_until TEXT, status_changed_at TEXT,
  created_by TEXT, ${COMMON});
CREATE INDEX IF NOT EXISTS items_eng ON items(engagement_id);
CREATE INDEX IF NOT EXISTS items_rev ON items(rev);
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, item_id TEXT NOT NULL, user_id TEXT, body TEXT, ${COMMON});
CREATE INDEX IF NOT EXISTS comments_item ON comments(item_id);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, item_id TEXT NOT NULL, name TEXT, mime TEXT, size INTEGER,
  file TEXT, uploaded_by TEXT, ${COMMON});
CREATE INDEX IF NOT EXISTS att_item ON attachments(item_id);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, sections TEXT DEFAULT '[]', tasks TEXT DEFAULT '[]', ${COMMON});
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, user_id TEXT, entity TEXT, entity_id TEXT,
  engagement_id TEXT, action TEXT, diff TEXT);
CREATE INDEX IF NOT EXISTS audit_entity ON audit(entity, entity_id);
CREATE TABLE IF NOT EXISTS applied_ops(op_id TEXT PRIMARY KEY, user_id TEXT, at TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS prefs(user_id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id TEXT, p256dh TEXT, auth TEXT, ua TEXT,
  created_at TEXT, last_ok_at TEXT, fail_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, title TEXT, body TEXT,
  lock_title TEXT, lock_body TEXT, url TEXT, item_ids TEXT, engagement_id TEXT, score INTEGER, local_date TEXT,
  created_at TEXT, read_at TEXT, push_status TEXT, push_at TEXT, push_error TEXT);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, created_at);
CREATE TABLE IF NOT EXISTS notif_marks(user_id TEXT, item_id TEXT, kind TEXT, mark TEXT, at TEXT, PRIMARY KEY(user_id, item_id, kind));
CREATE TABLE IF NOT EXISTS notif_runs(user_id TEXT, key TEXT, at TEXT, PRIMARY KEY(user_id, key));
`);

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

// معاملة قابلة للتداخل عبر SAVEPOINT
let depth = 0;
export function tx(fn) {
  const sp = `sp${depth++}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const r = fn();
    db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  } finally {
    depth--;
  }
}

export function currentRev() {
  return Number(db.prepare("SELECT value FROM meta WHERE key='rev'").get().value);
}
export function nextRev() {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='rev'").run();
  return currentRev();
}

// ---------- مواصفات الكيانات القابلة للمزامنة ----------
export const SPECS = {
  users: { fields: ['name', 'email', 'role', 'active'], json: [] },
  companies: { fields: ['name', 'code', 'notes'], json: [] },
  engagements: {
    fields: ['company_id', 'year', 'in_charge_id', 'manager_id', 'team', 'report_due', 'stage', 'caseware_url',
      'sections', 'status', 'escalation_enabled', 'escalation_days', 'notes'],
    json: ['team', 'sections'],
  },
  items: {
    fields: ['engagement_id', 'section_code', 'type', 'ref', 'wp_url', 'title', 'description', 'assignee_id',
      'priority', 'due_date', 'last_followup', 'next_step', 'status', 'progress', 'conclusion', 'client_response',
      'received_at', 'approved_by', 'approved_at', 'blocks_report', 'depends_on', 'snooze_until',
      'status_changed_at', 'created_by'],
    json: ['depends_on'],
  },
  comments: { fields: ['item_id', 'user_id', 'body'], json: [] },
  attachments: { fields: ['item_id', 'name', 'mime', 'size', 'uploaded_by'], json: [] },
  templates: { fields: ['name', 'sections', 'tasks'], json: ['sections', 'tasks'] },
};
const META_FIELDS = ['id', 'created_at', 'updated_at', 'updated_by', 'rev', 'version', 'deleted'];

export function decode(entity, row) {
  if (!row) return null;
  const spec = SPECS[entity];
  const out = {};
  for (const f of [...META_FIELDS, ...spec.fields]) if (f in row) out[f] = row[f];
  for (const f of spec.json) {
    try { out[f] = row[f] ? JSON.parse(row[f]) : []; } catch { out[f] = []; }
  }
  return out;
}
function encodeVal(entity, f, v) {
  if (SPECS[entity].json.includes(f)) return JSON.stringify(v ?? []);
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function getRow(entity, id) {
  return decode(entity, db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id));
}

export function insertRow(entity, data, userId) {
  const now = nowIso();
  const rev = nextRev();
  const row = { ...data, created_at: data.created_at || now, updated_at: now, updated_by: userId, rev, version: 1, deleted: 0 };
  const cols = ['id', ...SPECS[entity].fields.filter((f) => f in row), 'created_at', 'updated_at', 'updated_by', 'rev', 'version', 'deleted'];
  if (entity === 'attachments' && row.file) cols.push('file');
  if (entity === 'users') cols.push('pass');
  db.prepare(`INSERT INTO ${entity}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => encodeVal(entity, c, row[c])));
  return getRow(entity, row.id);
}

export function updateRow(entity, id, patch, userId) {
  const fields = Object.keys(patch).filter((f) => SPECS[entity].fields.includes(f) || f === 'deleted' || f === 'pass');
  const rev = nextRev();
  const sets = [...fields.map((f) => `${f} = ?`), 'updated_at = ?', 'updated_by = ?', 'rev = ?', 'version = version + 1'];
  db.prepare(`UPDATE ${entity} SET ${sets.join(', ')} WHERE id = ?`)
    .run(...fields.map((f) => encodeVal(entity, f, patch[f])), nowIso(), userId, rev, id);
  return getRow(entity, id);
}

// لمس السجلات لتصل في المزامنة القادمة (مثلًا عند إضافة عضو للفريق).
export function touch(entity, where, ...args) {
  const rev = nextRev();
  db.prepare(`UPDATE ${entity} SET rev = ? WHERE ${where}`).run(rev, ...args);
}

export function audit(userId, entity, entityId, action, diff, engagementId = null) {
  db.prepare('INSERT INTO audit(at, user_id, entity, entity_id, engagement_id, action, diff) VALUES (?,?,?,?,?,?,?)')
    .run(nowIso(), userId, entity, entityId, engagementId, action, diff ? JSON.stringify(diff) : null);
}

export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active };
}
