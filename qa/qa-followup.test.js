// QA Release Tester — follow-up probes. Round 1 artefacts corrected + deeper checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';
import { createApp } from '../server/app.js';

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db); const inbox = new Map();
  let time = Date.now();
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code) });
  t.after(() => db.close());
  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function login(email, role = 'member') {
    if (role !== 'member') db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), email, role, time);
    const start = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const v = await call('post', '/auth/verify-otp', null, { challenge_id: start.body.challenge_id, code: inbox.get(email) }).expect(200);
    return v.body.token;
  }
  return { db, app, inbox, call, login, tick: ms => { time += ms; } };
}
const M = (s, over = {}) => ({ name: 'สุดา ใจดี', email: `m${s}@example.test`, phone: `089${String(s).padStart(7, '0')}`, ...over });
const THAI = /[฀-๿]/;

// Round 1 compared a reused address against fresh ones and tripped the 60s cooldown.
// Correct design: every address is asked exactly once, on a fresh clock.
test('MEM-047 (retest) fresh known vs fresh unknown addresses, one request each', async t => {
  const { call, db, tick } = fixture(t);
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    db.prepare('INSERT INTO users(id,email,email_verified_at,created_at) VALUES(?,?,?,?)')
      .run(randomUUID(), `real${i}@example.test`, now, now);
  }
  const samples = { known: [], unknown: [] };
  const shapes = { known: new Set(), unknown: new Set() };
  const statuses = { known: [], unknown: [] };
  for (let i = 0; i < 5; i++) {
    for (const kind of ['known', 'unknown']) {
      tick(1000);                                    // stay clear of the 60s cooldown per address
      const address = kind === 'known' ? `real${i}@example.test` : `ghost${i}@example.test`;
      const t0 = performance.now();
      const r = await call('post', '/auth/request-otp', null, { email: address });
      samples[kind].push(performance.now() - t0);
      statuses[kind].push(r.status);
      shapes[kind].add(`${r.status}:${Object.keys(r.body).sort().join(',')}`);
    }
  }
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  console.log('MEM-047 statuses known  :', JSON.stringify(statuses.known));
  console.log('MEM-047 statuses unknown:', JSON.stringify(statuses.unknown));
  console.log('MEM-047 body shapes known  :', [...shapes.known].join(' | '));
  console.log('MEM-047 body shapes unknown:', [...shapes.unknown].join(' | '));
  console.log(`MEM-047 avg latency known=${avg(samples.known).toFixed(2)}ms unknown=${avg(samples.unknown).toFixed(2)}ms`);
  assert.deepEqual(statuses.known, statuses.unknown, 'status differs between known and unknown addresses');
  assert.deepEqual([...shapes.known], [...shapes.unknown], 'response shape differs');
  assert.ok(db.prepare('SELECT count(*) n FROM users').get().n === 5, 'request-otp must not create accounts');
});

// MEM-034 requires user-facing Thai. Round 1 printed English Zod defaults for two
// input classes; this probe asserts the rule instead of only reporting it.
test('MEM-034 (strict) every field message reaching the user is Thai', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const probes = {
    'POST /members missing fields': await call('post', '/members', admin, {}),
    'POST /members unknown key role': await call('post', '/members', admin, { ...M(1), role: 'admin' }),
    'PUT /members/:id missing version': await call('put', `/members/${randomUUID()}`, admin, M(1)),
    'GET /members?limit=500': await call('get', '/members?limit=500', admin),
    'GET /members?page=0': await call('get', '/members?page=0', admin),
    'GET /members unknown query key': await call('get', '/members?sort=name', admin),
    'PUT /me/profile missing name': await call('put', '/me/profile', await login('mem@example.test'), { phone: '0891234567' }),
    'POST /packages missing fields': await call('post', '/packages', admin, {}),
    'POST /packages bad price': await call('post', '/packages', admin, { code: 'P1', name_th: 'x', type: 'unlimited', duration_days: 30, price_satang: 'abc' }),
    'PUT /gym/hours wrong length': await call('put', '/gym/hours', admin, { hours: [] }),
    'POST /auth/request-otp no body': await call('post', '/auth/request-otp', null, {}),
  };
  const english = [];
  for (const [name, r] of Object.entries(probes)) {
    const fields = r.body.fields || {};
    for (const [field, msg] of Object.entries(fields)) {
      if (!THAI.test(String(msg))) english.push(`${name} → ${field}: ${msg}`);
    }
    if (r.body.error && !THAI.test(r.body.error)) english.push(`${name} → error: ${r.body.error}`);
  }
  console.log('MEM-034 non-Thai messages shown to the user:\n' + (english.length ? english.map(s => '  - ' + s).join('\n') : '  (none)'));
  assert.deepEqual(english, [], 'English framework text is rendered to Thai end users');
});

