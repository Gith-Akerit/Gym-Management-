// The gym's own logo and colours.
//
// A gym that has paid for a sign wants the card its members carry to look like
// the sign. Everything here follows from two things: the owner picks one
// colour and the rest is arithmetic, and the card is drawn on the server so
// the picture and the screen cannot disagree about what that colour is.
//
// The one thing that must not move is the token in the QR. A colour change is
// a change of clothes; a card already in somebody's phone still opens the door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, jpegBuffer, PHOTO_JPEG } from './counter.js';
import {
  contrastRatio, darkenUntilReadable, deriveSecondary, luminance, MIN_CONTRAST,
  normalizeHex, paletteFrom, prepareLogo, readableInk, resolveTheme,
} from '../server/theme.js';

const asBytes = request => request.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

/** A logo the way a gym's designer hands one over: flat colour, transparent. */
async function logoFile({ width = 600, height = 600, colour = '#C2185B' } = {}) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#12306B';
  ctx.fillRect(width * 0.3, height * 0.44, width * 0.4, height * 0.12);
  return canvas.toBuffer('image/png');
}

// ------------------------------------------------------------ the arithmetic

test('the ink on a colour is whichever of black and white can be read on it', () => {
  // Not a lightness cut-off: a mid green takes white, a bright yellow takes
  // black, and both answers have to beat 4.5:1 or the card is unreadable.
  for (const [colour, ink] of [['#05603A', '#FFFFFF'], ['#FFD400', '#0E1418'],
    ['#111111', '#FFFFFF'], ['#8ED1FC', '#0E1418']]) {
    assert.equal(readableInk(colour), ink, colour);
    assert.ok(contrastRatio(colour, ink) >= MIN_CONTRAST, `${colour} on ${ink}`);
  }
});

test('a gym that names one colour gets a whole readable set from it', () => {
  for (const primary of ['#05603A', '#C2185B', '#FFD400', '#111111', '#8ED1FC']) {
    const theme = resolveTheme({ color_primary: primary });
    assert.equal(theme.primary, primary);
    // Text on the colour, and text on the pale version of the colour: the two
    // places a brand colour normally becomes unreadable.
    assert.ok(contrastRatio(theme.primary, theme.on_primary) >= MIN_CONTRAST, `on_primary for ${primary}`);
    assert.ok(contrastRatio(theme.ink, theme.soft) >= MIN_CONTRAST, `ink on soft for ${primary}`);
    assert.ok(contrastRatio(theme.secondary, theme.on_secondary) >= MIN_CONTRAST, `on_secondary for ${primary}`);
    assert.notEqual(theme.hover, theme.primary, 'a button that does not move when hovered looks broken');
  }
});

test('the second colour is the same colour again, not a different one', () => {
  // Darker for a light primary, lighter for a dark one: a pair, not a clash.
  assert.ok(luminance(deriveSecondary('#FFD400')) < luminance('#FFD400'));
  assert.ok(luminance(deriveSecondary('#05603A')) > luminance('#05603A'));
  // And the owner's own choice always wins over the arithmetic.
  assert.equal(resolveTheme({ color_primary: '#05603A', color_secondary: '#8B0000' }).secondary, '#8B0000');
});

test('a colour nothing can be read on is used anyway, and said out loud', () => {
  // The narrow band of mid grey where white fails on it and black fails on it
  // too. It is the gym's sign and they know what it looks like, so it is not
  // refused -- but the screen has to say so, or the owner finds out from a
  // member squinting at a card.
  const theme = resolveTheme({ color_primary: '#7A7A7A' });
  assert.ok(theme.warning, 'a colour below 4.5:1 must warn');
  assert.match(theme.warning, /อ่านยาก/);
  assert.equal(resolveTheme({ color_primary: '#05603A' }).warning, null);
});

