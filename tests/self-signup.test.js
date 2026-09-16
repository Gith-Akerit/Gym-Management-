// Asking for an account, and the owner deciding.
//
// Two things are load-bearing and neither is visible on the screen.
//
// The sign-up form must not become the tool that tells somebody which email
// addresses belong to this gym. The login screen was built carefully not to
// say that -- "no such account", "no password set" and "wrong password" all
// answer the same sentence -- and a sign-up form that replies differently for
// an address that already exists gives the whole thing away in one request.
//
// And an account that is waiting must open nothing. Not "shows fewer menus":
// the session must not be issued at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture } from './counter.js';
import { createMailer, letters } from '../server/mail.js';

const APPLICANT = { email: 'nid@example.test', name: 'นิด ขยันมาก', phone: '0891112222', password: 'counter-test-password' };

const signup = (call, values = {}) => call('post', '/auth/signup', null, { ...APPLICANT, ...values });

test('a request arrives, opens nothing, and is visible to the owner', async t => {
  const { call, signIn, db, at } = counterFixture(t);
  const owner = await signIn('owner@example.test');

  const sent = await signup(call).expect(202);
  assert.equal(sent.body.pending, true);
  assert.match(sent.body.message, /อนุมัติ/);

  const row = db.prepare('SELECT * FROM users WHERE email=?').get(APPLICANT.email);
  assert.equal(row.approval, 'pending');
  assert.equal(row.name, 'นิด ขยันมาก');
  assert.equal(row.phone, '0891112222');
  assert.equal(row.requested_at, at());
  // The password is theirs from the start: approving does not mean handing one
  // out, which is what made the old flow need a link for every new person.
  assert.ok(row.password_hash);

  // The right password and still no way in.
  const refused = await call('post', '/auth/login', null,
    { email: APPLICANT.email, password: APPLICANT.password }).expect(403);
  assert.match(refused.body.error, /รอเจ้าของยิมอนุมัติ/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1, 'มี session ของเจ้าของคนเดียว');

  const waiting = await call('get', '/users/requests', owner).expect(200);
  assert.equal(waiting.body.items.length, 1);
  assert.equal(waiting.body.items[0].name, 'นิด ขยันมาก');
  assert.equal(waiting.body.items[0].approval, 'pending');
});

test('the form says the same thing about an address that already has an account', async t => {
  const { call, signIn, db } = counterFixture(t);
  await signIn('owner@example.test');

  const first = await signup(call).expect(202);
  // Same status, same body. Anything that differs here is the answer to "does
  // this gym know that address?", which is not a question this form answers.
  const again = await signup(call, { name: 'คนอื่น', phone: '0899998888' }).expect(202);
  assert.deepEqual(again.body, first.body);

  // And nothing was written the second time: the name of the first request is
  // still the one the owner sees.
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 1);
  assert.equal(db.prepare('SELECT name FROM users WHERE email=?').get(APPLICANT.email).name, 'นิด ขยันมาก');

  // The same holds for an address that belongs to a working account.
  const known = await signup(call, { email: 'owner@example.test' }).expect(202);
  assert.deepEqual(known.body, first.body);
  const owner = db.prepare('SELECT * FROM users WHERE email=?').get('owner@example.test');
  assert.equal(owner.approval, 'approved', 'บัญชีที่ใช้งานอยู่ต้องไม่ถูกคำขอใหม่แตะ');
  assert.equal(owner.role, 'admin');
});

test('the owner approves, chooses the role, and the person is in', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  await signup(call).expect(202);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  const approved = await call('post', `/users/${request.id}/approve`, owner, { role: 'staff' }).expect(200);
  assert.equal(approved.body.approval, 'approved');
  assert.equal(approved.body.role, 'staff');

  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='user.approve'").get();
  assert.ok(entry, 'การอนุมัติต้องถูกบันทึกว่าใครอนุมัติ');
  assert.equal(entry.actor_id, db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id);

  // In, with the password they chose when they asked. No link, no handover.
  const signedIn = await call('post', '/auth/login', null,
    { email: APPLICANT.email, password: APPLICANT.password }).expect(200);
  assert.equal(signedIn.body.role, 'staff');

  // The queue is empty and deciding twice is refused rather than silently redone.
  assert.equal((await call('get', '/users/requests', owner)).body.items.length, 0);
  await call('post', `/users/${request.id}/approve`, owner, { role: 'admin' }).expect(409);
});