test('MEM-033 server error and empty states are shaped for the UI', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const empty = await call('get', `/members?q=${encodeURIComponent('ไม่มีแน่นอน')}`, admin).expect(200);
  console.log('MEM-033 empty list payload:', JSON.stringify(empty.body));
  assert.deepEqual(empty.body, { items: [], total: 0, page: 1, limit: 20 });
  const missing = await call('get', `/members/${randomUUID()}`, admin);
  const badRoute = await call('get', '/does-not-exist', admin);
  console.log('MEM-033 404 member:', missing.status, JSON.stringify(missing.body), '| unknown route:', badRoute.status, JSON.stringify(badRoute.body));
  assert.equal(missing.status, 404);
  assert.ok(THAI.test(missing.body.error) && THAI.test(badRoute.body.error));
});

test('XCUT-009 security headers present on API responses', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const r = await call('get', '/members', admin).expect(200);
  const wanted = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy', 'cache-control'];
  const seen = Object.fromEntries(wanted.map(h => [h, r.headers[h] ?? null]));
  console.log('XCUT-009 headers:', JSON.stringify(seen, null, 2));
  console.log('XCUT-009 x-powered-by:', JSON.stringify(r.headers['x-powered-by'] ?? null));
  console.log('XCUT-009 strict-transport-security (dev build):', JSON.stringify(r.headers['strict-transport-security'] ?? null));
  for (const h of wanted) assert.ok(seen[h], `missing ${h}`);
  assert.equal(r.headers['x-powered-by'], undefined);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('XCUT-009 production build sets HSTS and refuses plain-HTTP origin', async t => {
  const db = openDatabase(); migrate(db); t.after(() => db.close());
  let threw = null;
  try { createApp({ db, secret: 'x'.repeat(32), origin: 'http://app.example', production: true }); }
  catch (e) { threw = e.message; }
  console.log('XCUT-009 production + http origin ->', JSON.stringify(threw));
  assert.match(threw, /HTTPS/);
  const app = createApp({ db, secret: 'x'.repeat(32), origin: 'https://app.example', production: true, sendOtp: async () => {} });
  const r = await request(app).get('/api/health').expect(200);
  console.log('XCUT-009 production HSTS:', JSON.stringify(r.headers['strict-transport-security']));
  assert.ok(r.headers['strict-transport-security']);
  let weak = null;
  try { createApp({ db, secret: 'short', origin: 'https://app.example', production: true }); } catch (e) { weak = e.message; }
  console.log('XCUT-009 short OTP_SECRET ->', JSON.stringify(weak));
  assert.match(weak, /OTP_SECRET/);
});

test('MEM-018 role escalation is impossible through any public write path', async t => {
  const { call, login, db, inbox } = fixture(t);
  const token = await login('climber@example.test');
  const attempts = {};
  attempts['PUT /me/profile with role'] = (await call('put', '/me/profile', token, { name: 'x', phone: '0891111111', role: 'admin' })).status;
  attempts['PUT /me/profile with status'] = (await call('put', '/me/profile', token, { name: 'x', phone: '0891111112', status: 'active' })).status;
  const s = await call('post', '/auth/request-otp', null, { email: 'climber2@example.test' }).expect(202);
  attempts['verify-otp with role'] = (await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: inbox.get('climber2@example.test'), role: 'admin' })).status;
  console.log('MEM-018 escalation attempts:', JSON.stringify(attempts));
  const roles = db.prepare('SELECT email,role FROM users').all();
  console.log('MEM-018 roles in database:', JSON.stringify(roles));
  assert.ok(roles.every(r => r.role === 'member'), 'a public request created a privileged account');
  for (const v of Object.values(attempts)) assert.equal(v, 400);
});

test('MEM-028 migrate is idempotent and rollback+reapply leaves a usable schema', async t => {
  const { rollback } = await import('../server/db.js');
  const db = openDatabase(); t.after(() => db.close());
  migrate(db); migrate(db); migrate(db);
  const tablesAfterMigrate = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  rollback(db, { all: true });
  const tablesAfterRollback = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  migrate(db);
  const tablesAgain = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  console.log('MEM-028 after migrate  :', tablesAfterMigrate.join(','));
  console.log('MEM-028 after full down:', tablesAfterRollback.join(','));
  console.log('MEM-028 after re-up    :', tablesAgain.join(','));
  assert.deepEqual(tablesAgain, tablesAfterMigrate, 'schema drifted across a down/up cycle');
  assert.deepEqual(tablesAfterRollback, ['schema_migrations'], 'down migrations left tables behind');
});

test('MEM-032 admin create-member needs only the minimum fields', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const minimal = await call('post', '/members', admin, { name: 'น้อยที่สุด', email: 'min@example.test', phone: '0890000123' });
  console.log('MEM-032 minimal payload accepted:', minimal.status, '| required keys: name, email, phone');
  assert.equal(minimal.status, 201);
  assert.equal(minimal.body.date_of_birth, null);
  assert.equal(minimal.body.emergency_contact, '');
});

