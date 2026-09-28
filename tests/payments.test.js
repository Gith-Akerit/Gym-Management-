// Money.
//
// Two things live here now. The counter sale, which is how every membership is
// bought from here on; and the slip queue, which belongs to orders the old
// member app created and which a gym mid-upgrade still has to finish. The
// second is why approving is still guarded the way it is: it is the only record
// that money arrived, and approving twice would give a membership away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';

const MERCHANT = '0899999999';
const DAY = 86400000;
const PASSWORD = 'counter-test-password';
const HASH = hashPassword(PASSWORD);

/** A JPEG carrying an EXIF block, which is where a camera writes GPS. */
function jpegWithExif() {
  const exif = Buffer.alloc(0x20, 0);
  exif.writeUInt16BE(0xffe1, 0);
  exif.writeUInt16BE(0x1e, 2);
  exif.write('Exif\0\0', 4, 'latin1');
  exif.write('GPSLATITUDE-SECRET', 10, 'latin1');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    exif,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-slips-'));
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos')),
    promptPayId: MERCHANT,
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
  async function member(token, name = 'สุดา ใจดี') {
    return (await call('post', '/members', token, {
      name, phone: `089${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
    }).expect(201)).body;
  }
  /** An admin plus one package actually on sale at 1,200 baht. */
  async function shop(price = 120000, code = 'UNLIMITED_30D') {
    const adminToken = await login(`admin-${randomUUID().slice(0, 8)}@example.test`);
    const draft = db.prepare('SELECT * FROM packages WHERE code=?').get(code);
    await call('put', `/packages/${draft.id}`, adminToken, {
      version: draft.version, code: draft.code, name_th: draft.name_th, type: draft.type,
      duration_days: draft.duration_days, session_limit: draft.session_limit,
      price_satang: price, status: 'active',
    }).expect(200);
    return { adminToken, packageId: draft.id, package: db.prepare('SELECT * FROM packages WHERE id=?').get(draft.id) };
  }
  const sell = (token, memberId, packageId, method = 'cash', fields = {}) => {
    const req = call('post', `/members/${memberId}/grant`, token)
      .field('package_id', packageId).field('payment_method', method);
    for (const [key, value] of Object.entries(fields)) req.field(key, value);
    return req;
  };

  /**
   * An order the old member app left behind: paid by PromptPay, slip uploaded,
   * waiting for somebody to look at it. Written straight in because nothing in
   * the product creates one any more -- which is exactly the situation a gym
   * upgrading mid-week is in.
   */
  function legacyOrder(memberId, pkg, { slip = true, amountSatang = null, reference = null, file = jpegWithExif() } = {}) {
    const id = randomUUID();
    db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
      package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
      status,payment_method,created_at,expires_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'promptpay',?,?,?)`)
      .run(id, memberId, pkg.id, pkg.code, pkg.name_th, pkg.type, pkg.duration_days, pkg.session_limit,
        pkg.price_satang, slip ? 'awaiting_review' : 'pending_payment', time, time + 3600000, time);
    if (slip) {
      const stored = new SlipStore(join(root, 'slips')).save(file);
      db.prepare(`INSERT INTO payment_slips(id,order_id,stored_name,content_type,byte_size,file_hash,
        reference_no,transferred_at,amount_satang_claimed,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), id, stored.storedName, stored.contentType, stored.byteSize, stored.fileHash,
          reference ?? `REF-${randomUUID().slice(0, 8)}`, time - 60000, amountSatang, time);
    }
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  }

  return { db, call, login, member, shop, sell, legacyOrder, root, tick: ms => { time += ms; }, at: () => time };
}

// ------------------------------------------------------------ counter sales

test('one sale makes one order and exactly one membership', async t => {
  const { db, call, member, shop, sell } = fixture(t);
  const { adminToken, packageId } = await shop();
  const who = await member(adminToken);

  const sold = await sell(adminToken, who.id, packageId).expect(201);
  assert.equal(sold.body.order.price_thb, 1200, 'the price comes from the package, not the caller');
  assert.equal(sold.body.entitlement.member_id, who.id);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE member_id=?').get(who.id).n, 1);

  // Editing the package afterwards must not rewrite what was already sold.
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
  await call('put', `/packages/${pkg.id}`, adminToken, {
    version: pkg.version, code: pkg.code, name_th: 'ขึ้นราคาแล้ว', type: pkg.type,
    duration_days: pkg.duration_days, session_limit: pkg.session_limit, price_satang: 200000, status: 'active',
  }).expect(200);
  const after = await call('get', `/admin/orders/${sold.body.order.id}`, adminToken).expect(200);
  assert.equal(after.body.order.price_thb, 1200);
  assert.equal(after.body.order.package_name_snapshot, 'รายเดือน Unlimited');
});

test('a limited-sessions package grants the sessions bought and still expires', async t => {
  const { member, shop, sell, at } = fixture(t);
  const { adminToken, packageId, package: pkg } = await shop(90000, 'VISIT_10_90D');
  const who = await member(adminToken);
  const sold = await sell(adminToken, who.id, packageId).expect(201);
  assert.equal(sold.body.entitlement.sessions_total, 10);
  assert.equal(sold.body.entitlement.sessions_remaining, 10);
  assert.equal(sold.body.entitlement.expires_at, at() + pkg.duration_days * DAY);
});

test('stacking a second package keeps the first, and the takings match the orders', async t => {
  const { db, call, member, shop, sell } = fixture(t);
  const { adminToken, packageId } = await shop();
  const who = await member(adminToken);
  await sell(adminToken, who.id, packageId).expect(201);
  await sell(adminToken, who.id, packageId).expect(201);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE member_id=?').get(who.id).n, 2);

  const sales = await call('get', '/admin/sales', adminToken).expect(200);
  assert.equal(sales.body.items[0].orders, 2);
  assert.equal(sales.body.items[0].total_thb, 2400);
});

test('the slip attached to a counter sale is renamed and stripped of EXIF', async t => {
  const { db, member, shop, sell, root } = fixture(t);
  const { adminToken, packageId } = await shop();
  const who = await member(adminToken);
  const sold = await sell(adminToken, who.id, packageId, 'transfer', { reference_no: 'REF-EXIF' })
    .attach('slip', jpegWithExif(), { filename: '../../etc/passwd.jpg', contentType: 'image/jpeg' })
    .expect(201);

  const slip = db.prepare('SELECT * FROM payment_slips WHERE order_id=?').get(sold.body.order.id);
  assert.match(slip.stored_name, /^[0-9a-f-]{36}\.jpg$/, 'the server named it, not the browser');
  const files = readdirSync(join(root, 'slips'));
  assert.deepEqual(files, [slip.stored_name]);
  const bytes = readFileSync(join(root, 'slips', slip.stored_name));
  assert.equal(bytes.includes(Buffer.from('GPSLATITUDE-SECRET')), false, 'the camera metadata is gone');
});

// -------------------------------------------------- the queue left behind

test('approving turns one confirmed transfer into exactly one membership', async t => {
  const { db, call, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken, 'ปิติ ตั้งใจ');
  const order = legacyOrder(who.id, pkg);

  const approved = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true, note: 'ตรงกับรายการเงินเข้า' }).expect(200);
  assert.equal(approved.body.order.status, 'paid');
  assert.equal(approved.body.entitlement.member_id, who.id);

  // Who decided, when, and on what basis: this is the only record money arrived.
  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='order.approve'").get();
  assert.ok(entry && entry.actor_id);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1);
});

test('approve and reject at once never leave the order and the membership disagreeing', async t => {
  const { db, call, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);

  const [approve, reject] = await Promise.all([
    call('post', `/admin/orders/${order.id}/approve`, adminToken, { version: order.version, checked_against_bank: true }),
    call('post', `/admin/orders/${order.id}/reject`, adminToken, { version: order.version, reason: 'ยอดไม่ตรง' }),
  ]);
  const outcomes = [approve.status, reject.status].sort();
  assert.deepEqual(outcomes, [200, 409], 'exactly one of the two wins');

  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  const count = db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n;
  assert.equal(count, row.status === 'paid' ? 1 : 0, 'the membership and the order always agree');
});

test('an order that was already decided cannot be approved again', async t => {
  const { call, member, shop, legacyOrder, db } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true }).expect(200);
  const again = await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version + 1, checked_against_bank: true }).expect(409);
  assert.match(again.body.error, /ถูกดำเนินการไปแล้ว/);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 1);
});

test('rejecting explains why, and the order can be brought back', async t => {
  const { call, member, shop, legacyOrder, db } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);

  const rejected = await call('post', `/admin/orders/${order.id}/reject`, adminToken,
    { version: order.version, reason: 'สลิปเบลอ อ่านยอดไม่ออก' }).expect(200);
  assert.equal(rejected.body.order.status, 'rejected');
  assert.equal(rejected.body.order.rejection_reason, 'สลิปเบลอ อ่านยอดไม่ออก');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(order.id).n, 0);

  // A reason is required: "rejected" with nothing beside it helps nobody.
  const order2 = legacyOrder(who.id, pkg);
  await call('post', `/admin/orders/${order2.id}/reject`, adminToken,
    { version: order2.version, reason: '' }).expect(400);
});

test('an approval made in error can be reversed, revoking the membership', async t => {
  const { call, member, shop, legacyOrder, db } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true }).expect(200);

  const reversed = await call('post', `/admin/orders/${order.id}/reverse`, adminToken,
    { version: order.version + 1, reason: 'อนุมัติผิดคน' }).expect(200);
  assert.equal(reversed.body.order.status, 'rejected');
  const entitlement = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(order.id);
  assert.equal(entitlement.status, 'revoked');
  assert.equal(entitlement.revoked_reason, 'อนุมัติผิดคน');
});

test('a mismatched amount and a reused transfer are both flagged to the admin', async t => {
  const { call, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const first = await member(adminToken, 'คนแรก');
  const second = await member(adminToken, 'คนที่สอง');
  legacyOrder(first.id, pkg, { reference: 'REF-SHARED', amountSatang: 120000 });
  const order = legacyOrder(second.id, pkg, { reference: 'REF-SHARED', amountSatang: 90000 });

  const view = await call('get', `/admin/orders/${order.id}`, adminToken).expect(200);
  assert.equal(view.body.amount_mismatch, true, 'flagged, not blocked: only a person can judge it');
  assert.equal(view.body.duplicates.length, 1);
  // Both slips are the same picture here as well as the same reference, and
  // the identical file is the stronger signal, so that is what it reports.
  assert.equal(view.body.duplicates[0].kind, 'file');

  // Approving a short payment demands a written reason.
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true }).expect(400);
  await call('post', `/admin/orders/${order.id}/approve`, adminToken,
    { version: order.version, checked_against_bank: true, note: 'จ่ายส่วนต่างเป็นเงินสดที่เคาน์เตอร์' }).expect(200);
});

test('only an admin may decide an order; staff may look but not touch', async t => {
  const { call, login, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  const staff = await login('desk@example.test', 'staff');

  await call('get', '/admin/orders?status=awaiting_review', staff).expect(200);
  await call('get', `/admin/orders/${order.id}`, staff).expect(200);
  await call('post', `/admin/orders/${order.id}/approve`, staff, { version: order.version, checked_against_bank: true }).expect(403);
  await call('post', `/admin/orders/${order.id}/reject`, staff, { version: order.version, reason: 'x' }).expect(403);
  await call('get', '/admin/sales', staff).expect(403);
});

test('the slip image is served with headers that stop it being treated as a page', async t => {
  const { call, member, shop, legacyOrder, db } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  const slip = db.prepare('SELECT id FROM payment_slips WHERE order_id=?').get(order.id);

  const image = await call('get', `/slips/${slip.id}/image`, adminToken).expect(200);
  assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.match(image.headers['content-security-policy'], /sandbox/);
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.equal(image.headers['cache-control'], 'no-store');
  // Nobody outside the counter reaches it at all.
  await call('get', `/slips/${slip.id}/image`, null).expect(401);
});

test('the database itself refuses a second entitlement for one order', async t => {
  const { db, member, shop, sell } = fixture(t);
  const { adminToken, packageId } = await shop();
  const who = await member(adminToken);
  const sold = await sell(adminToken, who.id, packageId).expect(201);
  const entitlement = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(sold.body.order.id);
  // Belt and braces: even if the code above were wrong, the schema says no.
  assert.throws(() => db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,
    expires_at,sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?)`)
    .run(randomUUID(), entitlement.order_id, entitlement.member_id, entitlement.package_id,
      entitlement.starts_at, entitlement.expires_at, entitlement.created_at), /UNIQUE/);
});

test('the merchant identifier never reaches a screen', async t => {
  const { call, member, shop, legacyOrder } = fixture(t);
  const { adminToken, package: pkg } = await shop();
  const who = await member(adminToken);
  const order = legacyOrder(who.id, pkg);
  const view = await call('get', `/admin/orders/${order.id}`, adminToken).expect(200);
  const body = JSON.stringify(view.body);
  assert.equal(body.includes(MERCHANT), false, 'the gym bank account is not a fact for a screen');
  assert.equal(body.includes('stored_name'), false, 'nor is the path the bytes sit at');
});
