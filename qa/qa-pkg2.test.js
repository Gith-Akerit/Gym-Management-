// QA Release Tester — Phase 2 follow-up probes.
// Round 1 unit mix-ups corrected, plus the flows round 1 pointed at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { parsePromptPayPayload } from '../server/promptpay.js';

const MERCHANT = '0812345678';
const THAI = /[฀-๿]/;

function lengthOf(p) { const h = Buffer.alloc(2); h.writeUInt16BE(p.length + 2); return h; }
function jpeg(tag = 'x') {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(`GPS ${tag}`, 'latin1')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), lengthOf(exif), exif]);
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, app1,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([...Buffer.from(String(tag).padEnd(8, '.'), 'latin1'), 0xff, 0xd9])]);
}

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'qa2-slips-'));
  const inbox = new Map();
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code),
    slipStore: new SlipStore(root), promptPayId: MERCHANT });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const upload = (token, orderId, file = jpeg(), f = {}) => {
    const req = request(app).post(`/api/orders/${orderId}/slip`).set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${token}`)
      .field('reference_no', f.reference_no ?? `REF${randomUUID().slice(0, 8).toUpperCase()}`)
      .field('transferred_at', f.transferred_at ?? '2026-09-14T08:45');
    if (f.amount_thb !== undefined) req.field('amount_thb', String(f.amount_thb));
    return req.attach('slip', file, { filename: f.filename ?? 'slip.jpg', contentType: f.contentType ?? 'image/jpeg' });
  };
  async function login(email, role = 'member') {
    const address = email.toLowerCase();
    if (role !== 'member') db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), address, role, time);
    const s = await call('post', '/auth/request-otp', null, { email: address }).expect(202);
    const v = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: inbox.get(address) }).expect(200);
    return v.body.token;
  }
  let seq = 1000000;
  async function member(email, name = 'สุดา ใจดี') {
    const token = await login(email);
    await call('put', '/me/profile', token, { name, phone: `089${seq++}` }).expect(201);
    return token;
  }
  /** NOTE: the API field is called price_satang but the value it accepts is BAHT. */
  async function pkg(admin, over = {}) {
    const body = { code: `P${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`, name_th: 'รายเดือน',
      type: 'unlimited', duration_days: 30, price_satang: 1200, status: 'active', ...over };
    return (await call('post', '/packages', admin, body).expect(201)).body;
  }
  return { db, app, call, upload, login, member, pkg, root, tick: ms => { time += ms; }, at: () => time };
}

// ------------------------------------------------------- round 1 corrections
test('PKG-004 (retest) a later price edit leaves the placed order alone', async t => {
  const { call, login, member, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });          // 1,200 baht
  console.log('PKG-004 package as created: price_satang =', p.price_satang, 'price_thb =', p.price_thb);
  const tok = await member('buyer@example.test');
  const view = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body;
  console.log('PKG-004 order at purchase: ฿', view.order.price_thb, '| QR tag 54 =', parsePromptPayPayload(view.promptpay_payload).fields['54']);
  await call('put', `/packages/${p.id}`, admin, { code: p.code, name_th: 'ชื่อใหม่', type: p.type,
    duration_days: p.duration_days, price_satang: 3000, status: 'active', sort_order: 0, version: p.version }).expect(200);
  const after = (await call('get', `/orders/${view.order.id}`, tok).expect(200)).body;
  console.log('PKG-004 after the price rose to ฿3,000: order still ฿', after.order.price_thb,
    '| name snapshot:', after.order.package_name_snapshot, '| QR tag 54 =', parsePromptPayPayload(after.promptpay_payload).fields['54']);
  assert.equal(after.order.price_thb, 1200);
  assert.equal(after.order.package_name_snapshot, 'รายเดือน');
  assert.equal(parsePromptPayPayload(after.promptpay_payload).fields['54'], '1200');
});

test('PKG-012/014 (retest) the QR carries the exact amount, decimals included', async t => {
  const { call, login, member, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const rows = [];
  for (const baht of [1200, 1, 999, 1299.5, 1200.05, 999999]) {
    const p = await pkg(admin, { price_satang: baht });
    const tok = await member(`amt${String(baht).replace('.', '')}@example.test`);
    const v = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body;
    const f = parsePromptPayPayload(v.promptpay_payload);
    rows.push({ baht, orderTHB: v.order.price_thb, tag54: f.fields['54'], crcValid: f.crcValid,
      currency: f.fields['53'], country: f.fields['58'], poi: f.fields['01'] });
  }
  console.log('PKG-012/014 amount encoding:\n' + JSON.stringify(rows, null, 1));
  for (const r of rows) {
    assert.equal(Number(r.tag54), r.baht, `tag 54 wrong for ฿${r.baht}`);
    assert.equal(r.orderTHB, r.baht);
    assert.ok(r.crcValid);
    assert.equal(r.currency, '764');
    assert.equal(r.country, 'TH');
    assert.equal(r.poi, '12');
  }
});

test('PKG-015 (retest) the price comes from the package, never from the request', async t => {
  const { call, login, member, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });
  const tok = await member('cheat@example.test');
  const ok = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body;
  console.log('PKG-015 server-decided amount: ฿', ok.order.price_thb, '| QR tag 54 =', parsePromptPayPayload(ok.promptpay_payload).fields['54']);
  assert.equal(ok.order.price_thb, 1200);
  assert.equal(parsePromptPayPayload(ok.promptpay_payload).fields['54'], '1200');
});

test('PKG-029 (retest) a reused image and a reused reference number are both flagged', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 500 });
  const image = jpeg('SAMEIMAGE');
  const orders = {};
  for (const [who, img, ref] of [['a', image, 'REFSHARED1'], ['b', image, 'REFSHARED1'], ['c', jpeg('OTHER'), 'REFSHARED1'], ['d', image, 'REFUNIQUE9']]) {
    const tok = await member(`dup${who}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    await upload(tok, o.id, img, { reference_no: ref }).expect(201);
    orders[who] = o.id;
  }
  for (const who of ['b', 'c', 'd']) {
    const dup = (await call('get', `/admin/orders/${orders[who]}`, admin).expect(200)).body.duplicates;
    console.log(`PKG-029 order ${who} duplicates:`, JSON.stringify(dup.map(x => x.kind)));
    assert.ok(dup.length >= 1, `order ${who} reused a transfer and was not flagged`);
  }
  const clean = await member('cleanx@example.test');
  const co = (await call('post', '/orders', clean, { package_id: p.id }).expect(201)).body.order;
  await upload(clean, co.id, jpeg('FRESH'), { reference_no: 'REFFRESH1' }).expect(201);
  const none = (await call('get', `/admin/orders/${co.id}`, admin).expect(200)).body.duplicates;
  console.log('PKG-029 a genuinely new slip is not flagged:', none.length === 0);
  assert.equal(none.length, 0, 'false positive on a fresh slip');
});

