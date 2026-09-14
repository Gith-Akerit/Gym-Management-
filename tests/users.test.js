// Who may sign in, and what they may do once they have.
//
// This screen exists because a freshly installed gym had exactly one account --
// the owner's -- and no way at all to make a second one. Nobody could work the
// scanner, and nothing in the product could fix that (QA smoke test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  let time = Date.parse('2026-09-15T09:00:00+07:00');
  const inbox = new Map();
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code) });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function login(email) {
    const start = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const verified = await call('post', '/auth/verify-otp', null,
      { challenge_id: start.body.challenge_id, code: inbox.get(email) }).expect(200);
    return verified.body.token;
  }
  /** The first admin, the way db:admin makes one on a fresh install. */
  function seedAdmin(email) {
    db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?)").run(randomUUID(), email, time);
    return login(email);
  }
  const userRow = email => db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const auditFor = id => db.prepare("SELECT * FROM audit_logs WHERE entity_id=? AND entity_type='user' ORDER BY created_at").all(id);

  return { db, call, login, seedAdmin, userRow, auditFor, tick: ms => { time += ms; } };
}

test('an admin can create the staff account the gym could not make before', async t => {
  const { call, login, seedAdmin, userRow, auditFor, tick } = fixture(t);
  const owner = await seedAdmin('owner@example.test');

  const created = await call('post', '/users', owner, { email: 'Counter@Example.Test', role: 'staff' }).expect(201);
  assert.equal(created.body.role, 'staff');
  assert.equal(created.body.email, 'counter@example.test', 'addresses are stored as one case');
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.member_id, null, 'a staff account is not a membership');

  // Creating one is recorded, with who did it.
  const [entry] = auditFor(created.body.id);
  assert.equal(entry.action, 'user.create');
  assert.equal(entry.actor_id, userRow('owner@example.test').id);
  assert.equal(JSON.parse(entry.after_json).role, 'staff');

  // And the account works: they sign in with a code like anybody else and can
  // do the job the role exists for.
  tick(61000);
  const counter = await login('counter@example.test');
  assert.equal((await call('get', '/me', counter).expect(200)).body.role, 'staff');
  const scan = await call('post', '/check-ins/verify', counter, { qr: 'GYMCHK1.nope.00' }).expect(409);
  assert.equal(scan.body.result, 'denied', 'staff reached the scanner');

  // Staff run the counter; they do not hand out roles.
  await call('get', '/users', counter).expect(403);
  await call('post', '/users', counter, { email: 'x@example.test', role: 'admin' }).expect(403);
  await call('put', `/users/${created.body.id}/role`, counter, { role: 'admin' }).expect(403);
  await call('post', `/users/${created.body.id}/suspend`, counter, {}).expect(403);
});

test('roles move in both directions, and every move is written down', async t => {
  const { call, login, seedAdmin, userRow, auditFor, tick } = fixture(t);
  const owner = await seedAdmin('owner@example.test');
  const id = (await call('post', '/users', owner, { email: 'promoted@example.test', role: 'staff' }).expect(201)).body.id;

  for (const role of ['admin', 'member', 'staff']) {
    const changed = await call('put', `/users/${id}/role`, owner, { role }).expect(200);
    assert.equal(changed.body.role, role);
    assert.equal(userRow('promoted@example.test').role, role);
  }
  assert.deepEqual(auditFor(id).map(row => row.action), ['user.create', 'user.role', 'user.role', 'user.role']);
  const last = auditFor(id).at(-1);
  assert.equal(JSON.parse(last.before_json).role, 'member');
  assert.equal(JSON.parse(last.after_json).role, 'staff');

  // A role change ends the sessions it applies to: somebody demoted from admin
  // must not keep an admin screen open until their token expires.
  tick(61000);
  const theirs = await login('promoted@example.test');
  await call('get', '/me', theirs).expect(200);
  await call('put', `/users/${id}/role`, owner, { role: 'member' }).expect(200);
  await call('get', '/me', theirs).expect(401);

  await call('put', `/users/${id}/role`, owner, { role: 'owner' }).expect(400);
  await call('put', `/users/${randomUUID()}/role`, owner, { role: 'staff' }).expect(404);
});

