// "ใช้ไม่ได้" with a picture of it.
//
// Two rules decide everything here and they pull in opposite directions.
// Anybody signed in can send a report, because the person who meets the
// problem is whoever is holding the tablet and a report that takes a login
// dance is a report nobody sends. But the picture is of whatever was on the
// screen -- which at a counter is a member's name, face and phone number --
// so reading one back is the owner's alone, and every look is written down.
//
// The other thing checked here is that a report with no picture is a normal
// report: the capture fails on some browsers and some people switch it off,
// and losing the sentence they typed because of that would be the worst
// possible trade.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, PHOTO_JPEG } from './counter.js';
import { REPORT_MAX_EDGE } from '../server/reports.js';

/** A screenshot the size of a real one: wider than the ceiling, so it shrinks. */
async function screenshot({ width = 1920, height = 1200 } = {}) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#EFF2F4';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#0E1418';
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText('สมาชิก: สุดา ใจดี', 80, 200);
  return canvas.toBuffer('image/png');
}

const send = (call, token, message, image, extra = {}) => {
  const request = call('post', '/reports', token)
    .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14; Tab A9) Chrome/131')
    .field('message', message);
  for (const [key, value] of Object.entries(extra)) request.field(key, value);
  return image ? request.attach('screenshot', image, { filename: 'shot.png', contentType: 'image/png' }) : request;
};

test('a member of staff can send one, and it lands with everything the owner needs', async t => {
  const { call, signIn, db, root, at } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');

  const sent = await send(call, staff, 'กดปุ่มบันทึกแล้วหมุนค้าง ไม่ขึ้นอะไรเลย', await screenshot(), {
    screen: 'รับเงินและมอบแพ็กเกจ', viewport: '1280x800', app_revision: '692ed75',
  }).expect(201);

  // The reference is what the screen tells them to write down, so it has to be
  // small enough to say out loud.
  assert.equal(sent.body.reference, 1);
  assert.equal(sent.body.status, 'new');
  assert.equal(sent.body.has_image, true);
  assert.equal(sent.body.screen, 'รับเงินและมอบแพ็กเกจ');
  assert.equal(sent.body.app_revision, '692ed75', 'ครึ่งหนึ่งของเรื่องจะมาถึงหลัง deploy รอบถัดไป');
  assert.ok(sent.body.user_agent.length, 'the machine is recorded without anybody typing it');

  // The picture is on the volume as a JPEG no wider than the ceiling, not as
  // the several-hundred-kilobyte PNG the browser produced.
  const [stored] = readdirSync(join(root, 'reports'));
  assert.match(stored, /\.jpg$/);
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  assert.ok(createCanvas);
  const image = await loadImage(join(root, 'reports', stored));
  assert.equal(Math.max(image.width, image.height), REPORT_MAX_EDGE, 'ภาพไม่ได้ถูกย่อ');

  const row = db.prepare('SELECT * FROM problem_reports').get();
  assert.equal(row.reported_by, db.prepare('SELECT id FROM users WHERE email=?').get('desk@example.test').id);
  assert.equal(row.created_at, at());

  // And the owner sees it from their side, with the reporter named.
  const list = await call('get', '/reports', owner).expect(200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].reported_by_email, 'desk@example.test');
  assert.equal(list.body.counts.new, 1);
});

test('a report with no picture is a normal report, not a failed one', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');

  // The capture fails on some browsers, and the privacy tick turns it off on
  // purpose. Either way the sentence somebody typed must survive.
  const sent = await send(call, staff, 'กล้องไม่ติดบนแท็บเล็ตเครื่องที่สอง').expect(201);
  assert.equal(sent.body.has_image, false);
  assert.equal(sent.body.image_url, null);

  const image = await call('get', `/reports/${sent.body.id}/image`, owner).expect(404);
  assert.match(image.body.error, /ไม่มีภาพ/);
});

test('the one field that is required is the one a picture cannot answer', async t => {
  const { call, signIn } = counterFixture(t);
  const staff = await signIn('desk@example.test', 'staff');
  // A screenshot rarely says what the person was trying to do.
  const empty = await send(call, staff, '   ', await screenshot()).expect(400);
  assert.ok(empty.body.fields?.message || /ตรวจสอบข้อมูล/.test(empty.body.error), JSON.stringify(empty.body));
});

test('a file that is not an image does not become a report with a broken picture', async t => {
  const { call, signIn } = counterFixture(t);
  const staff = await signIn('desk@example.test', 'staff');
  const refused = await call('post', '/reports', staff).field('message', 'ทดสอบ')
    .attach('screenshot', Buffer.from('%PDF-1.4 this is not a screenshot'),
      { filename: 'shot.png', contentType: 'image/png' })
    .expect(400);
  assert.match(refused.body.error, /[ก-๙]/, 'ต้องปฏิเสธเป็นภาษาไทย');

  // Deliberately NOT refused: a screenshot that only half decodes is still
  // evidence, and the sentence attached to it is the part that matters. This
  // is the opposite call from the gym logo, which is refused when it cannot be
  // drawn in full because it goes on every member's card.
  const halfSent = Buffer.concat([(await screenshot()).subarray(0, 120), Buffer.alloc(200, 7)]);
  const partial = await call('post', '/reports', staff).field('message', 'ภาพส่งไม่ครบ')
    .attach('screenshot', halfSent, { filename: 'shot.png', contentType: 'image/png' });
  assert.equal(partial.status, 201, 'ภาพที่ถอดได้ไม่ครบไม่ควรทำให้เรื่องที่พนักงานพิมพ์หาย');
  assert.equal(partial.body.message, 'ภาพส่งไม่ครบ');
});

