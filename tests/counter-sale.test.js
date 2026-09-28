// Signing somebody up and taking their money, at the desk.
//
// Nobody buys anything from a phone any more. The member pays the person at the
// counter, who records which way and hands the package over in the same action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture, jpegBuffer, PNG_PIXEL } from './counter.js';

async function sellablePackage(call, token, values = {}) {
  const created = await call('post', '/packages', token, {
    code: 'MONTH', name_th: 'รายเดือน ไม่จำกัดครั้ง', type: 'unlimited',
    duration_days: 30, price_thb: 1200, status: 'active', ...values,
  }).expect(201);
  return created.body;
}

test('a walk-in is signed up with no email address at all', async t => {
  const { call, signIn, db } = counterFixture(t);
  const staff = await signIn('desk@example.test', 'staff');
  const created = await call('post', '/members', staff,
    { name: 'วาสนา เดินเข้ามา', phone: '0895554433' }).expect(201);

  assert.equal(created.body.email, null);
  assert.equal(created.body.card_version, 1);
  assert.ok(created.body.member_code.startsWith('GYM-'));
  // No account is created, because there is nothing for one to do.
  assert.equal(db.prepare('SELECT user_id FROM members WHERE id=?').get(created.body.id).user_id, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE role='member'").get().n, 0);

  // And they are findable afterwards, which an inner join on users would have
  // quietly prevented.
  const listed = await call('get', '/members?q=วาสนา', staff).expect(200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].id, created.body.id);
  await call('get', `/members/${created.body.id}`, staff).expect(200);
});

test('an email address is still allowed, and is only a way to reach them', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { email: 'Reach@Example.Test', phone: '0896667788' });
  assert.equal(member.email, 'reach@example.test');
  // It opens nothing: there is no password on that row and members cannot sign in.
  await call('post', '/auth/login', null, { email: 'reach@example.test', password: 'anything-at-all' }).expect(401);
});

test('cash across the counter is recorded as revenue and grants the package', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);

  const sold = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);
  assert.equal(sold.body.order.status, 'paid');
  assert.equal(sold.body.order.payment_method, 'cash');
  assert.equal(sold.body.entitlement.sessions_remaining, null, 'unlimited counts no sessions');

  // Money that actually arrived belongs in the number reconciled against the
  // till, unlike a comped membership.
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(sold.body.order.id);
  assert.equal(row.manual_grant, 0);
  const sales = await call('get', '/admin/sales', owner).expect(200);
  assert.equal(sales.body.items[0].total_thb, 1200);

  // The member can walk straight in.
  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  const scan = await call('post', '/check-ins/verify', owner, { qr: card.body.qr }).expect(200);
  assert.equal(scan.body.result, 'allowed');
  assert.match(card.body.membership.package, /รายเดือน/);
});

test('a transfer can carry the slip the member just showed', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);

  const sold = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'transfer').field('reference_no', 'REF-COUNTER-1')
    .attach('slip', jpegBuffer(), { filename: 'slip.jpg', contentType: 'image/jpeg' })
    .expect(201);
  assert.equal(sold.body.order.payment_method, 'transfer');
  assert.equal(sold.body.slip.reference_no, 'REF-COUNTER-1');
  const slip = db.prepare('SELECT * FROM payment_slips WHERE order_id=?').get(sold.body.order.id);
  assert.ok(slip, 'the photo is kept with the sale it belongs to');
  await call('get', `/slips/${slip.id}/image`, owner).expect(200);
});

test('a transfer with no slip photo is still a sale', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);
  // A gym taking money across a desk often has nothing to photograph.
  const sold = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'transfer').expect(201);
  assert.equal(sold.body.order.status, 'paid');
  assert.equal(sold.body.slip, null);
});

