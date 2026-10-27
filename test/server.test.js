// اختبارات الخادم: قواعد المراجعة، المزامنة والتعارضات، محرك الإشعارات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-'));
process.env.DATA_DIR = dir;
const { db, getRow } = await import('../server/db.js');
const { seedIfEmpty } = await import('../server/seed.js');
const { processOps, pull } = await import('../server/sync.js');
const { rollover } = await import('../server/templates.js');
const { runEngine, setSender, savePrefs } = await import('../server/notify.js');
seedIfEmpty();

const U = Object.fromEntries(db.prepare('SELECT id, name, email, role FROM users').all().map((u) => [u.email.split('@')[0], u]));
const eng = db.prepare("SELECT e.* FROM engagements e JOIN companies c ON c.id = e.company_id WHERE c.code = 'NIL'").get();
const item = (ref) => db.prepare('SELECT * FROM items WHERE engagement_id = ? AND ref = ?').get(eng.id, ref);
let n = 0;
const op = (user, entity, id, changes, base = {}, action = 'update', extra = {}) =>
  processOps(user, [{ opId: `op${++n}`, entity, id, action, changes, base, ...extra }])[0];

test('staff cannot approve; assignee cannot self-approve', () => {
  const d2 = item('D2'); // مسند لكريم
  assert.match(op(U.karim, 'items', d2.id, { status: 'closed' }, { status: d2.status }).error, /اعتماد/);
  const d3 = item('D3'); // مسند ليوسف (admin) — admin مستثنى؛ نختبر بمنى (senior غير عضو)
  const r = op(U.mona, 'items', d3.id, { status: 'closed' }, { status: d3.status });
  assert.ok(r.error, 'senior outside engagement should be rejected');
});

test('document receipt does not complete; response does not close', () => {
  const e3 = item('E3'); // waiting_client
  const r = op(U.youssef, 'items', e3.id, { received_at: '2026-10-27' }, { received_at: null });
  assert.equal(r.ok, true);
  assert.equal(getRow('items', e3.id).status, 'in_progress');
});

test('approve then change evidence reopens', () => {
  const d6 = item('D6');
  assert.equal(op(U.ahmed, 'items', d6.id, { status: 'closed' }, { status: d6.status }).ok, true);
  const a = getRow('items', d6.id);
  assert.equal(a.status, 'closed');
  assert.equal(a.approved_by, U.ahmed.id);
  // تغيير التنفيذ فقط لا يعيد الفتح
  op(U.karim, 'items', d6.id, { progress: 90 }, { progress: a.progress });
  assert.equal(getRow('items', d6.id).status, 'closed');
  op(U.karim, 'items', d6.id, { conclusion: 'نتيجة معدلة' }, { conclusion: null });
  const b = getRow('items', d6.id);
  assert.equal(b.status, 'in_progress');
  assert.equal(b.approved_by, null);
});

test('conflict detection with three-way base, force resolves', () => {
  const d7 = item('D7');
  assert.equal(op(U.youssef, 'items', d7.id, { next_step: 'A' }, { next_step: null }).ok, true);
  // جهاز آخر عدّل على نسخة قديمة
  const c = op(U.ahmed, 'items', d7.id, { next_step: 'B' }, { next_step: null });
  assert.ok(c.conflict);
  assert.equal(c.conflict.fields[0].theirs, 'A');
  // حقل مختلف لا يتعارض
  assert.equal(op(U.ahmed, 'items', d7.id, { priority: 'high' }, { priority: 'medium' }).ok, true);
  assert.equal(op(U.ahmed, 'items', d7.id, { next_step: 'B' }, { next_step: null }, 'update', { force: true }).ok, true);
  assert.equal(getRow('items', d7.id).next_step, 'B');
});

test('ops are idempotent', () => {
  const d5 = item('D5');
  const o = { opId: 'same-op', entity: 'items', id: d5.id, action: 'update', changes: { progress: 10 }, base: { progress: 0 } };
  assert.equal(processOps(U.youssef, [o])[0].ok, true);
  assert.equal(processOps(U.youssef, [o])[0].ok, true);
  assert.equal(getRow('items', d5.id).version, d5.version + 1);
});

test('staff sees only own engagements', () => {
  const p = pull(U.sara, 0);
  assert.ok(p.engagements.every((e) => (e.team || []).includes(U.sara.id)));
  assert.ok(p.engagements.length >= 1 && p.engagements.length < 3);
});

test('rollover clears results, approvals, dates', () => {
  const ne = rollover(U.ahmed, eng.id, { year: 2027 });
  const items = db.prepare('SELECT * FROM items WHERE engagement_id = ?').all(ne.id);
  assert.ok(items.length > 10);
  for (const i of items) {
    assert.equal(i.status, 'not_started');
    assert.equal(i.progress, 0);
    assert.equal(i.approved_by, null);
    assert.equal(i.due_date, null);
    assert.equal(i.conclusion, null);
    assert.equal(i.wp_url, null);
  }
  assert.equal(getRow('engagements', ne.id).caseware_url, null);
  assert.ok(items.every((i) => i.type === 'task' || i.type === 'doc_request'));
});

test('notification engine: quiet hours, grouping, dedupe, daily limit, privacy', async () => {
  const sent = [];
  setSender(async (sub, payload) => { sent.push(JSON.parse(payload)); });
  db.prepare("INSERT INTO push_subs(endpoint, user_id, p256dh, auth) VALUES ('https://push.example/1', ?, 'k', 'a')").run(U.youssef.id);
  savePrefs(U.youssef.id, { workdays: [0, 1, 2, 3, 4, 5, 6], daily_limit: 2 });
  // 23:00 القاهرة = ساعات هدوء
  assert.equal((await runEngine(new Date('2026-10-27T20:00:00Z'))).filter((x) => x.user_id === U.youssef.id).length, 0);
  // 10:00 القاهرة
  const out = (await runEngine(new Date('2026-10-27T07:00:00Z'))).filter((x) => x.user_id === U.youssef.id);
  assert.ok(out.some((x) => x.kind === 'morning'));
  const engIds = out.filter((x) => x.engagement_id).map((x) => x.engagement_id);
  assert.equal(new Set(engIds).size, engIds.length, 'one notification per engagement');
  const pushed = out.filter((x) => x.kind !== 'morning' && x.push_status === 'sent').length;
  assert.ok(pushed <= 2, 'daily limit respected');
  // لا تفاصيل حساسة في شاشة القفل
  for (const p of sent) assert.ok(!p.body.includes('النيل'), p.body);
  // تشغيل ثانٍ: لا تكرار
  const again = (await runEngine(new Date('2026-10-27T07:05:00Z'))).filter((x) => x.user_id === U.youssef.id);
  assert.equal(again.length, 0);
});

test('closed items stop reminders', async () => {
  setSender(async () => {});
  const d1 = item('D1'); // مسند لسارة، متأخر وبانتظار العميل
  savePrefs(U.sara.id, { workdays: [0, 1, 2, 3, 4, 5, 6] });
  op(U.ahmed, 'items', d1.id, { status: 'closed' }, { status: d1.status });
  const out = (await runEngine(new Date('2026-10-28T07:00:00Z'))).filter((x) => x.user_id === U.sara.id);
  assert.ok(out.every((x) => !(x.item_ids || []).includes(d1.id)));
});
