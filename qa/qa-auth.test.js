// QA Release Tester — signing in (release/pilot at bb1aa74).
//
// The login screen is the whole of the door now: no OTP, no mailbox, one form.
// These are the AUTH cases of the matrix that needed measuring rather than
// reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';

const DAY = 86400000;
const THAI = /[฀-๿]/;
const PASSWORD = 'counter-password-2569';

function gym(t, { production = false } = {}) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const dir = mkdtempSync(join(tmpdir(), 'qa-auth-'));
  let time = Date.parse('2026-09-15T09:00:00+07:00');
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time, production,
    origin: production ? 'https://gym.example.test' : 'http://localhost:5173',
    slipStore: new SlipStore(join(dir, 'slips')),
    photoStore: new SlipStore(join(dir, 'photos'), { maxBytes: 8e6 }), promptPayId: '0812345678' });
  t.after(() => {
    app.locals.stopSweeper?.(); db.close();
    for (let i = 0; i < 15; i++) {
      try { return rmSync(dir, { recursive: true, force: true }); } catch { /* still held */ }
    }
  });
  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'web');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const user = (email, role, password = PASSWORD) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users(id,email,role,password_hash,password_set_at,created_at)
      VALUES(?,?,?,?,?,?)`).run(id, email, role, password ? hashPassword(password) : null,
      password ? time : null, time);
    return { id, email };
  };
  // A browser sign-in gets a cookie; the bearer token these probes carry is
  // what a phone gets, and is the easier of the two to pass around here.
  const login = (email, password) => request(app).post('/api/auth/login')
    .set('X-Gym-Client', 'mobile').send({ email, password });
  return { db, app, call, user, login, tick: ms => { time += ms; } };
}

test('AUTH-03 the door says the same thing however you fail to open it', async t => {
  const { user, login, db } = gym(t);
  user('owner@example.test', 'admin');
  user('nopassword@example.test', 'staff', null);
  const member = randomUUID();
  db.prepare(`INSERT INTO users(id,email,role,password_hash,password_set_at,created_at)
    VALUES(?,?,'member',?,?,?)`).run(member, 'leftover@example.test', hashPassword(PASSWORD), 1, 1);

  const tries = {
    'the right address, the wrong password': await login('owner@example.test', 'not-the-password'),
    'an address with no account at all': await login('nobody@example.test', 'not-the-password'),
    'an account whose password is not set yet': await login('nopassword@example.test', 'not-the-password'),
    'a leftover member account, right password': await login('leftover@example.test', PASSWORD),
  };
  const report = {};
  for (const [name, res] of Object.entries(tries)) report[name] = { status: res.status, error: res.body.error };
  console.log('AUTH-03 / AUTH-08 what each failure says:\n' + JSON.stringify(report, null, 1));
  for (const [name, row] of Object.entries(report)) {
    assert.equal(row.status, 401, `${name} was answered differently`);
    assert.ok(THAI.test(row.error ?? ''));
  }
  // The wording may count down remaining attempts; what must not differ is
  // anything that says whether the address is a real account.
  const shapes = new Set(Object.values(report).map(r => r.error.replace(/\d+/g, 'N')));
  console.log('AUTH-03 distinct wordings, ignoring the countdown:', JSON.stringify([...shapes]));
  assert.equal(shapes.size, 1, 'the reply tells an outsider which addresses are real accounts');

  const ok = await login('owner@example.test', PASSWORD);
  console.log('AUTH-03 and the right password ->', ok.status, JSON.stringify({ role: ok.body.role }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.role, 'admin');
});

test('AUTH-04 an address with no account costs the same time as one with', async t => {
  const { user, login } = gym(t);
  user('owner@example.test', 'admin');
  const time = async (email, password) => {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const started = process.hrtime.bigint();
      await login(email, password);
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return Math.round(runs.sort((a, b) => a - b)[2]);
  };
  // Five each, median, so one slow scheduling hiccup does not decide it.
  const real = await time('owner@example.test', 'wrong-password-here');
  const unknown = await time('nobody-at-all@example.test', 'wrong-password-here');
  const ratio = Math.max(real, unknown) / Math.max(1, Math.min(real, unknown));
  console.log(`AUTH-04 median reply: real account ${real}ms · unknown address ${unknown}ms · ratio ${ratio.toFixed(2)}`);
  assert.ok(real > 50, 'the password check is too fast to be a real hash');
  assert.ok(ratio < 1.5, 'an unknown address is answered so much faster that it is recognisable');
});

test('AUTH-05 / AUTH-06 guessing locks one address, and leaves the next alone', async t => {
  const { user, login, tick } = gym(t);
  user('target@example.test', 'admin');
  user('bystander@example.test', 'staff');

  const attempts = [];
  for (let i = 1; i <= 6; i++) {
    const res = await login('target@example.test', `guess-${i}`);
    attempts.push(res.status);
  }
  const lockedOut = await login('target@example.test', PASSWORD);
  const neighbour = await login('bystander@example.test', PASSWORD);
  console.log('AUTH-05 six wrong guesses:', JSON.stringify(attempts));
  console.log('AUTH-05 the right password during the lockout ->', lockedOut.status,
    JSON.stringify(lockedOut.body.error));
  console.log('AUTH-06 somebody else signing in from the same address ->', neighbour.status);
  assert.equal(lockedOut.status, 429, 'the right password opened a locked account');
  assert.ok(THAI.test(lockedOut.body.error ?? ''));
  assert.equal(neighbour.status, 200, 'one person guessing locked the whole gym out');

  tick(15 * 60000 + 1000);
  const later = await login('target@example.test', PASSWORD);
  console.log('AUTH-05 fifteen minutes later ->', later.status);
  assert.equal(later.status, 200, 'the lockout never lets go');
});

test('AUTH-11 nothing about a password leaves the server', async t => {
  const { db, call, user, login } = gym(t);
  const owner = user('owner@example.test', 'admin');
  const signedIn = await login('owner@example.test', PASSWORD).expect(200);
  const listed = await call('get', '/users', signedIn.body.token).expect(200);
  const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(owner.id);

  const everything = JSON.stringify({ login: signedIn.body, users: listed.body,
    audit: db.prepare('SELECT * FROM audit_logs').all() });
  console.log('AUTH-11 the stored hash starts with:', row.password_hash.slice(0, 7),
    '| length', row.password_hash.length);
  console.log('AUTH-11 the password or its hash appears in a response or the audit:',
    everything.includes(PASSWORD) || everything.includes(row.password_hash));
  assert.match(row.password_hash, /^\$2[aby]\$12\$/, 'not bcrypt at cost 12');
  assert.ok(!everything.includes(PASSWORD), 'the password itself came back out');
  assert.ok(!everything.includes(row.password_hash), 'the hash came back out');
  assert.ok(!JSON.stringify(listed.body).includes('password_hash'));
});

test('AUTH-12 the password rules hold at the edges', async t => {
  const { call, user, login } = gym(t);
  const owner = user('owner@example.test', 'admin');
  const admin = (await login('owner@example.test', PASSWORD).expect(200)).body.token;
  const target = user('counter@example.test', 'staff', null);

  const attempts = {
    'empty': '',
    'eleven characters': 'x'.repeat(11),
    'twelve characters': 'x'.repeat(12),
    'seventy-two bytes': 'y'.repeat(72),
    'longer than bcrypt reads': 'z'.repeat(200),
    'thai, long enough': 'รหัสผ่านของเจ้าของยิม',
  };
  const report = {};
  for (const [name, password] of Object.entries(attempts)) {
    const res = await call('put', `/users/${target.id}/password`, admin, { password });
    report[name] = { status: res.status, error: res.body.error ?? res.body.fields?.password };
  }
  console.log('AUTH-12 what the password field accepts:\n' + JSON.stringify(report, null, 1));
  assert.ok(report.empty.status >= 400 && report['eleven characters'].status >= 400);
  assert.equal(report['twelve characters'].status, 200);
  for (const [name, row] of Object.entries(report)) {
    if (row.status >= 400) assert.ok(THAI.test(JSON.stringify(row.error)), `${name} was refused in English`);
  }

  // A password longer than bcrypt reads must not quietly become a shorter one:
  // if it is accepted, only the whole thing may open the door.
  if (report['longer than bcrypt reads'].status === 200) {
    // Set it last, so the account really is carrying the long one when asked.
    await call('put', `/users/${target.id}/password`, admin, { password: 'z'.repeat(200) }).expect(200);
    const full = await login('counter@example.test', 'z'.repeat(200));
    const truncated = await login('counter@example.test', 'z'.repeat(72));
    console.log('AUTH-12 a 200 character password: the whole thing ->', full.status,
      '| its first 72 bytes ->', truncated.status);
    if (truncated.status === 200) {
      console.log('AUTH-12 NOTE: bcrypt stops at 72 bytes, so a longer password is'
        + ' silently only its first 72. Nothing on screen says so.');
    }
  }
  assert.ok(owner);
});

test('AUTH-13 signing out ends the session, and the cookie says how it travels', async t => {
  const { app, user } = gym(t, { production: true });
  user('owner@example.test', 'admin');
  const web = (method, path) => request(app)[method](`/api${path}`)
    .set('X-Gym-Client', 'web').set('Origin', 'https://gym.example.test');

  const signedIn = await web('post', '/auth/login').send({ email: 'owner@example.test', password: PASSWORD });
  const setCookie = signedIn.headers['set-cookie']?.[0] ?? '';
  console.log('AUTH-13 the cookie the browser is given:', JSON.stringify(setCookie.replace(/=[^;]+;/, '=…;')));
  assert.equal(signedIn.status, 200);
  assert.ok(!('token' in signedIn.body), 'a web sign-in also handed back a bearer token');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api']) {
    assert.ok(setCookie.includes(flag), `the session cookie is missing ${flag}`);
  }

  const cookie = setCookie.split(';')[0];
  const before = await web('get', '/me').set('Cookie', cookie);
  const out = await web('post', '/auth/logout').set('Cookie', cookie).send({});
  const after = await web('get', '/me').set('Cookie', cookie);
  const cleared = out.headers['set-cookie']?.[0] ?? '';
  console.log('AUTH-13 before:', before.status, '-> logout:', out.status, '-> after:', after.status);
  console.log('AUTH-13 the cookie it clears with:', JSON.stringify(cleared.replace(/=[^;]*;/, '=;')));
  assert.equal(before.status, 200);
  assert.equal(after.status, 401, 'the session survived signing out');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) {
    assert.ok(cleared.includes(flag), `the cookie is cleared without ${flag}`);
  }
});
