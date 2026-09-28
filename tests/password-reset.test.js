// Proving an address, and the way back in when a password is forgotten.
//
// One rule governs both, and it has two halves that are easy to get half
// right. Nothing may reveal whether an address has an account here: the screen
// says one sentence, the server takes the same time to say it -- and NO EMAIL
// GOES OUT AT ALL for an address with no account. A letter back saying "there
// is no account here" would undo the whole thing from the other side, which is
// the half that gets forgotten (Designer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture } from './counter.js';

const APPLICANT = {
  email: 'nid@example.test', name: 'นิด ขยันมาก', phone: '0891112222',
  password: 'counter-test-password',
};
const signup = (call, values = {}) => call('post', '/auth/signup', null, { ...APPLICANT, ...values });

test('the address has to answer before the owner can approve', async t => {
  const fixture = counterFixture(t, { selfSignup: true });
  const { call, signIn, db } = fixture;
  const owner = await signIn('owner@example.test');
  await signup(call).expect(202);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  // Approving an address nobody has proved means the "you are in" letter goes
  // nowhere and nobody finds out until the person telephones.
  const tooSoon = await call('post', `/users/${request.id}/approve`, owner, { role: 'staff' }).expect(409);
  assert.match(tooSoon.body.error, /ยังไม่ได้ยืนยัน/);

  // The owner's way out of that state: send it again.
  await call('post', `/users/${request.id}/resend-verify`, owner, {}).expect(200);
  const token = fixture.verifyToken();
  assert.ok(token, 'ต้องมีลิงก์ยืนยันในจดหมาย');

  await call('get', `/auth/verify/${token}`, null).expect(200);
  assert.ok(db.prepare('SELECT email_verified_at FROM users WHERE email=?').get(APPLICANT.email).email_verified_at);
  // One use only, like every other link in this system.
  await call('get', `/auth/verify/${token}`, null).expect(404);

  await call('post', `/users/${request.id}/approve`, owner, { role: 'staff' }).expect(200);
  await call('post', `/users/${request.id}/resend-verify`, owner, {}).expect(409);
});

test('forgetting a password: one sentence, whoever asks, and silence for a stranger', async t => {
  const fixture = counterFixture(t, { selfSignup: true });
  const { call, signIn, outbox } = fixture;
  await signIn('owner@example.test');

  const real = await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(200);
  assert.match(real.body.message, /ถ้ามีบัญชีของอีเมลนี้อยู่/);
  assert.match(real.body.message, /30 นาที/);
  const afterReal = outbox.length;
  assert.ok(afterReal > 0, 'บัญชีที่มีอยู่จริงต้องได้รับลิงก์');

  const stranger = await call('post', '/auth/forgot', null, { email: 'nobody@example.test' }).expect(200);
  // Byte for byte the same answer.
  assert.deepEqual(stranger.body, real.body);
  // And the half that is easy to forget: nothing left the building.
  assert.equal(outbox.length, afterReal, 'อีเมลที่ไม่มีบัญชีต้องไม่มีเมลออกไปเลยสักฉบับ');
});

test('the reset link works once, and closes every session that was open', async t => {
  const fixture = counterFixture(t, { selfSignup: true });
  const { call, signIn, db, tick } = fixture;
  const owner = await signIn('owner@example.test');
  // Two places signed in, the way a counter tablet and a phone would be.
  const phone = await signIn('owner@example.test');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);

  await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(200);
  const token = fixture.resetToken();
  assert.ok(token, 'ต้องมีลิงก์ตั้งรหัสผ่านใหม่ในจดหมาย');

  const opened = await call('get', `/auth/set-password/${token}`, null).expect(200);
  assert.equal(opened.body.email, 'owner@example.test');

  await call('post', '/auth/set-password', null, { token, password: 'a-brand-new-password' }).expect(200);
  // The usual reason for changing a password is that somebody else knows the
  // old one, so everything that was open ends here.
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  await call('get', '/users', owner).expect(401);
  await call('get', '/users', phone).expect(401);
  await call('post', '/auth/login', null,
    { email: 'owner@example.test', password: 'a-brand-new-password' }).expect(200);

  await call('post', '/auth/set-password', null, { token, password: 'another-password-x' }).expect(404);

  // And a link that sat in a mailbox for half an hour is no longer a way in.
  await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(200);
  const stale = fixture.resetToken();
  tick(31 * 60000);
  await call('get', `/auth/set-password/${stale}`, null).expect(404);
});

