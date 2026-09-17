// A photograph that is not a photograph (QA PHOTO-03).
//
// The counter's wifi drops halfway through an upload. What arrives has a
// perfect JPEG header and nothing behind it, so the check on the leading bytes
// waves it through -- and from then on that member's card answered 500, for
// ever, with "ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง", which was not true: retrying
// never helped and nothing on the screen said the photograph was the problem.
//
// Two layers, because they fail at different moments. The door check is the
// one that matters: it happens while the member is still standing there and
// can be photographed again. The fallback is for the bytes that go bad after
// that -- a half-written file, a disk that lost a block -- where nobody is
// standing there any more and a card with a silhouette beats no card at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, jpegBuffer, PHOTO_JPEG, PNG_PIXEL } from './counter.js';
import { photoIsDrawable, preparePhoto, PhotoUnreadableError } from '../server/cards.js';

const asBytes = request => request.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

// ------------------------------------------------------- at the door

test('a file that begins like a JPEG but will not open is refused at the counter', async t => {
  const { call, signIn, addMember, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'เน็ตหลุดกลางคัน' });

  const refused = await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', jpegBuffer(), { filename: 'half-sent.jpg', contentType: 'image/jpeg' })
    .expect(400);
  // Thai, and it says what to do: the fix is another photograph, not another
  // attempt at this one.
  assert.match(refused.body.error, /ถ่ายใหม่/);
  assert.match(refused.body.error, /เปิดไม่ได้/);

  // Nothing was written and nothing was recorded: the member is exactly as
  // they were a moment ago, which is what makes "ถ่ายใหม่" true.
  assert.equal(readdirSync(join(root, 'photos')).length, 0);
  const after = await call('get', `/members/${member.id}`, owner).expect(200);
  assert.equal(after.body.has_photo, false);

  // And the card the counter needs right now still comes out.
  const card = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.equal(card.body.readUInt32BE(16), 1080);
});

test('a photograph that replaces a good one has to open too', async t => {
  const { call, signIn, addMember, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PHOTO_JPEG, { filename: 'face.jpg', contentType: 'image/jpeg' }).expect(200);
  const kept = readdirSync(join(root, 'photos'))[0];

  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', jpegBuffer(), { filename: 'broken.jpg', contentType: 'image/jpeg' }).expect(400);

  // A refused upload must not take the working photograph with it: that would
  // turn one bad press of the shutter into a member with no face on their card.
  assert.deepEqual(readdirSync(join(root, 'photos')), [kept]);
  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(card.body.photo_readable, true);
});

test('the counter is still told which formats it may send', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  // A file that is not an image at all is refused by the older, cheaper check,
  // and keeps its own message: the two failures need different answers.
  const wrongType = await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', Buffer.from('<?php echo 1; ?>'), { filename: 'face.jpg', contentType: 'image/jpeg' })
    .expect(400);
  assert.match(wrongType.body.error, /JPG, PNG และ WEBP/);
});

// --------------------------------------------- after it is on the disk

test('a photograph that goes bad on the disk leaves the card working', async t => {
  const { call, signIn, addMember, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'รูปเสียบนดิสก์' });
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PHOTO_JPEG, { filename: 'face.jpg', contentType: 'image/jpeg' }).expect(200);
  const withFace = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);

  // Whatever the cause -- a half-written file, a disk that lost a block, a
  // restore from a backup that was taken mid-write -- the bytes are no longer
  // an image.
  const [stored] = readdirSync(join(root, 'photos'));
  writeFileSync(join(root, 'photos', stored), Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 0x7f),
  ]));

  const card = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.equal(card.headers['content-type'], 'image/png');
  assert.equal(card.body.readUInt32BE(16), 1080);
  assert.equal(card.body.readUInt32BE(20), 1350);
  assert.ok(!card.body.equals(withFace.body), 'the silhouette is drawn, not the face');

  // The card never says anything is wrong -- it goes to a member. The screen
  // in front of the person who can fix it does.
  const detail = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(detail.body.photo_readable, false);
  assert.equal(detail.body.member.has_photo, true);

  // And photographing them again puts the face back, with no new card needed:
  // the QR is over the member, not over the picture.
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PHOTO_JPEG, { filename: 'again.jpg', contentType: 'image/jpeg' }).expect(200);
  const fixed = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(fixed.body.photo_readable, true);
  assert.equal(fixed.body.card_version, 1, 'a broken photograph is not a reason to reissue a card');
  assert.equal(fixed.body.qr, detail.body.qr);
});

test('a photograph whose file has gone missing reads as unusable, not as absent', async t => {
  const { call, signIn, addMember, root, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PHOTO_JPEG, { filename: 'face.jpg', contentType: 'image/jpeg' }).expect(200);

  // The row says there is a photograph and the disk disagrees. "ยังไม่มีรูป"
  // would send somebody looking for a photograph that is never coming back.
  db.prepare('UPDATE members SET photo_stored_name=? WHERE id=?')
    .run('00000000-0000-4000-a000-000000000000.jpg', member.id);
  const detail = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(detail.body.photo_readable, false);
  await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.equal(readdirSync(join(root, 'photos')).length, 1, 'the orphan file is left alone, not deleted blind');
});

test('a member with no photograph at all is a different answer from a broken one', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const card = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(card.body.photo_readable, null);
  assert.equal(card.body.member.has_photo, false);
});

// ----------------------------------------------------------- the check itself

test('the check opens the file rather than trusting its first three bytes', async () => {
  assert.equal(await photoIsDrawable(PHOTO_JPEG), true);
  assert.equal(await photoIsDrawable(PNG_PIXEL), true);
  assert.equal(await photoIsDrawable(jpegBuffer()), false);
  assert.equal(await photoIsDrawable(Buffer.from('not an image at all')), false);
  // Nothing to judge is not a failure.
  assert.equal(await photoIsDrawable(null), true);
});

test('preparing a photograph shrinks it, and refuses what cannot be drawn', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const big = createCanvas(1500, 900);
  big.getContext('2d').fillRect(0, 0, 1500, 900);
  const shrunk = await preparePhoto(big.toBuffer('image/png'));
  assert.equal((await loadImage(shrunk)).width, 700);

  // Small enough already: re-encoding only loses detail.
  assert.equal(await preparePhoto(PHOTO_JPEG), PHOTO_JPEG);
  assert.equal(await preparePhoto(null), null);

  await assert.rejects(() => preparePhoto(jpegBuffer()), PhotoUnreadableError);
  await assert.rejects(() => preparePhoto(Buffer.from('not an image at all')),
    error => error instanceof PhotoUnreadableError && /ถ่ายใหม่/.test(error.message));
});
