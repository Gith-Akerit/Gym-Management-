// A member's own account, and the wall between it and the till.
//
// The load-bearing claim in this file is the last test: a member session must
// not open a single counter route. Not "shows fewer menus" -- the request
// itself has to be refused, because the only thing between a phone and the
// gym's money is what the server says when that phone asks.
//
// The other two are the ones that go wrong quietly. A portal login that
// answers differently for an address that exists turns a public page into a
// list of who trains here. And a membership that is checked at login rather
// than on every request keeps letting somebody in for twelve hours after it
// ran out -- which is the wrong side to be generous on, because the thing
// behind the wall is what the membership is paying for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture } from './counter.js';

const MEMBER = { name: 'สมชาย ขยันมาก', phone: '0891234567', email: 'somchai@example.test' };
const PORTAL_PASSWORD = 'a-password-of-my-own';

/**
 * Signs somebody up at the counter with an address, sends them their card, and
 * opens the link in the letter -- the journey a real member walks.
 */
async function joinAndSetPassword(fixture, { withPackage = true } = {}) {
  const { call, signIn, addMember } = fixture;
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');
  const member = await addMember(desk, MEMBER);
  if (withPackage) {
    // Sold the way the counter sells one, rather than written into the table:
    // a membership conjured straight into the database is a membership whose
    // shape can drift from the real thing without anything failing.
    const pkg = (await call('post', '/packages', owner, {
      code: 'MONTH', name_th: 'รายเดือน ไม่จำกัดครั้ง', type: 'unlimited',
      duration_days: 30, price_thb: 1200, status: 'active',
    }).expect(201)).body;
    await call('post', `/members/${member.id}/grant`, owner)
      .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);
  }
  await call('post', `/members/${member.id}/welcome`, desk, {}).expect(200);
  const token = fixture.resetToken();
  assert.ok(token, 'จดหมายบัตรสมาชิกต้องมีลิงก์ตั้งรหัสผ่าน');
  await call('post', '/auth/set-password', null, { token, password: PORTAL_PASSWORD }).expect(200);
  return { member, desk };
}

test('the card letter carries a way into the portal, good for a week', async t => {
  const fixture = counterFixture(t);
  const { call, db, outbox } = fixture;
  const { member } = await joinAndSetPassword(fixture);

  const letter = outbox.at(-1);
  assert.match(letter.text, /ช่วยเล่น/);
  assert.match(letter.text, /7 วัน/);
  assert.equal(/\{\{[a-z_]+\}\}/.test(letter.text), false, 'ต้องไม่มีตัวแปรที่ยังไม่แทนค่าเหลือ');
  // The card works whether or not they ever set a password, and the letter
  // says so: otherwise somebody who cannot open the link thinks their
  // membership has not started.
  assert.match(letter.text, /บัตรสมาชิกใช้ได้เลยโดยไม่ต้องตั้งรหัสผ่าน/);

  // The account behind it is a member's account, not a staff one.
  const row = db.prepare('SELECT u.role FROM users u JOIN members m ON m.user_id=u.id WHERE m.id=?').get(member.id);
  assert.equal(row.role, 'member');
  assert.ok(db.prepare('SELECT portal_invited_at p FROM members WHERE id=?').get(member.id).p);

  const signedIn = await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200);
  assert.equal(signedIn.body.member.name, MEMBER.name);
});

test('the member sign-in answers one sentence, whoever is asking', async t => {
  const fixture = counterFixture(t);
  const { call, signIn } = fixture;
  await joinAndSetPassword(fixture);
  // A member of staff exists with a password, on the same machine.
  await signIn('owner@example.test');

  const stranger = await call('post', '/auth/member/login', null,
    { email: 'nobody-at-all@example.test', password: PORTAL_PASSWORD }).expect(401);
  const wrong = await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: 'not-the-password' }).expect(401);
  // A member of staff typing their own working password into the member page
  // gets the same answer as a stranger. Otherwise this page is a list of which
  // addresses work at the gym, on a URL that needs no session.
  const staffAddress = await call('post', '/auth/member/login', null,
    { email: 'owner@example.test', password: 'counter-test-password' }).expect(401);

  assert.deepEqual(wrong.body, stranger.body);
  assert.deepEqual(staffAddress.body, stranger.body);

  // And the staff door does not open for a member either.
  await call('post', '/auth/login', null, { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(401);
});

