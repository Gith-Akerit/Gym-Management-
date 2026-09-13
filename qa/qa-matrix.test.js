// QA Release Tester — independent probes for KENC-20 Phase 1 matrix (MEM-001..054, XCUT-004/005/008).
// Read-only against production code: nothing here is imported by the server.
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

// ---------------------------------------------------------------- MEM-001..009
test('MEM-001/002/003 admin create, edit, status round trip', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const c = await call('post', '/members', admin, M(1)).expect(201);
  assert.match(c.body.member_code, /^GYM-[A-Z0-9]{12}$/);
  assert.equal(c.body.status, 'active');
  console.log('MEM-001 created:', JSON.stringify({ code: c.body.member_code, status: c.body.status, version: c.body.version }));

  const edited = { ...M(1, { name: 'สุดา ใจงาม', phone: '0891112222', email: 'changed1@example.test' }), status: 'active' };
  const up = await call('put', `/members/${c.body.id}`, admin, { ...edited, version: c.body.version }).expect(200);
  assert.equal(up.body.name, 'สุดา ใจงาม');
  const reread = await call('get', `/members/${c.body.id}`, admin).expect(200);
  assert.equal(reread.body.email, 'changed1@example.test');
  assert.equal(reread.body.phone, '0891112222');
  console.log('MEM-002 after refresh:', JSON.stringify({ name: reread.body.name, phone: reread.body.phone, email: reread.body.email }));

  const s1 = await call('put', `/members/${c.body.id}`, admin, { ...edited, status: 'suspended', version: reread.body.version }).expect(200);
  assert.equal(s1.body.status, 'suspended');
  const s2 = await call('put', `/members/${c.body.id}`, admin, { ...edited, status: 'active', version: s1.body.version }).expect(200);
  assert.equal(s2.body.status, 'active');
  console.log('MEM-003 transitions ok, updated_at:', s1.body.updated_at, '->', s2.body.updated_at);
});

test('MEM-004/005/008 search by name fragment, phone, email, member_code, id, and miss', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const a = (await call('post', '/members', admin, M(2, { name: 'ประยุทธ์ มั่นคง' })).expect(201)).body;
  await call('post', '/members', admin, M(3, { name: 'สมชาย ใจดี' })).expect(201);
  const out = {};
  out.nameFragment = (await call('get', `/members?q=${encodeURIComponent('ยุทธ')}`, admin).expect(200)).body.total;
  out.email = (await call('get', `/members?q=${encodeURIComponent('m2@example.test')}`, admin).expect(200)).body.total;
  out.phone = (await call('get', '/members?q=0890000002', admin).expect(200)).body.total;
  out.memberCode = (await call('get', `/members?q=${a.member_code}`, admin).expect(200)).body.total;
  out.memberId = (await call('get', `/members?q=${a.id}`, admin).expect(200)).body.total;
  const miss = await call('get', `/members?q=${encodeURIComponent('ไม่มีคนนี้แน่นอน')}`, admin).expect(200);
  out.miss = miss.body.total;
  console.log('MEM-004/005/008 totals:', JSON.stringify(out));
  assert.deepEqual(miss.body.items, []);
  for (const k of ['nameFragment', 'email', 'phone', 'memberCode', 'memberId']) assert.equal(out[k], 1, `${k} lookup failed`);
  assert.equal(out.miss, 0);
});

test('MEM-006 phone search normalisation (dashes, +66, spaces)', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  await call('post', '/members', admin, M(4, { phone: '081-234-5678' })).expect(201);
  const results = {};
  for (const form of ['0812345678', '081-234-5678', '+66812345678', '081 234 5678', '(081) 234-5678']) {
    results[form] = (await call('get', `/members?q=${encodeURIComponent(form)}`, admin).expect(200)).body.total;
  }
  console.log('MEM-006 search hits per input form:', JSON.stringify(results));
  for (const [form, total] of Object.entries(results)) assert.equal(total, 1, `must find with ${form}`);
});