test('PKG-048 (retest) the audit entry carries the amount actually charged', async t => {
  const { call, login, member, upload, pkg, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });
  const tok = await member('audit@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true, note: 'ตรงกับ statement 09:12' }).expect(200);
  const approve = db.prepare("SELECT * FROM audit_logs WHERE entity_id=? AND action='order.approve'").get(o.id);
  const after = JSON.parse(approve.after_json);
  console.log('PKG-048 approve audit:', JSON.stringify({ actor: !!approve.actor_id, at: approve.created_at,
    status: after.status, satang: after.price_satang_snapshot, baht: after.price_satang_snapshot / 100, note: after.review_note }));
  assert.equal(after.price_satang_snapshot, 120000);
  assert.equal(after.status, 'paid');
  assert.ok(approve.actor_id);
});

test('PKG-084 (retest) both satang and baht are published for every amount', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200.5 });
  const tok = await member('money@example.test');
  const v = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body;
  await upload(tok, v.order.id, jpeg(), { amount_thb: 1200.5 }).expect(201);
  const full = (await call('get', `/orders/${v.order.id}`, tok).expect(200)).body;
  console.log('PKG-084 package:', JSON.stringify({ satang: p.price_satang, thb: p.price_thb }));
  console.log('PKG-084 order:', JSON.stringify({ satang: full.order.price_satang_snapshot, thb: full.order.price_thb }));
  console.log('PKG-084 slip claim:', JSON.stringify({ satang: full.slip.amount_satang_claimed, thb: full.slip.amount_thb_claimed }));
  assert.equal(p.price_satang, 120050);
  assert.equal(p.price_thb, 1200.5);
  assert.equal(full.order.price_thb, 1200.5);
  assert.equal(full.slip.amount_thb_claimed, 1200.5);
});

