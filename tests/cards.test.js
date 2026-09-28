// The membership card: the photograph, the picture, and the token inside it.
//
// The card is the whole of what a member holds. It is a file in a chat app, so
// it can be forwarded; what stops that being a free membership is the face on
// it, the signature in it, and the gym's ability to cancel it in one click.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, PHOTO_JPEG, PNG_PIXEL } from './counter.js';
import { cardSignature, cardSignatureMatches, decodeCardQr, encodeCardQr } from '../server/cards.js';

const SECRET = 'a'.repeat(64);
const MEMBER = '7d106cfe-8770-4a1b-9c2d-1122334455aa';

test('a card token carries the member, the card number and a signature — and nothing else', () => {
  const qr = encodeCardQr(MEMBER, 3, cardSignature(SECRET, MEMBER, 3));
  assert.ok(!qr.includes('@') && !/[ก-๙]/.test(qr), 'no name, no address, nothing readable');
  const decoded = decodeCardQr(qr);
  assert.equal(decoded.version, 3);
  assert.equal(decoded.member, MEMBER.replaceAll('-', ''));
  assert.ok(cardSignatureMatches(SECRET, MEMBER, 3, decoded.signature));

  // Changing any part of it invalidates it: the signature covers the card
  // number, which is what makes reissuing a counter rather than a blocklist.
  assert.equal(cardSignatureMatches(SECRET, MEMBER, 4, decoded.signature), false);
  assert.equal(cardSignatureMatches('b'.repeat(64), MEMBER, 3, decoded.signature), false);
  assert.equal(decodeCardQr(`${qr}.extra`), null);
  assert.equal(decodeCardQr('GYMCHK1.a.b'), null);
  assert.equal(decodeCardQr(''), null);
});

test('a photograph is stored outside the web root and served only to the counter', async t => {
  const { call, signIn, addMember, root, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  assert.equal(member.has_photo, false);

  const saved = await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PNG_PIXEL, { filename: 'face.png', contentType: 'image/png' })
    .expect(200);
  assert.equal(saved.body.has_photo, true);
  assert.equal(saved.body.photo_stored_name, undefined, 'the path on disk never leaves the server');

  const files = readdirSync(join(root, 'photos'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f-]{36}\.png$/, 'the server chose the name, not the browser');

  const image = await call('get', `/members/${member.id}/photo`, owner).expect(200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['cache-control'], 'no-store', 'a face is not left in a shared tablet cache');

  // Nobody signed in reaches it at all.
  await call('get', `/members/${member.id}/photo`, null).expect(401);
  assert.equal(db.prepare('SELECT photo_stored_name FROM members WHERE id=?').get(member.id).photo_stored_name, files[0]);
});

test('replacing a photograph deletes the one it replaced', async t => {
  const { call, signIn, addMember, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PNG_PIXEL, { filename: 'first.png', contentType: 'image/png' }).expect(200);
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PHOTO_JPEG, { filename: 'second.jpg', contentType: 'image/jpeg' }).expect(200);
  // One member, one face: old ones are not worth keeping and are personal data.
  assert.equal(readdirSync(join(root, 'photos')).length, 1);
});

test('a file that is not an image is refused whatever it is called', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const refused = await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', Buffer.from('<?php echo 1; ?>'), { filename: 'face.jpg', contentType: 'image/jpeg' })
    .expect(400);
  assert.match(refused.body.error, /JPG, PNG และ WEBP/);
});

test('the card is a PNG with the member on it, and it scans', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'ประกายแก้ว เจริญรุ่งเรือง' });
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PNG_PIXEL, { filename: 'face.png', contentType: 'image/png' }).expect(200);

  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(card.body.card_version, 1);
  assert.match(card.body.qr, /^GYMCARD1\./);
  assert.equal(card.body.membership.package, null);
  assert.equal(card.body.membership.expires_at, null);

  const png = await call('get', `/members/${member.id}/card.png`, owner)
    .buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.match(png.headers['content-disposition'], /GYM-[0-9A-F]{12}\.png/);
  assert.ok(png.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'really a PNG');
  // 1080 x 1350: the 4:5 a chat app shows at full width, so the QR arrives
  // ready to scan instead of needing a tap first (Designer, แบบ 2).
  assert.equal(png.body.readUInt32BE(16), 1080);
  assert.equal(png.body.readUInt32BE(20), 1350);

  // And the token on it is the one the scanner accepts.
  const scan = await call('post', '/check-ins/verify', owner, { qr: card.body.qr }).expect(409);
  assert.equal(scan.body.member.name, 'ประกายแก้ว เจริญรุ่งเรือง');
  assert.match(scan.body.failure_reason, /ยังไม่มีแพ็กเกจ/, 'refused for want of a package, not a bad card');
});

