import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { httpClient } from './http.js';
import { SMTPServer } from 'smtp-server';
import { openDatabase, migrate, rollback, transaction, createMember } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createMailer } from '../server/mail.js';

function fixture(t) {
  const db = openDatabase(); migrate(db); const inbox = new Map();
  let time = Date.now();
  const options = { db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code) };
  const app = createApp(options);
  t.after(() => { app.locals.stopSweeper?.(); db.close(); });
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
  return { db, app, http, inbox, call, login, options, tick: ms => { time += ms; } };
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
    assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 1); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('OTP registers only after proof; only hashes stored; no token in web JSON', async t => {
  const { db, http, call, inbox } = fixture(t);
  const start = await call('post', '/auth/request-otp', null, { email: 'New@Example.Test' }).expect(202);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 0);
  assert.ok(!JSON.stringify(start.body).includes(inbox.get('new@example.test')));
  const c = db.prepare('SELECT * FROM otp_challenges').get(); assert.notEqual(c.code_hash, inbox.get(c.email));
  const result = await http.post('/api/auth/verify-otp').set('X-Gym-Client', 'web').send({ challenge_id: c.id, code: inbox.get(c.email) }).expect(200);
  assert.equal(result.body.role, 'member'); assert.equal(result.body.member, null); assert.equal(result.body.token, undefined);
  assert.match(result.headers['set-cookie'][0], /HttpOnly/); assert.match(result.headers['set-cookie'][0], /SameSite=Strict/);
  await http.get('/api/me').set('Cookie', result.headers['set-cookie']).expect(200);
});
test('OTP wrong code, max attempts, expiry, replay and resend invalidation', async t => {
  const { call, inbox, tick } = fixture(t);
  const email = 'otp@example.test'; let start = await call('post', '/auth/request-otp', null, { email });
  const id = start.body.challenge_id, correct = inbox.get(email), wrong = correct === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) await call('post', '/auth/verify-otp', null, { challenge_id: id, code: wrong }).expect(400);
  await call('post', '/auth/verify-otp', null, { challenge_id: id, code: correct }).expect(400);
  // Five wrong codes lock the address, so a fresh challenge cannot restart the guessing.
  tick(61000); await call('post', '/auth/request-otp', null, { email }).expect(429);
  tick(900001); start = await call('post', '/auth/request-otp', null, { email }).expect(202);
  const old = { challenge_id: start.body.challenge_id, code: inbox.get(email) };
  tick(61000); start = await call('post', '/auth/request-otp', null, { email }).expect(202);
  await call('post', '/auth/verify-otp', null, old).expect(400);
  const current = { challenge_id: start.body.challenge_id, code: inbox.get(email) };
  await call('post', '/auth/verify-otp', null, current).expect(200);
  await call('post', '/auth/verify-otp', null, current).expect(400);
  tick(61000); start = await call('post', '/auth/request-otp', null, { email }).expect(202);
  tick(300001); await call('post', '/auth/verify-otp', null, { challenge_id: start.body.challenge_id, code: inbox.get(email) }).expect(400);
});
test('OTP cooldown, per-address and per-IP limits persist in database', async t => {
  const { call, tick, db } = fixture(t); const email = 'limit@example.test';
  await call('post', '/auth/request-otp', null, { email }).expect(202);
  await call('post', '/auth/request-otp', null, { email }).expect(429);
  for (let i = 0; i < 3; i++) { tick(61000); await call('post', '/auth/request-otp', null, { email }).expect(202); }
  tick(61000); await call('post', '/auth/request-otp', null, { email }).expect(429);
  assert.ok(db.prepare('SELECT count(*) n FROM rate_limits').get().n > 0);

  // One address spraying many different inboxes still runs into the per-IP
  // ceiling, which is what keeps the mail bill and the spam complaints down.
  const statuses = [];
  for (let i = 0; i < 60; i++) statuses.push((await call('post', '/auth/request-otp', null, { email: `ip${i}@example.test` })).status);
  assert.ok(statuses.includes(429), 'a single address could spray 60 inboxes unthrottled');
});