test('MEM-007 Thai search with tone marks and spacing', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  await call('post', '/members', admin, M(5, { name: 'สุดา' })).expect(201);
  const hit = (await call('get', `/members?q=${encodeURIComponent('สุดา')}`, admin).expect(200)).body.total;
  const spaced = (await call('get', `/members?q=${encodeURIComponent('สุ ดา')}`, admin).expect(200)).body.total;
  const partial = (await call('get', `/members?q=${encodeURIComponent('ดา')}`, admin).expect(200)).body.total;
  console.log('MEM-007 exact=', hit, ' spaced("สุ ดา")=', spaced, ' partial("ดา")=', partial);
  assert.equal(hit, 1);
  assert.equal(partial, 1);
});

test('MEM-009 suspended member still sees own status via /me', async t => {
  const { call, login, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const m = (await call('post', '/members', admin, M(6, { email: 'sus@example.test' })).expect(201)).body;
  const token = await login('sus@example.test');
  await call('delete', `/members/${m.id}`, admin, { version: m.version }).expect(200);
  const me = await call('get', '/me', token).expect(200);
  console.log('MEM-009 /me after deactivate:', JSON.stringify({ status: me.body.member.status }));
  assert.equal(me.body.member.status, 'suspended');
  assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 1, 'soft delete only');
});

// ---------------------------------------------------------------- MEM-010..015
test('MEM-010/011 required fields and duplicate email/phone', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const empty = await call('post', '/members', admin, { name: '', email: '', phone: '' }).expect(400);
  console.log('MEM-010 empty payload fields:', JSON.stringify(empty.body.fields));
  assert.ok(empty.body.fields.name && empty.body.fields.email && empty.body.fields.phone);
  await call('post', '/members', admin, M(7)).expect(201);
  const dupEmail = await call('post', '/members', admin, M(7, { phone: '0899999999' })).expect(409);
  const dupPhone = await call('post', '/members', admin, M(8, { phone: '0890000007' })).expect(409);
  const dupCase = await call('post', '/members', admin, M(7, { email: 'M7@EXAMPLE.TEST', phone: '0899999998' })).expect(409);
  console.log('MEM-011 dup responses:', JSON.stringify([dupEmail.body, dupPhone.body, dupCase.body]));
});

test('MEM-012 long name, emoji, special chars', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const long = await call('post', '/members', admin, M(9, { name: 'ก'.repeat(500) })).expect(400);
  console.log('MEM-012 500-char name ->', JSON.stringify(long.body.fields));
  const emoji = await call('post', '/members', admin, M(10, { name: 'สมชาย 💪🏋️' })).expect(201);
  assert.equal(emoji.body.name, 'สมชาย 💪🏋️');
  const special = await call('post', '/members', admin, M(11, { name: `O'Brien <b>& "x"` })).expect(201);
  assert.equal(special.body.name, `O'Brien <b>& "x"`, 'stored verbatim, not mangled');
  console.log('MEM-012 emoji/special stored:', JSON.stringify([emoji.body.name, special.body.name]));
});

test('MEM-013 malformed phone numbers', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const out = {};
  let n = 1000;
  for (const p of ['abc', '+66', '081', '08123456789012', '0712345678', '', '0812345678']) {
    const r = await call('post', '/members', admin, M(n++, { phone: p }));
    out[p || '(empty)'] = r.status;
  }
  console.log('MEM-013 status per phone:', JSON.stringify(out));
  for (const p of ['abc', '+66', '081', '08123456789012', '0712345678', '(empty)']) assert.equal(out[p], 400, `${p} must be rejected`);
  assert.equal(out['0812345678'], 201);
});

test('MEM-014 date of birth: future, Buddhist era, 0000-00-00, 2026-02-30', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const out = {};
  let n = 2000;
  for (const d of ['2099-01-01', '2568-01-01', '0000-00-00', '2026-02-30', '1899-12-31', '1990-05-20']) {
    const r = await call('post', '/members', admin, M(n++, { date_of_birth: d }));
    out[d] = r.status;
  }
  console.log('MEM-014 status per DOB:', JSON.stringify(out));
  for (const d of ['2099-01-01', '2568-01-01', '0000-00-00', '2026-02-30', '1899-12-31']) assert.equal(out[d], 400, `${d} must be rejected`);
  assert.equal(out['1990-05-20'], 201);
});

