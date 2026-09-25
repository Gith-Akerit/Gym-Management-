// The Phase 3 defects QA reported, kept honest across the change of product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp, CHECK_IN_TOKEN_RETENTION_MS } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { cardQrFor } from '../server/cards.js';

const DAY = 86400000;

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-fixes-'));
  let time = Date.parse('2026-09-14T18:00:00+07:00');
  const secret = randomBytes(32).toString('hex');
  const app = createApp({ db, secret, now: () => time,
    slipStore: new SlipStore(join(root, 'slips')), photoStore: new SlipStore(join(root, 'photos')) });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  /** A session written straight in, so these tests are not about sign-in budgets. */
  function session(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), userId, time + 365 * DAY);
    return token;
  }
  let seq = 2000000;
  function user(email, role = 'staff') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,email_verified_at,created_at) VALUES(?,?,?,?,?)')
      .run(id, email, role, time, time);
    return id;
  }
  /** A member with no account, which is what every member is now. */
  function member(name = 'สุดา ใจดี') {
    const id = randomUUID();
    const code = `GYM-${String(seq).padStart(12, '0')}`;
    db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,status,card_version,joined_at,updated_at)
      VALUES(?,NULL,?,?,?,'active',1,?,?)`)
      .run(id, code, name, `089${seq++}`, time, time);
    return { id, code, qr: cardQrFor(secret, { id, card_version: 1 }) };
  }
  const staff = email => session(user(email, 'staff'));
  /** Reissuing a card is the owner's, so the tests that do it need one. */
  const owner = email => session(user(email, 'admin'));
  /** Hands a member a membership without walking the whole sale. */
  function grant(memberId, { days = 30, sessions = null } = {}) {
    const pkg = db.prepare("SELECT id FROM packages WHERE code='UNLIMITED_30D'").get();
    const orderId = randomUUID();
    db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
      package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
      status,payment_method,created_at,expires_at,updated_at)
      VALUES(?,?,?,'X','รายเดือน','unlimited',?,NULL,100000,'paid','cash',?,?,?)`)
      .run(orderId, memberId, pkg.id, days, time, time + DAY, time);
    db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,expires_at,
      sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), orderId, memberId, pkg.id, time, time + days * DAY, sessions, sessions, time);
  }
  const scan = (token, qr) => call('post', '/check-ins/verify', token, { qr, device_label: 'เคาน์เตอร์ 1' });

  return { db, app, call, member, staff, owner, grant, scan, tick: ms => { time += ms; }, at: () => time };
}

test('the sweeper still clears the one-time tokens the member app left behind', async t => {
  // Nothing mints these any more, but a gym upgrading has a week of them in the
  // table and the sweeper is what stops that pile growing for ever.
  const { member, app, db, tick, at } = fixture(t);
  const who = member();
  for (let i = 0; i < 20; i++) {
    db.prepare('INSERT INTO check_in_tokens(id,member_id,issued_at,expires_at) VALUES(?,?,?,?)')
      .run(randomUUID(), who.id, at(), at() + 60000);
    tick(1000);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 20);

  // A week is the retention, so two days later they are all still there.
  tick(2 * DAY);
  app.locals.sweep();
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 20,
    'a token from two days ago is still inside the retention window');

  tick(CHECK_IN_TOKEN_RETENTION_MS);
  app.locals.sweep();
  assert.equal(db.prepare('SELECT count(*) n FROM check_in_tokens').get().n, 0);
});

test('a repeat scan still tells the counter what is left', async t => {
  // "How many do I have?" is asked just as often by somebody who walked back in
  // -- and with a card that never changes, a second scan is commonplace.
  const { member, staff, grant, scan, tick } = fixture(t);
  const counter = staff('staff-dup@example.test');
  const who = member('มาอีกรอบ');
  grant(who.id, { days: 90, sessions: 5 });

  const first = await scan(counter, who.qr).expect(200);
  assert.equal(first.body.remaining.sessions_remaining, 4);

  tick(60000);
  const repeat = await scan(counter, who.qr).expect(409);
  assert.equal(repeat.body.result, 'duplicate');
  assert.ok(repeat.body.remaining, 'the counter screen went blank on the question it is asked most');
  assert.equal(repeat.body.remaining.sessions_remaining, 4, 'and the repeat took nothing more');
});