test('a colour that is not a colour never reaches the card', () => {
  for (const nonsense of ['red', '#12345', 'rgb(1,2,3)', '', null, undefined, '#' + 'f'.repeat(7)]) {
    assert.equal(normalizeHex(nonsense), null, String(nonsense));
  }
  assert.equal(normalizeHex('#abc'), '#AABBCC', 'three digits are a colour people type');
  assert.equal(normalizeHex('05603a'), '#05603A', 'and so is one without a hash');
  // Whatever is in the row, something drawable comes out.
  assert.equal(resolveTheme(null).primary, '#05603A');
  assert.equal(resolveTheme({ color_primary: 'nonsense' }).primary, '#05603A');
});

test('darkening stops at something legible rather than looping forever', () => {
  assert.ok(contrastRatio(darkenUntilReadable('#FFFFFF', '#FFFFFF'), '#FFFFFF') >= MIN_CONTRAST);
  assert.equal(darkenUntilReadable('#05603A', '#FFFFFF'), '#05603A', 'already readable is left alone');
});

// ----------------------------------------------------------------- the logo

test('the colours in a logo are offered back, most used first', async () => {
  const palette = await paletteFrom(await logoFile({ colour: '#C2185B' }));
  assert.ok(palette.length >= 1, 'a two-colour logo yields at least one colour');
  for (const colour of palette) assert.equal(normalizeHex(colour), colour);
  // The circle covers more of the picture than the bar across it, so the pink
  // is the first thing offered -- which is the colour somebody would point at.
  assert.ok(contrastRatio(palette[0], '#C2185B') < 1.6, `expected the pink first, got ${palette.join(' ')}`);
  // White paper and black outlines are not what anybody means by "our colour".
  for (const colour of palette) {
    assert.notEqual(colour, '#FFFFFF');
    assert.notEqual(colour, '#000000');
  }
});

test('a logo is checked by opening it, and trimmed to something sendable', async () => {
  const { loadImage } = await import('@napi-rs/canvas');
  const big = await logoFile({ width: 1600, height: 900 });
  const trimmed = await prepareLogo(big);
  const image = await loadImage(trimmed);
  assert.equal(Math.max(image.width, image.height), 512);
  // PNG, not JPEG: a logo is usually flat colour on nothing, and JPEG would
  // give it a white box and soft edges.
  assert.ok(trimmed.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  const small = await logoFile({ width: 200, height: 200 });
  assert.equal(await prepareLogo(small), small, 'already small is left exactly as it arrived');
  await assert.rejects(() => prepareLogo(jpegBuffer()), /เปิดไม่ได้/);
});

// ------------------------------------------------------------- the endpoints

test('the login screen can read the gym colours without signing in', async t => {
  const { call } = counterFixture(t);
  const theme = await call('get', '/public/theme', null).expect(200);
  assert.equal(theme.body.theme.primary, '#05603A');
  assert.equal(theme.body.has_logo, false);
  assert.equal(theme.body.logo_url, null);
  // Nothing private in it: it is what is painted on the door.
  assert.equal(JSON.stringify(theme.body).includes('@'), false);
  assert.equal(theme.body.brand_short.length <= 12, true);
});

test('the owner sets the colours, and staff can only look', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');

  const before = await call('get', '/gym/settings', staff).expect(200);
  assert.equal(before.body.theme.primary, '#05603A');
  assert.equal(before.body.color_secondary_source, 'auto');
  await call('put', '/gym/settings', staff, { color_primary: '#C2185B' }).expect(403);

  const saved = await call('put', '/gym/settings', owner,
    { color_primary: '#c2185b', brand_short: 'สฟ', line_id: '@suklutai' }).expect(200);
  assert.equal(saved.body.theme.primary, '#C2185B', 'stored the same whichever case it was typed in');
  assert.equal(saved.body.theme.on_primary, '#FFFFFF');
  assert.equal(saved.body.brand_short, 'สฟ');
  assert.equal(saved.body.line_id, '@suklutai');
  assert.equal(saved.body.version, 2);

  // Written down: the look of every member's card just changed.
  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='gym.settings'").get();
  assert.ok(entry);
  assert.equal(JSON.parse(entry.after_json).color_primary, '#C2185B');
  assert.equal(entry.actor_id, db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id);

  // And the public screen sees it immediately, without a restart.
  assert.equal((await call('get', '/public/theme', null).expect(200)).body.theme.primary, '#C2185B');
});

