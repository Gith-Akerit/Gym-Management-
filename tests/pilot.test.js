// Pilot mode: the gym trying the system before it has a mail provider or a
// PromptPay account. What has to hold is that nothing is faked -- the OTP is a
// real one-time code, the membership is a real membership -- and that turning
// the flag off later leaves every row created while it was on still usable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function fixture(t, { pilotMode = true } = {}) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-pilot-'));
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const sent = [];
  const options = {
    db, secret: SECRET, now: () => time,
    // A pilot app is built exactly as start.js builds it: no mailer, no
    // merchant id. If anything still reached for either, this would throw.
    sendOtp: async message => { sent.push(message); },
    slipStore: new SlipStore(root),
    promptPayId: pilotMode ? null : '0812345678',
    pilotMode,
  };
  let app = createApp(options);
  let http = httpClient(app, t);
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };

  /** Signs in the way a real member does, through the codes the admin can see. */
  async function login(email, role = 'member') {
    if (role !== 'member') {
      db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), email, role, time);
    }
    const start = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const code = pilotMode
      ? (await call('get', '/admin/pilot/otp-codes', adminToken).expect(200)).body.items.find(item => item.email === email).code
      : sent.at(-1).code;
    const verified = await call('post', '/auth/verify-otp', null, { challenge_id: start.body.challenge_id, code }).expect(200);
    return verified.body.token;
  }

  // One admin is created directly, because the code list is admin-only and
  // somebody has to be able to read it first.
  const adminId = randomUUID();
  db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?)").run(adminId, 'owner@example.test', time);
  const adminToken = 'a'.repeat(43);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)')
    .run(createHash('sha256').update(adminToken).digest('hex'), adminId, time + 86400000);

  let phone = 3000000;
  async function member(email, name = 'สมาชิก ทดลอง') {
    const token = await login(email);
    await call('put', '/me/profile', token, { name, phone: `089${phone++}` }).expect(201);
    return token;
  }
  async function priced(code = 'UNLIMITED_30D', baht = 1200) {
    const draft = db.prepare('SELECT * FROM packages WHERE code=?').get(code);
    await call('put', `/packages/${draft.id}`, adminToken, {
      version: draft.version, code: draft.code, name_th: draft.name_th, type: draft.type,
      duration_days: draft.duration_days, session_limit: draft.session_limit,
      price_thb: baht, status: 'active',
    }).expect(200);
    return draft.id;
  }

  /**
   * The same database, served by an app with the flag the other way round --
   * which is exactly what restarting the service without PILOT_MODE does.
   */
  function restartAs(mode) {
    app.locals.stopSweeper?.();
    app = createApp({ ...options, pilotMode: mode, promptPayId: mode ? null : '0812345678' });
    http = httpClient(app, t);
    return { call, app };
  }

  return { db, call, login, member, priced, adminToken, adminId, sent, restartAs, tick: ms => { time += ms; } };
}

test('the app runs with no PromptPay account and no mail server at all', async t => {
  const { call, adminToken } = fixture(t);
  await call('get', '/health').expect(200);
  // The one fact the login screen needs before anybody has signed in.
  const config = await call('get', '/public/config').expect(200);
  assert.deepEqual(config.body, { pilot_mode: true });
  // And the admin console still works end to end.
  await call('get', '/members', adminToken).expect(200);
  await call('get', '/packages', adminToken).expect(200);
});