test('a membership is checked on every request, not once at sign-in', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { member } = await joinAndSetPassword(fixture);
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200)).body.token;

  const live = (await call('get', '/m/me', portal).expect(200)).body;
  assert.equal(live.active, true);
  assert.equal(live.member_code.startsWith('GYM-'), true);

  // The membership ends while the phone in somebody's pocket still holds the
  // session it signed in with. Nothing about that session changes -- so if the
  // check happened at sign-in, this next request would still say "active".
  //
  // Ended by its own date, which is what "expired" means. Writing 'revoked'
  // here and calling it expiry is how the two endings got the same sentence on
  // screen without a test noticing (QA BUG-12); the reversal is its own test.
  db.prepare("UPDATE entitlements SET expires_at=? WHERE member_id=?")
    .run(fixture.at() - 1000, member.id);
  const after = (await call('get', '/m/me', portal).expect(200)).body;
  assert.equal(after.active, false, 'สิทธิ์หมดอายุแล้วต้องรู้ทันที ไม่ใช่รอ session หมดอายุ');
  // Still signed in, deliberately: the screen that says "your membership ended
  // on the 3rd, here is the gym's number" is only reachable from inside.
  assert.ok(after.expires_on, 'ต้องบอกวันที่หมดอายุ ไม่ใช่แค่บอกว่าหมด');
  assert.equal(after.revoked, false, 'หมดอายุตามกำหนดไม่ใช่การถูกยกเลิก');
  assert.ok(after.package);
  const refused = await call('get', '/m/home', portal).expect(402);
  assert.match(refused.body.error, /หมดอายุ/);
  assert.ok(refused.body.expired_on, 'หน้า H ต้องมีวันที่ไว้บอกว่าหมดเมื่อไหร่');

  // And somebody whose membership has lapsed can still sign in tomorrow, which
  // is the only way they can reach that screen at all.
  await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200);
});

test('a membership the gym took back is not told it has weeks left', async t => {
  const fixture = counterFixture(t);
  const { call, signIn } = fixture;
  const { member } = await joinAndSetPassword(fixture);
  const owner = await signIn('owner@example.test');
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200)).body.token;
  await call('get', '/m/home', portal).expect(200);

  // The button the owner presses when an approval was a mistake or the money
  // went back. Through the route rather than an UPDATE, so this meets the same
  // rows a reversal really leaves behind.
  const paid = (await call('get', '/admin/orders?status=paid', owner).expect(200)).body;
  const order = paid.items.find(row => row.member_id === member.id);
  assert.ok(order, 'การมอบแพ็กเกจต้องทิ้งคำสั่งซื้อที่อนุมัติแล้วไว้ให้ยกเลิกได้');
  await call('post', `/admin/orders/${order.id}/reverse`, owner,
    { version: order.version, reason: 'โอนเงินคืนแล้ว' }).expect(200);

  // A membership that ran out and a membership that was taken back are
  // different facts. Sending the date the second one WOULD have run to put
  // "หมดอายุ 17 ตุลาคม" on the screen of somebody who had none left, a month
  // early, and they rang the counter holding the screen up as proof (BUG-12).
  const refused = await call('get', '/m/home', portal).expect(402);
  assert.equal(refused.body.revoked, true);
  assert.match(refused.body.error, /ยกเลิก/);
  assert.equal(refused.body.expired_on, undefined, 'สิทธิ์ที่ถูกยกเลิกต้องไม่มีวันที่ในอนาคตติดไปด้วย');
  assert.equal(refused.body.expired_at, undefined);

  // The same answer whichever way the screen arrives at it: a 402 on the way
  // in, or /m/me saying the membership is not live.
  const me = (await call('get', '/m/me', portal).expect(200)).body;
  assert.equal(me.active, false);
  assert.equal(me.revoked, true);
  assert.equal(me.expires_on, null, 'หน้าจอเดียวกันต้องไม่ได้วันที่มาจากอีกทาง');
});