test('MEM-030 (risk) list query plan on 50k rows', async t => {
  const { call, login, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const now = Date.now();
  const insU = db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)');
  const insM = db.prepare('INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 50000; i++) {
    const uid = randomUUID();
    insU.run(uid, `big${i}@example.test`, now);
    insM.run(randomUUID(), uid, `GYM-C${String(i).padStart(11, '0')}`, `สมาชิก ${i}`, `07${String(10000000 + i)}`, 'active', now, now);
  }
  db.exec('COMMIT');
  const t0 = performance.now();
  await call('get', '/members?limit=20', admin).expect(200);
  const ms = performance.now() - t0;
  const t1 = performance.now();
  await call('get', `/members?q=${encodeURIComponent('สมาชิก 49999')}`, admin).expect(200);
  const searchMs = performance.now() - t1;
  console.log(`MEM-030 at 50,000 rows: first page ${ms.toFixed(0)}ms, search ${searchMs.toFixed(0)}ms`);
  assert.ok(ms < 3000, `first page took ${ms.toFixed(0)}ms`);
});

test('XCUT-003 API surface snapshot for the mobile client', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const token = await login('surface@example.test');
  const shapes = {
    'GET /me': Object.keys((await call('get', '/me', token).expect(200)).body).sort(),
    'GET /gym (member)': Object.keys((await call('get', '/gym', token).expect(200)).body.profile).sort(),
    'GET /gym (admin)': Object.keys((await call('get', '/gym', admin).expect(200)).body.profile).sort(),
    'GET /packages item': Object.keys((await call('get', '/packages', admin).expect(200)).body.items[0]).sort(),
  };
  console.log('XCUT-003 contract:\n' + JSON.stringify(shapes, null, 2));
  const memberGym = (await call('get', '/gym', token).expect(200)).body.profile;
  console.log('XCUT-003 member gym payload:', JSON.stringify(memberGym));
  assert.ok(!('phone_primary' in memberGym) && !('phone_secondary' in memberGym), 'member sees raw phone columns');
  assert.ok('phone' in memberGym);
  assert.ok('hours_confirmed' in memberGym, 'member cannot tell that opening hours are unconfirmed');
});

test('PKG price NULL is never rendered as zero and drafts stay internal', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const token = await login('shopper@example.test');
  const adminList = (await call('get', '/packages', admin).expect(200)).body.items;
  const memberList = (await call('get', '/packages', token).expect(200)).body.items;
  console.log('PKG admin sees:', JSON.stringify(adminList.map(p => ({ code: p.code, status: p.status, price_thb: p.price_thb }))));
  console.log('PKG member sees:', JSON.stringify(memberList.map(p => ({ code: p.code, status: p.status, price_thb: p.price_thb }))));
  assert.equal(memberList.length, 0, 'draft packages leaked to members');
  for (const p of adminList) {
    if (p.price_satang === null) assert.equal(p.price_thb, null, `${p.code} rendered a null price as a number`);
  }
  const free = adminList.find(p => p.code === 'TRIAL_1_VISIT');
  console.log('PKG free trial price_satang:', free.price_satang, 'price_thb:', free.price_thb, '(0 = genuinely free, distinct from null)');
  assert.equal(free.price_thb, 0);
  const activateWithoutPrice = await call('put', `/packages/${adminList[0].id}`, admin,
    { code: adminList[0].code, name_th: adminList[0].name_th, type: adminList[0].type, duration_days: adminList[0].duration_days, session_limit: adminList[0].session_limit, status: 'active', sort_order: 0, version: adminList[0].version });
  console.log('PKG activate without price ->', activateWithoutPrice.status, JSON.stringify(activateWithoutPrice.body));
  assert.equal(activateWithoutPrice.status, 400);
});

test('GYM unconfirmed opening hours are flagged to members', async t => {
  const { call, login } = fixture(t);
  const token = await login('visitor@example.test');
  const gym = (await call('get', '/gym', token).expect(200)).body;
  console.log('GYM member view:', JSON.stringify({ hours_confirmed: gym.profile.hours_confirmed, hours_note: gym.profile.hours_note, phone: gym.profile.phone }));
  console.log('GYM hours:', JSON.stringify(gym.hours));
  assert.equal(gym.profile.hours_confirmed, false);
  assert.equal(gym.hours.length, 7);
});

test('rate_limits and otp_challenges rows are bounded by the start.js sweeper only', async t => {
  const { call, db, tick } = fixture(t);
  for (let i = 0; i < 15; i++) { tick(1000); await call('post', '/auth/request-otp', null, { email: `sweep${i}@example.test` }); }
  const rows = {
    rate_limits: db.prepare('SELECT count(*) n FROM rate_limits').get().n,
    otp_challenges: db.prepare('SELECT count(*) n FROM otp_challenges').get().n,
  };
  console.log('rate_limits/otp_challenges rows after 15 requests:', JSON.stringify(rows));
  console.log('note: createApp has no sweeper; only server/start.js runs the 60s cleanup interval.');
  assert.ok(rows.rate_limits > 0);
});