test('the code is shown to the admin and to nobody else', async t => {
  const { call, db, adminToken } = fixture(t);
  const requested = await call('post', '/auth/request-otp', null, { email: 'walkin@example.test' }).expect(202);
  assert.equal(requested.body.pilot_mode, true, 'the login screen has to know which sentence to show');
  assert.ok(!JSON.stringify(requested.body).match(/\b\d{6}\b/), 'the code must never be in the member response');

  const board = await call('get', '/admin/pilot/otp-codes', adminToken).expect(200);
  const entry = board.body.items.find(item => item.email === 'walkin@example.test');
  assert.match(entry.code, /^\d{6}$/);
  assert.equal(entry.used, false);

  // It is a real one-time code, not a display: the stored challenge is still a
  // hash, and the code itself was never written to the database.
  const challenge = db.prepare('SELECT * FROM otp_challenges WHERE email=?').get('walkin@example.test');
  assert.ok(!challenge.code_hash.includes(entry.code));
  assert.ok(!JSON.stringify(challenge).includes(entry.code));

  const token = (await call('post', '/auth/verify-otp', null,
    { challenge_id: requested.body.challenge_id, code: entry.code }).expect(200)).body.token;

  // Signed in as that member, the code is nowhere they can reach it.
  await call('get', '/admin/pilot/otp-codes', token).expect(403);
  const me = await call('get', '/me', token).expect(200);
  assert.ok(!JSON.stringify(me.body).includes(entry.code));

  // Used codes stop being offered for retyping.
  const after = await call('get', '/admin/pilot/otp-codes', adminToken).expect(200);
  assert.equal(after.body.items.find(item => item.email === 'walkin@example.test').used, true);
});

test('the admin sees the code of the member whose page is open', async t => {
  const { call, db, member, adminToken, tick } = fixture(t);
  const token = await member('counter@example.test', 'มา ที่เคาน์เตอร์');
  const id = db.prepare('SELECT id FROM members WHERE user_id=(SELECT id FROM users WHERE email=?)').get('counter@example.test').id;

  // Nothing outstanding right after signing in.
  assert.equal((await call('get', `/members/${id}`, adminToken).expect(200)).body.pilot_otp, null);

  tick(61000);
  await call('post', '/auth/logout', token).expect(204);
  await call('post', '/auth/request-otp', null, { email: 'counter@example.test' }).expect(202);
  const detail = await call('get', `/members/${id}`, adminToken).expect(200);
  assert.match(detail.body.pilot_otp.code, /^\d{6}$/);
  assert.ok(detail.body.pilot_otp.expires_at > 0);

  // Five minutes later it is gone rather than stale.
  tick(300001);
  assert.equal((await call('get', `/members/${id}`, adminToken).expect(200)).body.pilot_otp, null);
});

test('a member cannot buy, and the admin hands the package over instead', async t => {
  const { call, db, member, priced, adminToken, adminId } = fixture(t);
  const packageId = await priced();
  const token = await member('given@example.test', 'ได้รับ แพ็กเกจ');
  const memberId = db.prepare('SELECT id FROM members WHERE user_id=(SELECT id FROM users WHERE email=?)').get('given@example.test').id;

  // Every way to start paying says so in Thai rather than failing obscurely.
  const refusedBuy = await call('post', '/orders', token, { package_id: packageId }).expect(403);
  assert.match(refusedBuy.body.error, /โหมดทดลอง/);
  const refusedQr = await call('get', `/orders/${randomUUID()}/qr.png`, token).expect(403);
  assert.match(refusedQr.body.error, /โหมดทดลอง/);

  // The note is not optional: a membership nobody paid for needs a reason.
  await call('post', `/members/${memberId}/grant`, adminToken, { package_id: packageId }).expect(400);
  await call('post', `/members/${memberId}/grant`, adminToken, { package_id: packageId, note: '  ' }).expect(400);

  const granted = await call('post', `/members/${memberId}/grant`, adminToken,
    { package_id: packageId, note: 'ทดลองใช้ช่วง pilot' }).expect(201);
  assert.equal(granted.body.order.status, 'paid');
  assert.equal(granted.body.order.manual_grant, 1);
  assert.equal(granted.body.order.review_note, 'ทดลองใช้ช่วง pilot');
  assert.equal(granted.body.order.price_thb, 1200, 'what it would have cost is still recorded');
  assert.equal(granted.body.entitlement.status, 'active');

  // The member has a working membership, from their own side.
  const mine = await call('get', '/entitlements', token).expect(200);
  assert.equal(mine.body.items.length, 1);

  // It is in the audit trail as a manual grant, with who did it.
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action='order.grant_manual'").get();
  assert.equal(audit.actor_id, adminId);

  // And it is not money: the daily total reconciled against the bank leaves it
  // out, while still saying one was given away.
  const sales = await call('get', '/admin/sales', adminToken).expect(200);
  assert.equal(sales.body.items[0].total_thb, 0);
  assert.equal(sales.body.items[0].manual_grants, 1);
  assert.equal(sales.body.items[0].orders, 1);
});