test('a member with no photograph still gets a card, and the screen is told', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(card.body.member.has_photo, false);
  await call('get', `/members/${member.id}/card.png`, owner).expect(200);
});

test('reissuing kills the old card and nothing else', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const first = (await call('get', `/members/${member.id}/card`, owner).expect(200)).body.qr;

  const reissued = await call('post', `/members/${member.id}/card/reissue`, owner, { reason: 'บัตรหาย' }).expect(200);
  assert.equal(reissued.body.member.card_version, 2);
  assert.notEqual(reissued.body.qr, first);

  const refused = await call('post', '/check-ins/verify', owner, { qr: first }).expect(409);
  assert.match(refused.body.failure_reason, /บัตรใบนี้ถูกยกเลิกแล้ว/);
  assert.equal(refused.body.member.id, member.id, 'the counter still knows whose card it was');

  // Written down, with a reason: this cancels something a member is carrying.
  const entry = db.prepare("SELECT * FROM audit_logs WHERE entity_id=? AND action='member.card_reissue'").get(member.id);
  assert.ok(entry);
  assert.equal(JSON.parse(entry.after_json).reason, 'บัตรหาย');
  assert.equal(entry.actor_id, db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id);

  // Both codes, so "which card was this?" has an answer afterwards -- and
  // named so that the audit trail does not mistake the record for a member row
  // and stamp `has_photo` over it.
  assert.equal(JSON.parse(entry.before_json).code_before, member.member_code);
  assert.equal(JSON.parse(entry.after_json).code_after, reissued.body.member.member_code);
  assert.equal(JSON.parse(entry.after_json).has_photo, undefined);

  // A reissue with no reason is refused; the reason is the whole record.
  await call('post', `/members/${member.id}/card/reissue`, owner, { reason: '' }).expect(400);
});

test('staff sign members up and read cards; only the owner cancels one', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const member = await addMember(staff, { name: 'พนักงานสมัครให้', phone: '0892223344' });
  await call('get', `/members/${member.id}/card`, staff).expect(200);
  await call('put', `/members/${member.id}/photo`, staff)
    .attach('photo', PNG_PIXEL, { filename: 'face.png', contentType: 'image/png' }).expect(200);
  // Reissuing throws away a card somebody is already carrying, so it is the
  // owner's decision rather than a busy counter's.
  await call('post', `/members/${member.id}/card/reissue`, staff, { reason: 'ลองดู' }).expect(403);
});

test('a forged or edited card is refused and recorded', async t => {
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const real = decodeCardQr((await call('get', `/members/${member.id}/card`, owner).expect(200)).body.qr);

  for (const qr of [
    encodeCardQr(member.id, 1, 'f'.repeat(32)),                     // made-up signature
    encodeCardQr(member.id, 9, real.signature),                     // a later card, real signature
    encodeCardQr('00000000-0000-4000-a000-000000000000', 1, real.signature), // somebody else's
    'GYMCARD1.not-hex.1.' + 'f'.repeat(32),
    'nonsense',
  ]) {
    const refused = await call('post', '/check-ins/verify', owner, { qr }).expect(409);
    assert.equal(refused.body.result, 'denied');
  }
  // Every attempt is kept: somebody will ask about the queue at the door later.
  assert.equal(db.prepare("SELECT count(*) AS n FROM check_ins WHERE result='denied'").get().n, 5);
});

test('reissuing replaces the code printed on the card as well as the QR', async t => {
  // Pentester D1. The QR is cancelled by a counter the signature covers, but
  // the twelve characters printed under it are typed in by hand at the desk
  // and are matched by nothing but themselves -- so a cancelled card whose
  // code still worked was a cancelled card that still opened the door.
  const { call, signIn, addMember, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'บัตรหลุดไปถึงคนอื่น' });
  const printed = member.member_code;
  assert.match(printed, /^GYM-[0-9A-F]{12}$/);

  const reissued = await call('post', `/members/${member.id}/card/reissue`, owner,
    { reason: 'บัตรหลุดไปถึงคนอื่น' }).expect(200);
  const fresh = reissued.body.member.member_code;
  assert.notEqual(fresh, printed);
  assert.match(fresh, /^GYM-[0-9A-F]{12}$/, 'still a code somebody can read off a card and type');

  // The row itself moved, not just the answer this one request gave.
  assert.equal(db.prepare('SELECT member_code FROM members WHERE id=?').get(member.id).member_code, fresh);
  // And the retired code is gone rather than parked somewhere that could hand
  // it back out: nothing in the table answers to it any more.
  assert.equal(db.prepare('SELECT count(*) n FROM members WHERE member_code=?').get(printed).n, 0);

  // Every screen that reads the member reads the new one, including the file
  // name the counter is about to send to the customer.
  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(card.body.member.member_code, fresh);
  const png = await call('get', `/members/${member.id}/card.png`, owner)
    .buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.ok(png.headers['content-disposition'].includes(`${fresh}.png`),
    'the card being handed over is filed under the code drawn on it');
});

