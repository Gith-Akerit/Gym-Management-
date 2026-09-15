// The Phase 2 defects QA reported, kept honest after the move to the counter.
//
// The member-side purchase they were found in is gone. What each of them was
// really about is not: prices that mean what their field name says, a queue
// ordered by how long somebody has actually waited, reads that do not write,
// and a reversal that can be undone without minting a second membership.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';
import { jpegBuffer } from './counter.js';

const PASSWORD = 'counter-test-password';
const HASH = hashPassword(PASSWORD);

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-fix2-'));
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos')),
    promptPayId: '0899999999',
  });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });
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
  const member = async (token, name = 'สุดา ใจดี') => (await call('post', '/members', token, {
    name, phone: `089${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
  }).expect(201)).body;
  async function shop(price = 120000) {
    const adminToken = await login(`admin-${randomUUID().slice(0, 8)}@example.test`);
    const draft = db.prepare("SELECT * FROM packages WHERE code='UNLIMITED_30D'").get();
    await call('put', `/packages/${draft.id}`, adminToken, {
      version: draft.version, code: draft.code, name_th: draft.name_th, type: draft.type,
      duration_days: draft.duration_days, price_satang: price, status: 'active',
    }).expect(200);
    return { adminToken, packageId: draft.id, package: db.prepare('SELECT * FROM packages WHERE id=?').get(draft.id) };
  }
  const sell = (token, memberId, packageId, method = 'cash', fields = {}) => {
    const req = call('post', `/members/${memberId}/grant`, token)
      .field('package_id', packageId).field('payment_method', method);
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    return req;
  };
  /** An order the old member app left waiting for somebody to look at it. */
  function legacyOrder(memberId, pkg, { uploadedAt = time } = {}) {
    const id = randomUUID();
    db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
      package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
      status,payment_method,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'awaiting_review','promptpay',?,?,?)`)
      .run(id, memberId, pkg.id, pkg.code, pkg.name_th, pkg.type, pkg.duration_days, pkg.session_limit,
        pkg.price_satang, time, time + 3600000, time);
    const stored = new SlipStore(join(root, 'slips')).save(jpegBuffer());
    db.prepare(`INSERT INTO payment_slips(id,order_id,stored_name,content_type,byte_size,file_hash,
      reference_no,transferred_at,amount_satang_claimed,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), id, stored.storedName, stored.contentType, stored.byteSize, stored.fileHash,
        `REF-${randomUUID().slice(0, 8)}`, uploadedAt - 60000, pkg.price_satang, uploadedAt);
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  }

  return { db, call, login, member, shop, sell, legacyOrder, tick: ms => { time += ms; }, at: () => time };
}

test('an order approved after a reversal reinstates its membership', async t => {
  // The revoked row is still there, so the second approval has to update it in
  // place rather than collide with the UNIQUE constraint (P2-BUG-02).
  const { db, call, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);

  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true }).expect(200);
  await call('post', `/admin/orders/${order.id}/reverse`, adminToken,
    { version: order.version + 1, reason: 'อนุมัติผิดคน' }).expect(200);
  // Put it back in the queue the way the member app used to, by sending the
  // slip again. Nothing does that now, so the row is set directly -- the bug
  // being guarded against is in the approval, not in how it got there.
  db.prepare("UPDATE orders SET status='awaiting_review',version=version+1 WHERE id=?").run(order.id);
  const again = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 3, checked_against_bank: true }).expect(200);

  assert.equal(again.body.entitlement.status, 'active');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1,
    'reinstated, never duplicated');
});

test('a short payment cannot be approved without a written reason', async t => {
  const { db, call, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  db.prepare('UPDATE payment_slips SET amount_satang_claimed=? WHERE order_id=?').run(60000, order.id);

  const refused = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true, note: 'ok' }).expect(400);
  assert.match(refused.body.fields.note, /อย่างน้อย 10 ตัวอักษร/);
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true, note: 'จ่ายส่วนต่างเป็นเงินสดที่เคาน์เตอร์' }).expect(200);
});

test('prices mean what their field name says, in both directions', async t => {
  const { call, login } = fixture(t);
  const adminToken = await login('units@example.test');
  const base = { code: 'UNITS_1', name_th: 'ทดสอบหน่วย', type: 'unlimited', duration_days: 30 };

  const inBaht = await call('post', '/packages', adminToken, { ...base, price_thb: '1299.50' }).expect(201);
  assert.equal(inBaht.body.price_satang, 129950);
  assert.equal(inBaht.body.price_thb, 1299.5);

  // Reading the object and writing it straight back must not move the price.
  const echoed = await call('put', `/packages/${inBaht.body.id}`, adminToken, {
    code: inBaht.body.code, name_th: inBaht.body.name_th, type: inBaht.body.type,
    duration_days: inBaht.body.duration_days, session_limit: inBaht.body.session_limit,
    price_satang: inBaht.body.price_satang, description: inBaht.body.description,
    status: inBaht.body.status, sort_order: inBaht.body.sort_order, version: inBaht.body.version,
  }).expect(200);
  assert.equal(echoed.body.price_satang, 129950, 'a round trip must not multiply the price by 100');
  assert.equal(echoed.body.price_thb, 1299.5);

  // Satang is a whole number, and sending both units at once is ambiguous.
  await call('post', '/packages', adminToken, { ...base, code: 'UNITS_2', price_satang: 1.5 }).expect(400);
  await call('post', '/packages', adminToken, { ...base, code: 'UNITS_3', price_satang: 100, price_thb: 1 }).expect(400);
});

test('the slip handed back carries no storage detail', async t => {
  const { call, member, shop, sell, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const who = await member(adminToken);
  const sold = await sell(adminToken, who.id, packageId, 'transfer', { reference_no: 'REF-DETAIL' })
    .attach('slip', jpegBuffer(), { filename: 'slip.jpg', contentType: 'image/jpeg' }).expect(201);

  for (const field of ['stored_name', 'file_hash']) {
    assert.equal(field in sold.body.slip, false, `${field} is internal detail`);
  }
  const detail = await call('get', `/admin/orders/${sold.body.order.id}`, adminToken).expect(200);
  assert.equal('file_hash' in detail.body.slip, false);
  // The image is still reachable by slip id, which is how the screen loads it.
  const slipId = db.prepare('SELECT id FROM payment_slips WHERE order_id=?').get(sold.body.order.id).id;
  await call('get', `/slips/${slipId}/image`, adminToken).expect(200);
});

test('the review queue is ordered by when each slip arrived', async t => {
  const { call, member, shop, legacyOrder, tick } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const people = [];
  for (let i = 0; i < 3; i++) people.push(await member(adminToken, `สมาชิก ${i}`));
  // Slips arrive in the opposite order to the sign-ups, and the queue has to
  // follow the wait the screen shows rather than the order's own age.
  for (const who of [...people].reverse()) { legacyOrder(who.id, pkg); tick(30000); }

  const queue = await call('get', '/admin/orders', adminToken).expect(200);
  const waiting = queue.body.items.map(item => item.waiting_since);
  assert.deepEqual(waiting, [...waiting].sort((a, b) => a - b), 'longest wait first, measured from the slip');
  assert.deepEqual(queue.body.items.map(item => item.member_name), ['สมาชิก 2', 'สมาชิก 1', 'สมาชิก 0']);
});

test('reading an order does not write to the database', async t => {
  // expireStaleOrders used to run on every GET, turning somebody watching a
  // screen into a stream of writes. The sweeper owns that job now.
  const { call, member, shop, legacyOrder, tick, db } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  db.prepare("UPDATE orders SET status='pending_payment' WHERE id=?").run(order.id);
  tick(61 * 60000);

  const before = db.prepare('SELECT version, status FROM orders WHERE id=?').get(order.id);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('get', `/admin/orders/${order.id}`, adminToken).expect(200)).body.order.status, 'expired');
  }
  const after = db.prepare('SELECT version, status FROM orders WHERE id=?').get(order.id);
  assert.deepEqual(after, before, 'a read changed the row');
  assert.equal(after.status, 'pending_payment', 'the stored status is only changed by the sweeper');
});

test('a free package is handed over without anybody swearing money arrived', async t => {
  const { call, member, shop, sell, db } = fixture(t);
  const { adminToken, packageId } = await shop(0);
  const who = await member(adminToken);
  const sold = await sell(adminToken, who.id, packageId, 'none', { note: 'แพ็กเกจแนะนำเพื่อน' }).expect(201);
  assert.equal(sold.body.order.price_thb, 0);
  assert.equal(sold.body.free, true);
  assert.equal(sold.body.order.status, 'paid');
  assert.equal(db.prepare('SELECT manual_grant FROM orders WHERE id=?').get(sold.body.order.id).manual_grant, 1);
});
