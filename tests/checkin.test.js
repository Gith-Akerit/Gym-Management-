import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { decodeCheckInQr, encodeCheckInQr } from '../server/checkin.js';

const DAY = 86400000;

function jpeg() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-checkin-'));
  const inbox = new Map();
  let time = Date.parse('2026-09-14T18:00:00+07:00');
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code),
    slipStore: new SlipStore(root), promptPayId: '0899999999',
  });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function login(email, role = 'member') {
    if (role !== 'member') db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), email, role, time);
    const start = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const verified = await call('post', '/auth/verify-otp', null, { challenge_id: start.body.challenge_id, code: inbox.get(email) }).expect(200);
    return verified.body.token;
  }
  async function member(email, name = 'สุดา ใจดี') {
    const token = await login(email);
    await call('put', '/me/profile', token, { name, phone: `089${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` }).expect(201);
    return token;
  }
  /** Puts a package on sale and walks one member all the way to an entitlement. */
  async function sell(adminToken, code, overrides = {}) {
    const pkg = db.prepare('SELECT * FROM packages WHERE code=?').get(code);
    await call('put', `/packages/${pkg.id}`, adminToken, {
      version: pkg.version, code: pkg.code, name_th: pkg.name_th, type: pkg.type,
      duration_days: overrides.duration_days ?? pkg.duration_days,
      session_limit: pkg.session_limit, price_satang: 100000, status: 'active',
    }).expect(200);
    return db.prepare('SELECT * FROM packages WHERE code=?').get(code);
  }
  async function buy(memberToken, adminToken, packageId) {
    const order = (await call('post', '/orders', memberToken, { package_id: packageId }).expect(201)).body.order;
    await http.post(`/api/orders/${order.id}/slip`).set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${memberToken}`)
      .field('reference_no', `REF-${randomUUID().slice(0, 8)}`)
      .field('transferred_at', '2026-09-14T17:30')
      .attach('slip', jpeg(), { filename: 'slip.jpg', contentType: 'image/jpeg' }).expect(201);
    return (await call('post', `/admin/orders/${order.id}/approve`, adminToken,
      { version: order.version + 1, checked_against_bank: true }).expect(200)).body.entitlement;
  }
  const qrFor = async memberToken => (await call('post', '/me/check-in-token', memberToken).expect(201)).body;
  const scan = (staffToken, qr, device_label = 'เคาน์เตอร์ 1') =>
    call('post', '/check-ins/verify', staffToken, { qr, device_label });

  return { db, app, call, login, member, sell, buy, qrFor, scan, tick: ms => { time += ms; }, at: () => time };
}

// ------------------------------------------------------------------ the QR

test('the QR carries no personal data and is rejected once tampered with', async t => {
  const { call, member, db } = fixture(t);
  const token = await member('qr@example.test', 'ปิติ ตั้งใจ');
  const issued = await call('post', '/me/check-in-token', token).expect(201);

  const decoded = decodeCheckInQr(issued.body.qr);
  assert.ok(decoded, 'the QR must decode');
  // CHK-020: everything identifying stays on the server side of the lookup.
  const row = db.prepare('SELECT * FROM members WHERE id=(SELECT member_id FROM check_in_tokens WHERE id=?)').get(decoded.id);
  for (const secretish of [row.name, row.member_code, row.phone, row.id]) {
    assert.equal(issued.body.qr.includes(secretish), false, `QR leaked ${secretish}`);
  }
  assert.match(issued.body.qr, /^GYMCHK1\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);

  for (const bad of ['', 'GYMCHK1', 'nonsense', `GYMCHK1.${decoded.id}`, `OTHER.${decoded.id}.${decoded.signature}`]) {
    assert.equal(decodeCheckInQr(bad), null, `must not decode: ${bad}`);
  }
});

test('a QR signed with a different key, or for a token that never existed, is refused', async t => {
  const { member, login, qrFor, scan, db } = fixture(t);
  const memberToken = await member('forge@example.test');
  const staff = await login('staff1@example.test', 'staff');
  const real = decodeCheckInQr((await qrFor(memberToken)).qr);

  const forged = [
    encodeCheckInQr(randomUUID(), real.signature),                    // real signature, unknown id
    encodeCheckInQr(real.id, 'a'.repeat(64)),                         // real id, invented signature
    'GYMCHK1.not-a-uuid.' + 'b'.repeat(64),
    'https://example.com/some-other-app-qr',
  ];
  for (const qr of forged) {
    const response = await scan(staff, qr);
    assert.equal(response.status, 409, qr);
    assert.equal(response.body.result, 'denied');
    assert.match(response.body.failure_reason, /QR ไม่ถูกต้อง/);
  }
  // Every refusal is still recorded — the counter may need to explain it later.
  assert.equal(db.prepare("SELECT count(*) n FROM check_ins WHERE result='denied'").get().n, forged.length);
});

test('asking for a new QR kills the one already on screen', async t => {
  const { member, login, qrFor, scan } = fixture(t);
  const memberToken = await member('rotate@example.test');
  const staff = await login('staff1@example.test', 'staff');

  const first = await qrFor(memberToken);
  await qrFor(memberToken);                       // the member refreshed the screen
  const stale = await scan(staff, first.qr);
  assert.equal(stale.status, 409);
  assert.match(stale.body.failure_reason, /หมดอายุ/);
});

test('a screenshot passed to a friend expires, and a used QR cannot be replayed', async t => {
  const { member, login, sell, buy, qrFor, scan, tick } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const memberToken = await member('share@example.test');
  await buy(memberToken, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');

  const shared = await qrFor(memberToken);
  tick(61000);                                    // a minute later, at the door
  const late = await scan(staff, shared.qr);
  assert.equal(late.status, 409);
  assert.match(late.body.failure_reason, /หมดอายุ/);

  // And a QR that did work cannot be used a second time.
  const fresh = await qrFor(memberToken);
  assert.equal((await scan(staff, fresh.qr)).status, 200);
  const replay = await scan(staff, fresh.qr);
  assert.equal(replay.status, 409);
  assert.match(replay.body.failure_reason, /ถูกใช้ไปแล้ว/);
});

// ------------------------------------------------------------- the decision

test('an unlimited package lets a member in and shows the counter who they are', async t => {
  const { member, login, sell, buy, qrFor, scan, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const memberToken = await member('welcome@example.test', 'มานี รักดี');
  const entitlement = await buy(memberToken, admin, pkg.id);

  const result = await scan(await login('staff1@example.test', 'staff'), (await qrFor(memberToken)).qr);
  assert.equal(result.status, 200);
  assert.equal(result.body.result, 'allowed');
  assert.equal(result.body.member.name, 'มานี รักดี');
  assert.equal(result.body.remaining.sessions_remaining, null, 'unlimited counts nothing');
  assert.equal(result.body.remaining.expires_at, entitlement.expires_at);

  const row = db.prepare('SELECT * FROM check_ins ORDER BY checked_in_at DESC LIMIT 1').get();
  // CHK-025: the record has to answer "who, when, on what, by whom".
  assert.equal(row.member_id, entitlement.member_id);
  assert.equal(row.entitlement_id, entitlement.id);
  assert.equal(row.device_label, 'เคาน์เตอร์ 1');
  assert.equal(row.method, 'qr');
  assert.ok(row.scanned_by && row.checked_in_at);
});

test('a limited package counts down and stops at zero', async t => {
  const { member, login, sell, buy, qrFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'VISIT_10_90D');
  const memberToken = await member('tenvisits@example.test');
  const entitlement = await buy(memberToken, admin, pkg.id);
  assert.equal(entitlement.sessions_remaining, 10);
  const staff = await login('staff1@example.test', 'staff');

  const seen = [];
  for (let visit = 0; visit < 10; visit++) {
    tick(6 * 60000);                              // a new visit, clear of the duplicate window
    const result = await scan(staff, (await qrFor(memberToken)).qr);
    assert.equal(result.status, 200, `visit ${visit + 1}`);
    seen.push(result.body.remaining.sessions_remaining);
  }
  assert.deepEqual(seen, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

  tick(6 * 60000);
  const eleventh = await scan(staff, (await qrFor(memberToken)).qr);
  assert.equal(eleventh.status, 409);
  assert.match(eleventh.body.failure_reason, /ใช้ครบจำนวนครั้ง|หมดอายุ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 0,
    'the quota must never go below zero');
});

test('scanning twice in a row is one visit, not two', async t => {
  const { member, login, sell, buy, qrFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'VISIT_10_90D');
  const memberToken = await member('twice@example.test');
  const entitlement = await buy(memberToken, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');

  assert.equal((await scan(staff, (await qrFor(memberToken)).qr)).status, 200);
  tick(30000);
  const again = await scan(staff, (await qrFor(memberToken)).qr);
  assert.equal(again.status, 409);
  assert.equal(again.body.result, 'duplicate');
  assert.match(again.body.failure_reason, /ไม่ได้หักสิทธิ์ซ้ำ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 9,
    'a repeat scan must not take a second session');

  // Past the window it is a genuine second visit.
  tick(6 * 60000);
  assert.equal((await scan(staff, (await qrFor(memberToken)).qr)).status, 200);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 8);
});

test('an expired package is refused even with sessions left on it', async t => {
  const { login, member, sell, buy, qrFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'VISIT_10_90D', { duration_days: 1 });
  const entitlement = await buy(await member('stale@example.test'), admin, pkg.id);

  // A day later everybody has been signed out too, so sign back in the way they
  // would the next evening.
  tick(DAY + 60000);
  const memberToken = await login('stale@example.test');
  const staff = await login('staff1@example.test', 'staff');
  const result = await scan(staff, (await qrFor(memberToken)).qr);
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /หมดอายุ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, 10,
    'nothing may be deducted from an expired package');
});

test('a member with no package at all is told what to do about it', async t => {
  const { member, login, qrFor, scan } = fixture(t);
  const memberToken = await member('nopackage@example.test');
  const staff = await login('staff1@example.test', 'staff');
  const result = await scan(staff, (await qrFor(memberToken)).qr);
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /ยังไม่มีแพ็กเกจ/);
  assert.match(result.body.failure_reason, /ซื้อแพ็กเกจ/);
});

test('membership status beats the package: a suspended member cannot get in', async t => {
  const { call, member, login, sell, buy, qrFor, scan, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const memberToken = await member('suspended@example.test');
  const entitlement = await buy(memberToken, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');

  // The QR is issued while everything is fine, then the admin suspends them —
  // the code in their hand must stop working, not merely stop being issued.
  const held = await qrFor(memberToken);
  const row = db.prepare('SELECT * FROM members WHERE id=?').get(entitlement.member_id);
  await call('delete', `/members/${row.id}`, admin, { version: row.version }).expect(200);

  const result = await scan(staff, held.qr);
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /ถูกระงับ/);
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(entitlement.id).s, null);

  // They cannot get a fresh code either.
  await call('post', '/me/check-in-token', memberToken).expect(403);
});

test('when two packages are live the one expiring soonest is used first', async t => {
  const { member, login, sell, buy, qrFor, scan, tick, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const shortPkg = await sell(admin, 'VISIT_10_90D', { duration_days: 7 });
  const longPkg = await sell(admin, 'UNLIMITED_30D', { duration_days: 60 });
  const memberToken = await member('stacked@example.test');
  const soonest = await buy(memberToken, admin, shortPkg.id);
  const later = await buy(memberToken, admin, longPkg.id);
  assert.ok(soonest.expires_at < later.expires_at);
  const staff = await login('staff1@example.test', 'staff');

  const result = await scan(staff, (await qrFor(memberToken)).qr);
  assert.equal(result.status, 200);
  assert.equal(db.prepare('SELECT entitlement_id e FROM check_ins ORDER BY checked_in_at DESC LIMIT 1').get().e,
    soonest.id, 'the package expiring first must be used first');
  assert.equal(db.prepare('SELECT sessions_remaining s FROM entitlements WHERE id=?').get(soonest.id).s, 9);

  // Once the short one runs out the long one takes over.
  db.prepare("UPDATE entitlements SET sessions_remaining=0 WHERE id=?").run(soonest.id);
  tick(6 * 60000);
  await scan(staff, (await qrFor(memberToken)).qr).expect(200);
  assert.equal(db.prepare('SELECT entitlement_id e FROM check_ins ORDER BY checked_in_at DESC LIMIT 1').get().e, later.id);
});

test('a revoked entitlement stops working immediately', async t => {
  const { call, member, login, sell, buy, qrFor, scan, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const memberToken = await member('revoked@example.test');
  await buy(memberToken, admin, pkg.id);
  const order = db.prepare("SELECT * FROM orders WHERE status='paid'").get();
  await call('post', `/admin/orders/${order.id}/reverse`, admin, { version: order.version, reason: 'อนุมัติผิดคน' }).expect(200);

  const result = await scan(await login('staff1@example.test', 'staff'), (await qrFor(memberToken)).qr);
  assert.equal(result.status, 409);
  assert.match(result.body.failure_reason, /ยังไม่มีแพ็กเกจ|หมดอายุ/);
});

// ----------------------------------------------------------- who may scan

test('only staff and admins can scan or read the check-in log', async t => {
  const { call, member, login, qrFor, scan } = fixture(t);
  const memberToken = await member('regular@example.test');
  const qr = (await qrFor(memberToken)).qr;

  for (const who of [null, memberToken]) {
    const expected = who ? 403 : 401;
    assert.equal((await call('post', '/check-ins/verify', who, { qr })).status, expected);
    assert.equal((await call('get', '/check-ins', who)).status, expected);
    assert.equal((await call('get', '/check-ins/summary', who)).status, expected);
  }
  const staff = await login('staff1@example.test', 'staff');
  assert.equal((await scan(staff, qr)).status, 409);   // no package, but the scan was allowed
  assert.equal((await call('get', '/check-ins', staff)).status, 200);
});

test('staff may read the slip queue but never decide it', async t => {
  const { call, member, login, sell, db } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const memberToken = await member('queue@example.test');
  const order = (await call('post', '/orders', memberToken, { package_id: pkg.id }).expect(201)).body.order;
  const staff = await login('staff1@example.test', 'staff');

  assert.equal((await call('get', '/admin/orders?status=all', staff)).status, 200);
  assert.equal((await call('get', `/admin/orders/${order.id}`, staff)).status, 200);
  assert.equal((await call('post', `/admin/orders/${order.id}/approve`, staff, { version: order.version, checked_against_bank: true })).status, 403);
  assert.equal((await call('post', `/admin/orders/${order.id}/reject`, staff, { version: order.version, reason: 'x' })).status, 403);
  assert.equal((await call('get', '/members', staff)).status, 403, 'staff still cannot browse members');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n, 0);
});

// ------------------------------------------------------------------ history

test('the log keeps refusals as well as entries, and can be filtered', async t => {
  const { call, member, login, sell, buy, qrFor, scan, tick } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const allowed = await member('in@example.test', 'อารี เข้าได้');
  await buy(allowed, admin, pkg.id);
  const refused = await member('out@example.test', 'สมชาย ไม่มีสิทธิ์');
  const staff = await login('staff1@example.test', 'staff');

  await scan(staff, (await qrFor(allowed)).qr).expect(200);
  tick(60000);
  await scan(staff, (await qrFor(refused)).qr).expect(409);

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

  // The member sees their own history and nobody else's.
  const mine = await call('get', '/me/check-ins', allowed).expect(200);
  assert.equal(mine.body.items.length, 1);
  assert.equal(mine.body.items[0].result, 'allowed');
});

test('a late-evening check-in is counted on the Bangkok day, not the UTC one', async t => {
  const { call, member, login, sell, buy, qrFor, scan, tick } = fixture(t);
  const admin = await login('admin@example.test', 'admin');
  const pkg = await sell(admin, 'UNLIMITED_30D');
  const memberToken = await member('evening@example.test');
  await buy(memberToken, admin, pkg.id);
  const staff = await login('staff1@example.test', 'staff');

  // 20:30 in Bangkok is 13:30 UTC — same day either way. 00:30 Bangkok is the
  // interesting one: still 17:30 UTC the day before.
  tick(Date.parse('2026-09-15T00:30:00+07:00') - Date.parse('2026-09-14T18:00:00+07:00'));
  await scan(staff, (await qrFor(memberToken)).qr).expect(200);
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
