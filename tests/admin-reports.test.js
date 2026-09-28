// The five reports the owner reads, and the ten edge cases the spec names.
//
// Every one of these is about a number being right rather than a screen
// appearing. Three of them are about a number being WRONG in a way nobody
// would notice: a reversed sale that still counts as income, a package given
// away that counts as income, and a membership the gym took back filed under
// "expired" as though time had done it.
//
// The privacy rule is here too, and it is absolute: `before_json` and
// `after_json` hold a member's name, telephone number and address, and neither
// may appear in a CSV or in the JSON the screen receives. What may appear is
// which fields changed, in Thai.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture } from './counter.js';
import { baht, changedFields, failureGroup, rangeFrom, thaiDate, thaiTime, toCsv } from '../server/admin-reports.js';

/** The day the fixture's clock is on, in Thai time. */
const dayOf = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);

/** A gym with a package, a member, a sale and a scan -- the usual afternoon. */
async function busyGym(fixture) {
  const { call, signIn, addMember, db } = fixture;
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');
  const pkg = (await call('post', '/packages', owner, {
    code: 'MONTH', name_th: 'รายเดือน ไม่จำกัดครั้ง', type: 'unlimited',
    duration_days: 30, price_thb: 1200, status: 'active',
  }).expect(201)).body;
  const member = await addMember(desk, { name: 'สมชาย ขยันมาก', phone: '0891234567' });
  const granted = (await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201)).body;
  const order = granted.order ?? granted;
  const qr = (await call('get', `/members/${member.id}/card`, desk).expect(200)).body.qr;
  await call('post', '/check-ins/verify', desk, { qr, device_label: 'เคาน์เตอร์ 1' }).expect(200);
  return { owner, desk, pkg, member, order, qr, db };
}

test('the reports belong to the owner, and nobody else gets a row of them', async t => {
  const fixture = counterFixture(t);
  const { call, signIn } = fixture;
  const desk = await signIn('desk@example.test', 'staff');
  await signIn('owner@example.test');

  // Case 1: staff get 403 on every one of them, not an empty list.
  for (const name of ['today', 'staff-activity', 'sales', 'checkins', 'members', 'issues']) {
    const refused = await call('get', `/admin/reports/${name}`, desk);
    assert.equal(refused.status, 403, `/${name} ตอบ ${refused.status}`);
    assert.equal((await call('get', `/admin/reports/${name}`, null)).status, 401);
  }
});

test('an empty range answers with an empty list, not with a broken page', async t => {
  const fixture = counterFixture(t);
  const owner = await fixture.signIn('owner@example.test');
  // Case 2.
  const quiet = (await fixture.call('get', '/admin/reports/staff-activity?from=2026-01-01&to=2026-01-02', owner)
    .expect(200)).body;
  assert.deepEqual(quiet.items, []);
  assert.equal(quiet.total, 0);

  // The range rules are the same for every report.
  const backwards = await fixture.call('get', '/admin/reports/sales?from=2026-02-01&to=2026-01-01', owner).expect(400);
  assert.match(backwards.body.error, /วันเริ่มต้องไม่เกินวันสิ้นสุด/);
  const toolong = await fixture.call('get', '/admin/reports/sales?from=2024-01-01&to=2026-01-01', owner).expect(400);
  assert.match(toolong.body.error, /ไม่เกิน 1 ปี/);
});

test('a sale reversed the same day leaves the day total, and appears as a reversal', async t => {
  const fixture = counterFixture(t);
  const { call } = fixture;
  const { owner, order } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 3, first half: the money is counted while it is money.
  const before = (await call('get', `/admin/reports/sales?from=${today}&to=${today}`, owner).expect(200)).body;
  assert.equal(before.total_orders, 1);
  assert.equal(before.total_baht, '1200.00');
  assert.equal(before.items[0].payment_method, 'เงินสด');
  assert.equal(before.items[0].package, 'รายเดือน ไม่จำกัดครั้ง');

  await call('post', `/admin/orders/${order.id}/reverse`, owner,
    { version: order.version, reason: 'คืนเงินให้ลูกค้า' }).expect(200);

  // Second half: gone from the money, present in the block that explains why.
  const after = (await call('get', `/admin/reports/sales?from=${today}&to=${today}`, owner).expect(200)).body;
  assert.equal(after.total_orders, 0);
  assert.equal(after.total_baht, '0.00');
  assert.equal(after.reversed.length, 1);
  assert.equal(after.reversed[0].reason, 'คืนเงินให้ลูกค้า');
  assert.equal(after.reversed[0].baht, '1200.00');
  assert.match(after.note, /กลับรายการ/);
});