test('a colour that is not a colour is refused before it reaches a card', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  for (const bad of ['blue', '#12345', 'drop table']) {
    const refused = await call('put', '/gym/settings', owner, { color_primary: bad }).expect(400);
    assert.match(refused.body.error, /สีหลักไม่ถูกต้อง/);
  }
  // Clearing the second colour is a choice, not a mistake: it hands it back to
  // the arithmetic, which is where most gyms leave it.
  await call('put', '/gym/settings', owner, { color_primary: '#FFD400', color_secondary: '#123456' }).expect(200);
  const cleared = await call('put', '/gym/settings', owner, { color_secondary: '' }).expect(200);
  assert.equal(cleared.body.color_secondary_source, 'auto');
  assert.equal(cleared.body.theme.secondary, deriveSecondary('#FFD400'));
});

test('two people on two tablets cannot quietly undo each other', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const opened = (await call('get', '/gym/settings', owner).expect(200)).body.version;
  await call('put', '/gym/settings', owner, { color_primary: '#C2185B', version: opened }).expect(200);
  const stale = await call('put', '/gym/settings', owner, { color_primary: '#12306B', version: opened }).expect(409);
  assert.match(stale.body.error, /โหลดหน้าใหม่/);
});

test('the logo is stored like everything else and served to anybody', async t => {
  const { call, signIn, root, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  const logo = await logoFile();

  await call('put', '/gym/settings/logo', staff).attach('logo', logo, { filename: 'logo.png' }).expect(403);
  const saved = await call('put', '/gym/settings/logo', owner)
    .attach('logo', logo, { filename: '../../evil.png', contentType: 'image/png' }).expect(200);
  assert.equal(saved.body.has_logo, true);
  assert.match(saved.body.logo_url, /^\/api\/gym\/logo\?v=\d+$/);
  // The colours of the file just uploaded, ready to pick from.
  assert.ok(saved.body.palette.length >= 1);
  assert.equal(saved.body.logo_stored_name, undefined, 'the path on disk never leaves the server');

  const files = readdirSync(join(root, 'logo'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f-]{36}\.png$/, 'the server chose the name, not the browser');

  // Served without a session, because the login screen needs it before there
  // is one. It is a shop sign, not personal data.
  const image = await asBytes(call('get', '/gym/logo', null)).expect(200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.ok(image.body.length > 0);

  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='gym.logo'").get();
  assert.ok(entry, 'changing the logo changes every card, so it is written down');
});

test('a second logo replaces the first, and removing it leaves nothing behind', async t => {
  const { call, signIn, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  await call('put', '/gym/settings/logo', owner)
    .attach('logo', await logoFile({ colour: '#C2185B' }), { filename: 'one.png' }).expect(200);
  await call('put', '/gym/settings/logo', owner)
    .attach('logo', await logoFile({ colour: '#12306B' }), { filename: 'two.png' }).expect(200);
  assert.equal(readdirSync(join(root, 'logo')).length, 1, 'one gym, one logo');

  const removed = await call('delete', '/gym/settings/logo', owner, {}).expect(200);
  assert.equal(removed.body.has_logo, false);
  assert.equal(readdirSync(join(root, 'logo')).length, 0);
  await call('get', '/gym/logo', null).expect(404);
  // And the app falls back to the letters, which is what it did before.
  assert.ok((await call('get', '/public/theme', null).expect(200)).body.brand_short.length > 0);
});

test('a file that is not a logo is refused with the reason', async t => {
  const { call, signIn, root } = counterFixture(t);
  const owner = await signIn('owner@example.test');

  const notAnImage = await call('put', '/gym/settings/logo', owner)
    .attach('logo', Buffer.from('<?php echo 1; ?>'), { filename: 'logo.png' }).expect(400);
  assert.match(notAnImage.body.error, /JPG, PNG และ WEBP/);

  const halfSent = await call('put', '/gym/settings/logo', owner)
    .attach('logo', jpegBuffer(), { filename: 'logo.jpg' }).expect(400);
  assert.match(halfSent.body.error, /เปิดไม่ได้/);

  assert.equal(readdirSync(join(root, 'logo')).length, 0, 'nothing refused is left on the disk');
});

// -------------------------------------------------------------- on the card

test('the card is drawn in the gym colours, and the token does not move', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner, { name: 'สีของยิมเปลี่ยน' });
  await call('put', `/members/${member.id}/photo`, owner)
    .attach('photo', PHOTO_JPEG, { filename: 'face.jpg', contentType: 'image/jpeg' }).expect(200);

  const green = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  const first = await call('get', `/members/${member.id}/card`, owner).expect(200);

  await call('put', '/gym/settings', owner, { color_primary: '#C2185B' }).expect(200);
  const pink = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.ok(!pink.body.equals(green.body), 'the card follows the gym colour');
  assert.equal(pink.body.readUInt32BE(16), 1080);
  assert.equal(pink.body.readUInt32BE(20), 1350);

  // The whole point: a card already in somebody's phone still opens the door.
  const second = await call('get', `/members/${member.id}/card`, owner).expect(200);
  assert.equal(second.body.qr, first.body.qr);
  assert.equal(second.body.card_version, first.body.card_version);
  assert.notEqual(second.body.theme_version, first.body.theme_version, 'but the screen knows to redraw');
  const scan = await call('post', '/check-ins/verify', owner, { qr: first.body.qr }).expect(409);
  assert.match(scan.body.failure_reason, /ยังไม่มีแพ็กเกจ/, 'refused for want of a package, not a dead card');
});

test('the logo goes on the card, and the QR stays black on white', async t => {
  const { call, http, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const plain = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);

  await call('put', '/gym/settings/logo', owner)
    .attach('logo', await logoFile(), { filename: 'logo.png', contentType: 'image/png' }).expect(200);
  const branded = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.ok(!branded.body.equals(plain.body), 'the gym logo is on it');

  // A seven-day link hands over the card as it is now, not as it was: the
  // member sees the gym's new look without anybody reissuing anything.
  const link = (await call('post', `/members/${member.id}/card/link`, owner, {}).expect(200)).body;
  const sent = await asBytes(http.get(link.url)).expect(200);
  assert.ok(sent.body.equals(branded.body));

  // And the QR is drawn from the module matrix in black, whatever colour the
  // gym picked: a tinted QR is a QR that stops reading off a dim phone.
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const image = await loadImage(branded.body);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  const { data } = canvas.getContext('2d').getImageData(540, 700, 1, 1);
  const [r, g, b] = data;
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 12, `the QR is not tinted: got ${r},${g},${b}`);
});