test('a member session opens nothing at the counter', async t => {
  const fixture = counterFixture(t);
  const { call, signIn, db } = fixture;
  const { member } = await joinAndSetPassword(fixture);
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200)).body.token;

  // Every route the counter and the owner work through, asked for with a
  // member's session. Listed out rather than sampled: a route added later
  // without a guard is exactly the failure this is here to catch, and the list
  // is what makes that visible in review.
  const forbidden = [
    ['get', '/members'],
    ['post', '/members'],
    ['get', `/members/${member.id}`],
    ['get', `/members/${member.id}/card`],
    ['post', `/members/${member.id}/welcome`],
    ['get', '/users'],
    ['get', '/users/requests'],
    ['post', '/users'],
    ['get', '/packages'],
    ['post', '/packages'],
    ['get', '/gym'],
    ['put', '/gym'],
    ['get', '/gym/settings'],
    ['put', '/gym/settings'],
    ['get', '/gym/mail-settings'],
    ['post', '/gym/mail-settings/test'],
    ['get', '/machines'],
    ['get', '/programs'],
    ['get', '/articles'],
    ['get', '/safety'],
    ['put', '/safety'],
    ['get', '/reports'],
    ['get', '/checkins'],
  ];
  for (const [method, path] of forbidden) {
    const answer = await call(method, path, portal, method === 'get' ? undefined : {});
    assert.ok([403, 404].includes(answer.status),
      `${method.toUpperCase()} ${path} ตอบ ${answer.status} — สมาชิกต้องเข้าไม่ได้`);
    if (answer.status === 403) assert.match(answer.body.error, /[ก-๙]/);
  }

  // Nothing was created by any of that.
  assert.equal(db.prepare('SELECT count(*) AS n FROM members').get().n, 1);

  // And the other way round: staff cannot wander into the portal either. Not
  // because a programme is secret, but because a route that quietly accepts
  // three kinds of session is a route whose rules nobody can state.
  const desk = await signIn('desk2@example.test', 'staff');
  const refused = await call('get', '/m/me', desk).expect(403);
  assert.match(refused.body.error, /สมาชิก/);
});

test('the counter can hand a member a way into the portal, without the post', async t => {
  const fixture = counterFixture(t);
  const { call, signIn, db } = fixture;
  const { member, desk } = await joinAndSetPassword(fixture);
  const owner = await signIn('owner@example.test');

  // The situation this exists for: the gym's mailbox is not filled in, so the
  // welcome letter -- the only other way a member ever gets a password -- is
  // refused. On the first day of every gym that is every member (QA smoke).
  fixture.noMailbox();
  await call('post', `/members/${member.id}/welcome`, desk, {}).expect(409);

  // Staff, not only the owner: the customer is standing at the counter.
  const issued = (await call('post', `/members/${member.id}/portal-link`, desk, {}).expect(200)).body;
  assert.equal(issued.email, MEMBER.email);
  assert.match(issued.url, /\/\?setpw=[A-Za-z0-9_-]{43}$/);
  // A day, not the letter's week: this one is read out at the counter or sent
  // over LINE, and a week of validity is a week of a live link in a chat log.
  assert.equal(issued.expires_at - fixture.at(), 24 * 3600000);

  // It really opens the door, and it opens it once.
  const token = /setpw=([A-Za-z0-9_-]{43})/.exec(issued.url)[1];
  await call('post', '/auth/set-password', null, { token, password: 'a-brand-new-password' }).expect(200);
  // Used once and gone, the same as every other link this system hands out.
  await call('post', '/auth/set-password', null, { token, password: 'again-with-the-same' }).expect(404);
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: 'a-brand-new-password' }).expect(200)).body.token;
  await call('get', '/m/me', portal).expect(200);

  // Handing over a way into somebody's account is written down.
  const logged = db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='member.portal_link_issued'").get();
  assert.equal(logged.n, 1);

  // A member with no address has no account to let anybody into, and the
  // answer says what to do about it rather than failing blankly.
  const walkIn = await fixture.addMember(desk, { name: 'ไม่มีอีเมล', phone: '0890000111' });
  const refused = await call('post', `/members/${walkIn.id}/portal-link`, desk, {}).expect(409);
  assert.match(refused.body.error, /อีเมล/);

  // And it is the counter's, not a member's: a member session cannot mint one
  // for anybody, including themselves.
  await call('post', `/members/${member.id}/portal-link`, portal, {}).expect(403);
  await call('post', `/members/${member.id}/portal-link`, null, {}).expect(401);
  assert.ok(owner);
});

