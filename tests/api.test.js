import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate, rollback, transaction, createMember } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/passwords.js';

const PASSWORD = 'counter-test-password';
const HASH = hashPassword(PASSWORD);

function fixture(t) {
  const db = openDatabase(); migrate(db);
  let time = Date.now();
  const options = { db, secret: randomBytes(32).toString('hex'), now: () => time };
  const app = createApp(options);
  t.after(() => { app.locals.stopSweeper?.(); db.close(); });
  const http = httpClient(app, t);
  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function login(email, role = 'admin') {
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), email, role, HASH, time, time);
    }
    return (await call('post', '/auth/login', null, { email, password: PASSWORD }).expect(200)).body.token;
  }
  return { db, app, http, call, login, options, tick: ms => { time += ms; } };
}
const member = (suffix = 1) => ({ name: 'สุดา ใจดี', email: `member${suffix}@example.test`, phone: `089${String(suffix).padStart(7, '0')}` });

test('fresh migration, idempotent rerun, rollback and reapply', t => {
  const { db } = fixture(t); migrate(db); rollback(db); migrate(db);
  assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%branch%'").get().n, 0);
});
test('data survives close/reopen and a migration on an existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gym-test-'));
  try {
    let db = openDatabase(join(dir, 'test.sqlite')); migrate(db);
    db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run('one', 'one@example.test', Date.now()); db.close();
    db = openDatabase(join(dir, 'test.sqlite')); migrate(db);
    assert.equal(db.prepare("SELECT count(*) n FROM users WHERE id<>'deleted-user'").get().n, 1); db.close();
  // maxRetries: on Windows the WAL companion files are released a beat after
  // close(), and a bare rmSync loses that race with EPERM.
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
test('admin CRUD/search/deactivate creates transactionally complete audit trail', async t => {
  const { login, call, db } = fixture(t); const admin = await login('admin@example.test', 'admin');
  let result = await call('post', '/members', admin, member()).expect(201); const id = result.body.id;
  assert.ok(result.body.member_code.startsWith('GYM-')); assert.equal(result.body.user_id, undefined);
  for (const q of ['สุดา', member().phone, '089-000-0001', member().email, result.body.member_code, id]) {
    const list = await call('get', `/members?q=${encodeURIComponent(q)}`, admin).expect(200); assert.equal(list.body.total, 1, q);
  }
  result = await call('put', `/members/${id}`, admin, { ...member(), name: 'ชื่อใหม่', status: 'expired', version: 1 }).expect(200);
  assert.equal(result.body.version, 2);
  await call('put', `/members/${id}`, admin, { ...member(), version: 1 }).expect(409);
  await call('delete', `/members/${id}`, admin, { version: 2 }).expect(200);
  assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 1);
  const log = await call('get', `/members/${id}/audit`, admin).expect(200);
  assert.equal(log.body.items.length, 3);
  const edit = log.body.items.find(x => x.action === 'member.update'); assert.equal(edit.before.name, member().name); assert.equal(edit.after.name, 'ชื่อใหม่'); assert.ok(edit.actor_id && edit.created_at);
});
test('duplicate normalized email/phone returns 409 and rolls back user/audit insert', async t => {
  const { login, call, db } = fixture(t); const admin = await login('admin@example.test', 'admin');
  await call('post', '/members', admin, member()).expect(201);
  await call('post', '/members', admin, { ...member(2), email: member().email.toUpperCase() }).expect(409);
  await call('post', '/members', admin, { ...member(2), phone: '+66 89-000-0001' }).expect(409);
  // The placeholder that migration 018 adds for deleted accounts' history is
  // a row in this table but not an account; counting it here would make this
  // assertion about the migration rather than about the rollback.
  assert.equal(db.prepare("SELECT count(*) n FROM users WHERE id<>'deleted-user'").get().n, 2);
  // Signing in writes a row of its own now, so this counts the rows the
  // member routes wrote: one create, and nothing from the two that rolled back.
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action LIKE 'member.%'").get().n, 1);
});
test('validation rejects empty, long, malformed, future and invalid calendar dates', async t => {
  const { login, call } = fixture(t); const admin = await login('admin@example.test', 'admin');
  for (const patch of [{ name: '' }, { name: 'a'.repeat(500) }, { email: 'bad' }, { phone: 'abc' }, { phone: '+66' }, { phone: '081' }, { date_of_birth: '2569-01-01' }, { date_of_birth: '0000-00-00' }, { date_of_birth: '2025-02-30' }, { role: 'admin' }]) {
    const result = await call('post', '/members', admin, { ...member(), ...patch }).expect(400); assert.ok(result.body.fields);
  }
});
test('anonymous callers reach nothing, and staff reach only what the counter needs', async t => {
  const { login, call } = fixture(t); const admin = await login('admin@example.test', 'admin');
  const target = await call('post', '/members', admin, member()).expect(201);
  const staff = await login('staff@example.test', 'staff');
  // Nobody signed in reaches any of it.
  for (const [method, path, body] of [['get', '/members'], ['get', `/members/${target.body.id}`],
    ['post', '/members', member(2)], ['put', `/members/${target.body.id}`, { ...member(), version: 1 }],
    ['delete', `/members/${target.body.id}`, { version: 1 }], ['get', `/members/${target.body.id}/audit`]]) {
    await call(method, path, null, body).expect(401);
  }
  // Staff sign people up, read them, AND correct what was typed -- QA-01:
  // an address mistyped at the desk sends the member's card to a stranger,
  // and that has to be fixable while the member is still standing there.
  // What stays with the owner is the decision (suspending) and the history.
  for (const [method, path, body] of [['delete', `/members/${target.body.id}`, { version: 1 }],
    ['get', `/members/${target.body.id}/audit`]]) {
    await call(method, path, staff, body).expect(403);
  }
  await call('get', '/members', staff).expect(200);
  await call('put', `/members/${target.body.id}`, staff, { ...member(), version: 1 }).expect(200);
});
test('suspending a member and changing their address leaves the record intact', async t => {
  const { login, call, db } = fixture(t); const admin = await login('admin@example.test', 'admin');
  const created = await call('post', '/members', admin, member()).expect(201);
  await call('delete', `/members/${created.body.id}`, admin, { version: 1 }).expect(200);
  assert.equal((await call('get', `/members/${created.body.id}`, admin).expect(200)).body.status, 'suspended');
  const changed = await call('put', `/members/${created.body.id}`, admin,
    { ...member(), email: 'changed@example.test', version: 2 }).expect(200);
  assert.equal(changed.body.email, 'changed@example.test');
  // The address is a way to reach somebody now, nothing more, so it moves
  // without disturbing anything else about them.
  assert.equal(db.prepare('SELECT count(*) n FROM members WHERE id=?').get(created.body.id).n, 1);
});
test('logout, expired and tampered tokens are denied', async t => {
  const { login, call, tick } = fixture(t); let token = await login('session@example.test', 'staff');
  await call('get', '/me', token.slice(0, -1) + '!').expect(401);
  await call('get', '/me', 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.').expect(401);
  await call('post', '/auth/logout', token).expect(204); await call('get', '/me', token).expect(401);
  tick(61000); token = await login('session@example.test', 'staff'); tick(43200001); await call('get', '/me', token).expect(401);
});
test('cross-origin mutations and missing custom header fail closed', async t => {
  const { http } = fixture(t);
  await http.post('/api/auth/login').send({ email: 'csrf@example.test', password: 'x' }).expect(403);
  await http.post('/api/auth/login').set('Origin', 'https://evil.example').set('X-Gym-Client', 'web')
    .send({ email: 'csrf@example.test', password: 'x' }).expect(403);
  await http.options('/api/auth/login').set('Origin', 'https://evil.example').expect(403);
});
test('search metacharacters are literal, objects rejected, stored markup stays data', async t => {
  const { login, call } = fixture(t); const admin = await login('admin@example.test', 'admin');
  await call('post', '/members', admin, { ...member(), name: '<img src=x onerror=alert(1)>' }).expect(201);
  for (const q of ["' OR 1=1 --", '%', '_', '1;DROP TABLE']) {
    const result = await call('get', `/members?q=${encodeURIComponent(q)}`, admin).expect(200); assert.equal(result.body.total, 0);
  }
  await call('get', '/members?q[$ne]=null', admin).expect(400);
  const result = await call('get', '/members', admin).expect(200); assert.equal(result.body.items[0].name, '<img src=x onerror=alert(1)>');
});
test('10,000 members are paginated and searched under one second', async t => {
  const { login, call, db } = fixture(t); const admin = await login('admin@example.test', 'admin');
  const actor = db.prepare("SELECT id FROM users WHERE role='admin'").get().id;
  transaction(db, () => {
    for (let i = 1; i <= 10000; i++) {
      const id = randomUUID(); db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(id, `perf${i}@example.test`, Date.now());
      createMember(db, id, { ...member(i), name: `สมาชิก ${i}`, date_of_birth: null, emergency_contact: '' }, actor, Date.now());
    }
  });
  const start = performance.now(); const list = await call('get', '/members?page=2&limit=20', admin).expect(200);
  const found = await call('get', '/members?q=perf10000%40example.test', admin).expect(200);
  const elapsed = performance.now() - start;
  assert.equal(list.body.items.length, 20); assert.equal(list.body.total, 10000); assert.equal(found.body.total, 1); assert.ok(elapsed < 1000, `elapsed ${elapsed}ms`);
  t.diagnostic(`list + search, 10,000 rows: ${elapsed.toFixed(1)}ms`);
});
test('production refuses a weak secret and a plain-HTTP origin', t => {
  const { options } = fixture(t);
  assert.throws(() => createApp({ ...options, secret: 'weak' }));
  assert.throws(() => createApp({ ...options, production: true }));
});
