// The Phase 2 defects QA reported, each pinned by the case it broke.
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

function jpeg(tag = 'x') {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(`GPS ${tag}`, 'latin1')]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xe1]), length, exif,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-p2-'));
  const inbox = new Map();
  let time = Date.parse('2026-09-14T21:00:00+07:00');
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code),
    slipStore: new SlipStore(root), promptPayId: '0899999999',
  });
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const sendSlip = (token, orderId, fields = {}) => {
    const req = http.post(`/api/orders/${orderId}/slip`).set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${token}`)
      .field('reference_no', fields.reference_no ?? `REF${randomUUID().slice(0, 8).toUpperCase()}`)
      .field('transferred_at', fields.transferred_at ?? '2026-09-14T20:45');
    if (fields.amount_thb !== undefined) req.field('amount_thb', String(fields.amount_thb));
    return req.attach('slip', jpeg(fields.tag ?? 'a'), { filename: 'slip.jpg', contentType: 'image/jpeg' });
  };
  async function login(email, role = 'member') {
    if (role !== 'member') db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), email, role, time);
    const start = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const verified = await call('post', '/auth/verify-otp', null, { challenge_id: start.body.challenge_id, code: inbox.get(email) }).expect(200);
    return verified.body.token;
  }
  let phone = 1000000;
  async function member(email, name = 'สุดา ใจดี') {
    const token = await login(email);
    await call('put', '/me/profile', token, { name, phone: `089${phone++}` }).expect(201);
    return token;
  }
  /** An admin, plus the monthly package on sale at 1,200 baht. */
  async function shop() {
    const adminToken = await login(`admin-${randomUUID().slice(0, 8)}@example.test`, 'admin');
    const draft = db.prepare("SELECT * FROM packages WHERE code='UNLIMITED_30D'").get();
    await call('put', `/packages/${draft.id}`, adminToken, {
      version: draft.version, code: draft.code, name_th: draft.name_th, type: draft.type,
      duration_days: draft.duration_days, price_thb: 1200, status: 'active',
    }).expect(200);
    return { adminToken, packageId: draft.id };
  }
  return { db, call, login, member, shop, sendSlip, tick: ms => { time += ms; } };
}

test('a rejected order stays workable: the deadline only binds an unpaid one', async t => {
  // The member transferred at closing time and nobody looked until morning.
  // Expiring the order at that point stranded money that had really arrived.
  const { call, member, shop, sendSlip, tick } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('overnight@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await sendSlip(token, order.id).expect(201);

  tick(10 * 3600000);
  const queue = await call('get', '/admin/orders', adminToken).expect(200);
  assert.ok(queue.body.items.some(item => item.id === order.id), 'the slip must still be in the queue');

  const current = (await call('get', `/admin/orders/${order.id}`, adminToken).expect(200)).body.order;
  assert.equal(current.status, 'awaiting_review');
  await call('post', `/admin/orders/${order.id}/reject`, adminToken,
    { version: current.version, reason: 'สลิปเบลอ อ่านยอดไม่ออก กรุณาส่งใหม่' }).expect(200);

  const retried = await sendSlip(token, order.id, { tag: 'clear' }).expect(201);
  assert.equal(retried.body.order.status, 'awaiting_review', 'the member could not act on an order they had paid for');
});

test('a member told to pay again can still reach the QR for that order', async t => {
  const { call, member, shop, sendSlip } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('payagain@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await sendSlip(token, order.id).expect(201);
  await call('post', `/admin/orders/${order.id}/reject`, adminToken,
    { version: order.version + 1, reason: 'ไม่พบเงินเข้าบัญชี กรุณาโอนแล้วส่งสลิปใหม่' }).expect(200);

  const view = await call('get', `/orders/${order.id}`, token).expect(200);
  assert.ok(view.body.promptpay_payload, 'the commonest rejection means the member still owes money');
  await call('get', `/orders/${order.id}/qr.png`, token).expect(200);
});

test('an admin can bring back an order that expired before anyone looked', async t => {
  const { call, member, shop, tick, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('stranded@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  tick(61 * 60000);
  assert.equal((await call('get', `/orders/${order.id}`, token).expect(200)).body.order.status, 'expired');

  const seen = (await call('get', `/admin/orders/${order.id}`, adminToken).expect(200)).body.order;
  const reopened = await call('post', `/admin/orders/${order.id}/reopen`, adminToken,
    { version: seen.version, minutes: 1440 }).expect(200);
  assert.equal(reopened.body.order.status, 'pending_payment');
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action='order.reopen'").get().n, 1);
  await call('post', `/admin/orders/${order.id}/reopen`, adminToken,
    { version: reopened.body.order.version }).expect(409);
});

test('an order approved after a reversal reinstates its membership', async t => {
  // order_id is UNIQUE, which is what stops a double-click minting a second
  // membership. The second approval used to collide with the revoked row and
  // surface to the admin as a duplicate email address.
  const { call, member, shop, sendSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('secondchance@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await sendSlip(token, order.id).expect(201);
  const approved = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(200);
  await call('post', `/admin/orders/${order.id}/reverse`, adminToken,
    { version: approved.body.order.version, reason: 'อนุมัติผิดคน' }).expect(200);

  const retried = await sendSlip(token, order.id, { tag: 'right' }).expect(201);
  const again = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: retried.body.order.version, checked_against_bank: true }).expect(200);
  assert.equal(again.body.order.status, 'paid');
  assert.equal(again.body.entitlement.status, 'active');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1);
  assert.equal((await call('get', '/entitlements', token).expect(200)).body.items.length, 1);
});

test('a short payment cannot be approved without a written reason', async t => {
  const { call, member, shop, sendSlip } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('shortpay@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await sendSlip(token, order.id, { amount_thb: 500 }).expect(201);

  const detail = await call('get', `/admin/orders/${order.id}`, adminToken).expect(200);
  assert.equal(detail.body.amount_mismatch, true);

  const version = detail.body.order.version;
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version, checked_against_bank: true }).expect(400);
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version, checked_against_bank: true, note: 'สั้นไป' }).expect(400);

  const ok = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version, checked_against_bank: true, note: 'ลูกค้าจ่ายส่วนที่เหลือเป็นเงินสดที่เคาน์เตอร์' }).expect(200);
  assert.equal(ok.body.order.review_note, 'ลูกค้าจ่ายส่วนที่เหลือเป็นเงินสดที่เคาน์เตอร์');

  // A slip that matches still needs no explanation.
  const second = await member('exactpay@example.test');
  const other = (await call('post', '/orders', second, { package_id: packageId }).expect(201)).body.order;
  await sendSlip(second, other.id, { amount_thb: 1200, tag: 'exact' }).expect(201);
  await call('post', `/admin/orders/${other.id}/approve`, adminToken,
    { version: other.version + 1, checked_against_bank: true }).expect(200);
});

test('a free package skips the QR and the slip entirely', async t => {
  // The seeded trial package is priced at zero. Building a PromptPay QR for
  // nothing is impossible, and buying one used to return a 500.
  const { call, member, login, db } = fixture(t);
  const adminToken = await login('admin-free@example.test', 'admin');
  const trial = db.prepare("SELECT * FROM packages WHERE code='TRIAL_1_VISIT'").get();
  await call('put', `/packages/${trial.id}`, adminToken, {
    version: trial.version, code: trial.code, name_th: trial.name_th, type: trial.type,
    duration_days: trial.duration_days, session_limit: trial.session_limit,
    price_satang: 0, status: 'active',
  }).expect(200);

  const token = await member('freetrial@example.test');
  const bought = await call('post', '/orders', token, { package_id: trial.id }).expect(201);
  assert.equal(bought.body.order.status, 'awaiting_review', 'nothing to pay, so it waits to be granted');
  assert.equal(bought.body.free, true);
  assert.equal(bought.body.promptpay_payload, null);
  await call('get', `/orders/${bought.body.order.id}/qr.png`, token).expect(409);

  const granted = await call('post', `/admin/orders/${bought.body.order.id}/approve`, adminToken,
    { version: bought.body.order.version, checked_against_bank: true }).expect(200);
  assert.equal(granted.body.entitlement.sessions_remaining, 1);
});

test('prices mean what their field name says, in both directions', async t => {
  const { call, login } = fixture(t);
  const adminToken = await login('units@example.test', 'admin');
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
  const { call, member, shop, sendSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('nodetail@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  const view = await sendSlip(token, order.id).expect(201);

  for (const field of ['stored_name', 'file_hash']) {
    assert.equal(field in view.body.slip, false, `${field} is internal detail`);
  }
  const detail = await call('get', `/admin/orders/${order.id}`, adminToken).expect(200);
  assert.equal('file_hash' in detail.body.slip, false);
  // The image is still reachable by slip id, which is how the screens load it.
  const slipId = db.prepare('SELECT id FROM payment_slips WHERE order_id=?').get(order.id).id;
  await call('get', `/slips/${slipId}/image`, token).expect(200);
});

test('the review queue is ordered by when each slip arrived', async t => {
  const { call, member, shop, sendSlip, tick } = fixture(t);
  const { adminToken, packageId } = await shop();
  const orders = [];
  for (let i = 0; i < 3; i++) {
    const token = await member(`queue${i}@example.test`, `สมาชิก ${i}`);
    orders.push({ token, order: (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order });
    tick(120000);
  }
  // Slips arrive in the opposite order to the purchases.
  for (const entry of [...orders].reverse()) {
    await sendSlip(entry.token, entry.order.id).expect(201);
    tick(30000);
  }
  const queue = await call('get', '/admin/orders', adminToken).expect(200);
  const waiting = queue.body.items.map(item => item.waiting_since);
  assert.deepEqual(waiting, [...waiting].sort((a, b) => a - b), 'longest wait first, measured from the slip');
  assert.deepEqual(queue.body.items.map(item => item.member_name), ['สมาชิก 2', 'สมาชิก 1', 'สมาชิก 0']);
});

test('reading an order does not write to the database', async t => {
  // expireStaleOrders used to run on every GET, turning a member polling their
  // order status into a stream of writes. The sweeper owns that job now.
  const { call, member, shop, tick, db } = fixture(t);
  const { packageId } = await shop();
  const token = await member('readonly@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  tick(61 * 60000);

  const before = db.prepare('SELECT version, status FROM orders WHERE id=?').get(order.id);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('get', `/orders/${order.id}`, token).expect(200)).body.order.status, 'expired');
  }
  const after = db.prepare('SELECT version, status FROM orders WHERE id=?').get(order.id);
  assert.deepEqual(after, before, 'a read changed the row');
  assert.equal(after.status, 'pending_payment', 'the stored status is only changed by the sweeper');
});