test('a granted package opens the door like any other', async t => {
  const { call, db, member, priced, adminToken } = fixture(t);
  const packageId = await priced('VISIT_10_90D', 900);
  const token = await member('scan@example.test', 'สแกน ได้');
  const memberId = db.prepare('SELECT id FROM members WHERE user_id=(SELECT id FROM users WHERE email=?)').get('scan@example.test').id;
  await call('post', `/members/${memberId}/grant`, adminToken, { package_id: packageId, note: 'pilot' }).expect(201);

  const qr = (await call('post', '/me/check-in-token', token, {}).expect(201)).body.qr;
  const scan = await call('post', '/check-ins/verify', adminToken, { qr, device_label: 'เคาน์เตอร์' }).expect(200);
  assert.equal(scan.body.result, 'allowed');
  assert.equal(scan.body.remaining.sessions_remaining, 9);
});

test('turning pilot mode off restores payments and keeps what pilot mode created', async t => {
  const { call, db, member, priced, adminToken, restartAs, tick } = fixture(t);
  const packageId = await priced();
  const token = await member('kept@example.test', 'ยัง ใช้ได้');
  const memberId = db.prepare('SELECT id FROM members WHERE user_id=(SELECT id FROM users WHERE email=?)').get('kept@example.test').id;
  await call('post', `/members/${memberId}/grant`, adminToken, { package_id: packageId, note: 'pilot' }).expect(201);

  // The service is restarted without PILOT_MODE, against the same database.
  const live = restartAs(false).call;

  assert.deepEqual((await live('get', '/public/config').expect(200)).body, { pilot_mode: false });
  // The code list is gone, not merely hidden.
  await live('get', '/admin/pilot/otp-codes', adminToken).expect(404);
  // The member page no longer carries a code field at all.
  const detail = await live('get', `/members/${memberId}`, adminToken).expect(200);
  assert.equal('pilot_otp' in detail.body, false);

  // Everything created while piloting still works: the session, the member, the
  // membership, and the history behind it.
  assert.equal((await live('get', '/me', token).expect(200)).body.member.name, 'ยัง ใช้ได้');
  assert.equal((await live('get', '/entitlements', token).expect(200)).body.items.length, 1);
  const qr = (await live('post', '/me/check-in-token', token, {}).expect(201)).body.qr;
  assert.equal((await live('post', '/check-ins/verify', adminToken, { qr }).expect(200)).body.result, 'allowed');

  // And buying is open again, with a QR that carries the real merchant id.
  tick(61000);
  const order = await live('post', '/orders', token, { package_id: packageId }).expect(201);
  assert.equal(order.body.order.status, 'pending_payment');
  assert.ok(order.body.promptpay_payload.includes('0812345678'.slice(1)),
    'the payload is built from the merchant id that pilot mode was withholding');

  // The grant made during the pilot is still excluded from the money column.
  const sales = await live('get', '/admin/sales', adminToken).expect(200);
  assert.equal(sales.body.items[0].total_thb, 0);
  assert.equal(sales.body.items[0].manual_grants, 1);
});

test('with pilot mode off, codes are emailed and never exposed', async t => {
  const { call, sent, adminToken } = fixture(t, { pilotMode: false });
  assert.deepEqual((await call('get', '/public/config').expect(200)).body, { pilot_mode: false });
  const requested = await call('post', '/auth/request-otp', null, { email: 'normal@example.test' }).expect(202);
  assert.equal(requested.body.pilot_mode, undefined);
  assert.equal(sent.at(-1).email, 'normal@example.test');
  await call('get', '/admin/pilot/otp-codes', adminToken).expect(404);
});