// ---------------------------------------------------------- suspended, not lapsed
//
// The counter has always refused a suspended member at the door (checkin.js).
// The portal did not agree: a member the gym suspended kept reading paid
// content from home, on the session they already had and on a fresh sign-in
// with the same password, right up until whatever package they were on ran
// out on its own (Pentester). Suspending was never meant to wait for that.
//
// Fixed the same way the membership-expiry check above already was: nothing
// about a suspension is decided at sign-in or carried on the session. Every
// request re-reads `members.status`, so a suspension reaches an open tab on
// its very next request, and lifting one reaches the same tab on its next
// request too -- no sign-out, no new link, because nothing was ever cached
// long enough to go stale.

/** Puts the member's current row back with only `status` changed. */
async function setStatus(call, admin, member, status) {
  const current = (await call('get', `/members/${member.id}`, admin).expect(200)).body;
  return call('put', `/members/${member.id}`, admin, {
    name: current.name, phone: current.phone, email: current.email ?? undefined,
    date_of_birth: current.date_of_birth, emergency_contact: current.emergency_contact ?? '',
    status, version: current.version,
  }).expect(200);
}

test('suspending a member cuts the portal off mid-session, not at its next login', async t => {
  const fixture = counterFixture(t);
  const { call, signIn } = fixture;
  const { member } = await joinAndSetPassword(fixture);
  const owner = await signIn('owner@example.test');
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200)).body.token;

  // The session is live and the content behind it opens, before anything happens.
  await call('get', '/m/me', portal).expect(200);
  await call('get', '/m/home', portal).expect(200);

  await setStatus(call, owner, member, 'suspended');

  // The same token, not a new one: nothing about the session changed, only the
  // row it is checked against on this request.
  const me = await call('get', '/m/me', portal).expect(403);
  assert.match(me.body.error, /ระงับ/);
  const home = await call('get', '/m/home', portal).expect(403);
  assert.match(home.body.error, /ระงับ/);
  // Reading a specific programme is the actual content, not just its listing,
  // and goes through the identical two guards -- checked directly rather than
  // trusted to follow from the home route.
  const program = await call('get', '/m/programs/whatever-code', portal);
  assert.ok([403, 404].includes(program.status));
  if (program.status === 403) assert.match(program.body.error, /ระงับ/);

  // A fresh sign-in with the very same, correct password is refused too --
  // folded into the one sentence every other kind of failure here gets, not a
  // distinct "บัญชีนี้ถูกระงับ" that would itself tell a stranger this address
  // belongs to somebody currently held for something.
  const relogin = await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(401);
  const stranger = await call('post', '/auth/member/login', null,
    { email: 'nobody-at-all@example.test', password: PORTAL_PASSWORD }).expect(401);
  assert.equal(relogin.body.error, stranger.body.error);
  assert.doesNotMatch(relogin.body.error, /ระงับ/);

  // The counter's own answer did not move: this is the same fact the door
  // already had, read the same way, not a second definition of "suspended".
  const scan = await call('post', '/check-ins/verify', owner,
    { qr: member.member_code }).expect(409);
  assert.match(scan.body.failure_reason, /ระงับ/);
});

test('unsuspending puts the same session straight back to work', async t => {
  const fixture = counterFixture(t);
  const { call, signIn } = fixture;
  const { member } = await joinAndSetPassword(fixture);
  const owner = await signIn('owner@example.test');
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200)).body.token;

  await setStatus(call, owner, member, 'suspended');
  await call('get', '/m/me', portal).expect(403);

  await setStatus(call, owner, member, 'active');

  // No sign-out happened and no new link was issued -- the token from before
  // the suspension is what proves this, not a fresh login.
  const me = await call('get', '/m/me', portal).expect(200);
  assert.equal(me.body.active, true);
  await call('get', '/m/home', portal).expect(200);

  // And a brand new sign-in works again too, the same password as always.
  await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200);
});