test('MEM-015 two concurrent edits do not silently lose data', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const m = (await call('post', '/members', admin, M(12)).expect(201)).body;
  const base = { ...M(12), status: 'active', version: m.version };
  const tabA = await call('put', `/members/${m.id}`, admin, { ...base, name: 'แท็บ เอ' }).expect(200);
  const tabB = await call('put', `/members/${m.id}`, admin, { ...base, phone: '0897776666' });
  console.log('MEM-015 second stale write:', tabB.status, JSON.stringify(tabB.body));
  assert.equal(tabB.status, 409, 'stale version must be refused, not silently applied');
  assert.equal(tabA.body.name, 'แท็บ เอ');
});

// ---------------------------------------------------------------- MEM-016..026
test('MEM-016 every endpoint is 401 without a token', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const m = (await call('post', '/members', admin, M(13)).expect(201)).body;
  const probes = [['get', '/members'], ['post', '/members'], ['get', `/members/${m.id}`], ['put', `/members/${m.id}`],
    ['delete', `/members/${m.id}`], ['get', `/members/${m.id}/audit`], ['get', '/me'], ['put', '/me/profile'],
    ['get', '/gym'], ['put', '/gym'], ['put', '/gym/hours'], ['get', '/packages'], ['post', '/packages']];
  const out = {};
  for (const [method, path] of probes) {
    const r = await call(method, path, null, method === 'get' ? undefined : {});
    out[`${method.toUpperCase()} ${path.replace(m.id, ':id')}`] = r.status;
    assert.equal(r.status, 401, `${method} ${path} leaked`);
    assert.ok(!JSON.stringify(r.body).includes('GYM-'), 'no data leak in 401 body');
  }
  console.log('MEM-016:', JSON.stringify(out));
});

test('MEM-017/018 member token cannot read others or reach admin routes (IDOR)', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const a = (await call('post', '/members', admin, M(14, { email: 'aa@example.test' })).expect(201)).body;
  const b = (await call('post', '/members', admin, M(15, { email: 'bb@example.test' })).expect(201)).body;
  const tokenA = await login('aa@example.test');
  const out = {};
  const rB = await call('get', `/members/${b.id}`, tokenA);
  out['GET /members/{B}'] = rB.status;
  out['GET /members'] = (await call('get', '/members', tokenA)).status;
  out['POST /members'] = (await call('post', '/members', tokenA, M(16))).status;
  out['PUT /members/{B}'] = (await call('put', `/members/${b.id}`, tokenA, { ...M(15), status: 'active', version: b.version })).status;
  out['DELETE /members/{B}'] = (await call('delete', `/members/${b.id}`, tokenA, { version: b.version })).status;
  out['GET /members/{A}/audit'] = (await call('get', `/members/${a.id}/audit`, tokenA)).status;
  out['PUT /gym'] = (await call('put', '/gym', tokenA, { name: 'x', version: 1 })).status;
  out['PUT /gym/hours'] = (await call('put', '/gym/hours', tokenA, { hours: [] })).status;
  out['POST /packages'] = (await call('post', '/packages', tokenA, { code: 'ABC', name_th: 'x', type: 'unlimited', duration_days: 30 })).status;
  out['GET /packages/{id}'] = (await call('get', `/packages/${randomUUID()}`, tokenA)).status;
  console.log('MEM-017/018:', JSON.stringify(out));
  for (const [k, v] of Object.entries(out)) assert.equal(v, 403, `${k} returned ${v}`);
  assert.ok(!JSON.stringify(rB.body).includes(b.member_code), 'must not leak B data');
});

test('MEM-019 injection payloads are inert', async t => {
  const { call, login, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  await call('post', '/members', admin, M(17)).expect(201);
  const payloads = [`' OR 1=1 --`, `1;DROP TABLE members;--`, `%`, `_`, `\\`, `admin'--`, `" OR ""="`];
  const out = {};
  for (const p of payloads) {
    const r = await call('get', `/members?q=${encodeURIComponent(p)}`, admin).expect(200);
    out[p] = r.body.total;
    assert.ok(!JSON.stringify(r.body).match(/SQLITE|at Object|\.js:\d+/i), 'no stack trace leaked');
  }
  const obj = await call('get', '/members', admin).query({ q: { $ne: null } });
  out['{"$ne":null} as q'] = obj.status;
  console.log('MEM-019 results:', JSON.stringify(out));
  assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 1, 'members table intact');
  for (const p of [`' OR 1=1 --`, `1;DROP TABLE members;--`, `%`, `_`, `\\`]) assert.equal(out[p], 0, `${p} must be literal`);
});