test('a refusal keeps the record, says why, and does not free the address', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  await signup(call).expect(202);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  await call('post', `/users/${request.id}/reject`, owner, { reason: '' }).expect(400);
  const rejected = await call('post', `/users/${request.id}/reject`, owner,
    { reason: 'ไม่ใช่พนักงานของยิมนี้' }).expect(200);
  assert.equal(rejected.body.approval, 'rejected');
  assert.equal(rejected.body.reject_reason, 'ไม่ใช่พนักงานของยิมนี้');

  const refused = await call('post', '/auth/login', null,
    { email: APPLICANT.email, password: APPLICANT.password }).expect(403);
  assert.match(refused.body.error, /ไม่ได้รับอนุมัติ/);

  // The row stays: deleting it would let the same address ask again a minute
  // later and would throw away the fact that somebody said no.
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='user.reject'").get());
  await signup(call).expect(202);
  assert.equal(db.prepare('SELECT approval FROM users WHERE email=?').get(APPLICANT.email).approval, 'rejected');
});

test('deciding belongs to the owner, and the form to nobody in particular', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  await signup(call).expect(202);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  await call('get', '/users/requests', staff).expect(403);
  await call('post', `/users/${request.id}/approve`, staff, { role: 'admin' }).expect(403);
  await call('post', `/users/${request.id}/reject`, staff, { reason: 'ไม่' }).expect(403);
  await call('get', '/users/requests', null).expect(401);
  // Signing up needs no session at all -- that is the point of it.
  await signup(call, { email: 'another@example.test' }).expect(202);
});

test('what the form refuses to accept', async t => {
  const { call } = counterFixture(t);
  for (const [what, values] of Object.entries({
    'อีเมลไม่ถูกต้อง': { email: 'not-an-email' },
    'ไม่มีชื่อ': { name: '   ' },
    'เบอร์ไม่ใช่มือถือไทย': { phone: '021234567' },
    'รหัสผ่านสั้นเกิน': { password: 'sn' },
  })) {
    const refused = await signup(call, values).expect(400);
    assert.match(JSON.stringify(refused.body), /[ก-๙]/, `${what} ต้องตอบเป็นภาษาไทย`);
  }
});

test('one address cannot send sixty requests', async t => {
  const { call } = counterFixture(t);
  for (let n = 0; n < 10; n += 1) await signup(call, { email: `n${n}@example.test` }).expect(202);
  const stopped = await signup(call, { email: 'eleventh@example.test' }).expect(429);
  assert.match(stopped.body.error, /[ก-๙]/);
});

test('the mailer keeps the flow alive when there is no provider yet', async t => {
  assert.ok(t);
  // Not configured: it says so and does not throw, which is what lets every
  // screen above it be finished before the gym has an account anywhere.
  const quiet = createMailer();
  assert.equal(quiet.ready, false);
  assert.deepEqual(await quiet.send({ to: 'a@b.test', subject: 'x', text: 'y' }),
    { sent: false, reason: 'not_configured' });

  // Configured: one HTTPS call, the sender the gym verified, and the body.
  const calls = [];
  const live = createMailer({
    apiKey: 'key', from: 'gym@example.test', fromName: 'สุขฤทัย',
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; },
  });
  assert.equal(live.ready, true);
  const letter = letters.approved({ gym: 'สุขฤทัย ฟิตเนส', role: 'staff' });
  assert.deepEqual(await live.send({ to: 'nid@example.test', ...letter }), { sent: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /brevo/);
  assert.equal(calls[0].body.sender.email, 'gym@example.test');
  assert.equal(calls[0].body.to[0].email, 'nid@example.test');
  assert.match(calls[0].body.textContent, /พนักงาน/);

  // A provider that is down must never become a gym that cannot approve
  // somebody: the decision is already written down.
  const broken = createMailer({
    apiKey: 'key', from: 'gym@example.test',
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.deepEqual(await broken.send({ to: 'a@b.test', subject: 'x', text: 'y' }),
    { sent: false, reason: 'network' });
});

test('the letters that go out say what happened, in Thai', async t => {
  assert.ok(t);
  for (const letter of [
    letters.signupReceived({ gym: 'สุขฤทัย ฟิตเนส' }),
    letters.signupWaiting({ gym: 'สุขฤทัย ฟิตเนส', name: 'นิด', email: 'nid@example.test', phone: '0891112222' }),
    letters.approved({ gym: 'สุขฤทัย ฟิตเนส', role: 'admin' }),
    letters.rejected({ gym: 'สุขฤทัย ฟิตเนส', reason: 'ไม่ใช่พนักงาน' }),
  ]) {
    assert.match(letter.subject, /[ก-๙]/);
    assert.match(letter.text, /[ก-๙]/);
    assert.ok(letter.subject.length < 120, 'หัวเรื่องยาวเกินจะอ่านบนมือถือ');
  }
  // The one the owner gets has to carry enough to decide with.
  const waiting = letters.signupWaiting({ gym: 'ยิม', name: 'นิด', email: 'nid@example.test', phone: '0891112222' });
  assert.match(waiting.text, /nid@example\.test/);
  assert.match(waiting.text, /0891112222/);
});