test('an oversized screenshot is refused with a way to still send the report', async t => {
  const { call, signIn } = counterFixture(t);
  const staff = await signIn('desk@example.test', 'staff');
  const huge = Buffer.concat([PHOTO_JPEG, Buffer.alloc(7 * 1024 * 1024, 9)]);
  const refused = await call('post', '/reports', staff).field('message', 'ทดสอบ')
    .attach('screenshot', huge, { filename: 'shot.jpg', contentType: 'image/jpeg' })
    .expect(400);
  // The message has to name the way out, because the person reading it is at a
  // counter with somebody waiting and cannot shrink a file.
  assert.match(refused.body.error, /ภาพหน้าจอ/);
  assert.match(refused.body.error, /ไม่แนบภาพ/);
});

test('reading them back belongs to the owner, and every look at a picture is written down', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const sent = await send(call, staff, 'หน้าสมาชิกค้าง', await screenshot()).expect(201);

  // Staff send them and cannot read them: the picture has a member on it.
  await call('get', '/reports', staff).expect(403);
  await call('get', `/reports/${sent.body.id}`, staff).expect(403);
  await call('get', `/reports/${sent.body.id}/image`, staff).expect(403);
  await call('patch', `/reports/${sent.body.id}`, staff, { status: 'done' }).expect(403);
  await call('delete', `/reports/${sent.body.id}`, staff, {}).expect(403);
  // And nobody at all without a session.
  await call('get', `/reports/${sent.body.id}/image`, null).expect(401);

  const seen = await call('get', `/reports/${sent.body.id}/image`, owner).expect(200);
  assert.match(seen.headers['content-type'], /image\/jpeg/);
  assert.equal(seen.headers['x-content-type-options'], 'nosniff');
  assert.match(seen.headers['cache-control'], /no-store/);

  // The question "who looked at this member's face?" only has an answer if it
  // was recorded before anybody thought to ask it.
  const views = db.prepare("SELECT * FROM audit_logs WHERE action='report.view_image'").all();
  assert.equal(views.length, 1);
  assert.equal(views[0].actor_id, db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id);
});

test('the owner works through them: status, a private note, and deleting one', async t => {
  const { call, signIn, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const first = await send(call, staff, 'เรื่องที่หนึ่ง', await screenshot()).expect(201);
  const second = await send(call, staff, 'เรื่องที่สอง').expect(201);
  assert.equal(second.body.reference, 2);

  const read = await call('patch', `/reports/${first.body.id}`, owner,
    { status: 'reading', internal_note: 'ถามคนติดตั้งแล้ว รอตอบ' }).expect(200);
  assert.equal(read.body.status, 'reading');
  assert.equal(read.body.internal_note, 'ถามคนติดตั้งแล้ว รอตอบ');

  const counts = (await call('get', '/reports', owner).expect(200)).body.counts;
  assert.equal(counts.reading, 1);
  assert.equal(counts.new, 1);
  assert.equal((await call('get', '/reports?status=reading', owner).expect(200)).body.items.length, 1);
  await call('patch', `/reports/${first.body.id}`, owner, { status: 'nonsense' }).expect(400);

  // Deleting takes the picture with it: a report the owner removed should not
  // leave a member's face on the volume.
  assert.equal(readdirSync(join(root, 'reports')).length, 1);
  await call('delete', `/reports/${first.body.id}`, owner, {}).expect(200);
  assert.equal(readdirSync(join(root, 'reports')).length, 0);
  await call('get', `/reports/${first.body.id}`, owner).expect(404);

  // The next report does not inherit the deleted one's number.
  const third = await send(call, staff, 'เรื่องที่สาม').expect(201);
  assert.equal(third.body.reference, 3);
});

test('a deleted number is never handed out again, even when it was the newest', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');

  const first = await send(call, staff, 'เรื่องแรก').expect(201);
  const second = await send(call, staff, 'เรื่องที่สอง').expect(201);
  assert.deepEqual([first.body.reference, second.body.reference], [1, 2]);

  // Counting the rows that are left rather than the numbers already issued is
  // what handed #2 out twice: the number is what the screen tells somebody to
  // write down, and the manual tells them to write it down, so two reports
  // months apart answering to "เรื่อง 2" is a conversation nobody can hold.
  await call('delete', `/reports/${second.body.id}`, owner, {}).expect(200);
  const third = await send(call, staff, 'เรื่องที่สาม').expect(201);
  assert.equal(third.body.reference, 3, 'เลขของเรื่องที่ลบไปแล้วถูกแจกซ้ำ');

  // Empty the table entirely and it still does not start over.
  await call('delete', `/reports/${first.body.id}`, owner, {}).expect(200);
  await call('delete', `/reports/${third.body.id}`, owner, {}).expect(200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM problem_reports').get().n, 0);
  const fourth = await send(call, staff, 'เรื่องที่สี่').expect(201);
  assert.equal(fourth.body.reference, 4);
});

test('the staff guide is served from the repository, to anybody who asks', async t => {
  const { call, http } = counterFixture(t);
  assert.ok(call);
  // No session: whoever most needs the manual may be the person who cannot get
  // signed in. It is instructions for a counter, not gym data.
  const manual = await http.get('/manual.pdf').expect(200);
  assert.match(manual.headers['content-type'], /application\/pdf/);
});