test('MEM-020 stored markup stays data, not markup', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const xss = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
  const c = await call('post', '/members', admin, M(18, { name: xss })).expect(201);
  assert.equal(c.body.name, xss, "server stores verbatim; escaping is the renderer's job");
  const list = await call('get', '/members', admin).expect(200);
  console.log('MEM-020 stored name:', JSON.stringify(c.body.name), '| content-type:', list.headers['content-type'], '| CSP:', list.headers['content-security-policy']);
  assert.equal(list.headers['content-type'].split(';')[0], 'application/json');
});

test('MEM-021 responses carry no hashes, secrets or internal ids', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const c = await call('post', '/members', admin, M(19, { email: 'p@example.test' })).expect(201);
  const token = await login('p@example.test');
  const bodies = {
    create: c.body,
    me: (await call('get', '/me', token).expect(200)).body,
    list: (await call('get', '/members', admin).expect(200)).body,
    detail: (await call('get', `/members/${c.body.id}`, admin).expect(200)).body,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const s = JSON.stringify(body);
    for (const bad of ['user_id', 'code_hash', 'token_hash', 'password', 'secret']) {
      assert.ok(!s.includes(bad), `${name} leaked ${bad}`);
    }
  }
  console.log('MEM-021 keys in create response:', Object.keys(c.body).join(','));
  console.log('MEM-021 keys in /me:', Object.keys(bodies.me).join(','), '| member keys:', Object.keys(bodies.me.member).join(','));
});

test('MEM-025/026 tampered, truncated, expired tokens and reuse after logout', async t => {
  const { call, login, tick } = fixture(t);
  const token = await login('t@example.test');
  const out = {};
  out['valid'] = (await call('get', '/me', token)).status;
  out['flipped char'] = (await call('get', '/me', (token[0] === 'A' ? 'B' : 'A') + token.slice(1))).status;
  out['truncated'] = (await call('get', '/me', token.slice(0, 20))).status;
  out['forged 43-char'] = (await call('get', '/members', 'x'.repeat(43))).status;
  await call('post', '/auth/logout', token, {}).expect(204);
  out['after logout'] = (await call('get', '/me', token)).status;
  const token2 = await login('t2@example.test');
  tick(43200001);
  out['expired'] = (await call('get', '/me', token2)).status;
  console.log('MEM-025/026:', JSON.stringify(out));
  assert.equal(out['valid'], 200);
  for (const k of ['flipped char', 'truncated', 'forged 43-char', 'after logout', 'expired']) assert.equal(out[k], 401, k);
});

// ---------------------------------------------------------------- MEM-027..031
test('MEM-027 audit log records actor, action, before, after, timestamp', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const m = (await call('post', '/members', admin, M(20)).expect(201)).body;
  const u = (await call('put', `/members/${m.id}`, admin, { ...M(20), name: 'ชื่อใหม่', status: 'active', version: m.version }).expect(200)).body;
  await call('delete', `/members/${m.id}`, admin, { version: u.version }).expect(200);
  const audit = (await call('get', `/members/${m.id}/audit`, admin).expect(200)).body.items;
  const actions = audit.map(a => a.action);
  console.log('MEM-027 actions:', JSON.stringify(actions));
  const upd = audit.find(a => a.action === 'member.update');
  console.log('MEM-027 update entry before.name ->', JSON.stringify(upd.before?.name), 'after.name ->', JSON.stringify(upd.after?.name), '| actor:', !!upd.actor_id, '| ts:', upd.created_at);
  assert.deepEqual(new Set(actions), new Set(['member.create', 'member.update', 'member.deactivate']));
  for (const entry of audit) {
    assert.ok(entry.actor_id && entry.created_at && entry.entity_id);
    if (entry.action !== 'member.create') assert.ok(entry.before, 'before missing');
    assert.ok(entry.after, 'after missing');
  }
});

