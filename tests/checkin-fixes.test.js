// The Phase 3 defects QA reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp, CHECK_IN_TOKEN_RETENTION_MS } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';

const DAY = 86400000;

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  let time = Date.parse('2026-09-14T18:00:00+07:00');
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time, sendOtp: async () => {} });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  /** A session written straight in, so these tests are not about OTP budgets. */
  function session(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), userId, time + 365 * DAY);
    return token;
  }
  let seq = 2000000;
  function user(email, role = 'member') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,email_verified_at,created_at) VALUES(?,?,?,?,?)')
      .run(id, email, role, time, time);
    return id;
  }
  function member(email, name = 'สุดา ใจดี') {
    const userId = user(email);
    const id = randomUUID();
    db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)`)
      .run(id, userId, `GYM-${String(seq).padStart(12, '0')}`, name, `089${seq++}`, time, time);
    return { id, token: session(userId) };
  }
  const staff = email => session(user(email, 'staff'));
  /** Hands a member a membership without walking the whole purchase flow. */
  function grant(memberId, { days = 30, sessions = null } = {}) {
    const pkg = db.prepare("SELECT id FROM packages WHERE code='UNLIMITED_30D'").get();
    const orderId = randomUUID();
    db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
      package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
      status,created_at,expires_at,updated_at) VALUES(?,?,?,'X','รายเดือน','unlimited',?,NULL,100000,'paid',?,?,?)`)
      .run(orderId, memberId, pkg.id, days, time, time + DAY, time);
    db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,expires_at,
      sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), orderId, memberId, pkg.id, time, time + days * DAY, sessions, sessions, time);
  }
  const qrOf = async token => (await call('post', '/me/check-in-token', token, {}).expect(201)).body.qr;
  const scan = (token, qr) => call('post', '/check-ins/verify', token, { qr, device_label: 'เคาน์เตอร์ 1' });

  return { db, app, call, member, staff, grant, qrOf, scan, tick: ms => { time += ms; } };
}

test('the sweeper deletes check-in tokens once they are a week stale', async t => {
  // The QR screen mints a fresh token about once a minute, and nothing used to
  // delete any of them.
  const { call, member, grant, app, db, tick } = fixture(t);
  const who = member('mint@example.test');
  grant(who.id);
  for (let i = 0; i < 20; i++) { tick(1000); await call('post', '/me/check-in-token', who.token, {}).expect(201); }
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 20);

  // A week is the retention, so two days later they are all still there.
  tick(2 * DAY);
  app.locals.sweep();
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 20,
    'a token from two days ago is still inside the retention window');

  tick(CHECK_IN_TOKEN_RETENTION_MS);
  app.locals.sweep();
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 0);

  // A live token is never swept, whatever else goes.
  await call('post', '/me/check-in-token', who.token, {}).expect(201);
  app.locals.sweep();
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 1);
});

test('one account cannot mint check-in QR codes without end', async t => {
  const { call, member, grant, db, tick } = fixture(t);
  const who = member('flood@example.test');
  grant(who.id);
  const statuses = [];
  for (let i = 0; i < 200; i++) { tick(100); statuses.push((await call('post', '/me/check-in-token', who.token, {})).status); }
  assert.ok(statuses.includes(429), 'issuing a QR writes to the database, so it needs a ceiling like every other write');

  // The ceiling still leaves room for the screen to renew itself for hours.
  assert.ok(statuses.filter(s => s === 201).length >= 120);
  assert.ok(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n <= 121);

  // Another member is unaffected: the budget is per account.
  const other = member('calm@example.test');
  grant(other.id);
  await call('post', '/me/check-in-token', other.token, {}).expect(201);
});

test('a repeat scan still tells the counter what is left', async t => {
  // "How many do I have?" is asked just as often by somebody who walked back in.
  const { member, staff, grant, qrOf, scan, tick } = fixture(t);
  const counter = staff('staff-dup@example.test');
  const who = member('again@example.test', 'มาอีกรอบ');
  grant(who.id, { days: 90, sessions: 5 });

  const first = await scan(counter, await qrOf(who.token)).expect(200);
  assert.equal(first.body.remaining.sessions_remaining, 4);

  tick(60000);
  const repeat = await scan(counter, await qrOf(who.token)).expect(409);
  assert.equal(repeat.body.result, 'duplicate');
  assert.ok(repeat.body.remaining, 'the counter screen went blank on the question it is asked most');
  assert.equal(repeat.body.remaining.sessions_remaining, 4, 'and the repeat took nothing more');
});

test('scans that belong to nobody can be read on their own', async t => {
  const { call, member, staff, grant, qrOf, scan } = fixture(t);
  const counter = staff('staff-log@example.test');
  const who = member('real@example.test', 'ผ่าน ทุกครั้ง');
  grant(who.id);
  await scan(counter, await qrOf(who.token)).expect(200);
  for (const junk of ['GYMCHK1.not-a-real-token.00', 'https://example.com/other-app', 'GYMCHK1..']) {
    await scan(counter, junk).expect(409);
  }
  // An empty box is a slip of the hand, not a scan, so it is never logged.
  await scan(counter, '').expect(400);

  // The default still returns everything, so nothing is hidden from an audit.
  const all = await call('get', '/check-ins', counter).expect(200);
  assert.equal(all.body.total, 4);
  assert.equal(all.body.unknown_total, 3);

  // The screen asks for one side or the other, so a spray of junk cannot bury
  // the day's real visits.
  const real = await call('get', '/check-ins?scope=identified', counter).expect(200);
  assert.equal(real.body.total, 1);
  assert.equal(real.body.items[0].member_name, 'ผ่าน ทุกครั้ง');

  const junk = await call('get', '/check-ins?scope=unknown', counter).expect(200);
  assert.equal(junk.body.total, 3);
  assert.ok(junk.body.items.every(item => item.member_name === null));
  assert.ok(junk.body.items.every(item => item.failure_reason));

  await call('get', '/check-ins?scope=nonsense', counter).expect(400);
});