test('a package given away is not income, and says so in its own block', async t => {
  const fixture = counterFixture(t);
  const { call, addMember } = fixture;
  const { owner, desk, pkg } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 4: `payment_method='none'` is a manual grant, not a sale.
  const friend = await addMember(desk, { name: 'เพื่อนเจ้าของยิม', phone: '0890001111' });
  await call('post', `/members/${friend.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'none')
    .field('note', 'แถมให้เพื่อน').expect(201);

  const report = (await call('get', `/admin/reports/sales?from=${today}&to=${today}`, owner).expect(200)).body;
  assert.equal(report.total_orders, 1, 'ของแถมต้องไม่ถูกนับเป็นยอดขาย');
  assert.equal(report.granted.length, 1);
  assert.equal(report.granted[0].orders, 1);
  assert.equal(report.granted[0].baht, '1200.00');
});

test('a membership the gym took back is not filed under "expired"', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner, member, order } = await busyGym(fixture);

  // Case 5.
  await call('post', `/admin/orders/${order.id}/reverse`, owner,
    { version: order.version, reason: 'อนุมัติผิดคน' }).expect(200);
  const expired = (await call('get', '/admin/reports/members?view=expired', owner).expect(200)).body;
  // They are in the list -- somebody who cannot get in is what this view is
  // for, and leaving them out of it was how they became invisible. What must
  // never happen is reading this as a membership that ran out of time, and
  // that is now said in a column rather than by absence (Mika, on BUG-18).
  assert.equal(expired.items.length, 1);
  assert.equal(expired.items[0].reason, 'ถูกยกเลิก');
  assert.equal(expired.items[0].package, 'รายเดือน ไม่จำกัดครั้ง', 'ยกเลิกแล้วก็ยังต้องรู้ว่าแพ็กเกจอะไร');
  assert.equal(expired.revoked.length, 1);
  assert.equal(expired.revoked[0].status, 'ถูกยกเลิก');
  assert.equal(expired.revoked[0].reason, 'อนุมัติผิดคน');
  assert.ok(expired.revoked[0].revoked_on, 'ต้องบอกวันที่ยกเลิกด้วย');
  assert.ok(db.prepare("SELECT 1 FROM entitlements WHERE status='revoked'").get());

  // And the member is still a member: they show up in "จะหมดอายุ" nowhere and
  // in "ใช้งานอยู่" nowhere, because they have no live entitlement at all.
  const active = (await call('get', '/admin/reports/members?view=active', owner).expect(200)).body;
  assert.equal(active.items.find(row => row.name === member.name), undefined);
});

test('a scan of a QR from somewhere else counts as a failure, not as a person', async t => {
  const fixture = counterFixture(t);
  const { call } = fixture;
  const { owner, desk } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 6: no member behind it, so it is a denial with nobody attached.
  await call('post', '/check-ins/verify', desk, { qr: 'not-a-card-from-this-gym' }).expect(409);

  const report = (await call('get', `/admin/reports/checkins?from=${today}&to=${today}`, owner).expect(200)).body;
  const day = report.items.find(row => row.day === today);
  assert.equal(day.allowed, 1);
  assert.equal(day.denied, 1);
  assert.equal(day.unique_members, 1, 'คนที่สแกน QR มั่วไม่ใช่สมาชิกอีกหนึ่งคน');
  assert.ok(report.reasons.some(row => row.group === 'QR ไม่ถูกต้อง'));

  // And on the staff report the "เกี่ยวกับ" column is blank rather than a
  // sentence apologising for having nobody to name.
  const activity = (await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}`, owner)
    .expect(200)).body;
  const denied = activity.items.find(row => row.label.includes('ไม่ผ่าน'));
  assert.equal(denied.about, '');
  assert.ok(denied.reason, 'เหตุผลดิบต้องยังอยู่');
});

test('the CSV is one Excel on Windows can open without mangling anything', async t => {
  const fixture = counterFixture(t);
  const { call } = fixture;
  const { owner } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 7.
  const csv = await call('get', `/admin/reports/sales?from=${today}&to=${today}&format=csv`, owner).expect(200);
  assert.match(csv.headers['content-type'], /text\/csv; charset=utf-8/);
  assert.match(csv.headers['content-disposition'], new RegExp(`filename="sales-${today}-${today}\\.csv"`));
  assert.ok(csv.text.startsWith('﻿'), 'ไม่มี BOM แล้ว Excel อ่านภาษาไทยเป็นขยะ');
  assert.ok(csv.text.includes('\r\n'), 'ต้องขึ้นบรรทัดใหม่แบบ CRLF');
  assert.ok(csv.text.includes('รายเดือน ไม่จำกัดครั้ง'));
  assert.ok(csv.text.includes('1200.00'), 'เงินต้องเป็นตัวเลขที่ SUM ได้ ไม่มีจุลภาคคั่นหลัก');
  assert.equal(csv.text.includes('฿'), false);
  assert.ok(/(^|\r\n)รวม,/.test(csv.text), 'ต้องมีแถวรวมท้ายบล็อก');

  // The telephone number keeps its leading zero because it is not a number.
  const members = await call('get', '/admin/reports/members?view=new&format=csv', owner).expect(200);
  assert.ok(members.text.includes('089-123-4567'), 'เบอร์ต้องมีขีด ไม่งั้น Excel กินศูนย์หน้า');
});