test('MEM-029 deactivating a member keeps the row and its audit trail', async t => {
  const { call, login, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const m = (await call('post', '/members', admin, M(21)).expect(201)).body;
  await call('delete', `/members/${m.id}`, admin, { version: m.version }).expect(200);
  const row = db.prepare('SELECT status FROM members WHERE id=?').get(m.id);
  const audits = db.prepare('SELECT count(*) n FROM audit_logs WHERE entity_id=?').get(m.id).n;
  console.log('MEM-029 row after DELETE:', JSON.stringify(row), '| audit rows:', audits);
  assert.equal(row.status, 'suspended');
  assert.ok(audits >= 2);
});

test('MEM-030/031 10k members: pagination, index use, response time', async t => {
  const { call, login, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const now = Date.now();
  const insU = db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)');
  const insM = db.prepare('INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 10000; i++) {
    const uid = randomUUID();
    insU.run(uid, `bulk${i}@example.test`, now);
    insM.run(randomUUID(), uid, `GYM-B${String(i).padStart(11, '0')}`, `สมาชิก ${i}`, `08${String(10000000 + i)}`, 'active', now, now);
  }
  db.exec('COMMIT');
  let t0 = performance.now();
  const page = await call('get', '/members?limit=20', admin).expect(200);
  const listMs = performance.now() - t0;
  t0 = performance.now();
  const found = await call('get', `/members?q=${encodeURIComponent('สมาชิก 9999')}`, admin).expect(200);
  const searchMs = performance.now() - t0;
  console.log(`MEM-030 list 20 of ${page.body.total} in ${listMs.toFixed(1)}ms, search in ${searchMs.toFixed(1)}ms`);
  assert.equal(page.body.items.length, 20, 'must not render the whole table');
  assert.ok(page.body.total >= 10000);
  assert.equal(found.body.total, 1);
  assert.ok(listMs < 1000 && searchMs < 1000, 'must stay under 1s');
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT m.*, u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.name LIKE ? ORDER BY m.joined_at DESC,m.id LIMIT 20`).all('%x%');
  console.log('MEM-031 query plan:', plan.map(p => p.detail).join(' | '));
  const over = await call('get', '/members?limit=500', admin);
  console.log('MEM-030 limit=500 ->', over.status, JSON.stringify(over.body.fields || {}));
  assert.equal(over.status, 400, 'page size must be capped');
  const deep = await call('get', '/members?page=501&limit=20', admin).expect(200);
  console.log('MEM-030 deep page 501 items:', deep.body.items.length);
});

// ---------------------------------------------------------------- MEM-034/037/038
test('MEM-034/037 validation errors are Thai, user-readable, no framework jargon', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const cases = {
    'empty name': await call('post', '/members', admin, M(22, { name: '' })),
    'bad email': await call('post', '/members', admin, M(23, { email: 'not-an-email' })),
    'bad phone': await call('post', '/members', admin, M(24, { phone: '12345' })),
    'bad dob': await call('post', '/members', admin, M(25, { date_of_birth: '2099-01-01' })),
    'bad status': await call('post', '/members', admin, M(26, { status: 'zombie' })),
    'unknown field role=admin': await call('post', '/members', admin, { ...M(27), role: 'admin' }),
    'missing everything': await call('post', '/members', admin, {}),
  };
  const report = {};
  for (const [name, r] of Object.entries(cases)) {
    report[name] = { status: r.status, error: r.body.error, fields: r.body.fields };
    assert.equal(r.status, 400, name);
  }
  console.log('MEM-034 messages:\n' + JSON.stringify(report, null, 2));
  const flat = JSON.stringify(report);
  for (const jargon of ['ValidationError', 'ZodError', 'unrecognized_keys', 'invalid_type', 'Expected ', 'Required']) {
    assert.ok(!flat.includes(jargon), `framework jargon leaked to user: ${jargon}`);
  }
});

test('MEM-038 timestamps are epoch integers, gym is THB/Asia-Bangkok', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const c = await call('post', '/members', admin, M(28)).expect(201);
  console.log('MEM-038 joined_at:', c.body.joined_at, typeof c.body.joined_at, '| dob:', JSON.stringify(c.body.date_of_birth));
  assert.equal(typeof c.body.joined_at, 'number');
  const gym = await call('get', '/gym', admin).expect(200);
  console.log('MEM-038 gym timezone/currency:', JSON.stringify({ tz: gym.body.profile.timezone, cur: gym.body.profile.currency }));
  assert.equal(gym.body.profile.timezone, 'Asia/Bangkok');
  assert.equal(gym.body.profile.currency, 'THB');
});

// ---------------------------------------------------------------- MEM-041..054
test('MEM-041 self signup creates exactly one account and profile', async t => {
  const { call, inbox, db } = fixture(t);
  const s = await call('post', '/auth/request-otp', null, { email: 'self@example.test' }).expect(202);
  const v = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: inbox.get('self@example.test') }).expect(200);
  console.log('MEM-041 verify body keys:', Object.keys(v.body).join(','), '| role:', v.body.role, '| member:', v.body.member);
  assert.equal(v.body.role, 'member');
  const prof = await call('put', '/me/profile', v.body.token, { name: 'ตัวเอง', phone: '0881112233' }).expect(201);
  assert.match(prof.body.member_code, /^GYM-/);
  assert.equal(prof.body.status, 'active');
  const dup = await call('put', '/me/profile', v.body.token, { name: 'ซ้ำ', phone: '0881112244' });
  console.log('MEM-041 second profile attempt:', dup.status, JSON.stringify(dup.body));
  assert.equal(dup.status, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 1);
});

test('MEM-042 admin-created member logs in without a duplicate account', async t => {
  const { call, login, db, inbox } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const m = (await call('post', '/members', admin, M(29, { email: 'pre@example.test' })).expect(201)).body;
  const s = await call('post', '/auth/request-otp', null, { email: 'pre@example.test' }).expect(202);
  const v = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: inbox.get('pre@example.test') }).expect(200);
  console.log('MEM-042 logged-in member_code:', v.body.member.member_code, '| users:', db.prepare('SELECT count(*) n FROM users').get().n, '| members:', db.prepare('SELECT count(*) n FROM members').get().n);
  assert.equal(v.body.member.member_code, m.member_code);
  assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, 1);
});

test('MEM-043 expired OTP is refused', async t => {
  const { call, inbox, tick } = fixture(t);
  const s = await call('post', '/auth/request-otp', null, { email: 'exp@example.test' }).expect(202);
  const code = inbox.get('exp@example.test');
  tick(300001);
  const r = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code });
  console.log('MEM-043 after 5min+1ms:', r.status, JSON.stringify(r.body));
  assert.equal(r.status, 400);
});

test('MEM-044 malformed OTP inputs never 500', async t => {
  const { call } = fixture(t);
  const s = await call('post', '/auth/request-otp', null, { email: 'fmt@example.test' }).expect(202);
  const out = {};
  for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56', '  123456', null, 123456, { a: 1 }, ['123456']]) {
    const r = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code });
    out[JSON.stringify(code)] = r.status;
    assert.notEqual(r.status, 500, `500 on ${JSON.stringify(code)}`);
  }
  out['bad challenge_id'] = (await call('post', '/auth/verify-otp', null, { challenge_id: 'not-a-uuid', code: '123456' })).status;
  out['empty body'] = (await call('post', '/auth/verify-otp', null, {})).status;
  out['extra field'] = (await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: '123456', admin: true })).status;
  console.log('MEM-044:', JSON.stringify(out));
  for (const [k, v] of Object.entries(out)) assert.equal(v, 400, k);
});

test('MEM-045 brute force across fresh challenges is locked out', async t => {
  const { call, inbox, db } = fixture(t);
  const target = 'victim@example.test';
  let guesses = 0, locked = false, lockedAfter = null, note = '';
  for (let round = 0; round < 30 && !locked; round++) {
    const s = await call('post', '/auth/request-otp', null, { email: target });
    if (s.status !== 202) { note = `request-otp blocked at round ${round + 1}: ${s.status} ${JSON.stringify(s.body)}`; locked = true; lockedAfter = guesses; break; }
    for (let i = 0; i < 5; i++) {
      const r = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: '000000' });
      guesses++;
      if (r.status === 429) { locked = true; lockedAfter = guesses; note = `verify returned 429 ${JSON.stringify(r.body)}`; break; }
    }
  }
  const row = db.prepare('SELECT * FROM otp_lockouts WHERE email=?').get(target);
  console.log(`MEM-045 guesses before block: ${lockedAfter} | ${note}`);
  console.log('MEM-045 lockout row:', JSON.stringify(row), '| real code was never submitted:', !!inbox.get(target));
  assert.ok(locked, 'attacker was never locked out');
  assert.ok(lockedAfter <= 25, `too many guesses allowed before lockout: ${lockedAfter}`);
});

test('MEM-046 a consumed OTP cannot be replayed', async t => {
  const { call, inbox } = fixture(t);
  const s = await call('post', '/auth/request-otp', null, { email: 'once@example.test' }).expect(202);
  const code = inbox.get('once@example.test');
  await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code }).expect(200);
  const again = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code });
  console.log('MEM-046 replay:', again.status, JSON.stringify(again.body));
  assert.equal(again.status, 400);
});

// MEM-047 moved to qa-followup.test.js: this version reused one address and tripped
// the 60s resend cooldown, which is a probe defect, not an enumeration signal.
test('MEM-048 burst of OTP requests is throttled per address and per IP', async t => {
  const { call } = fixture(t);
  const perAddress = [];
  for (let i = 0; i < 10; i++) perAddress.push((await call('post', '/auth/request-otp', null, { email: 'burst@example.test' })).status);
  console.log('MEM-048 same address x10:', JSON.stringify(perAddress));
  const perIp = [];
  for (let i = 0; i < 50; i++) perIp.push((await call('post', '/auth/request-otp', null, { email: `spray${i}@example.test` })).status);
  const blockedAt = perIp.indexOf(429);
  const delivered = perIp.filter(s => s === 202).length;
  console.log(`MEM-048 50 distinct addresses from one IP: first 429 at request #${blockedAt + 1}, emails actually sent = ${delivered}`);
  assert.ok(perAddress.includes(429), 'no per-address throttle');
  assert.ok(blockedAt >= 0, 'no per-IP throttle: one IP could spam 50 inboxes');
});

test('MEM-049 OTP code never appears in logs or any response', async t => {
  const { call, inbox, db } = fixture(t);
  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => captured.push(a.map(String).join(' '));
  let s, v, code;
  try {
    s = await call('post', '/auth/request-otp', null, { email: 'log@example.test' });
    code = inbox.get('log@example.test');
    await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: '999999' });
    v = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code });
  } finally { Object.assign(console, real); }
  const logText = captured.join('\n');
  const dbDump = JSON.stringify(db.prepare('SELECT * FROM otp_challenges').all());
  console.log('MEM-049 captured log lines:', captured.length, JSON.stringify(captured));
  assert.ok(!logText.includes(code), 'OTP found in logs');
  assert.ok(!JSON.stringify(s.body).includes(code), 'OTP in request-otp response');
  assert.ok(!JSON.stringify(v.body).includes(code), 'OTP in verify response');
  assert.ok(!dbDump.includes(code), 'OTP stored in cleartext');
});

