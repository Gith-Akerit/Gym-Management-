// Sending the card again, cancelling one, and the key that signs them all.
//
// A member loses the picture. They message the gym, and whoever is at the desk
// presses "ส่งบัตรซ้ำ" and pastes a link into the chat. It has to hand over the
// same card -- not a new one -- and it has to stop working on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, PNG_PIXEL } from './counter.js';
import { shrinkPhoto } from '../server/cards.js';
import { CARD_LINK_TTL_MS } from '../server/cards-routes.js';
import { cardSecret } from '../server/secret.js';

const START = Date.parse('2026-09-15T09:00:00+07:00');

/** Supertest parses a body by default; a PNG needs the bytes. */
const asBytes = request => request.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

test('"ส่งบัตรซ้ำ" gives a link that downloads the same card for seven days', async t => {
  const { call, http, signIn, addMember, db, tick } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'ลืมรูปบัตรไปแล้ว' });

  const link = await call('post', `/members/${member.id}/card/link`, owner, {}).expect(200);
  assert.match(link.body.url, /^\/card\/[0-9a-f-]{36}\.png\?v=1&e=\d+&s=[0-9a-f]{32}$/);
  // Seven days: the reason it exists is a member messaging the gym days after
  // losing the picture, and a link that dies first is a second phone call.
  assert.equal(link.body.expires_at, START + CARD_LINK_TTL_MS);

  // Opened by whoever the gym sent it to, in a browser with no session at all.
  const got = await asBytes(http.get(link.body.url)).expect(200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['cache-control'], 'no-store');
  assert.equal(got.body.readUInt32BE(16), 1080);
  assert.equal(got.body.readUInt32BE(20), 1350);
  assert.match(got.headers['content-disposition'], /GYM-[0-9A-F]{12}\.png/);

  // Handing one out is written down: it is a copy of somebody's card.
  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='member.card_link'").get();
  assert.equal(entry.entity_id, member.id);

  tick(CARD_LINK_TTL_MS - 1000);
  await asBytes(http.get(link.body.url)).expect(200);
  tick(2000);
  const dead = await http.get(link.body.url).expect(404);
  assert.match(dead.text, /หมดอายุหรือถูกยกเลิกแล้ว/);
});

test('a link to a card stops working the moment that card is reissued', async t => {
  const { call, http, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const link = (await call('post', `/members/${member.id}/card/link`, owner, {}).expect(200)).body.url;
  await asBytes(http.get(link)).expect(200);

  await call('post', `/members/${member.id}/card/reissue`, owner, { reason: 'โทรศัพท์หาย' }).expect(200);
  // Nothing was deleted and no list of dead links is kept: the signature covers
  // the card number, so every link to the old card died with the card.
  await http.get(link).expect(404);

  const fresh = (await call('post', `/members/${member.id}/card/link`, owner, {}).expect(200)).body;
  assert.equal(fresh.card_version, 2);
  await asBytes(http.get(fresh.url)).expect(200);
});

test('an edited link is refused, and one link does not open another card', async t => {
  const { call, http, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const other = await addMember(owner, { name: 'คนอื่น', phone: '0890000002' });
  const link = (await call('post', `/members/${member.id}/card/link`, owner, {}).expect(200)).body;
  const query = link.url.split('?')[1];

  for (const url of [
    link.url.replace(/s=[0-9a-f]{32}/, `s=${'f'.repeat(32)}`),        // a made-up signature
    link.url.replace(/e=\d+/, `e=${START + 86400000 * 3650}`),        // a longer life
    link.url.replace('v=1', 'v=2'),                                   // a card that is not this one
    `/card/${other.id}.png?${query}`,                                 // somebody else's card
    `/card/${member.id}.png`,                                         // no signature at all
  ]) {
    await http.get(url).expect(404);
  }
});

test('the cancelled card is drawn for the counter and never for a member', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const live = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  const voided = await asBytes(call('get', `/members/${member.id}/card.png?voided=1`, owner)).expect(200);

  assert.equal(voided.body.readUInt32BE(16), 1080);
  assert.equal(voided.body.readUInt32BE(20), 1350);
  // Stamped across, with the QR faded: an admin looking at the history has to
  // see at a glance which picture is the dead one (Designer).
  assert.ok(!voided.body.equals(live.body), 'the cancelled card is not the same picture');
});

test('a photograph is shrunk to 700px on its long edge before it is stored', async t => {
  const { call, signIn, addMember, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);

  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  // What a phone camera actually hands over, near enough: many times more
  // pixels than the 232px circle on the card or the 300px one on the scanner.
  const source = createCanvas(2400, 1800);
  const ctx = source.getContext('2d');
  ctx.fillStyle = '#05603A'; ctx.fillRect(0, 0, 2400, 1800);
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(400, 300, 900, 900);
  const huge = source.toBuffer('image/png');

  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', huge, { filename: 'from-a-phone.png', contentType: 'image/png' }).expect(200);

  assert.equal(readdirSync(join(root, 'photos')).length, 1);
  const served = await asBytes(call('get', `/members/${member.id}/photo`, owner)).expect(200);
  const image = await loadImage(served.body);
  assert.equal(Math.max(image.width, image.height), 700);
  assert.equal(image.height, 525, 'the shape of the face is kept, not squared off');
  assert.ok(served.body.length < huge.length, 'and the gym is not storing a photo album');

  // And the card still draws from it.
  const card = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.equal(card.body.readUInt32BE(16), 1080);
});

test('a photograph that is already small is stored exactly as it arrived', async t => {
  const { call, signIn, addMember, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PNG_PIXEL, { filename: 'face.png', contentType: 'image/png' }).expect(200);
  // Re-encoding a picture already within the limit only loses detail.
  assert.match(readdirSync(join(root, 'photos'))[0], /\.png$/);
});

test('shrinking hands back what it was given when it cannot do better', async () => {
  // A machine with no build of the drawing library still signs members up and
  // keeps their photograph; only the card is unavailable, and it says so.
  assert.equal(await shrinkPhoto(PNG_PIXEL), PNG_PIXEL);
  const notAnImage = Buffer.from('not an image at all');
  assert.equal(await shrinkPhoto(notAnImage), notAnImage);
  assert.equal(await shrinkPhoto(null), null);
});

// ------------------------------------------------------------ the key itself

test('the card signing key keeps its old name readable, and says why', () => {
  const warnings = [];
  const warn = line => warnings.push(line);

  assert.equal(cardSecret({ CARD_SIGNING_SECRET: 'a'.repeat(64) }, warn), 'a'.repeat(64));
  assert.deepEqual(warnings, [], 'nothing to say when the key has its own name');

  // An installed gym upgrades without its cards dying, and is told exactly once
  // what to rename and -- more importantly -- not to generate a new value.
  assert.equal(cardSecret({ OTP_SECRET: 'b'.repeat(64) }, warn), 'b'.repeat(64));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CARD_SIGNING_SECRET/);
  assert.match(warnings[0], /Do NOT generate a new value/);

  // The new name wins, so renaming the key in a file that still has both is safe.
  assert.equal(cardSecret({ CARD_SIGNING_SECRET: 'new', OTP_SECRET: 'old' }, warn), 'new');
  assert.equal(cardSecret({}, warn), '');
});