test('five thousand rows are the screen limit, never the file limit', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 8. Written straight into the table: five thousand scans through the
  // API would be a five-minute test that proves the same thing.
  const insert = db.prepare(`INSERT INTO check_ins(id,member_id,entitlement_id,result,failure_reason,
    device_label,scanned_by,checked_in_at) VALUES(?,?,?,?,?,?,?,?)`);
  const staff = db.prepare("SELECT id FROM users WHERE email='desk@example.test'").get();
  const rangeStart = Date.parse(`${today}T00:00:00+07:00`);
  const rangeEnd = rangeStart + 86400000;
  for (let i = 0; i < 5100; i += 1) {
    insert.run(`bulk-${i}`, null, null, 'denied', 'QR ไม่ถูกต้อง', 'เคาน์เตอร์ 1', staff.id, fixture.at());
  }

  const json = (await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}`, owner)
    .expect(200)).body;
  assert.equal(json.items.length, 5000, 'หน้าจอได้ 5,000 แถวแรกพอดี');
  assert.equal(json.truncated, true);
  // `total` is the whole count, not the truncated one: the screen says
  // "แสดง 5,000 รายการแรก" and needs the real number to say it against.
  const everything = db.prepare(`SELECT
    (SELECT count(*) FROM check_ins WHERE checked_in_at >= ? AND checked_in_at < ?) AS scans,
    (SELECT count(*) FROM audit_logs WHERE created_at >= ? AND created_at < ?
      AND action <> 'checkin.allowed') AS logged`)
    .get(rangeStart, rangeEnd, rangeStart, rangeEnd);
  assert.equal(json.total, everything.scans + everything.logged);
  assert.ok(json.total > 5000);

  // The file is not the screen: every row is in it, counted exactly rather
  // than "more than five thousand".
  const csv = await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}&format=csv`, owner)
    .expect(200);
  const lines = csv.text.split('\r\n').filter(line => line.includes('QR ไม่ถูกต้อง'));
  assert.equal(lines.length, 5100, `CSV ต้องครบทุกแถว ได้ ${lines.length}`);
  assert.ok(csv.text.startsWith('﻿'), 'ไฟล์ใหญ่ก็ยังต้องมี BOM');

  // And the same rule holds on a second report, so this is the shape of every
  // one of them rather than something staff-activity happens to do.
  for (let i = 0; i < 5100; i += 1) {
    db.prepare(`INSERT INTO problem_reports(id,reference,message,screen,status,reported_by,created_at,updated_at)
      VALUES(?,?,?,?,'new',?,?,?)`)
      .run(`pr-${i}`, 1000 + i, `เรื่องที่ ${i}`, 'สแกนเช็คอิน', staff.id, fixture.at(), fixture.at());
  }
  const issues = (await call('get', '/admin/reports/issues', owner).expect(200)).body;
  assert.equal(issues.items.length, 5000);
  assert.equal(issues.truncated, true);
  assert.equal(issues.total, 5100);
  const issuesCsv = await call('get', '/admin/reports/issues?format=csv', owner).expect(200);
  assert.equal(issuesCsv.text.split('\r\n').filter(line => line.startsWith('#')).length, 5100);
});

test('a date that does not exist is named as such, not blamed on the order', async t => {
  const fixture = counterFixture(t);
  const owner = await fixture.signIn('owner@example.test');

  // `2026-13-01` has the right shape and is nothing. Answering "the start must
  // not be after the end" sent somebody checking a range that was never the
  // problem (QA).
  const month13 = await fixture.call('get', '/admin/reports/sales?from=2026-13-01&to=2026-13-05', owner).expect(400);
  assert.match(month13.body.error, /รูปแบบวันที่ไม่ถูกต้อง/);
  assert.match(month13.body.error, /2026-13-05/, 'ต้องบอกด้วยว่าวันไหนที่ไม่มีอยู่จริง');

  const feb30 = await fixture.call('get', '/admin/reports/checkins?from=2026-02-30&to=2026-03-01', owner).expect(400);
  assert.match(feb30.body.error, /รูปแบบวันที่ไม่ถูกต้อง/);
  assert.match(feb30.body.error, /2026-02-30/);

  // The shape check still comes first for anything that is not a date at all.
  const notADate = await fixture.call('get', '/admin/reports/sales?from=เมื่อวาน&to=2026-03-01', owner).expect(400);
  assert.ok(notADate.body.error);

  // And a real range still works, so the new check has not eaten anything.
  await fixture.call('get', '/admin/reports/sales?from=2026-02-28&to=2026-03-01', owner).expect(200);
});

