import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';

const MERCHANT = '0899999999';
const DAY = 86400000;

// ---------------------------------------------------------------- fixtures

/** A structurally valid JPEG carrying an EXIF block with GPS text inside. */
function jpegWithExif() {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('GPSLatitude 13.7563N', 'latin1')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), lengthOf(exif), exif]);
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), jfif, app1,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}
function lengthOf(payload) {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length + 2);
  return header;
}
const pngBytes = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
]);

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-slips-'));
  const inbox = new Map();
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code),
    slipStore: new SlipStore(root), promptPayId: MERCHANT,
  });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const uploadSlip = (token, orderId, file = jpegWithExif(), fields = {}) => {
    const req = request(app).post(`/api/orders/${orderId}/slip`).set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${token}`)
      .field('reference_no', fields.reference_no ?? `REF-${randomUUID().slice(0, 8)}`)
      .field('transferred_at', fields.transferred_at ?? '2026-09-14T08:45');
    if (fields.amount_thb !== undefined) req.field('amount_thb', String(fields.amount_thb));
    return req.attach('slip', file, { filename: fields.filename ?? 'slip.jpg', contentType: fields.contentType ?? 'image/jpeg' });
  };

  async function login(email, role = 'member') {
    if (role !== 'member') db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), email, role, time);
    const start = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const verified = await call('post', '/auth/verify-otp', null, { challenge_id: start.body.challenge_id, code: inbox.get(email) }).expect(200);
    return verified.body.token;
  }
  async function member(email, name = 'สุดา ใจดี', phone = `089${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`) {
    const token = await login(email);
    await call('put', '/me/profile', token, { name, phone }).expect(201);
    return token;
  }
  /** An admin plus one package actually on sale at 1,200 baht. */
  async function shop(price = 120000) {
    const adminToken = await login(`admin-${randomUUID().slice(0, 8)}@example.test`, 'admin');
    const draft = db.prepare("SELECT * FROM packages WHERE code='UNLIMITED_30D'").get();
    await call('put', `/packages/${draft.id}`, adminToken, {
      version: draft.version, code: draft.code, name_th: draft.name_th, type: draft.type,
      duration_days: draft.duration_days, price_satang: price, status: 'active',
    }).expect(200);
    return { adminToken, packageId: draft.id };
  }
  return { db, call, login, member, shop, uploadSlip, root, tick: ms => { time += ms; }, at: () => time };
}

// ------------------------------------------------------------------- buying

test('buying produces one order at the price the server decides, with a scannable QR', async t => {
  const { call, member, shop } = fixture(t);
  const { packageId } = await shop();
  const token = await member('buyer@example.test');

  const created = await call('post', '/orders', token, { package_id: packageId }).expect(201);
  assert.equal(created.body.order.status, 'pending_payment');
  assert.equal(created.body.order.price_thb, 1200);
  assert.equal(created.body.payment_sla_text, 'ภายใน 30 นาทีในเวลาทำการ');
  // Tag 54 in the payload has to be the amount the member actually owes.
  assert.match(created.body.promptpay_payload, /54041200/);

  // Tapping buy repeatedly must not produce several orders to pay for.
  for (let i = 0; i < 4; i++) {
    const again = await call('post', '/orders', token, { package_id: packageId }).expect(200);
    assert.equal(again.body.order.id, created.body.order.id);
  }
  assert.equal((await call('get', '/orders', token).expect(200)).body.items.length, 1);

  const qr = await request_png(call, token, created.body.order.id);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.ok(qr.body.length > 200);
});
const request_png = (call, token, orderId) => call('get', `/orders/${orderId}/qr.png`, token).expect(200);

test('the client cannot dictate the price, and a later price edit does not rewrite the order', async t => {
  const { call, member, shop, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('snapshot@example.test');

  // amount is not part of the schema; sending one is rejected outright.
  await call('post', '/orders', token, { package_id: packageId, price_satang: 100 }).expect(400);
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  assert.equal(order.price_satang_snapshot, 120000);

  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  await call('put', `/packages/${packageId}`, adminToken, {
    version: pkg.version, code: pkg.code, name_th: pkg.name_th, type: pkg.type,
    duration_days: pkg.duration_days, price_thb: 2500, status: 'active',
  }).expect(200);

  const reread = await call('get', `/orders/${order.id}`, token).expect(200);
  assert.equal(reread.body.order.price_thb, 1200);
  assert.match(reread.body.promptpay_payload, /54041200/);
});

test('a draft or archived package cannot be bought', async t => {
  const { call, member, shop, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('draftbuyer@example.test');
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  await call('delete', `/packages/${packageId}`, adminToken, { version: pkg.version }).expect(200);
  await call('post', '/orders', token, { package_id: packageId }).expect(404);

  const stillDraft = db.prepare("SELECT id FROM packages WHERE code='VISIT_10_90D'").get();
  await call('post', '/orders', token, { package_id: stillDraft.id }).expect(404);
});

test('an unpaid order expires on its own and stops being payable', async t => {
  const { call, member, shop, tick, uploadSlip } = fixture(t);
  const { packageId } = await shop();
  const token = await member('slow@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;

  tick(61 * 60000);
  const expired = await call('get', `/orders/${order.id}`, token).expect(200);
  assert.equal(expired.body.order.status, 'expired');
  assert.equal(expired.body.promptpay_payload, null);
  await call('get', `/orders/${order.id}/qr.png`, token).expect(409);
  await uploadSlip(token, order.id).expect(409);

  // The member is free to start again.
  const fresh = await call('post', '/orders', token, { package_id: packageId }).expect(201);
  assert.notEqual(fresh.body.order.id, order.id);
});

// --------------------------------------------------------------- slip upload

test('uploading a slip means awaiting review, never paid', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { packageId } = await shop();
  const token = await member('uploader@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;

  const uploaded = await uploadSlip(token, order.id, jpegWithExif(), { reference_no: 'REF-0001', amount_thb: 1200 });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.order.status, 'awaiting_review');
  assert.equal(uploaded.body.slip.reference_no, 'REF-0001');
  assert.equal(uploaded.body.slip.amount_thb_claimed, 1200);
  assert.equal(uploaded.body.entitlement, null);
  // Nothing in the member response may imply the membership is usable yet.
  assert.equal(uploaded.body.order.status === 'paid', false);
});

test('the stored file is renamed by the server and stripped of EXIF', async t => {
  const { call, member, shop, uploadSlip, db, root } = fixture(t);
  const { packageId } = await shop();
  const token = await member('exif@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;

  const original = jpegWithExif();
  assert.ok(original.includes(Buffer.from('GPSLatitude', 'latin1')), 'fixture must actually carry GPS data');
  await uploadSlip(token, order.id, original, { filename: '../../../etc/passwd.jpg' }).expect(201);

  const stored = db.prepare('SELECT * FROM payment_slips WHERE order_id=?').get(order.id);
  assert.match(stored.stored_name, /^[0-9a-f-]{36}\.jpg$/);
  assert.deepEqual(readdirSync(root), [stored.stored_name]);

  const bytes = readFileSync(join(root, stored.stored_name));
  assert.equal(bytes.includes(Buffer.from('GPSLatitude', 'latin1')), false, 'EXIF must not survive');
  assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', 'still a JPEG');
});

test('files that are not really images are refused whatever they claim to be', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { packageId } = await shop();
  const token = await member('evil@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;

  const rejected = [
    { file: Buffer.from('<?php system($_GET["c"]); ?>'), filename: 'shell.jpg', contentType: 'image/jpeg' },
    { file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), filename: 'x.svg', contentType: 'image/svg+xml' },
    { file: Buffer.from('%PDF-1.4\n% fake slip'), filename: 'slip.pdf', contentType: 'application/pdf' },
    { file: Buffer.alloc(0), filename: 'empty.jpg', contentType: 'image/jpeg' },
    { file: Buffer.from('MZ\x90\x00' + 'x'.repeat(40)), filename: 'setup.exe', contentType: 'image/png' },
  ];
  for (const { file, filename, contentType } of rejected) {
    const response = await uploadSlip(token, order.id, file, { filename, contentType });
    assert.equal(response.status, 400, `${filename} must be refused`);
  }
  // HEIC is detected and explained rather than silently stored unviewable.
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)]);
  const heicResponse = await uploadSlip(token, order.id, heic, { filename: 'IMG_0001.HEIC', contentType: 'image/heic' });
  assert.equal(heicResponse.status, 400);
  assert.match(heicResponse.body.error, /HEIC/);

  assert.equal(db.prepare('SELECT count(*) n FROM payment_slips').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'pending_payment');

  await uploadSlip(token, order.id, pngBytes(), { filename: 'ok.png', contentType: 'image/png' }).expect(201);
});

test('a file over the size limit is refused in Thai rather than as a bare 413', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { packageId } = await shop();
  const token = await member('big@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  const huge = Buffer.concat([jpegWithExif(), Buffer.alloc(6 * 1024 * 1024)]);
  const response = await uploadSlip(token, order.id, huge, { filename: 'huge.jpg' });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /MB/);
});

test('slip fields are validated: reference number, transfer time and amount', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { packageId } = await shop();
  const token = await member('fields@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;

  for (const fields of [
    { reference_no: 'ab' },
    { reference_no: 'REF 001 WITH SPACES' },
    { transferred_at: 'ไม่ใช่เวลา' },
    { transferred_at: '2026-09-20T08:45' },   // future
    { transferred_at: '2026-07-01T08:45' },   // older than 30 days
    { amount_thb: '-5' },
  ]) {
    const response = await uploadSlip(token, order.id, jpegWithExif(), fields);
    assert.equal(response.status, 400, JSON.stringify(fields));
  }
});

test('re-uploading keeps the old slip and shows the newest', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { packageId } = await shop();
  const token = await member('again@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;

  await uploadSlip(token, order.id, jpegWithExif(), { reference_no: 'REF-FIRST' }).expect(201);
  const second = await uploadSlip(token, order.id, pngBytes(), { reference_no: 'REF-SECOND', contentType: 'image/png' }).expect(201);

  assert.equal(second.body.slip.reference_no, 'REF-SECOND');
  assert.equal(second.body.slip_history.length, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM payment_slips WHERE order_id=? AND superseded_at IS NOT NULL').get(order.id).n, 1);
});

// -------------------------------------------------------------- admin review

test('approving turns one confirmed transfer into exactly one membership', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('approved@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id, jpegWithExif(), { amount_thb: 1200 }).expect(201);

  const queue = await call('get', '/admin/orders', adminToken).expect(200);
  assert.equal(queue.body.awaiting_review, 1);
  assert.equal(queue.body.items[0].member_name, 'สุดา ใจดี');

  const detail = await call('get', `/admin/orders/${order.id}`, adminToken).expect(200);
  assert.equal(detail.body.amount_mismatch, false);
  assert.equal(detail.body.member.email, 'approved@example.test');

  // The bank-app confirmation is compulsory: there is no other evidence.
  await call('post', `/admin/orders/${order.id}/approve`, adminToken, { version: detail.body.order.version }).expect(400);

  const approved = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: detail.body.order.version, checked_against_bank: true }).expect(200);
  assert.equal(approved.body.order.status, 'paid');
  assert.equal(approved.body.entitlement.sessions_remaining, null);
  assert.equal(approved.body.entitlement.expires_at, approved.body.order.reviewed_at + 30 * DAY);

  const mine = await call('get', '/entitlements', token).expect(200);
  assert.equal(mine.body.items.length, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1);
});

test('a limited-sessions package grants the sessions bought and still expires', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken } = await shop();
  const draft = db.prepare("SELECT * FROM packages WHERE code='VISIT_10_90D'").get();
  await call('put', `/packages/${draft.id}`, adminToken, {
    version: draft.version, code: draft.code, name_th: draft.name_th, type: draft.type,
    duration_days: draft.duration_days, session_limit: draft.session_limit, price_thb: 900, status: 'active',
  }).expect(200);

  const token = await member('tenvisits@example.test');
  const order = (await call('post', '/orders', token, { package_id: draft.id }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);
  const approved = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(200);

  assert.equal(approved.body.entitlement.sessions_total, 10);
  assert.equal(approved.body.entitlement.sessions_remaining, 10);
  assert.equal(approved.body.entitlement.expires_at, approved.body.order.reviewed_at + 90 * DAY);
});

test('a double-clicked approve and two admins at once both yield one entitlement', async t => {
  const { call, member, shop, uploadSlip, login, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const secondAdmin = await login('second-admin@example.test', 'admin');
  const token = await member('racing@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);
  const version = order.version + 1;

  const results = await Promise.allSettled([
    call('post', `/admin/orders/${order.id}/approve`, adminToken, { version, checked_against_bank: true }),
    call('post', `/admin/orders/${order.id}/approve`, adminToken, { version, checked_against_bank: true }),
    call('post', `/admin/orders/${order.id}/approve`, secondAdmin, { version, checked_against_bank: true }),
    call('post', `/admin/orders/${order.id}/reject`, secondAdmin, { version, reason: 'ยอดไม่ตรง' }),
  ]);
  const statuses = results.map(r => r.value?.status ?? 500);
  assert.equal(statuses.filter(s => s === 200).length, 1, `exactly one winner, got ${statuses}`);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1);
  assert.equal((await call('get', '/entitlements', token).expect(200)).body.items.length, 1);
});

test('an order that was already decided cannot be approved again', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('settled@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);

  const approved = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(200);
  const paidVersion = approved.body.order.version;

  await call('post', `/admin/orders/${order.id}/approve`, adminToken, { version: paidVersion, checked_against_bank: true }).expect(409);
  await call('post', `/admin/orders/${order.id}/reject`, adminToken, { version: paidVersion, reason: 'เปลี่ยนใจ' }).expect(409);
  // A stale version loses before the status check even matters.
  await call('post', `/admin/orders/${order.id}/approve`, adminToken, { version: 1, checked_against_bank: true }).expect(409);
});

test('rejecting explains why and lets the member send a new slip on the same order', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('rejected@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);

  await call('post', `/admin/orders/${order.id}/reject`, adminToken, { version: order.version + 1 }).expect(400);
  const rejected = await call('post', `/admin/orders/${order.id}/reject`, adminToken,
    { version: order.version + 1, reason: 'สลิปอ่านยอดไม่ออก' }).expect(200);
  assert.equal(rejected.body.order.status, 'rejected');

  const seen = await call('get', `/orders/${order.id}`, token).expect(200);
  assert.equal(seen.body.order.rejection_reason, 'สลิปอ่านยอดไม่ออก');

  const retried = await uploadSlip(token, order.id, pngBytes(), { contentType: 'image/png' }).expect(201);
  assert.equal(retried.body.order.status, 'awaiting_review');
  assert.equal(retried.body.order.rejection_reason, null);
  assert.equal(retried.body.order.id, order.id, 'no new order needed');
});

test('an approval made in error can be reversed, revoking the membership', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('reversed@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);
  const approved = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(200);

  await call('post', `/admin/orders/${order.id}/reverse`, adminToken,
    { version: approved.body.order.version, reason: 'อนุมัติผิดคน' }).expect(200);

  assert.equal((await call('get', '/entitlements', token).expect(200)).body.items.length, 0);
  const entitlement = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(order.id);
  assert.equal(entitlement.status, 'revoked');
  assert.equal(entitlement.revoked_reason, 'อนุมัติผิดคน');

  const actions = db.prepare('SELECT action FROM audit_logs ORDER BY created_at').all().map(a => a.action);
  for (const expected of ['order.create', 'order.slip_upload', 'order.approve', 'entitlement.revoke', 'order.reverse']) {
    assert.ok(actions.includes(expected), `audit must record ${expected}`);
  }
});

test('a suspended member cannot be approved and cannot start a new order', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('suspended@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);

  const row = db.prepare('SELECT * FROM members WHERE id=?').get(order.member_id);
  await call('delete', `/members/${row.id}`, adminToken, { version: row.version }).expect(200);

  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(409);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n, 0);
  await call('post', '/orders', token, { package_id: packageId }).expect(403);
});

test('a mismatched amount and a reused transfer are both flagged to the admin', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { adminToken, packageId } = await shop();
  const first = await member('dup1@example.test', 'คนแรก');
  const second = await member('dup2@example.test', 'คนที่สอง');

  const orderA = (await call('post', '/orders', first, { package_id: packageId }).expect(201)).body.order;
  const shared = jpegWithExif();
  await uploadSlip(first, orderA.id, shared, { reference_no: 'REF-SHARED', amount_thb: 500 }).expect(201);

  const flagged = await call('get', `/admin/orders/${orderA.id}`, adminToken).expect(200);
  assert.equal(flagged.body.amount_mismatch, true, 'paying 500 for a 1,200 package must be flagged');
  assert.deepEqual(flagged.body.duplicates, []);

  const orderB = (await call('post', '/orders', second, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(second, orderB.id, shared, { reference_no: 'REF-SHARED', amount_thb: 1200 }).expect(201);

  const duplicate = await call('get', `/admin/orders/${orderB.id}`, adminToken).expect(200);
  assert.equal(duplicate.body.duplicates.length, 1);
  assert.equal(duplicate.body.duplicates[0].order_id, orderA.id);
  assert.equal(duplicate.body.duplicates[0].kind, 'file');
  // Flagged, not blocked — only a human can tell a genuine re-send from fraud.
  await call('post', `/admin/orders/${orderB.id}/approve`, adminToken,
    { version: duplicate.body.order.version, checked_against_bank: true }).expect(200);
});

// -------------------------------------------------------------- access control

test('one member cannot reach another member order, slip or entitlement', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { packageId } = await shop();
  const owner = await member('owner@example.test', 'เจ้าของ');
  const nosy = await member('nosy@example.test', 'คนอื่น');

  const order = (await call('post', '/orders', owner, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(owner, order.id).expect(201);
  const slip = db.prepare('SELECT id FROM payment_slips WHERE order_id=?').get(order.id);

  await call('get', `/orders/${order.id}`, nosy).expect(404);
  await call('get', `/orders/${order.id}/qr.png`, nosy).expect(404);
  await call('post', `/orders/${order.id}/cancel`, nosy).expect(404);
  await uploadSlip(nosy, order.id).expect(404);
  await call('get', `/slips/${slip.id}/image`, nosy).expect(404);
  assert.equal((await call('get', '/orders', nosy).expect(200)).body.items.length, 0);

  // The owner and an admin may both see the image.
  await call('get', `/slips/${slip.id}/image`, owner).expect(200);
});

test('only an admin may review orders or read the queue', async t => {
  const { call, member, shop, uploadSlip, login } = fixture(t);
  const { packageId } = await shop();
  const token = await member('regular@example.test');
  const staff = await login('counter@example.test', 'staff');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);

  for (const who of [null, token, staff]) {
    const expected = who ? 403 : 401;
    await call('get', '/admin/orders', who).expect(expected);
    await call('get', `/admin/orders/${order.id}`, who).expect(expected);
    await call('post', `/admin/orders/${order.id}/approve`, who, { version: 2, checked_against_bank: true }).expect(expected);
    await call('post', `/admin/orders/${order.id}/reject`, who, { version: 2, reason: 'x' }).expect(expected);
    await call('post', `/admin/orders/${order.id}/reverse`, who, { version: 2, reason: 'x' }).expect(expected);
    await call('get', '/admin/sales', who).expect(expected);
  }
});

test('the slip image is served with headers that stop it being treated as a page', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('headers@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id, pngBytes(), { contentType: 'image/png' }).expect(201);
  const slip = db.prepare('SELECT id FROM payment_slips WHERE order_id=?').get(order.id);

  const image = await call('get', `/slips/${slip.id}/image`, adminToken).expect(200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.match(image.headers['content-security-policy'], /sandbox/);
});

// -------------------------------------------------------------- housekeeping

test('stacking a second package keeps the first, and sales totals match the orders', async t => {
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('stacked@example.test');

  const visits = db.prepare("SELECT * FROM packages WHERE code='VISIT_10_90D'").get();
  await call('put', `/packages/${visits.id}`, adminToken, {
    version: visits.version, code: visits.code, name_th: visits.name_th, type: visits.type,
    duration_days: visits.duration_days, session_limit: visits.session_limit, price_thb: 900, status: 'active',
  }).expect(200);

  for (const id of [packageId, visits.id]) {
    const order = (await call('post', '/orders', token, { package_id: id }).expect(201)).body.order;
    await uploadSlip(token, order.id).expect(201);
    await call('post', `/admin/orders/${order.id}/approve`, adminToken,
      { version: order.version + 1, checked_against_bank: true }).expect(200);
  }

  const mine = await call('get', '/entitlements', token).expect(200);
  assert.equal(mine.body.items.length, 2);
  // Soonest expiry first: Phase 3 deducts from the head of this list.
  assert.deepEqual(mine.body.items.map(e => e.expires_at), [...mine.body.items.map(e => e.expires_at)].sort((a, b) => a - b));

  const sales = await call('get', '/admin/sales', adminToken).expect(200);
  assert.equal(sales.body.items.length, 1);
  assert.equal(sales.body.items[0].orders, 2);
  assert.equal(sales.body.items[0].total_thb, 1200 + 900);
  assert.equal(sales.body.items[0].day, '2026-09-14');
});

test('a member can cancel an order they have not paid for, but not one under review', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { packageId } = await shop();
  const token = await member('cancel@example.test');
  const first = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  const cancelled = await call('post', `/orders/${first.id}/cancel`, token).expect(200);
  assert.equal(cancelled.body.order.status, 'cancelled');

  const second = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  assert.notEqual(second.id, first.id);
  await uploadSlip(token, second.id).expect(201);
  await call('post', `/orders/${second.id}/cancel`, token).expect(409);
});

test('neither the merchant identifier nor the raw slip path leaks to a member', async t => {
  const { call, member, shop, uploadSlip } = fixture(t);
  const { packageId } = await shop();
  const token = await member('leak@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  const view = await uploadSlip(token, order.id).expect(201);

  const body = JSON.stringify(view.body);
  // The payload legitimately encodes the merchant id, but nothing else may.
  assert.equal(view.body.promptpay_payload, null, 'no payload once the slip is in');
  assert.equal(body.includes(MERCHANT), false);
  assert.equal(body.includes('0066899999999'), false);
});

test('the database itself refuses a second entitlement for one order', async t => {
  // The route guards this already, but requests in these tests run one after
  // another, so the constraint underneath is what actually holds under real
  // concurrency. Assert it directly rather than trusting the happy path.
  const { call, member, shop, uploadSlip, db } = fixture(t);
  const { adminToken, packageId } = await shop();
  const token = await member('constraint@example.test');
  const order = (await call('post', '/orders', token, { package_id: packageId }).expect(201)).body.order;
  await uploadSlip(token, order.id).expect(201);
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(200);

  const existing = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(order.id);
  assert.throws(() => db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,
    expires_at,sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), existing.order_id, existing.member_id, existing.package_id,
      existing.starts_at, existing.expires_at, null, null, existing.created_at),
  /UNIQUE constraint failed/);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1);
});