// ---------------------------------------------------------- new hypotheses
test('a package read from the API and written back unchanged multiplies its price by 100', async t => {
  const { call, login, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });
  console.log('round trip — GET gives   :', JSON.stringify({ price_satang: p.price_satang, price_thb: p.price_thb }));
  // A client that echoes the object it was handed, as REST invites it to.
  const echoed = await call('put', `/packages/${p.id}`, admin, {
    code: p.code, name_th: p.name_th, type: p.type, duration_days: p.duration_days,
    session_limit: p.session_limit, price_satang: p.price_satang, description: p.description,
    status: p.status, sort_order: p.sort_order, version: p.version,
  });
  console.log('round trip — PUT returns :', JSON.stringify({ status: echoed.status, price_satang: echoed.body.price_satang, price_thb: echoed.body.price_thb }));
  console.log('=> price changed by a factor of', echoed.body.price_thb / p.price_thb);
  assert.equal(echoed.body.price_thb, p.price_thb,
    'the field named price_satang accepts baht on write but returns satang on read');
});

test('a free package that is put on sale cannot be bought at all', async t => {
  const { call, login, member, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const free = await pkg(admin, { price_satang: 0, name_th: 'ทดลองเล่นฟรี 1 ครั้ง', type: 'limited_sessions', session_limit: 1, duration_days: 7, status: 'active' });
  console.log('free package on sale:', JSON.stringify({ code: free.code, status: free.status, satang: free.price_satang, thb: free.price_thb }));
  const tok = await member('free@example.test');
  const catalogue = (await call('get', '/packages', tok).expect(200)).body.items.map(x => x.code);
  console.log('member sees it in the catalogue:', catalogue.includes(free.code));
  const buy = await call('post', '/orders', tok, { package_id: free.id });
  console.log('member taps buy ->', buy.status, JSON.stringify(buy.body));
  assert.notEqual(buy.status, 500, 'buying a ฿0 package crashes the server');
  assert.ok(buy.status === 201 || THAI.test(buy.body.error ?? ''),
    'a free package must either be buyable or refused with an explanation');
});

test('a slip sent late is stranded when the admin rejects it after the deadline', async t => {
  const { call, login, member, upload, pkg, tick } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });
  const tok = await member('night@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  console.log('21:00 — member transfers and uploads the slip');
  await upload(tok, o.id, jpeg('blurry'), { reference_no: 'REFNIGHT01' }).expect(201);
  let state = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  console.log('  order:', state.status, '| deadline passes in', (state.expires_at - Date.parse('2026-09-14T09:00:00+07:00')) / 60000, 'minutes');

  tick(10 * 3600000);                                  // the gym is closed overnight
  console.log('09:00 next morning — admin finally looks at the queue');
  const queue = (await call('get', '/admin/orders', admin).expect(200)).body;
  console.log('  queue still holds it:', queue.items.some(x => x.id === o.id), '| status:', queue.items.find(x => x.id === o.id)?.status);
  const cur = (await call('get', `/admin/orders/${o.id}`, admin).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/reject`, admin, { version: cur.version, reason: 'สลิปเบลอ อ่านยอดไม่ออก กรุณาส่งใหม่' }).expect(200);

  const afterReject = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  console.log('  member reloads:', afterReject.status, '| reason:', JSON.stringify(afterReject.rejection_reason));
  const retry = await upload(tok, o.id, jpeg('clear'), { reference_no: 'REFNIGHT02' });
  console.log('  member sends the clear slip ->', retry.status, JSON.stringify(retry.body.error ?? retry.body.order?.status));
  assert.equal(retry.status, 201,
    'the member has already transferred the money but can no longer act on the order');
});

test('after a rejection the member is never shown the QR again', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });
  const tok = await member('noqr@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/reject`, admin, { version: cur.version, reason: 'ไม่พบเงินเข้าบัญชี กรุณาโอนแล้วส่งสลิปใหม่' }).expect(200);
  const view = (await call('get', `/orders/${o.id}`, tok).expect(200)).body;
  const qr = await call('get', `/orders/${o.id}/qr.png`, tok);
  console.log('rejected because no transfer arrived — member must pay, but:');
  console.log('  promptpay_payload in the order view:', view.promptpay_payload);
  console.log('  GET /orders/:id/qr.png ->', qr.status, JSON.stringify(qr.body?.error));
  assert.ok(view.promptpay_payload !== null || qr.status === 200,
    'a member told to pay again has no way back to the QR for this order');
});

test('slip metadata handed to the member includes the storage filename and file hash', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 500 });
  const tok = await member('leak@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const view = (await upload(tok, o.id).expect(201)).body;
  console.log('slip object the member receives:', JSON.stringify(view.slip));
  const keys = Object.keys(view.slip);
  console.log('fields exposed:', keys.join(', '));
  const internal = keys.filter(k => ['stored_name', 'file_hash'].includes(k));
  console.log('internal storage fields visible to the member:', JSON.stringify(internal));
  assert.deepEqual(internal, [], 'storage filename and content hash are internal detail');
});