test('one token does one thing', async t => {
  const fixture = counterFixture(t, { selfSignup: true });
  const { call, signIn } = fixture;
  await signIn('owner@example.test');
  await signup(call).expect(202);
  const verify = fixture.verifyToken();

  // A link that proves an address must not also set a password: they arrive in
  // different letters, at different moments, and mean different things.
  await call('post', '/auth/set-password', null, { token: verify, password: 'not-allowed-here' }).expect(404);
  await call('get', `/auth/set-password/${verify}`, null).expect(404);

  await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(200);
  await call('get', `/auth/verify/${fixture.resetToken()}`, null).expect(404);
});

test('asking over and over does not turn into a way to post mail at somebody', async t => {
  const { call } = counterFixture(t, { selfSignup: true });
  for (let n = 0; n < 5; n += 1) {
    await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(200);
  }
  // Per address, not only per address-that-asked: an IP limit alone leaves one
  // person's mailbox open to being buried from a hundred machines.
  const stopped = await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(429);
  assert.match(stopped.body.error, /[ก-๙]/);
  // Somebody else is unaffected by that person's limit.
  await call('post', '/auth/forgot', null, { email: 'desk@example.test' }).expect(200);
});

test('a gym that sets an invite code stops the queue being open to everybody', async t => {
  const fixture = counterFixture(t, { selfSignup: true });
  const { call, signIn, db } = fixture;
  const owner = await signIn('owner@example.test');
  const version = (await call('get', '/gym/settings', owner).expect(200)).body.version;
  await call('put', '/gym/settings', owner, { invite_code: 'SUKLUTAI-2026', version }).expect(200);

  // The public theme says a code is needed. It never says what it is.
  const theme = await call('get', '/public/theme', null).expect(200);
  assert.equal(theme.body.needs_invite_code, true);
  assert.equal(JSON.stringify(theme.body).includes('SUKLUTAI-2026'), false,
    'รหัสเชิญต้องไม่หลุดออกหน้าสาธารณะ');

  // A wrong code is answered exactly like a duplicate address: the same
  // sentence, and nothing written. Saying "wrong code" would turn the form
  // into a way to find out whether a gym uses one.
  const wrong = await signup(call, { invite_code: 'GUESS' }).expect(202);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 0);
  const right = await signup(call, { invite_code: 'SUKLUTAI-2026' }).expect(202);
  assert.deepEqual(wrong.body, right.body);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 1);

  // Staff read this screen too -- it is where they read the LINE ID out to a
  // member -- and a code that lets somebody into the approval queue is not
  // something every counter shift needs a copy of.
  const desk = await signIn('desk@example.test', 'staff');
  const staffView = await call('get', '/gym/settings', desk).expect(200);
  assert.equal('invite_code' in staffView.body, false, 'พนักงานต้องไม่เห็นรหัสเชิญ');
  assert.equal(staffView.body.needs_invite_code, true);

  // Cleared, and the form is open again -- which is where every gym starts.
  const current = (await call('get', '/gym/settings', owner).expect(200)).body.version;
  await call('put', '/gym/settings', owner, { invite_code: '', version: current }).expect(200);
  assert.equal((await call('get', '/public/theme', null)).body.needs_invite_code, false);
  await signup(call, { email: 'open-again@example.test' }).expect(202);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get('open-again@example.test').n, 1);
});
