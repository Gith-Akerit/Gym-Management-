// The membership card: the photograph, the picture, and the token inside it.
//
// The card is the whole of what a member holds. It is a file in a chat app, so
// it can be forwarded; what stops that being a free membership is the face on
// it, the signature in it, and the gym's ability to cancel it in one click.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, jpegBuffer, PNG_PIXEL } from './counter.js';
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
    .attach('photo', jpegBuffer(), { filename: 'second.jpg', contentType: 'image/jpeg' }).expect(200);
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
  assert.match(card.body.subtitle, /ยังไม่มีแพ็กเกจ/);

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