test('giving a package away demands a reason and stays out of the takings', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);

  const refused = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'none').expect(400);
  assert.match(refused.body.fields.note, /เหตุผล/);

  const given = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'none').field('note', 'ทดลองใช้ 1 เดือน')
    .expect(201);
  assert.equal(given.body.order.payment_method, 'none');
  assert.equal(db.prepare('SELECT manual_grant FROM orders WHERE id=?').get(given.body.order.id).manual_grant, 1);
  const sales = await call('get', '/admin/sales', owner).expect(200);
  assert.equal(sales.body.items[0].total_thb, 0, 'nobody paid, so nothing is in the total');
  assert.equal(sales.body.items[0].manual_grants, 1);
});

test('staff sell packages; a suspended member cannot be sold one', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);

  await call('post', `/members/${member.id}/grant`, staff)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);

  await call('delete', `/members/${member.id}`, owner, { version: member.version }).expect(200);
  const refused = await call('post', `/members/${member.id}/grant`, staff)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(409);
  assert.match(refused.body.error, /ถูกระงับ/);
});

test('an unpriced package cannot be sold', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner, { code: 'TBD', price_thb: '', status: 'draft' });
  const member = await addMember(owner);
  const refused = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(409);
  assert.match(refused.body.error, /ยังไม่ได้กำหนดราคา/);
});

test('members can no longer buy anything for themselves', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  // The routes the member app used are gone, not merely hidden behind a screen.
  for (const [method, path] of [['post', '/orders'], ['get', '/orders'], ['get', '/entitlements'],
    ['post', '/me/check-in-token'], ['get', '/me/check-ins'], ['put', '/me/profile']]) {
    const response = await call(method, path, owner, method === 'get' ? undefined : {});
    assert.equal(response.status, 404, `${method.toUpperCase()} ${path} should not exist`);
  }
});

test('a member photograph taken at signup shows up on the scan that follows', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner, { name: 'ชัยชนะ มาออกกำลัง' });
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PNG_PIXEL, { filename: 'face.png', contentType: 'image/png' }).expect(200);
  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);

  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  const scan = await call('post', '/check-ins/verify', owner, { qr: card.body.qr, device_label: 'เคาน์เตอร์ 1' }).expect(200);
  // The face is the check the person at the desk makes, so it has to be in the
  // answer rather than a click away.
  assert.equal(scan.body.member.has_photo, true);
  assert.equal(scan.body.member.photo_url, `/api/members/${member.id}/photo`);
  assert.equal(scan.body.member.name, 'ชัยชนะ มาออกกำลัง');
  await call('get', scan.body.member.photo_url.replace('/api', ''), owner).expect(200);
});

test('a member carries their own payment history, with the slips attached to it', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner, { name: 'จ่ายมาหลายรอบ' });

  // Nothing yet, and the screen can tell that apart from a broken request.
  const empty = await call('get', `/members/${member.id}/payments`, staff).expect(200);
  assert.deepEqual(empty.body.items, []);

  await call('post', `/members/${member.id}/grant`, staff)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);
  const transfer = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'transfer').field('reference_no', 'REF-HISTORY-9')
    .attach('slip', jpegBuffer(), { filename: 'slip.jpg', contentType: 'image/jpeg' })
    .expect(201);

  const history = await call('get', `/members/${member.id}/payments`, staff).expect(200);
  assert.equal(history.body.items.length, 2);
  // Newest first: the question at the counter is almost always about the last
  // payment, not the first one.
  const [latest, first] = history.body.items;
  assert.equal(latest.id, transfer.body.order.id);
  assert.equal(latest.payment_method, 'transfer');
  assert.equal(latest.price_thb, 1200);
  assert.equal(latest.recorded_by, 'owner@example.test', 'who took the money, from the audit trail');
  assert.equal(first.payment_method, 'cash');
  assert.equal(first.recorded_by, 'desk@example.test');

  // The slip that member of staff attached is reachable from here -- this is
  // what the old review queue was for, and the queue is gone.
  assert.equal(latest.slip.reference_no, 'REF-HISTORY-9');
  assert.equal(latest.slip.stored_name, undefined, 'the path on disk never leaves the server');
  await call('get', `/slips/${latest.slip.id}/image`, staff).expect(200);
  assert.equal(first.slip, null);

  // And the history is the member's own: nobody else's payments are in it.
  const other = await addMember(owner, { name: 'คนอื่น', phone: '0890000009' });
  const none = await call('get', `/members/${other.id}/payments`, staff).expect(200);
  assert.deepEqual(none.body.items, []);
  await call('get', `/members/${db.prepare('SELECT lower(hex(randomblob(16))) AS x').get().x}/payments`, staff).expect(404);
});