test('scans that belong to nobody can be read on their own', async t => {
  const { call, member, staff, grant, scan } = fixture(t);
  const counter = staff('staff-log@example.test');
  const who = member('ผ่าน ทุกครั้ง');
  grant(who.id);
  await scan(counter, who.qr).expect(200);
  for (const junk of ['GYMCHK1.not-a-real-token.00', 'https://example.com/other-app', 'GYMCARD1..']) {
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

test('one counter cannot be used to grind through card numbers', async t => {
  const { member, staff, scan, tick } = fixture(t);
  const counter = staff('staff-flood@example.test');
  const who = member();
  const statuses = [];
  for (let i = 0; i < 320; i++) { tick(100); statuses.push((await scan(counter, who.qr)).status); }
  // Every scan writes a row, so it needs a ceiling like every other write --
  // and a signature is only as good as the number of guesses allowed at it.
  assert.ok(statuses.includes(429), 'the scanner has no ceiling');
  assert.ok(statuses.filter(s => s !== 429).length >= 300, 'and it leaves room for a real day at the door');
});

// ---------------------------------------------------------- typed at the counter
//
// ผลทดสอบของผู้ใช้ ข้อ 2: "พอกรอกรหัสสมาชิกฟิตเนสลงไป แต่ขึ้นใช้บริการไม่ได้
// ไม่ทราบสมาชิก แต่สแกน QR เข้าได้" -- the box only ever understood the signed
// payload inside the QR, which is not the code printed on the card.

test('the member code printed on the card is accepted when it is typed in', async t => {
  const { member, staff, grant, scan, call } = fixture(t);
  const counter = staff('staff-typed@example.test');
  const who = member('พิมพ์รหัสเอา');
  grant(who.id, { days: 90, sessions: 5 });

  const typed = await scan(counter, who.code).expect(200);
  assert.equal(typed.body.result, 'allowed');
  assert.equal(typed.body.member.member_code, who.code);
  assert.equal(typed.body.remaining.sessions_remaining, 4, 'the visit is counted like any other');

  // And it is the same member the camera would have found, filed under their
  // name rather than in the "QR ไม่ถูกต้อง" pile.
  const log = await call('get', '/check-ins?scope=identified', counter).expect(200);
  assert.equal(log.body.total, 1);
  assert.equal(log.body.items[0].member_name, 'พิมพ์รหัสเอา');
  assert.equal((await call('get', '/check-ins?scope=unknown', counter)).body.total, 0);
});

test('a typed code is read the way people type it', async t => {
  const { member, staff, grant, scan, tick } = fixture(t);
  const counter = staff('staff-typing@example.test');
  const who = member('ตัวเล็กตัวใหญ่');
  grant(who.id);

  // Lower case, stray spaces, and the code without the prefix everybody's code
  // shares -- all of it is the same card in somebody's hand.
  for (const form of [who.code.toLowerCase(), ` ${who.code} `, who.code.slice(4)]) {
    const response = await scan(counter, form).expect(res => {
      assert.ok([200, 409].includes(res.status), `${form} was not understood`);
    });
    assert.notEqual(response.body.result, 'denied', `${form} was refused`);
    tick(60000);
  }
});

test('a code that belongs to nobody says so, and is not filed as a broken QR', async t => {
  const { staff, scan, call } = fixture(t);
  const counter = staff('staff-wrong@example.test');

  const wrong = await scan(counter, 'GYM-000000000001').expect(409);
  assert.equal(wrong.body.result, 'denied');
  assert.match(wrong.body.failure_reason, /ไม่พบรหัสสมาชิกนี้/,
    'a mistyped code should send staff back to the code, not to the camera');
  assert.equal(wrong.body.member, null);

  // Anything that is not a code and not a card is still an unreadable QR.
  const junk = await scan(counter, 'ไม่ใช่รหัสอะไรเลย').expect(409);
  assert.match(junk.body.failure_reason, /QR ไม่ถูกต้อง/);
  assert.equal((await call('get', '/check-ins?scope=unknown', counter)).body.total, 2);
});

test('a typed code still obeys everything a scanned card obeys', async t => {
  const { db, member, staff, grant, scan } = fixture(t);
  const counter = staff('staff-rules@example.test');

  const suspended = member('ถูกระงับ');
  grant(suspended.id);
  db.prepare("UPDATE members SET status='suspended' WHERE id=?").run(suspended.id);
  const refused = await scan(counter, suspended.code).expect(409);
  assert.equal(refused.body.result, 'denied');
  assert.match(refused.body.failure_reason, /สมาชิกถูกระงับ/);

  // No package is no entry, whichever way the member was identified.
  const broke = member('ยังไม่ได้ซื้อ');
  const nothing = await scan(counter, broke.code).expect(409);
  assert.match(nothing.body.failure_reason, /ยังไม่มีแพ็กเกจ/);
});

// ------------------------------------------------------------- reissue vs the code
//
// Pentester D1: cancelling a card cancelled the QR and left the twelve
// characters printed under it working. Staff type those in by hand, so the
// person a card was taken away from could read the code off the dead card and
// still be let in. Reissuing now mints a new code as well.

test('reissuing retires the code printed on the cancelled card', async t => {
  const { call, member, staff, owner, grant, scan, tick } = fixture(t);
  const counter = staff('staff-reissued@example.test');
  const boss = owner('owner-reissued@example.test');
  const who = member('ออกบัตรใหม่แล้ว');
  grant(who.id, { days: 90, sessions: 10 });

  // Before the reissue the printed code is a way in, which is the point of it.
  assert.equal((await scan(counter, who.code).expect(200)).body.result, 'allowed');
  tick(6 * 60000);

  const reissued = await call('post', `/members/${who.id}/card/reissue`, boss,
    { reason: 'ลูกค้าแจ้งว่าบัตรหลุดไปถึงคนอื่น' }).expect(200);
  const fresh = reissued.body.member.member_code;
  assert.notEqual(fresh, who.code, 'the code on the cancelled card is still the member’s code');
  assert.match(fresh, /^GYM-[0-9A-F]{12}$/);

  const oldCard = await scan(counter, who.qr).expect(409);
  assert.match(oldCard.body.failure_reason, /บัตรใบนี้ถูกยกเลิกแล้ว/);

  // Every shape the box accepts a code in, because refusing only the tidy one
  // is refusing nothing: whole, lower case, and without the shared prefix.
  for (const form of [who.code, who.code.toLowerCase(), who.code.slice(4), who.code.slice(4).toLowerCase()]) {
    const refused = await scan(counter, form).expect(409);
    assert.equal(refused.body.result, 'denied', `${form} still opened the door`);
    assert.match(refused.body.failure_reason, /ไม่พบรหัสสมาชิกนี้/);
    assert.equal(refused.body.member, null, 'and it is not somebody the counter recognises');
    tick(60000);
  }
});

test('the member holding the new card can still be typed in', async t => {
  // The other half of D1: the fix must not be "stop typing codes", which is
  // the thing ผลทดสอบของผู้ใช้ ข้อ 2 asked for in the first place.
  const { call, member, staff, owner, grant, scan, tick } = fixture(t);
  const counter = staff('staff-newcode@example.test');
  const boss = owner('owner-newcode@example.test');
  const who = member('ถือบัตรใบใหม่');
  grant(who.id, { days: 90, sessions: 5 });

  const fresh = (await call('post', `/members/${who.id}/card/reissue`, boss,
    { reason: 'ลูกค้าทำรูปหาย ขอใหม่' }).expect(200)).body.member.member_code;
  tick(6 * 60000);

  const typed = await scan(counter, fresh.slice(4).toLowerCase()).expect(200);
  assert.equal(typed.body.result, 'allowed');
  assert.equal(typed.body.member.member_code, fresh);
  assert.equal(typed.body.remaining.sessions_remaining, 4, 'the visit is counted like any other');
});

test('a package with one visit in a year lets that visit through, then says so', async t => {
  // ยิมตั้งแพ็กเกจจริงมาแบบนี้ทั้งห้าตัว — รายปี 10,000 บาท ใส่ "1 ครั้ง" —
  // สมาชิกจึงสแกนเข้าได้หนแรกหนเดียวแล้วสิทธิ์หมดทั้งปี ทุกบรรทัดของระบบทำถูก
  // ตามที่ถูกตั้งค่าไว้ เทสต์นี้ตรึงพฤติกรรมนั้นไว้ เพราะหน้าจอที่เพิ่งแก้ไป
  // (คำเตือนตอนตั้งแพ็กเกจ และประโยค "ครั้งนี้เป็นครั้งสุดท้าย" ตอนสแกน)
  // ยืนอยู่บนตัวเลข sessions_remaining ตัวนี้ตัวเดียว
  const { member, staff, grant, scan, tick } = fixture(t);
  const counter = staff('staff-lastvisit@example.test');
  const who = member('รายปีเข้าได้ครั้งเดียว');
  grant(who.id, { days: 365, sessions: 1 });

  const first = await scan(counter, who.qr).expect(200);
  assert.equal(first.body.result, 'allowed');
  assert.equal(first.body.remaining.sessions_remaining, 0,
    'จอสแกนอ่านเลขนี้เพื่อบอกว่าเป็นครั้งสุดท้าย');

  // ครั้งหน้าที่มา แพ็กเกจยังไม่หมดอายุ แต่เข้าไม่ได้แล้ว
  tick(2 * DAY);
  const next = await scan(counter, who.qr).expect(409);
  assert.equal(next.body.result, 'denied');
  assert.match(next.body.failure_reason, /ใช้ครบจำนวนครั้ง|หมดอายุ/);
});
