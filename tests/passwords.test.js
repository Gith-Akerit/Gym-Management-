// Signing in with a password, and who is allowed to set one.
//
// This replaced an emailed code. The gym is on a rented box with no mail
// provider guaranteed to be reachable, and the person who needs to get in is
// standing at the counter with a queue in front of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { counterFixture, PASSWORD } from './counter.js';
import { hashPassword, verifyPassword } from '../server/passwords.js';

test('a password is stored as a bcrypt hash and never as itself', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.match(hash, /^\$2[aby]\$12\$/, 'bcrypt at cost 12');
  assert.ok(!hash.includes('correct'), 'the password itself is not in the hash');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('Correct horse battery staple', hash), false);
  // Two hashes of one password differ: the salt is doing its job, so a stolen
  // table cannot be sorted to find everybody who chose the same thing.
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('an unknown address is refused the same way a wrong password is', async t => {
  const { call, signIn } = counterFixture(t);
  await signIn('owner@example.test');

  const wrong = await call('post', '/auth/login', null,
    { email: 'owner@example.test', password: 'not-the-password' }).expect(401);
  const stranger = await call('post', '/auth/login', null,
    { email: 'nobody@example.test', password: 'not-the-password' }).expect(401);
  // Identical replies: telling them apart is how somebody learns which
  // addresses have accounts here (QA USR-10).
  assert.deepEqual(wrong.body, stranger.body);
  assert.match(wrong.body.error, /อีเมลหรือรหัสผ่านไม่ถูกต้อง/);
});

test('an account with no password set opens nothing', async t => {
  const { db, call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const created = (await call('post', '/users', owner,
    { email: 'newstaff@example.test', role: 'staff' }).expect(201)).body;
  assert.equal(created.has_password, false);

  const refused = await call('post', '/auth/login', null,
    { email: 'newstaff@example.test', password: PASSWORD }).expect(401);
  assert.match(refused.body.error, /อีเมลหรือรหัสผ่านไม่ถูกต้อง/);

  // The owner hands one over at the counter, and it works immediately.
  await call('put', `/users/${created.id}/password`, owner, { password: 'long-enough-password' }).expect(200);
  const theirs = await call('post', '/auth/login', null,
    { email: 'newstaff@example.test', password: 'long-enough-password' }).expect(200);
  assert.equal(theirs.body.role, 'staff');
  assert.ok(theirs.body.token, 'a session comes back');
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE email=?').get('newstaff@example.test').password_hash.startsWith('$2'), true);
});

test('a password can be set at the moment the account is created', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const created = (await call('post', '/users', owner,
    { email: 'sameday@example.test', role: 'staff', password: 'opening-day-2026' }).expect(201)).body;
  assert.equal(created.has_password, true);
  assert.equal(created.password_hash, undefined, 'the hash never leaves the server');
  await call('post', '/auth/login', null, { email: 'sameday@example.test', password: 'opening-day-2026' }).expect(200);
});

test('a short password is refused with a reason, in Thai', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const created = (await call('post', '/users', owner, { email: 'short@example.test', role: 'staff' }).expect(201)).body;
  const refused = await call('put', `/users/${created.id}/password`, owner, { password: 'sun2026' }).expect(400);
  assert.match(refused.body.fields.password, /อย่างน้อย 12 ตัวอักษร/);
});

test('changing a password signs that account out everywhere else', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staffId = (await call('post', '/users', owner,
    { email: 'counter@example.test', role: 'staff', password: 'first-password-here' }).expect(201)).body.id;
  const theirs = await call('post', '/auth/login', null,
    { email: 'counter@example.test', password: 'first-password-here' }).expect(200);
  await call('get', '/me', theirs.body.token).expect(200);

  await call('put', `/users/${staffId}/password`, owner, { password: 'second-password-here' }).expect(200);
  // The usual reason to change somebody's password is that another person
  // knows the old one; a session they left open is the same problem.
  await call('get', '/me', theirs.body.token).expect(401);
  await call('post', '/auth/login', null, { email: 'counter@example.test', password: 'first-password-here' }).expect(401);
  await call('post', '/auth/login', null, { email: 'counter@example.test', password: 'second-password-here' }).expect(200);
});

test('an admin changing their own password keeps the session they are using', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const id = db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id;
  await call('put', `/users/${id}/password`, owner, { password: 'brand-new-password' }).expect(200);
  // Being thrown out of the screen you are standing in front of, by a button
  // on that screen, is not a security property.
  await call('get', '/me', owner).expect(200);
});

test('staff cannot set anybody a password, including their own', async t => {
  const { call, signIn, db } = counterFixture(t);
  await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const theirId = db.prepare('SELECT id FROM users WHERE email=?').get('desk@example.test').id;
  const ownerId = db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id;
  await call('put', `/users/${theirId}/password`, staff, { password: 'promote-me-please' }).expect(403);
  await call('put', `/users/${ownerId}/password`, staff, { password: 'promote-me-please' }).expect(403);
});

test('a member row has no password to set', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const id = randomUUID();
  db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'member',?)").run(id, 'old@example.test', Date.now());
  const refused = await call('put', `/users/${id}/password`, owner, { password: 'members-do-not-sign-in' }).expect(409);
  assert.match(refused.body.error, /ไม่ได้ใช้รหัสผ่าน/);
});

test('a suspended account is told why, but only after the right password', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staffId = (await call('post', '/users', owner,
    { email: 'left@example.test', role: 'staff', password: 'leaving-this-month' }).expect(201)).body.id;
  await call('post', `/users/${staffId}/suspend`, owner, {}).expect(200);

  const guess = await call('post', '/auth/login', null, { email: 'left@example.test', password: 'wrong' }).expect(401);
  assert.match(guess.body.error, /อีเมลหรือรหัสผ่านไม่ถูกต้อง/);
  const refused = await call('post', '/auth/login', null, { email: 'left@example.test', password: 'leaving-this-month' }).expect(403);
  assert.match(refused.body.error, /ถูกระงับ/);
  assert.equal(db.prepare('SELECT status FROM users WHERE id=?').get(staffId).status, 'suspended');
});

test('guessing at one address is locked out after five tries', async t => {
  const { call, signIn } = counterFixture(t);
  await signIn('owner@example.test');
  for (let attempt = 0; attempt < 5; attempt++) {
    await call('post', '/auth/login', null, { email: 'owner@example.test', password: `guess-${attempt}` }).expect(401);
  }
  // Even the right password, because the lockout is about the address rather
  // than about whoever happens to be typing at it.
  const locked = await call('post', '/auth/login', null, { email: 'owner@example.test', password: PASSWORD }).expect(429);
  assert.match(locked.body.error, /รอ 15 นาที/);
});

test('the OTP routes are gone', async t => {
  const { call, db } = counterFixture(t);
  // Not disabled behind a flag: removed, so there is no mail provider left in
  // the sign-in path to go down on a Sunday. Nothing answers them now, so they
  // fall through to "sign in first" like any other unknown path would.
  const asked = await call('post', '/auth/request-otp', null, { email: 'someone@example.test' }).expect(401);
  assert.equal(asked.body.challenge_id, undefined);
  await call('post', '/auth/verify-otp', null, { challenge_id: randomUUID(), code: '123456' }).expect(401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM otp_challenges').get().n, 0,
    'nothing is minting codes any more');
});