test('a comped package shows in the history as nothing received, with its reason', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);
  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'none').field('note', 'ทดลองใช้ 1 เดือน')
    .expect(201);

  const [given] = (await call('get', `/members/${member.id}/payments`, owner).expect(200)).body.items;
  assert.equal(given.payment_method, 'none');
  assert.equal(given.manual_grant, 1);
  // The reason is the whole record of a free membership, so it travels with it.
  assert.equal(given.review_note, 'ทดลองใช้ 1 เดือน');
});

test('a member who is not signed in cannot read their own payments', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('get', `/members/${member.id}/payments`, null).expect(401);
});

test('a package the owner has not opened for sale cannot be sold (QA BUG-SALE-09)', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const member = await addMember(owner);
  // Priced, so the older check waves it through -- and still a draft, which is
  // the owner saying "not this one, not yet".
  const draft = await sellablePackage(call, owner, { code: 'SOON', price_thb: 1500, status: 'draft' });

  const refused = await call('post', `/members/${member.id}/grant`, staff)
    .field('package_id', draft.id).field('payment_method', 'cash').expect(409);
  assert.match(refused.body.error, /ยังไม่ได้เปิดขาย/);

  // Nothing happened at all: no membership, no order, and nothing in the
  // takings the owner reconciles against the till.
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders WHERE package_id=?').get(draft.id).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entitlements WHERE member_id=?').get(member.id).n, 0);
  const sales = await call('get', '/admin/sales', owner).expect(200);
  assert.deepEqual(sales.body.items, []);

  // Opening it for sale is all it takes, and it is the owner's decision.
  await call('put', `/packages/${draft.id}`, owner, {
    code: draft.code, name_th: draft.name_th, type: draft.type, duration_days: draft.duration_days,
    session_limit: null, price_thb: 1500, description: '', status: 'active',
    sort_order: draft.sort_order, version: draft.version,
  }).expect(200);
  await call('post', `/members/${member.id}/grant`, staff)
    .field('package_id', draft.id).field('payment_method', 'cash').expect(201);
});

test('a package that was taken off sale cannot be sold either', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const retired = await sellablePackage(call, owner, { code: 'OLDPRICE', price_thb: 900, status: 'archived' });

  // The case that costs money: a tablet left open at the counter still holds
  // last month's list, and the price the owner withdrew would otherwise turn
  // up in today's takings without them agreeing to it.
  const refused = await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', retired.id).field('payment_method', 'transfer').expect(409);
  assert.match(refused.body.error, /ปิดการขายไปแล้ว/);
  assert.match(refused.body.error, /เปิดขาย/, 'and it says how to undo it');

  // Giving one away is the same rule: it is still the owner's package.
  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', retired.id).field('payment_method', 'none').field('note', 'ลูกค้าเก่าขอราคาเดิม')
    .expect(409);
});

test('an archived package that a member already holds keeps working', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const pkg = await sellablePackage(call, owner);
  const member = await addMember(owner);
  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);

  // Taking a package off sale stops new sales. It must not reach back and
  // cancel the membership somebody already paid for.
  await call('put', `/packages/${pkg.id}`, owner, {
    code: pkg.code, name_th: pkg.name_th, type: pkg.type, duration_days: pkg.duration_days,
    session_limit: null, price_thb: 1200, description: '', status: 'archived',
    sort_order: pkg.sort_order, version: pkg.version,
  }).expect(200);

  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  const scan = await call('post', '/check-ins/verify', owner, { qr: card.body.qr }).expect(200);
  assert.equal(scan.body.result, 'allowed');
});