test('an action nobody has translated is shown, not hidden', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 9: the owner must see that something happened even when the team has
  // not got round to naming it.
  const staff = db.prepare("SELECT id FROM users WHERE email='desk@example.test'").get();
  db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_id,created_at,entity_type)
    VALUES('odd',?,'something.new_next_month','x',?,'gym')`).run(staff.id, fixture.at());

  const report = (await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}`, owner)
    .expect(200)).body;
  const row = report.items.find(item => item.label === 'something.new_next_month');
  assert.ok(row, 'แถวที่ยังไม่มีคำแปลต้องไม่หายไป');
  assert.equal(row.kind, 'อื่น ๆ');
});

test('what a member typed never leaves the server, only which fields moved', async t => {
  const fixture = counterFixture(t);
  const { call } = fixture;
  const { owner, desk, member } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  // Case 10. The edit writes before/after JSON full of personal data.
  const current = (await call('get', `/members/${member.id}`, desk).expect(200)).body;
  await call('put', `/members/${member.id}`, desk, {
    name: current.name, phone: '0899998888', date_of_birth: current.date_of_birth,
    emergency_contact: current.emergency_contact, version: current.version,
  }).expect(200);

  const json = await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}`, owner).expect(200);
  const body = JSON.stringify(json.body);
  assert.equal(body.includes('before_json'), false);
  assert.equal(body.includes('after_json'), false);
  assert.equal(body.includes('0899998888'), false, 'เบอร์ใหม่ของสมาชิกต้องไม่หลุดออกมาทาง audit');
  const edit = json.body.items.find(row => row.label === 'แก้ข้อมูลสมาชิก');
  assert.equal(edit.reason, 'แก้: เบอร์โทร');

  const csv = await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}&format=csv`, owner)
    .expect(200);
  assert.equal(csv.text.includes('0899998888'), false);
  assert.ok(csv.text.includes('แก้: เบอร์โทร'));
});

