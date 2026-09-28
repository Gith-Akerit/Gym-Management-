import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration, PACKAGE_DRAFTS } from '../server/seed.js';
import { hashPassword } from '../server/passwords.js';

const PASSWORD = 'counter-test-password';
const HASH = hashPassword(PASSWORD);

function fixture(t, { seed = true } = {}) {
  const db = openDatabase(); migrate(db); if (seed) seedConfiguration(db, Date.now());
  let time = Date.now();
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); });
  const http = httpClient(app, t);
  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function login(email, role = 'staff') {
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), email, role, HASH, time, time);
    }
    return (await call('post', '/auth/login', null, { email, password: PASSWORD }).expect(200)).body.token;
  }
  /** Strips the fields the API computes so a GET response can be PUT back. */
  const editable = profile => {
    const { id, timezone, currency, updated_at, ...rest } = profile;
    return rest;
  };
  return { db, call, login, editable, tick: ms => { time += ms; } };
}

test('seed loads gym profile, hours and package drafts and never overwrites edits', t => {
  const { db } = fixture(t);
  const again = seedConfiguration(db, Date.now());
  assert.deepEqual(again, { profile: false, hours: 0, packages: [] });
  assert.equal(db.prepare('SELECT count(*) n FROM gym_hours').get().n, 7);
  assert.equal(db.prepare('SELECT count(*) n FROM packages').get().n, PACKAGE_DRAFTS.length);

  // Nothing the reporter has not confirmed may arrive as a published fact.
  assert.equal(db.prepare('SELECT hours_confirmed h FROM gym_profile WHERE id=1').get().h, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM packages WHERE price_satang IS NOT NULL AND code<>'TRIAL_1_VISIT'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM packages WHERE status<>'draft'").get().n, 0);

  db.prepare("UPDATE gym_profile SET name='แก้ไขแล้ว' WHERE id=1").run();
  seedConfiguration(db, Date.now());
  assert.equal(db.prepare('SELECT name FROM gym_profile WHERE id=1').get().name, 'แก้ไขแล้ว');
});

test('members read gym facts, admins edit them, and the phone shown is configurable', async t => {
  const { call, login, editable } = fixture(t);
  const staffToken = await login('gymreader@example.test');
  const adminToken = await login('gymadmin@example.test', 'admin');

  const seen = await call('get', '/gym', staffToken).expect(200);
  assert.equal(seen.body.profile.phone, '038541029');
  assert.equal(seen.body.profile.hours_confirmed, false);
  assert.equal(seen.body.hours.length, 7);
  assert.equal(seen.body.hours[0].closed, true);
  // Internal fields must not leak to members.
  assert.equal(seen.body.profile.phone_primary, undefined);
  assert.equal(seen.body.profile.phone_secondary, undefined);

  const full = await call('get', '/gym', adminToken).expect(200);
  const body = { ...editable(full.body.profile), phone_display: 'secondary', hours_confirmed: true };
  await call('put', '/gym', adminToken, body).expect(200);

  const after = await call('get', '/gym', staffToken).expect(200);
  assert.equal(after.body.profile.phone, '0863307368');
  assert.equal(after.body.profile.hours_confirmed, true);

  // A stale version loses rather than silently overwriting a concurrent edit.
  await call('put', '/gym', adminToken, body).expect(409);

  await call('put', '/gym', adminToken, { ...body, version: body.version + 1, phone_display: 'hidden' }).expect(200);
  assert.equal((await call('get', '/gym', staffToken).expect(200)).body.profile.phone, null);
});

test('staff cannot write gym settings or opening hours', async t => {
  const { call, login } = fixture(t);
  const staffToken = await login('staff@example.test', 'staff');
  for (const token of [null, staffToken]) {
    await call('put', '/gym', token, { name: 'ยึดยิม', phone_display: 'primary', version: 1 }).expect(token ? 403 : 401);
    await call('put', '/gym/hours', token, { hours: [] }).expect(token ? 403 : 401);
  }
});

test('opening hours round-trip and reject impossible ranges', async t => {
  const { call, login } = fixture(t);
  const adminToken = await login('hours@example.test', 'admin');
  const open = (weekday, open_time, close_time) => ({ weekday, closed: false, open_time, close_time });
  const week = [{ weekday: 0, closed: true, open_time: null, close_time: null },
    ...[1, 2, 3, 4, 5, 6].map(d => open(d, '17:00', '22:00'))];

  const saved = await call('put', '/gym/hours', adminToken, { hours: week }).expect(200);
  assert.equal(saved.body.hours[1].open_time, '17:00');
  assert.equal(saved.body.hours[0].closed, true);

  await call('put', '/gym/hours', adminToken, { hours: week.slice(0, 6) }).expect(400);
  await call('put', '/gym/hours', adminToken, { hours: [...week.slice(1), open(1, '08:00', '09:00')] }).expect(400);
  await call('put', '/gym/hours', adminToken, { hours: [...week.slice(1), open(0, '22:00', '17:00')] }).expect(400);
  await call('put', '/gym/hours', adminToken, { hours: [...week.slice(1), open(0, '25:00', '26:00')] }).expect(400);
});

test('package catalogue hides drafts from members and enforces admin-only writes', async t => {
  const { call, login, db } = fixture(t);
  const staffToken = await login('shopper@example.test');
  const adminToken = await login('pkgadmin@example.test', 'admin');

  assert.equal((await call('get', '/packages', staffToken).expect(200)).body.items.length, 0);
  assert.equal((await call('get', '/packages', adminToken).expect(200)).body.items.length, PACKAGE_DRAFTS.length);

  await call('post', '/packages', staffToken, { code: 'HACK_1', name_th: 'ของฟรี', type: 'unlimited', duration_days: 1 }).expect(403);
  const draft = db.prepare("SELECT * FROM packages WHERE code='UNLIMITED_30D'").get();
  await call('put', `/packages/${draft.id}`, staffToken,
    { version: draft.version, code: 'UNLIMITED_30D', name_th: 'x', type: 'unlimited', duration_days: 1 }).expect(403);
  await call('get', `/packages/${draft.id}`, staffToken).expect(403);
});

test('a package cannot go on sale without a price, and prices survive as exact satang', async t => {
  const { call, login } = fixture(t);
  const adminToken = await login('pricing@example.test', 'admin');
  const staffToken = await login('browse@example.test');

  const created = await call('post', '/packages', adminToken,
    { code: 'visit_10_180d', name_th: '10 ครั้ง 180 วัน', type: 'limited_sessions', duration_days: 180, session_limit: 10 }).expect(201);
  assert.equal(created.body.code, 'VISIT_10_180D');
  assert.equal(created.body.price_thb, null);
  assert.equal(created.body.status, 'draft');

  const base = { code: 'VISIT_10_180D', name_th: '10 ครั้ง 180 วัน', type: 'limited_sessions', duration_days: 180, session_limit: 10 };
  await call('put', `/packages/${created.body.id}`, adminToken, { ...base, version: created.body.version, status: 'active' }).expect(400);

  const priced = await call('put', `/packages/${created.body.id}`, adminToken,
    { ...base, version: created.body.version, price_thb: '1299.50', status: 'active' }).expect(200);
  assert.equal(priced.body.price_satang, 129950);
  assert.equal(priced.body.price_thb, 1299.5);

  assert.deepEqual((await call('get', '/packages', staffToken).expect(200)).body.items.map(p => p.code), ['VISIT_10_180D']);

  // Archiving keeps the row so Phase 2 orders still resolve.
  await call('delete', `/packages/${created.body.id}`, adminToken, { version: priced.body.version }).expect(200);
  assert.equal((await call('get', '/packages', staffToken).expect(200)).body.items.length, 0);
  assert.equal((await call('get', `/packages/${created.body.id}`, adminToken).expect(200)).body.status, 'archived');
});

test('package validation rejects mismatched type, bad prices and zero durations', async t => {
  const { call, login } = fixture(t);
  const adminToken = await login('validate@example.test', 'admin');
  const base = { code: 'CHECK_1', name_th: 'ทดสอบ', type: 'unlimited', duration_days: 30 };
  const rejected = [
    { ...base, session_limit: 5 },
    { ...base, type: 'limited_sessions' },
    { ...base, duration_days: 0 },
    { ...base, type: 'limited_sessions', session_limit: 0 },
    { ...base, price_satang: -1 },
    { ...base, price_thb: '1.005' },
    { ...base, price_satang: 1.5 },
    { ...base, price_thb: 1, price_satang: 100 },
    { ...base, code: 'no lower case' },
    { ...base, name_th: '' },
    { ...base, type: 'monthly' },
    { ...base, surprise: true },
  ];
  for (const body of rejected) await call('post', '/packages', adminToken, body).expect(400);
  await call('post', '/packages', adminToken, base).expect(201);
  await call('post', '/packages', adminToken, base).expect(409);
});

test('gym and package changes are written to the audit trail', async t => {
  const { call, login, db, editable } = fixture(t);
  const adminToken = await login('auditor@example.test', 'admin');
  await call('post', '/packages', adminToken, { code: 'AUDIT_1', name_th: 'ตรวจสอบ', type: 'unlimited', duration_days: 30 }).expect(201);
  const profile = (await call('get', '/gym', adminToken).expect(200)).body.profile;
  await call('put', '/gym', adminToken, { ...editable(profile), hours_note: 'ยืนยันกับเจ้าของแล้ว' }).expect(200);

  const actions = db.prepare('SELECT action, entity_type FROM audit_logs ORDER BY created_at').all();
  assert.ok(actions.some(a => a.action === 'package.create' && a.entity_type === 'package'));
  assert.ok(actions.some(a => a.action === 'gym.update' && a.entity_type === 'gym_profile'));
});