test('a second reissue gives a third code, and no code is ever reused', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const codes = [member.member_code];
  for (const reason of ['ครั้งที่หนึ่ง', 'ครั้งที่สอง', 'ครั้งที่สาม']) {
    const again = await call('post', `/members/${member.id}/card/reissue`, owner, { reason }).expect(200);
    codes.push(again.body.member.member_code);
  }
  assert.equal(new Set(codes).size, codes.length, 'a reissue handed back a code that had already been printed');
});

// ------------------------------------------------- which card a picture is
//
// Three rounds of the same bug were fixed by having the screen remember what
// the card was when a press started. It kept leaking, because a screen can be
// replaced and its memory goes with it. So the picture says which card it is,
// the server says which card it has, and whoever is about to hand a file to a
// member compares those two instead of anything it kept itself.

test('a card says which card it is, and the record agrees', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'ใบนี้ใบไหน' });

  const png = await call('get', `/members/${member.id}/card.png`, owner).expect(200);
  const stamped = png.headers['x-card-revision'];
  assert.match(stamped, /^[0-9a-f-]{36}\.\d+\.\d+\.\d+$/);
  assert.ok(stamped.startsWith(`${member.id}.`), 'it names the member it is a card for');

  const record = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(record.body.card_revision, stamped,
    'the picture and the record have to be answering the same question');
});

test('everything drawn on a card moves the revision', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'ก่อนแก้' });
  const revision = async () =>
    (await call('get', `/members/${member.id}/card.png`, owner).expect(200)).headers['x-card-revision'];

  const first = await revision();
  // The same card twice is the same answer: a revision that moved on its own
  // would refuse hand-overs that are perfectly fine.
  assert.equal(await revision(), first);

  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PNG_PIXEL, { filename: 'face.png', contentType: 'image/png' }).expect(200);
  const afterPhoto = await revision();
  assert.notEqual(afterPhoto, first, 'a new photograph is a new picture');

  const saved = await call('put', `/members/${member.id}`, owner, {
    name: 'หลังแก้ชื่อ', phone: '0891110001', email: null, date_of_birth: null,
    emergency_contact: '', status: 'active',
    version: (await call('get', `/members/${member.id}/card`, owner)).body.member.version,
  }).expect(200);
  assert.equal(saved.body.name, 'หลังแก้ชื่อ');
  const afterName = await revision();
  assert.notEqual(afterName, afterPhoto, 'the name is drawn on the card too');

  await call('post', `/members/${member.id}/card/reissue`, owner, { reason: 'บัตรหาย' }).expect(200);
  const afterReissue = await revision();
  assert.notEqual(afterReissue, afterName);
  // And the card number inside it really did move, which is what makes a
  // reissue tellable apart from a retouch.
  assert.notEqual(afterReissue.split('.')[1], afterName.split('.')[1]);
});

test('the letter reports the card it actually posted', async t => {
  const { call, signIn, addMember, outbox } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'ส่งไปแล้วใบไหน', email: 'posted@example.test' });

  const before = (await call('get', `/members/${member.id}/card`, owner).expect(200)).body.card_revision;
  const sent = await call('post', `/members/${member.id}/welcome`, owner, {}).expect(200);
  assert.equal(sent.body.card_revision, before,
    'a letter cannot be called back, so it has to say what went in it');
  assert.equal(outbox.at(-1).attachments[0].filename, `${member.member_code}.png`);

  // After a reissue the letter that went out no longer describes the card the
  // gym has -- which is the whole of what the counter needs to be told.
  await call('post', `/members/${member.id}/card/reissue`, owner, { reason: 'ส่งผิดคน' }).expect(200);
  const now = (await call('get', `/members/${member.id}/card`, owner).expect(200)).body.card_revision;
  assert.notEqual(now, sent.body.card_revision);
});