test('the last working admin cannot lock the gym out of itself', async t => {
  const { call, seedAdmin, userRow } = fixture(t);
  const owner = await seedAdmin('owner@example.test');
  const ownerId = userRow('owner@example.test').id;

  for (const attempt of [
    () => call('put', `/users/${ownerId}/role`, owner, { role: 'staff' }),
    () => call('put', `/users/${ownerId}/role`, owner, { role: 'member' }),
    () => call('post', `/users/${ownerId}/suspend`, owner, {}),
  ]) {
    const refused = await attempt().expect(409);
    assert.match(refused.body.error, /ผู้ดูแลระบบคนสุดท้าย/);
  }
  assert.equal(userRow('owner@example.test').role, 'admin');
  assert.equal(userRow('owner@example.test').status, 'active');

  // With somebody else holding the keys it is allowed -- this is how an owner
  // hands the gym over.
  const second = (await call('post', '/users', owner, { email: 'second@example.test', role: 'admin' }).expect(201)).body;
  await call('put', `/users/${ownerId}/role`, owner, { role: 'staff' }).expect(200);
  assert.equal(userRow('owner@example.test').role, 'staff');

  // Demoting yourself signs you out on the spot rather than leaving an admin
  // screen open that no longer matches what you may do.
  await call('get', '/me', owner).expect(401);
  await call('post', `/users/${second.id}/suspend`, owner, {}).expect(401);
});

test('suspending an account stops it signing in, and restoring lets it back', async t => {
  const { call, login, seedAdmin, userRow, auditFor, tick } = fixture(t);
  const owner = await seedAdmin('owner@example.test');
  const created = (await call('post', '/users', owner, { email: 'leaver@example.test', role: 'staff' }).expect(201)).body;

  tick(61000);
  const theirs = await login('leaver@example.test');
  await call('get', '/me', theirs).expect(200);

  const suspended = await call('post', `/users/${created.id}/suspend`, owner, {}).expect(200);
  assert.equal(suspended.body.status, 'suspended');
  // The session they already had stops working, not just the next one.
  await call('get', '/me', theirs).expect(401);

  // And they cannot get a new one: the code is still delivered, because saying
  // "no such account" would tell a stranger which addresses exist, but it opens
  // nothing.
  tick(61000);
  const start = await call('post', '/auth/request-otp', null, { email: 'leaver@example.test' }).expect(202);
  const refused = await call('post', '/auth/verify-otp', null,
    { challenge_id: start.body.challenge_id, code: '000000' }).expect(403);
  assert.match(refused.body.error, /ถูกระงับ/);

  await call('post', `/users/${created.id}/restore`, owner, {}).expect(200);
  assert.equal(userRow('leaver@example.test').status, 'active');
  tick(61000);
  const again = await login('leaver@example.test');
  await call('get', '/me', again).expect(200);

  assert.deepEqual(auditFor(created.id).map(row => row.action),
    ['user.create', 'user.suspend', 'user.restore']);
});

test('the list shows who is who, and refuses to make a second account for one address', async t => {
  const { call, seedAdmin } = fixture(t);
  const owner = await seedAdmin('owner@example.test');
  await call('post', '/users', owner, { email: 'staff1@example.test', role: 'staff' }).expect(201);
  await call('post', '/users', owner, { email: 'staff2@example.test', role: 'staff' }).expect(201);

  const listed = await call('get', '/users', owner).expect(200);
  assert.equal(listed.body.total, 3);
  assert.equal(listed.body.admins, 1, 'the screen needs this to explain why the last admin is protected');
  assert.deepEqual(listed.body.items.map(item => item.role), ['admin', 'staff', 'staff']);

  const found = await call('get', '/users?q=staff2', owner).expect(200);
  assert.equal(found.body.total, 1);
  assert.equal(found.body.items[0].email, 'staff2@example.test');

  // An address already in the system is changed, not duplicated: two rows for
  // one mailbox would be two different answers to "what may this person do?".
  const clash = await call('post', '/users', owner, { email: 'STAFF1@example.test', role: 'admin' }).expect(409);
  assert.match(clash.body.error, /มีบัญชีอยู่แล้ว/);

  // Members are made by signing up or from the members screen, not here.
  await call('post', '/users', owner, { email: 'someone@example.test', role: 'member' }).expect(400);
  await call('post', '/users', owner, { email: 'not-an-email', role: 'staff' }).expect(400);
});