test('MEM-050 two verifications of one challenge yield a single account', async t => {
  const { call, inbox, db } = fixture(t);
  const s = await call('post', '/auth/request-otp', null, { email: 'race@example.test' }).expect(202);
  const code = inbox.get('race@example.test');
  const results = await Promise.all([
    call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code }),
    call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code }),
  ]);
  console.log('MEM-050 statuses:', JSON.stringify(results.map(r => r.status)));
  console.log('MEM-050 users:', db.prepare('SELECT count(*) n FROM users').get().n, 'sessions:', db.prepare('SELECT count(*) n FROM sessions').get().n);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 1, 'duplicate account created');
  assert.equal(results.filter(r => r.status === 200).length, 1, 'challenge consumed twice');
});

test('MEM-053 OTP email body is Thai, states expiry, and encodes correctly', async () => {
  const captured = [];
  const nodemailer = (await import('nodemailer')).default;
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async opts => { captured.push(opts); return { messageId: 'stub' }; } });
  try {
    const { createMailer } = await import('../server/mail.js');
    const send = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', MAIL_FROM: 'gym@example.test' });
    await send({ email: 'x@example.test', code: '123456' });
  } finally { nodemailer.createTransport = original; }
  const mail = captured[0];
  console.log('MEM-053 subject:', mail.subject);
  console.log('MEM-053 body:\n' + mail.text);
  console.log('MEM-053 html alternative present:', !!mail.html);
  assert.match(mail.subject, /[฀-๿]/, 'subject must be Thai');
  assert.match(mail.text, /5 นาที/, 'expiry must be stated');
  assert.ok(mail.text.includes('123456'));
});

