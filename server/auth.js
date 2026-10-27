import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

const SESSION_DAYS = 30;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(token, userId, nowIso(), exp);
  return { token, exp };
}
export function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, exp, secure) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(exp).toUTCString()}${secure ? '; Secure' : ''}`;
}

export function authMiddleware(req, res, next) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (s && s.expires_at > nowIso()) {
      const u = db.prepare('SELECT id, name, email, role, active FROM users WHERE id = ? AND deleted = 0').get(s.user_id);
      if (u && u.active) {
        req.user = u;
        req.sessionToken = token;
      }
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  next();
}
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'لا تملك الصلاحية' });
    next();
  };
}

// حد بسيط لمحاولات الدخول لكل عنوان IP
const attempts = new Map();
export function loginLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (a.length >= 10) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد ربع ساعة' });
  a.push(now);
  attempts.set(key, a);
  next();
}