test('a broken logo file does not take the card down with it', async t => {
  const { call, signIn, addMember, root, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('put', '/gym/settings/logo', owner)
    .attach('logo', await logoFile(), { filename: 'logo.png', contentType: 'image/png' }).expect(200);

  // The bytes go bad after the fact, the way a half-written file does. Every
  // member's card depends on this one file, so it must fall back rather than
  // fail (the same rule as a member's photograph, QA PHOTO-03).
  const [stored] = readdirSync(join(root, 'logo'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'logo', stored), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 9)]));

  const card = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.equal(card.body.readUInt32BE(16), 1080);

  // And if the row points at a file that is gone entirely, same answer.
  db.prepare('UPDATE gym_settings SET logo_stored_name=? WHERE id=1').run('00000000-0000-4000-a000-000000000000.png');
  await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  await call('get', '/gym/logo', null).expect(404);
});

test('the way to reach the gym is on the card: phone, and LINE when there is one', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const without = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);

  await call('put', '/gym/settings', owner, { line_id: '@suklutai' }).expect(200);
  const withLine = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.ok(!withLine.body.equals(without.body), 'the LINE id is printed on the card');

  // It is optional, like the phone number: a gym with neither still gets a card.
  const cleared = await call('put', '/gym/settings', owner, { line_id: '' }).expect(200);
  assert.equal(cleared.body.line_id, '');
  await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
});