test('MEM-054 OTP is bound to the address, not the requesting client', async t => {
  const { inbox, app } = fixture(t);
  const s = await request(app).post('/api/auth/request-otp').set('X-Gym-Client', 'mobile').send({ email: 'cross@example.test' }).expect(202);
  const code = inbox.get('cross@example.test');
  const v = await request(app).post('/api/auth/verify-otp').set('X-Gym-Client', 'web').send({ challenge_id: s.body.challenge_id, code });
  console.log('MEM-054 requested on mobile, verified on web:', v.status, '| cookie set:', !!v.headers['set-cookie']);
  assert.equal(v.status, 200, 'OTP must not be bound to the device/session that asked for it');
});

// ---------------------------------------------------------------- XCUT
test('XCUT-004 .env.example covers every variable the code reads', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = ['server/start.js', 'server/mail.js', 'server/manage.js', 'server/db.js', 'server/app.js'];
  const used = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)|env\.([A-Z0-9_]+)/g)) used.add(m[1] || m[2]);
  }
  const declared = new Set(readFileSync('.env.example', 'utf8').split('\n')
    .filter(l => l.trim() && !l.trimStart().startsWith('#')).map(l => l.split('=')[0].trim()));
  const missing = [...used].filter(v => !declared.has(v));
  console.log('XCUT-004 read by code   :', [...used].sort().join(', '));
  console.log('XCUT-004 in .env.example:', [...declared].sort().join(', '));
  console.log('XCUT-004 MISSING        :', JSON.stringify(missing));
  console.log('XCUT-004 .gitignore lists .env:', readFileSync('.gitignore', 'utf8').split('\n').map(s => s.trim()).includes('.env'));
  console.log('XCUT-004 no .env committed in working tree:', !readdirSync('.').includes('.env'));
  assert.deepEqual(missing, [], 'undocumented environment variables');
});