test('the staff report reads both the audit table and the scans, without double counting', async t => {
  const fixture = counterFixture(t);
  const { call } = fixture;
  const { owner } = await busyGym(fixture);
  const today = dayOf(fixture.at());

  const report = (await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}`, owner)
    .expect(200)).body;
  // `checkin.allowed` is written to audit_logs AND is a row in check_ins. It
  // has to appear once -- and from check_ins, because that is the table that
  // has the ones that failed too.
  const scans = report.items.filter(row => row.kind === 'เช็คอิน');
  assert.equal(scans.length, 1);
  assert.equal(scans[0].result, 'ผ่าน');
  assert.equal(scans[0].device, 'เคาน์เตอร์ 1');
  assert.ok(scans[0].about.includes('สมชาย'), 'ต้องบอกได้ว่าใครเข้ามา');

  // Signing in is on the list now, which is what makes "who was on shift"
  // answerable at all.
  assert.ok(report.items.some(row => row.label === 'เข้าสู่ระบบ'));

  // And the per-person totals add up to the rows above them.
  const mine = report.summary.find(row => row.actor === 'desk@example.test');
  assert.equal(mine.checkin_ok, 1);
  assert.equal(mine.signups, 1);
  assert.equal(report.summary.reduce((sum, row) => sum + row.total, 0), report.total);
});

test('signing in and out is written down, and nothing about the machine is', async t => {
  const fixture = counterFixture(t);
  const { call, signIn, db } = fixture;
  const owner = await signIn('owner@example.test');

  const rows = db.prepare("SELECT * FROM audit_logs WHERE action='user.login'").all();
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].after_json), { role: 'admin' });
  assert.equal(rows[0].entity_type, 'user');
  // No address, no browser: a report that says who was on shift does not need
  // to know where they were standing.
  assert.equal(/\d+\.\d+\.\d+\.\d+/.test(rows[0].after_json), false);
  assert.equal(/Mozilla|curl|node/i.test(rows[0].after_json ?? ''), false);

  // A wrong password leaves nothing behind: the rate limit already holds that
  // line, and the address somebody mistyped may belong to a stranger.
  await call('post', '/auth/login', null, { email: 'owner@example.test', password: 'wrong-one' }).expect(401);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action='user.login'").get().n, 1);

  await call('post', '/auth/logout', owner, {}).expect(204);
  assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE action='user.logout'").get().n, 1);
});

test('a day with no scans is a row of zeros, not a hole in the table', async t => {
  const fixture = counterFixture(t);
  const { call } = fixture;
  const { owner } = await busyGym(fixture);
  const today = dayOf(fixture.at());
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

  const report = (await call('get', `/admin/reports/checkins?from=${yesterday}&to=${today}`, owner)
    .expect(200)).body;
  assert.equal(report.items.length, 2);
  const quiet = report.items.find(row => row.day === yesterday);
  assert.deepEqual([quiet.allowed, quiet.duplicate, quiet.denied], [0, 0, 0]);
  // Twenty-four bars whether or not anybody came, so the chart has an x axis.
  assert.equal(report.busiest.length, 24);
});

test('the issues report is oldest first, because that is the one still waiting', async t => {
  const fixture = counterFixture(t);
  const { call, http } = fixture;
  const { owner, desk } = await busyGym(fixture);

  const send = message => http.post('/api/reports').set('X-Gym-Client', 'mobile')
    .set('Authorization', `Bearer ${desk}`).field('message', message).field('screen', 'สแกนเช็คอิน');
  await send('เรื่องแรกที่ยังค้าง').expect(201);
  fixture.tick(3600000);
  await send('เรื่องที่สอง').expect(201);

  const report = (await call('get', '/admin/reports/issues', owner).expect(200)).body;
  assert.equal(report.items.length, 2);
  assert.equal(report.items[0].message, 'เรื่องแรกที่ยังค้าง');
  assert.match(report.items[0].reference, /^#/);
  assert.equal(report.items[0].status, 'ใหม่');
  assert.equal(report.items[0].reporter, 'desk@example.test');

  // No picture and no file name: looking at one goes through the screen that
  // writes `report.view_image`, which is the point of that row existing.
  const csv = await call('get', '/admin/reports/issues?format=csv', owner).expect(200);
  assert.equal(/\.jpg|\.png|screenshot/i.test(csv.text), false);
});

test('the pieces the reports are built from behave on their own', () => {
  // Range arithmetic: both ends inclusive, in Thai time.
  const range = rangeFrom({ from: '2026-09-17', to: '2026-09-19' });
  assert.equal(range.startMs, Date.parse('2026-09-17T00:00:00+07:00'));
  assert.equal(range.endMs, Date.parse('2026-09-20T00:00:00+07:00'));

  assert.equal(thaiDate('2026-09-20'), '20/09/2569');
  assert.equal(thaiTime(Date.parse('2026-09-20T14:05:32+07:00')), '20/09/2569 14:05');
  assert.equal(baht(120000), '1200.00');
  assert.equal(baht(null), '0.00');

  // Keywords, not whole strings: the day somebody fixes a typo in a sentence
  // the statistics must not start a new category.
  assert.equal(failureGroup('บัตรใบนี้ถูกยกเลิกแล้ว ออกบัตรใหม่ให้ลูกค้า'), 'บัตรถูกยกเลิก (ออกบัตรใหม่แล้ว)');
  assert.equal(failureGroup('แพ็กเกจหมดอายุเมื่อ 3 วันก่อน'), 'แพ็กเกจหมดอายุ / ใช้ครบแล้ว');
  assert.equal(failureGroup('QR ไม่ถูกต้อง'), 'QR ไม่ถูกต้อง');
  // เคาน์เตอร์พิมพ์รหัสผิดกับกล้องอ่านบัตรไม่ออก คนละปัญหา คนละทางแก้
  assert.equal(failureGroup('ไม่พบรหัสสมาชิกนี้ กรุณาตรวจตัวอักษรอีกครั้ง หรือให้สมาชิกเปิดรูปบัตรให้สแกน'),
    'พิมพ์รหัสสมาชิกผิด');
  assert.equal(failureGroup('อะไรที่ไม่เคยเจอมาก่อน'), 'อื่น ๆ');

  // Field names only, never values.
  assert.equal(changedFields(JSON.stringify({ name: 'ก', phone: '0811111111' }),
    JSON.stringify({ name: 'ก', phone: '0822222222' })), 'แก้: เบอร์โทร');
  assert.equal(changedFields(null, JSON.stringify({ name: 'ก' })), '');

  // CSV quoting, the part that goes wrong quietly.
  const csv = toCsv([{ headers: ['a', 'b'], rows: [['พร้อม, จุลภาค', 'มี "คำพูด"']] }]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"พร้อม, จุลภาค"'));
  assert.ok(csv.includes('"มี ""คำพูด"""'));
});

test('an account can be deleted and what it did stays readable', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const owner = await fixture.signIn('owner@example.test');
  const leaver = await fixture.signIn('leaver@example.test', 'staff');
  const today = dayOf(fixture.at());
  const gone = db.prepare("SELECT id FROM users WHERE email='leaver@example.test'").get();

  // Something worth keeping: they signed in, and that is now a row.
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE actor_id=? AND action='user.login'").get(gone.id));
  assert.ok(leaver);

  // Before migration 018 the next line threw FOREIGN KEY constraint failed:
  // an account that had ever done anything could not be deleted at all, so
  // clearing one meant deleting its history first -- exactly backwards.
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(gone.id);
  db.prepare('DELETE FROM users WHERE id=?').run(gone.id);

  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE actor_id='deleted-user'").get(),
    'แถวบันทึกต้องยังอยู่ และย้ายไปชี้บัญชีตัวแทน');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [],
    'ต้องไม่มีแถวไหนชี้ไปยังบัญชีที่ไม่มีอยู่');

  // And the report says so in words rather than showing a blank or a raw id.
  const report = (await call('get', `/admin/reports/staff-activity?from=${today}&to=${today}`, owner)
    .expect(200)).body;
  assert.ok(report.items.some(row => row.actor === 'บัญชีที่ถูกลบ'));
  // The placeholder is never offered as somebody to filter by: nobody works
  // here by that name, and it is not in the list of accounts either.
  assert.equal(report.actors.some(row => row.id === 'deleted-user'), false);
  const accounts = (await call('get', '/users', owner).expect(200)).body;
  assert.equal(accounts.items.some(row => row.email === 'deleted@local'), false);
});

test('the other tables still hold an account back, and the trail explains which', async t => {
  const fixture = counterFixture(t);
  const { db } = fixture;
  const { desk } = await busyGym(fixture);
  const staff = db.prepare("SELECT id FROM users WHERE email='desk@example.test'").get();
  assert.ok(desk);

  // Migration 018 covers `audit_logs`, which is what the spec asked for and
  // what the reports need. An account that also scanned somebody in or took
  // money is still held by `check_ins.scanned_by` and `orders.reviewed_by` --
  // deliberately, because those rows name who did it and nothing has decided
  // yet whether that should become the placeholder too. Written down here so
  // the next person meets the limit as a sentence rather than as a surprise.
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(staff.id);
  assert.throws(() => db.prepare('DELETE FROM users WHERE id=?').run(staff.id),
    /FOREIGN KEY constraint failed/);

  const holders = ['check_ins', 'orders', 'members', 'problem_reports', 'password_setup_tokens']
    .filter(table => db.prepare(`SELECT 1 FROM pragma_foreign_key_list('${table}') WHERE "table"='users'`).get());
  assert.ok(holders.length >= 4, 'ยังมีตารางอื่นที่อ้างถึง users โดยไม่มี ON DELETE');
});

test('the owner can open an account for somebody and hand them the way in', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const owner = await fixture.signIn('owner@example.test');

  // Created with an address and a permission, and the link comes with it --
  // an account with no password and no link is an account nobody can use.
  const created = (await call('post', '/users', owner,
    { email: 'newstaff@example.test', role: 'staff' }).expect(201)).body;
  assert.equal(created.has_password, false);
  assert.match(created.setup_link.url, /\/\?setpw=[A-Za-z0-9_-]{43}$/);
  assert.equal(created.setup_link.expires_at - fixture.at(), 24 * 3600000, 'ลิงก์ตั้งรหัสอายุ 24 ชั่วโมง');

  const token = /setpw=([A-Za-z0-9_-]{43})/.exec(created.setup_link.url)[1];
  await call('post', '/auth/set-password', null, { token, password: 'their-own-password' }).expect(200);
  const theirs = (await call('post', '/auth/login', null,
    { email: 'newstaff@example.test', password: 'their-own-password' }).expect(200)).body;
  assert.equal(theirs.role, 'staff');

  // A fresh link for an account that already exists: the same 24 hours, and
  // the old one stops working.
  const again = (await call('post', `/users/${created.id}/password-link`, owner, {}).expect(200)).body;
  assert.equal(again.expires_at - fixture.at(), 24 * 3600000);
  await call('post', '/auth/set-password', null, { token, password: 'the-old-link' }).expect(404);

  // Permissions move, but never your own.
  await call('put', `/users/${created.id}/role`, owner, { role: 'admin' }).expect(200);
  const mine = db.prepare("SELECT id FROM users WHERE email='owner@example.test'").get();
  const refused = await call('put', `/users/${mine.id}/role`, owner, { role: 'staff' }).expect(409);
  assert.match(refused.body.error, /ตัวเอง/);

  // Deactivating is suspending, not deleting: the account and everything it
  // did stay, and the person simply cannot get in.
  await call('post', `/users/${created.id}/suspend`, owner, {}).expect(200);
  assert.equal(db.prepare('SELECT status FROM users WHERE id=?').get(created.id).status, 'suspended');
  await call('post', '/auth/login', null,
    { email: 'newstaff@example.test', password: 'their-own-password' }).expect(403);

  // Every one of those presses is written down.
  const actions = db.prepare('SELECT action FROM audit_logs WHERE entity_id=? ORDER BY created_at, id')
    .all(created.id).map(row => row.action);
  for (const action of ['user.create', 'user.password_link_issued', 'user.role', 'user.suspend']) {
    assert.ok(actions.includes(action), `ต้องบันทึก ${action}`);
  }
});

// ---------------------------------------------------------------------------
// The four numbers across the top of the screen.
//
// They are read at a glance and never looked up again, which is exactly why
// they have to agree with the reports underneath them. "จะหมดอายุใน 7 วัน"
// counts PEOPLE by the longest entitlement they still have -- somebody who
// renewed early has two rows and is one person, and a bar that counts them
// twice sends the owner chasing a customer who has already paid.

test('the bar across the top counts today, and counts people once', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner, member, pkg } = await busyGym(fixture);

  const bar = (await call('get', '/admin/reports/today', owner).expect(200)).body;
  assert.equal(bar.day, dayOf(fixture.at()));
  assert.equal(bar.sales_orders, 1);
  assert.equal(bar.sales_baht, '1200.00');
  assert.equal(bar.checkins, 1);
  assert.equal(bar.people, 1);
  assert.equal(bar.new_members, 1);
  // A membership sold this afternoon for thirty days is not "about to expire".
  assert.equal(bar.expiring_7, 0);

  // Now bring it inside the week, and sell the same person a second package
  // that runs longer -- the renewal that used to count somebody twice.
  const soon = fixture.at() + 3 * 86400000;
  db.prepare("UPDATE entitlements SET expires_at=? WHERE member_id=?").run(soon, member.id);
  const warned = (await call('get', '/admin/reports/today', owner).expect(200)).body;
  assert.equal(warned.expiring_7, 1);

  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);
  const renewed = (await call('get', '/admin/reports/today', owner).expect(200)).body;
  assert.equal(renewed.expiring_7, 0, 'ต่ออายุแล้วต้องหายจากรายการที่จะหมดอายุ ไม่ใช่ถูกนับสองครั้ง');

  // And the number on the bar is the number of rows in the report behind it.
  const list = (await call('get', '/admin/reports/members?view=expiring&days=7', owner).expect(200)).body;
  assert.equal(renewed.expiring_7, list.total);
});

// ---------------------------------------------------------------------------
// BUG-18: "ครั้งคงเหลือ: ไม่จำกัด" for a member with nothing left.
//
// The member report exists to be telephoned from. The "หมดอายุแล้ว" view joins
// only entitlements that are still usable -- which those members, by
// definition, do not have -- so every column came back NULL, and
// `sessions_total === null` was read as "this package counts no visits". Every
// row of that view said "ไม่จำกัด", with the package and the date blank: the
// owner rings somebody who cannot get in, believing they can, and has nothing
// to talk to them about (QA, on the gym's own machine).
//
// The fix is to tell "an unlimited package" apart from "no row was joined",
// and to give that view a join that does not require the entitlement to be
// usable. These four cases are the three ways a membership ends plus the one
// that must still say "ไม่จำกัด" because it really is unlimited.

/** A gym selling a single visit, sold to one member who then uses it. */
async function usedUpGym(fixture) {
  const { call, signIn, addMember } = fixture;
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');
  const pkg = (await call('post', '/packages', owner, {
    code: 'TRIAL1', name_th: 'ทดลองเล่นฟรี 1 ครั้ง', type: 'limited_sessions',
    duration_days: 7, session_limit: 1, price_thb: 0, status: 'active',
  }).expect(201)).body;
  const member = await addMember(desk, { name: 'ทดลอง ใช้ครบแล้ว', phone: '0899990001' });
  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'none')
    .field('note', 'แถมให้ทดลอง').expect(201);
  const qr = (await call('get', `/members/${member.id}/card`, desk).expect(200)).body.qr;
  await call('post', '/check-ins/verify', desk, { qr, device_label: 'เคาน์เตอร์ 1' }).expect(200);
  return { owner, desk, member, pkg };
}

test('a member who used every visit is expired, says so, and keeps their package', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner, member } = await usedUpGym(fixture);

  // The state QA found: no visits left, and the date still days away.
  const left = db.prepare('SELECT sessions_remaining, expires_at FROM entitlements WHERE member_id=?').get(member.id);
  assert.equal(left.sessions_remaining, 0);
  assert.ok(left.expires_at > fixture.at(), 'วันหมดอายุต้องยังไม่ถึง ไม่งั้นเทสต์นี้ไม่ได้ตรวจเคสที่ตั้งใจ');

  const expired = (await call('get', '/admin/reports/members?view=expired', owner).expect(200)).body;
  assert.equal(expired.total, 1);
  const row = expired.items[0];
  assert.equal(row.sessions_left, 0, `ต้องเป็นเลข 0 ไม่ใช่ "${row.sessions_left}"`);
  assert.equal(row.reason, 'ใช้ครบแล้ว');
  assert.equal(row.package, 'ทดลองเล่นฟรี 1 ครั้ง', 'ช่องแพ็กเกจต้องไม่ว่าง');
  assert.match(row.expires_on, /^\d{2}\/\d{2}\/\d{4}$/, 'ช่องวันหมดอายุต้องไม่ว่าง');
  assert.ok(Number(row.days_left) > 0, 'ยังเหลือวันอยู่จริง ตัวเลขนั้นมีประโยชน์ตอนโทรขายเพิ่ม');

  // And nowhere near the list of people to ring about renewing: that list is
  // people who can still get in.
  const soon = (await call('get', '/admin/reports/members?view=expiring&days=7', owner).expect(200)).body;
  assert.equal(soon.total, 0);
  assert.equal((await call('get', '/admin/reports/today', owner).expect(200)).body.expiring_7, 0);

  // The CSV carries the same word, in a column of its own.
  const csv = await call('get', '/admin/reports/members?view=expired&format=csv', owner).expect(200);
  assert.match(csv.text, /สาเหตุ/);
  assert.match(csv.text, /ใช้ครบแล้ว/);
  assert.doesNotMatch(csv.text, /ไม่จำกัด/);
});

test('the other two endings are named apart from it', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner, member } = await usedUpGym(fixture);
  const reasonFor = async () => (await call('get', '/admin/reports/members?view=expired', owner)
    .expect(200)).body.items[0].reason;

  // Give the visit back and push the date into the past: the same member, a
  // different ending.
  db.prepare('UPDATE entitlements SET sessions_remaining=1, expires_at=? WHERE member_id=?')
    .run(fixture.at() - 2 * 86400000, member.id);
  assert.equal(await reasonFor(), 'ครบกำหนดวัน');

  db.prepare("UPDATE entitlements SET status='revoked', revoked_at=?, revoked_reason=? WHERE member_id=?")
    .run(fixture.at(), 'คืนเงินให้ลูกค้า', member.id);
  assert.equal(await reasonFor(), 'ถูกยกเลิก');
});

test('a package that really is unlimited still says so, and nothing else does', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  const { owner, member } = await busyGym(fixture);

  // The monthly package counts no visits. Run its date out.
  db.prepare('UPDATE entitlements SET expires_at=? WHERE member_id=?')
    .run(fixture.at() - 86400000, member.id);
  const expired = (await call('get', '/admin/reports/members?view=expired', owner).expect(200)).body;
  assert.equal(expired.total, 1);
  assert.equal(expired.items[0].sessions_left, 'ไม่จำกัด', 'แพ็กเกจไม่จำกัดครั้งจริง ต้องยังขึ้นว่าไม่จำกัด');
  assert.equal(expired.items[0].reason, 'ครบกำหนดวัน');
  assert.equal(expired.items[0].package, 'รายเดือน ไม่จำกัดครั้ง');
  assert.equal(expired.items[0].days_left, '', 'วันที่ผ่านไปแล้วไม่ต้องพิมพ์เป็นเลขติดลบ');

  // And a member who never bought anything: an empty cell, not the word.
  const walkIn = await fixture.addMember(await fixture.signIn('desk@example.test', 'staff'),
    { name: 'ยังไม่ซื้อ อะไรเลย', phone: '0899990002' });
  const fresh = (await call('get', '/admin/reports/members?view=new', owner).expect(200)).body;
  const theirs = fresh.items.find(row => row.name === 'ยังไม่ซื้อ อะไรเลย');
  assert.ok(theirs, 'สมาชิกที่เพิ่งสมัครต้องอยู่ในมุมมองสมัครใหม่');
  assert.equal(theirs.sessions_left, '', `ไม่มีสิทธิ์เลยต้องเป็นช่องว่าง ไม่ใช่ "${theirs.sessions_left}"`);
  assert.equal(theirs.package, '');
  assert.equal(theirs.reason, '', 'ไม่เคยมีสิทธิ์ ก็ไม่มีสาเหตุที่สิทธิ์จบลง');
  assert.ok(walkIn.id);
});