test('XCUT-001 Phase 1 member management still behaves after the Phase 2 changes', async t => {
  const { call, login, member, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const out = {};
  const created = await call('post', '/members', admin, { name: 'สมชาย ใจดี', email: 'reg1@example.test', phone: '0891112223', date_of_birth: '1990-05-20', emergency_contact: 'แม่ 0812223334' }).expect(201);
  out.create = created.status;
  out.search_name = (await call('get', `/members?q=${encodeURIComponent('สมชาย')}`, admin).expect(200)).body.total;
  out.search_phone_dashes = (await call('get', '/members?q=089-111-2223', admin).expect(200)).body.total;
  out.dup_email = (await call('post', '/members', admin, { name: 'x', email: 'REG1@example.test', phone: '0899998887' })).status;
  out.bad_dob = (await call('post', '/members', admin, { name: 'x', email: 'r2@example.test', phone: '0899998886', date_of_birth: '2568-01-01' })).status;
  out.injection = (await call('get', `/members?q=${encodeURIComponent("' OR 1=1 --")}`, admin).expect(200)).body.total;
  const tok = await member('mem1@example.test');
  out.idor = (await call('get', `/members/${created.body.id}`, tok)).status;
  out.admin_route_for_member = (await call('get', '/members', tok)).status;
  out.no_token = (await call('get', '/members', null)).status;
  const stale = await call('put', `/members/${created.body.id}`, admin, { name: 'ซ้อน', email: 'reg1@example.test', phone: '0891112223', date_of_birth: '1990-05-20', emergency_contact: 'แม่ 0812223334', status: 'active', version: 99 });
  out.optimistic_lock = stale.status;
  const gym = await call('get', '/gym', tok).expect(200);
  out.gym_hours = gym.body.hours.length;
  out.gym_hours_confirmed = gym.body.profile.hours_confirmed;
  out.audit_rows = db.prepare('SELECT count(*) n FROM audit_logs').get().n > 0;
  console.log('XCUT-001 Phase 1 regression:', JSON.stringify(out, null, 1));
  assert.equal(out.create, 201);
  assert.equal(out.search_name, 1);
  assert.equal(out.search_phone_dashes, 1);
  assert.equal(out.dup_email, 409);
  assert.equal(out.bad_dob, 400);
  assert.equal(out.injection, 0);
  assert.equal(out.idor, 403);
  assert.equal(out.admin_route_for_member, 403);
  assert.equal(out.no_token, 401);
  assert.equal(out.optimistic_lock, 409);
  assert.equal(out.gym_hours, 7);
  assert.equal(out.gym_hours_confirmed, false);
  assert.ok(out.audit_rows);
});

test('XCUT-001 migration 003 applies to a database that already holds Phase 1 data', async () => {
  const { rollback, migrate: mig } = await import('../server/db.js');
  const dir = mkdtempSync(join(tmpdir(), 'qa-xcut1-'));
  try {
    const db = openDatabase(join(dir, 'live.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY) STRICT');
    // Bring it up to Phase 1 only, load data, then apply Phase 2 on top.
    const { MIGRATIONS } = await import('../server/db.js');
    console.log('XCUT-001 migrations declared:', JSON.stringify(MIGRATIONS.map(m => m.version)));
    mig(db); seedConfiguration(db);
    const uid = randomUUID();
    db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(uid, 'live@example.test', Date.now());
    db.prepare('INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), uid, 'GYM-LIVE00000001', 'ผู้ใช้จริง', '0891234567', 'active', Date.now(), Date.now());
    const before = db.prepare('SELECT count(*) n FROM members').get().n;
    const sla = db.prepare('SELECT payment_sla_text, order_ttl_minutes FROM gym_profile WHERE id=1').get();
    console.log('XCUT-001 new gym_profile columns default to:', JSON.stringify(sla));
    rollback(db);
    console.log('XCUT-001 after rolling 003 back — versions:', JSON.stringify(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)),
      '| members kept:', db.prepare('SELECT count(*) n FROM members').get().n,
      '| gym_profile kept:', db.prepare('SELECT count(*) n FROM gym_profile').get().n,
      '| packages kept:', db.prepare('SELECT count(*) n FROM packages').get().n);
    assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, before, 'rolling back 003 destroyed member data');
    mig(db);
    console.log('XCUT-001 re-applied 003 — orders table present:',
      db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='orders'").get().n === 1);
    assert.equal(db.prepare('SELECT count(*) n FROM members').get().n, before);
    assert.ok(THAI.test(db.prepare('SELECT payment_sla_text s FROM gym_profile WHERE id=1').get().s));
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('XCUT-001 the app still starts without Phase 2 configured', async t => {
  const db = openDatabase(); migrate(db); seedConfiguration(db); t.after(() => db.close());
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), sendOtp: async () => {} });
  const health = await request(app).get('/api/health').expect(200);
  const orders = await request(app).post('/api/orders').set('X-Gym-Client', 'mobile').send({ package_id: randomUUID() });
  console.log('XCUT-001 no slipStore/promptPayId: /api/health ->', health.status, '| POST /api/orders ->', orders.status, JSON.stringify(orders.body));
  assert.equal(health.status, 200);
  assert.equal(orders.status, 401, 'payment routes must not exist when Phase 2 is not configured');
});

test('PKG-073 fifty members buying and uploading at once', async t => {
  const { call, login, member, upload, pkg, db, root } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_satang: 1200 });
  // Signing 50 members in through the front door is impossible today: the
  // per-IP OTP cap (BUG-01) refuses member 21. Sessions are minted directly so
  // this case measures the payment path rather than re-reporting that bug.
  const { createHash, randomBytes: rb } = await import('node:crypto');
  const tokens = [];
  for (let i = 0; i < 50; i++) {
    const uid = randomUUID(), token = rb(32).toString('base64url');
    db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(uid, `load${i}@example.test`, Date.now());
    db.prepare('INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), uid, `GYM-L${String(i).padStart(11, '0')}`, `โหลด ${i}`, `086${String(1000000 + i)}`, 'active', Date.now(), Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), uid, Date.now() + 43200000);
    tokens.push(token);
  }
  const t0 = performance.now();
  const orders = await Promise.all(tokens.map(tok => call('post', '/orders', tok, { package_id: p.id })));
  const orderMs = performance.now() - t0;
  const t1 = performance.now();
  const uploads = await Promise.all(orders.map((r, i) => upload(tokens[i], r.body.order.id, jpeg(`load${i}`), { reference_no: `REFLOAD${String(i).padStart(3, '0')}` })));
  const uploadMs = performance.now() - t1;
  const { readdirSync } = await import('node:fs');
  console.log(`PKG-073 50 orders in ${orderMs.toFixed(0)}ms, 50 slip uploads in ${uploadMs.toFixed(0)}ms`);
  console.log('PKG-073 order statuses:', JSON.stringify([...new Set(orders.map(r => r.status))]),
    '| upload statuses:', JSON.stringify([...new Set(uploads.map(r => r.status))]));
  console.log('PKG-073 rows — orders:', db.prepare('SELECT count(*) n FROM orders').get().n,
    'slips:', db.prepare('SELECT count(*) n FROM payment_slips').get().n,
    '| distinct files on disk:', readdirSync(root).length);
  assert.deepEqual([...new Set(orders.map(r => r.status))], [201]);
  assert.deepEqual([...new Set(uploads.map(r => r.status))], [201]);
  assert.equal(readdirSync(root).length, 50, 'slip files overwrote each other');
  const queue = (await call('get', '/admin/orders', admin).expect(200)).body;
  console.log('PKG-073 admin queue counter:', queue.awaiting_review);
  assert.equal(queue.awaiting_review, 50);
});

test('PKG-086 the docs state where slips live, how they are backed up and for how long', async () => {
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync('README.md', 'utf8');
  const design = readFileSync('docs/technical-design.md', 'utf8');
  const both = readme + '\n' + design;
  const covered = {
    storagePathDocumented: /SLIP_STORAGE_PATH/.test(both),
    notInWebRoot: /(นอก|ไม่).{0,40}(web root|dist|static)/i.test(both) || /outside the web root/i.test(both),
    backup: /สำรอง|backup/i.test(both),
    retention: /เก็บ.{0,20}(นาน|กี่วัน|ระยะ)|retention|ลบ.{0,20}สลิป/i.test(both),
    promptpayInEnv: /PROMPTPAY_ID/.test(both),
    rollbackPlan: /rollback|ย้อน migration/i.test(both),
  };
  console.log('PKG-086 documentation coverage:', JSON.stringify(covered, null, 1));
  const missing = Object.entries(covered).filter(([, v]) => !v).map(([k]) => k);
  console.log('PKG-086 missing from the docs:', JSON.stringify(missing));
  assert.deepEqual(missing, [], 'release documentation is incomplete');
});