test('XCUT-005 migration and rollback on a database that already holds data', async () => {
  const { rollback, migrate: mig } = await import('../server/db.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qa-xcut5-'));
  try {
    const db = openDatabase(join(dir, 'live.sqlite'));
    mig(db); seedConfiguration(db);
    const uid = randomUUID();
    db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(uid, 'live@example.test', Date.now());
    db.prepare('INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), uid, 'GYM-LIVE00000001', 'ผู้ใช้จริง', '0891234567', 'active', Date.now(), Date.now());
    const before = db.prepare('SELECT count(*) n FROM members').get().n;
    const pkgBefore = db.prepare('SELECT count(*) n FROM packages').get().n;
    rollback(db);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
    const afterRollback = db.prepare('SELECT count(*) n FROM members').get().n;
    console.log('XCUT-005 rollback of 002 — remaining versions:', JSON.stringify(versions), '| members kept:', afterRollback, '| packages before rollback:', pkgBefore);
    assert.equal(afterRollback, before, 'rolling back 002 must not drop member data');
    mig(db);
    console.log('XCUT-005 re-applied 002 — packages:', db.prepare('SELECT count(*) n FROM packages').get().n,
      '| gym_profile:', db.prepare('SELECT count(*) n FROM gym_profile').get().n,
      '| members:', db.prepare('SELECT count(*) n FROM members').get().n);
    assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, before);
    console.log('XCUT-005 WARNING — gym config seeded before rollback is gone after re-migrate unless db:seed is re-run.');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('XCUT-008 / MEM-022 no hardcoded secrets and no committed .env', async () => {
  const { execSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  const envFiles = tracked.filter(f => /(^|\/)\.env$/.test(f));
  console.log('MEM-022 tracked .env files:', JSON.stringify(envFiles));
  const hits = [];
  for (const f of tracked.filter(f => /\.(js|jsx|json|sql|md|yml|yaml)$/.test(f) && !f.includes('package-lock'))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(secret|password|api[_-]?key|token)\s*[:=]\s*['"][^'"]{12,}['"]/gi)) hits.push(`${f}: ${m[0].slice(0, 70)}`);
  }
  console.log('MEM-022 suspicious literals:', JSON.stringify(hits));
  const audit = execSync('npm audit --json --audit-level=high', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const meta = JSON.parse(audit).metadata.vulnerabilities;
  console.log('XCUT-008 npm audit:', JSON.stringify(meta));
  assert.deepEqual(envFiles, []);
  assert.deepEqual(hits, []);
  assert.equal(meta.critical + meta.high, 0, 'high/critical CVEs present');
});
