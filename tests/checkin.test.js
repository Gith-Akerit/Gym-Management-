// Letting somebody in at the counter.
//
// The member shows the card the gym sent them. What the scanner reads is a
// signed token with no name in it; what decides whether the person holding it
// is the member is the photograph on the screen, and that is a human's job.
// Everything below is about the part a machine can be held to: the quota, the
// duplicate window, the expiry, and who is allowed to scan at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { hashPassword } from '../server/passwords.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';

const DAY = 86400000;
const PASSWORD = 'counter-test-password';
const HASH = hashPassword(PASSWORD);

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-checkin-'));
  let time = Date.parse('2026-09-14T18:00:00+07:00');
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos')),
    promptPayId: '0899999999',
  });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  /** Staff and owners sign in with a password; nobody else signs in at all. */
  async function login(email, role = 'admin') {
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), email, role, HASH, time, time);
    }
    return (await call('post', '/auth/login', null, { email, password: PASSWORD }).expect(200)).body.token;
  }
  /** A member as the counter makes one: a name, a phone number, and a card. */
  async function member(staffToken, name = 'สุดา ใจดี') {
    return (await call('post', '/members', staffToken, {
      name, phone: `089${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    }).expect(201)).body;
  }
  /** Puts one of the seeded packages on sale. */
  async function sell(adminToken, code, overrides = {}) {
    const pkg = db.prepare('SELECT * FROM packages WHERE code=?').get(code);
    await call('put', `/packages/${pkg.id}`, adminToken, {
      version: pkg.version, code: pkg.code, name_th: pkg.name_th, type: pkg.type,
      duration_days: overrides.duration_days ?? pkg.duration_days,
      session_limit: pkg.session_limit, price_satang: 100000, status: 'active',
    }).expect(200);
    return db.prepare('SELECT * FROM packages WHERE code=?').get(code);
  }
  /** The counter takes the money and hands the package over. */
  async function buy(memberId, adminToken, packageId) {
    return (await call('post', `/members/${memberId}/grant`, adminToken)
      .field('package_id', packageId).field('payment_method', 'cash').expect(201)).body.entitlement;
  }
  const cardFor = async (staffToken, memberId) =>
    (await call('get', `/members/${memberId}/card`, staffToken).expect(200)).body.qr;
  const scan = (staffToken, qr, device_label = 'เคาน์เตอร์ 1') =>
    call('post', '/check-ins/verify', staffToken, { qr, device_label });

  return { db, app, call, login, member, sell, buy, cardFor, scan, tick: ms => { time += ms; }, at: () => time };
}

// ------------------------------------------------------------- the decision

test('an unlimited package lets a member in and shows the counter who they are', async t => {
  const { member, login, sell, buy, cardFor, scan, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const row = await member(admin, 'มานี รักดี');
  const entitlement = await buy(row.id, admin, pkg.id);

  const staff = await login('staff1@example.test', 'staff');
  const result = await scan(staff, await cardFor(staff, row.id));
  assert.equal(result.status, 200);
  assert.equal(result.body.result, 'allowed');
  assert.equal(result.body.member.name, 'มานี รักดี');
  assert.equal(result.body.member.member_code, row.member_code);
  assert.equal(result.body.remaining.sessions_remaining, null, 'unlimited counts nothing');
  assert.equal(result.body.remaining.expires_at, entitlement.expires_at);

  const entry = db.prepare('SELECT * FROM check_ins ORDER BY checked_in_at DESC LIMIT 1').get();
  // CHK-025: the record has to answer "who, when, on what, by whom".
  assert.equal(entry.member_id, entitlement.member_id);
  assert.equal(entry.entitlement_id, entitlement.id);
  assert.equal(entry.device_label, 'เคาน์เตอร์ 1');
  assert.equal(entry.method, 'qr');
  assert.ok(entry.scanned_by && entry.checked_in_at);
});

test('a card can be scanned every day it is valid', async t => {
  const { member, login, sell, buy, cardFor, scan, tick } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const row = await member(admin);
  await buy(row.id, admin, pkg.id);
  let staff = await login('staff1@example.test', 'staff');
  const card = await cardFor(staff, row.id);

  // The old QR lasted a minute and died on use. A card is a picture in a chat
  // app that the member keeps: it has to still work on Thursday. The staff
  // session does not -- it runs out overnight, which is why they sign in again
  // rather than the card being reissued.
  for (const day of [0, 1, 2]) {
    if (day) { tick(DAY); staff = await login('staff1@example.test', 'staff'); }
    const result = await scan(staff, card);
    assert.equal(result.status, 200, `day ${day}`);
    assert.equal(result.body.result, 'allowed');
  }
});

test('a limited package counts down and stops at zero', async t => {
  const { member, login, sell, buy, cardFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'VISIT_10_90D');
  const row = await member(admin);
  const entitlement = await buy(row.id, admin, pkg.id);
  assert.equal(entitlement.sessions_remaining, 10);
  const staff = await login('staff1@example.test', 'staff');
  const card = await cardFor(staff, row.id);

  const seen = [];
  for (let visit = 0; visit < 10; visit++) {
    tick(6 * 60000);                              // a new visit, clear of the duplicate window
    const result = await scan(staff, card);
    assert.equal(result.status, 200, `visit ${visit + 1}`);
    seen.push(result.body.remaining.sessions_remaining);
  }
  assert.deepEqual(seen, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

  tick(6 * 60000);
  const eleventh = await scan(staff, card);
  assert.equal(eleventh.status, 409);
  assert.match(eleventh.body.failure_reason, /ใช้ครบจำนวนครั้ง|หมดอายุ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 0,
    'the quota must never go below zero');
});

test('scanning twice in a row is one visit, not two', async t => {
  const { member, login, sell, buy, cardFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'VISIT_10_90D');
  const row = await member(admin);
  const entitlement = await buy(row.id, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');
  const card = await cardFor(staff, row.id);

  assert.equal((await scan(staff, card)).status, 200);
  tick(30000);
  const again = await scan(staff, card);
  assert.equal(again.status, 409);
  assert.equal(again.body.result, 'duplicate');
  assert.match(again.body.failure_reason, /ไม่ได้หักสิทธิ์ซ้ำ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 9,
    'a repeat scan must not take a second session');

  // Past the window it is a genuine second visit. This is the rule that does
  // the work now: a permanent card is scanned twice by accident all the time.
  tick(6 * 60000);
  assert.equal((await scan(staff, card)).status, 200);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 8);
});

test('an expired package is refused even with sessions left on it', async t => {
  const { login, member, sell, buy, cardFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'VISIT_10_90D', { duration_days: 1 });
  const row = await member(admin);
  const entitlement = await buy(row.id, admin, pkg.id);
  const card = await cardFor(admin, row.id);

  tick(DAY + 60000);
  // A day on, everybody has been signed out; the counter opens again and the
  // card is the same card.
  const staff = await login('staff1@example.test', 'staff');
  const result = await scan(staff, card);
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /หมดอายุ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 10,
    'nothing may be deducted from an expired package');
});

test('a member with no package at all is told what to do about it', async t => {
  const { member, login, cardFor, scan } = fixture(t);
  const admin = await login('admin@example.test');
  const row = await member(admin);
  const staff = await login('staff1@example.test', 'staff');
  const result = await scan(staff, await cardFor(staff, row.id));
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /ยังไม่มีแพ็กเกจ/);
  assert.match(result.body.failure_reason, /ซื้อแพ็กเกจ/);
});

test('membership status beats the package: a suspended member cannot get in', async t => {
  const { call, member, login, sell, buy, cardFor, scan, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const row = await member(admin);
  const entitlement = await buy(row.id, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');

  // The card is in the member's hand before anybody suspends them, and it is
  // the card the counter will scan afterwards: the refusal has to happen here,
  // not at the point the card was issued.
  const card = await cardFor(staff, row.id);
  const current = db.prepare('SELECT * FROM members WHERE id=?').get(row.id);
  await call('delete', `/members/${row.id}`, admin, { version: current.version }).expect(200);

  const result = await scan(staff, card);
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /ถูกระงับ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, null);
});

test('when two packages are live the one expiring soonest is used first', async t => {
  const { member, login, sell, buy, cardFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test');
  const shortPkg = await sell(admin, 'VISIT_10_90D', { duration_days: 7 });
  const longPkg = await sell(admin, 'UNLIMITED_30D', { duration_days: 60 });
  const row = await member(admin);
  const soonest = await buy(row.id, admin, shortPkg.id);
  const later = await buy(row.id, admin, longPkg.id);
  assert.ok(soonest.expires_at < later.expires_at);
  const staff = await login('staff1@example.test', 'staff');
  const card = await cardFor(staff, row.id);

  assert.equal((await scan(staff, card)).status, 200);
  assert.equal(db.prepare('SELECT entitlement_id e FROM check_ins ORDER BY checked_in_at DESC LIMIT 1').get().e,
    soonest.id, 'the package expiring first must be used first');
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(soonest.id).s, 9);

  // Once the short one runs out the long one takes over.
  db.prepare('UPDATE entitlements SET sessions_remaining=0 WHERE id=?').run(soonest.id);
  tick(6 * 60000);
  await scan(staff, card).expect(200);
  assert.equal(db.prepare('SELECT entitlement_id e FROM check_ins ORDER BY checked_in_at DESC LIMIT 1').get().e, later.id);
});

test('a revoked entitlement stops working immediately', async t => {
  const { call, member, login, sell, buy, cardFor, scan, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const row = await member(admin);
  await buy(row.id, admin, pkg.id);
  const order = db.prepare("SELECT * FROM orders WHERE status='paid'").get();
  await call('post', `/admin/orders/${order.id}/reverse`, admin, { version: order.version, reason: 'อนุมัติผิดคน' }).expect(200);

  const staff = await login('staff1@example.test', 'staff');
  const result = await scan(staff, await cardFor(staff, row.id));
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /ยังไม่มีแพ็กเกจ|หมดอายุ/);
});

// ----------------------------------------------------------- who may scan

test('only staff and admins can scan or read the check-in log', async t => {
  const { call, member, login, cardFor, scan } = fixture(t);
  const admin = await login('admin@example.test');
  const row = await member(admin);
  const qr = await cardFor(admin, row.id);

  // Nobody signed in reaches any of it: there is no member account left to try
  // it with, so the only caller to keep out is an anonymous one.
  for (const path of ['/check-ins', '/check-ins/summary']) {
    assert.equal((await call('get', path, null)).status, 401);
  }
  assert.equal((await call('post', '/check-ins/verify', null, { qr })).status, 401);

  const staff = await login('staff1@example.test', 'staff');
  assert.equal((await scan(staff, qr)).status, 409);   // no package, but the scan was allowed
  assert.equal((await call('get', '/check-ins', staff)).status, 200);
});

test('staff may read the slip queue but never decide it', async t => {
  const { call, member, login, sell, buy, db } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const row = await member(admin);
  await buy(row.id, admin, pkg.id);
  const order = db.prepare('SELECT * FROM orders').get();
  const staff = await login('staff1@example.test', 'staff');

  assert.equal((await call('get', '/admin/orders?status=all', staff)).status, 200);
  assert.equal((await call('get', `/admin/orders/${order.id}`, staff)).status, 200);
  assert.equal((await call('post', `/admin/orders/${order.id}/reverse`, staff, { version: order.version, reason: 'x' })).status, 403);
  // Members are counter work now, so staff do reach that list -- deciding money
  // and roles is what stays with the owner.
  assert.equal((await call('get', '/members', staff)).status, 200);
  assert.equal((await call('get', '/users', staff)).status, 403);
});

// ------------------------------------------------------------------ history

test('the log keeps refusals as well as entries, and can be filtered', async t => {
  const { call, member, login, sell, buy, cardFor, scan, tick } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const allowed = await member(admin, 'อารี เข้าได้');
  await buy(allowed.id, admin, pkg.id);
  const refused = await member(admin, 'สมชาย ไม่มีสิทธิ์');
  const staff = await login('staff1@example.test', 'staff');

  await scan(staff, await cardFor(staff, allowed.id)).expect(200);
  tick(60000);
  await scan(staff, await cardFor(staff, refused.id)).expect(409);

  const log = await call('get', '/check-ins', staff).expect(200);
  assert.equal(log.body.total, 2);
  assert.deepEqual(log.body.items.map(i => i.result), ['denied', 'allowed']);
  assert.equal(log.body.items[0].member_name, 'สมชาย ไม่มีสิทธิ์');
  assert.ok(log.body.items[0].failure_reason, 'a refusal without its reason is useless later');

  const filtered = await call('get', `/check-ins?q=${encodeURIComponent('อารี')}`, staff).expect(200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.items[0].result, 'allowed');

  const byDay = await call('get', '/check-ins?date=2026-09-14', staff).expect(200);
  assert.equal(byDay.body.total, 2, 'the day boundary follows Asia/Bangkok, not UTC');
  assert.equal((await call('get', '/check-ins?date=2026-09-13', staff).expect(200)).body.total, 0);

  const summary = await call('get', '/check-ins/summary', staff).expect(200);
  assert.deepEqual(summary.body.items[0], { day: '2026-09-14', allowed: 1, denied: 1, duplicate: 0 });
});

test('a late-evening check-in is counted on the Bangkok day, not the UTC one', async t => {
  const { call, member, login, sell, buy, cardFor, scan, tick } = fixture(t);
  const admin = await login('admin@example.test');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const row = await member(admin);
  await buy(row.id, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');
  const card = await cardFor(staff, row.id);

  // 20:30 in Bangkok is 13:30 UTC — same day either way. 00:30 Bangkok is the
  // interesting one: still 17:30 UTC the day before.
  tick(Date.parse('2026-09-15T00:30:00+07:00') - Date.parse('2026-09-14T18:00:00+07:00'));
  await scan(staff, card).expect(200);
  const summary = await call('get', '/check-ins/summary', staff).expect(200);
  assert.equal(summary.body.items[0].day, '2026-09-15');
});

test('the schema carries no notion of a branch', async t => {
  const { db } = fixture(t);
  const columns = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
  for (const table of columns) {
    assert.equal(/branch/i.test(table.sql ?? ''), false, `${table.name} mentions a branch`);
  }
});