test('behind a proxy each member gets their own per-IP budget', async t => {
  // Production forces HTTPS, so there is always a proxy and every request shares
  // one TCP peer. Keying the budget on that peer locked members out of login.
  const { app, http } = fixture(t);
  assert.equal(app.get('trust proxy'), 1);
  const statuses = [];
  for (let i = 0; i < 50; i++) {
    const response = await http.post('/api/auth/request-otp')
      .set('X-Gym-Client', 'mobile').set('X-Forwarded-For', `203.0.113.${i + 1}`)
      .send({ email: `device${i}@example.test` });
    statuses.push(response.status);
  }
  assert.deepEqual([...new Set(statuses)], [202], '50 members on 50 devices must each get their code');
});
test('SMTP failure returns safe retry message and invalidates challenge', async t => {
  const { db, options } = fixture(t);
  const app = createApp({ ...options, sendOtp: async () => { throw new Error('secret SMTP credentials'); } });
  t.after(() => app.locals.stopSweeper?.());
  const result = await httpClient(app, t).post('/api/auth/request-otp').set('X-Gym-Client', 'mobile').send({ email: 'fail@example.test' }).expect(503);
  assert.ok(!JSON.stringify(result.body).includes('credentials'));
  assert.ok(db.prepare('SELECT consumed_at FROM otp_challenges').get().consumed_at);
});
test('actual SMTP adapter delivers to local test server without external email', async () => {
  const received = [];
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
    onData(stream, session, callback) { const chunks = []; stream.on('data', b => chunks.push(b)); stream.on('end', () => { received.push({ to: session.envelope.rcptTo[0].address, body: Buffer.concat(chunks).toString() }); callback(); }); } });
  await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve));
  try {
    const send = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.server.address().port), MAIL_FROM: 'gym@example.test' });
    await send({ email: 'recipient@example.test', code: '123456' });
    assert.equal(received[0].to, 'recipient@example.test'); assert.match(received[0].body, /Subject:/);
  } finally { await new Promise(resolve => smtp.close(resolve)); }
});
test('a provider that demands a username and password is what production gets', async () => {
  // Every hosted mail service -- Brevo, SES, Mailgun, the SMTP that comes with
  // the hosting -- takes a login and a key rather than an open relay. This is
  // the shape docs/deploy.md tells the gym to fill in, so it is worth one test.
  const seen = { auth: null, to: null };
  const smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'], logger: false,
    onAuth(auth, session, callback) {
      seen.auth = { method: auth.method, user: auth.username };
      if (auth.username === 'gym@example.test' && auth.password === 'an-smtp-key') return callback(null, { user: auth.username });
      return callback(new Error('Invalid username or password'));
    },
    onData(stream, session, callback) { stream.resume(); stream.on('end', () => { seen.to = session.envelope.rcptTo[0].address; callback(); }); },
  });
  await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve));
  const env = {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.server.address().port),
    MAIL_FROM: 'noreply@example.test', SMTP_USER: 'gym@example.test', SMTP_PASSWORD: 'an-smtp-key',
  };
  try {
    await createMailer(env)({ email: 'member@example.test', code: '246810' });
    assert.equal(seen.to, 'member@example.test');
    assert.equal(seen.auth.user, 'gym@example.test');

    // A wrong key must fail loudly here rather than quietly dropping the code
    // a member is waiting for.
    await assert.rejects(createMailer({ ...env, SMTP_PASSWORD: 'stale-key' })({ email: 'member@example.test', code: '1' }));

    // And production refuses to start on an unauthenticated relay at all.
    assert.throws(() => createMailer({ ...env, NODE_ENV: 'production', SMTP_USER: '', SMTP_PASSWORD: '' }),
      /authenticated SMTP/);
  } finally { await new Promise(resolve => smtp.close(resolve)); }
});
test('self enrollment forces member role, unique profile and rejects extra role/status fields', async t => {
  const { login, call } = fixture(t); const token = await login('self@example.test');
  await call('put', '/me/profile', token, { name: 'ทดสอบ', phone: '0891111111', role: 'admin' }).expect(400);
  const result = await call('put', '/me/profile', token, { name: 'ทดสอบ', phone: '+66 89-111-1111' }).expect(201);
  assert.equal(result.body.status, 'active'); assert.equal(result.body.phone, '0891111111');
  await call('put', '/me/profile', token, { name: 'ทดสอบ', phone: '0891111111' }).expect(409);
  const me = await call('get', '/me', token).expect(200); assert.equal(me.body.member.id, result.body.id);
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
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM audit_logs').get().n, 1);
});
test('admin can finish an OTP-verified account with no profile', async t => {
  const { login, call, db } = fixture(t); const admin = await login('admin@example.test', 'admin');
  await login(member().email); await call('post', '/members', admin, member()).expect(201);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 2);
});
test('validation rejects empty, long, malformed, future and invalid calendar dates', async t => {
  const { login, call } = fixture(t); const admin = await login('admin@example.test', 'admin');
  for (const patch of [{ name: '' }, { name: 'a'.repeat(500) }, { email: 'bad' }, { phone: 'abc' }, { phone: '+66' }, { phone: '081' }, { date_of_birth: '2569-01-01' }, { date_of_birth: '0000-00-00' }, { date_of_birth: '2025-02-30' }, { role: 'admin' }]) {
    const result = await call('post', '/members', admin, { ...member(), ...patch }).expect(400); assert.ok(result.body.fields);
  }
});
test('anonymous, member and staff cannot list/read/write/admin audit; IDOR denied', async t => {
  const { login, call } = fixture(t); const admin = await login('admin@example.test', 'admin');
  const target = await call('post', '/members', admin, member()).expect(201);
  const memberToken = await login('another@example.test'), staff = await login('staff@example.test', 'staff');
  for (const token of [null, memberToken, staff]) {
    for (const [method, path, body] of [['get', '/members'], ['get', `/members/${target.body.id}`], ['post', '/members', member(2)], ['put', `/members/${target.body.id}`, { ...member(), version: 1 }], ['delete', `/members/${target.body.id}`, { version: 1 }], ['get', `/members/${target.body.id}/audit`]]) {
      await call(method, path, token, body).expect(token ? 403 : 401);
    }
  }
});
test('suspended members can view their status; email change revokes old session', async t => {
  const { login, call } = fixture(t); const admin = await login('admin@example.test', 'admin');
  const created = await call('post', '/members', admin, member()).expect(201);
  const token = await login(member().email);
  await call('delete', `/members/${created.body.id}`, admin, { version: 1 }).expect(200);
  const me = await call('get', '/me', token).expect(200); assert.equal(me.body.member.status, 'suspended');
  await call('put', `/members/${created.body.id}`, admin, { ...member(), email: 'changed@example.test', version: 2 }).expect(200);
  await call('get', '/me', token).expect(401);
});
test('logout, expired and tampered tokens are denied', async t => {
  const { login, call, tick } = fixture(t); let token = await login('session@example.test');
  await call('get', '/me', token.slice(0, -1) + '!').expect(401);
  await call('get', '/me', 'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.').expect(401);
  await call('post', '/auth/logout', token).expect(204); await call('get', '/me', token).expect(401);
  tick(61000); token = await login('session@example.test'); tick(43200001); await call('get', '/me', token).expect(401);
});
test('cross-origin mutations and missing custom header fail closed', async t => {
  const { http } = fixture(t);
  await http.post('/api/auth/request-otp').send({ email: 'csrf@example.test' }).expect(403);
  await http.post('/api/auth/request-otp').set('Origin', 'https://evil.example').set('X-Gym-Client', 'web').send({ email: 'csrf@example.test' }).expect(403);
  await http.options('/api/auth/request-otp').set('Origin', 'https://evil.example').expect(403);
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
test('production refuses weak secret, HTTP origin and unauthenticated SMTP', t => {
  const { options } = fixture(t);
  assert.throws(() => createApp({ ...options, secret: 'weak' }));
  assert.throws(() => createApp({ ...options, production: true }));
  assert.throws(() => createMailer({ NODE_ENV: 'production', SMTP_HOST: 'mail.example', MAIL_FROM: 'gym@example.test' }));
});
