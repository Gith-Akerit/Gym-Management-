// The gym's own logo and colours.
//
// A gym that has paid for a sign wants the card its members carry to look like
// the sign. Everything here follows from two things: the owner picks one
// colour and the rest is arithmetic, and that arithmetic lives in ONE file --
// `shared/brand.cjs`, the Designer's -- which the browser previews with and the
// server draws with. Two copies of the formula would be two answers to "what
// colour is our green".
//
// The one thing that must not move is the token in the QR. A colour change is
// a change of clothes; a card already in somebody's phone still opens the door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { counterFixture, jpegBuffer, PHOTO_JPEG } from './counter.js';
import { seedConfiguration } from '../server/seed.js';
import {
  Brand, contrastRatio, logoNeedsPlate, luminance, MIN_CONTRAST,
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

/**
 * The Designer's own table, and then some.
 *
 * Fourteen colours including the four they called out as the hard ones: pure
 * white and pure black (nothing to darken or lighten), a mid red (#E53935 --
 * the case that forced `--brand-soft` to be worked out before `--brand-ink`),
 * and a bright yellow (where white text disappears).
 */
const FOURTEEN = [
  '#05603A', '#FFFFFF', '#000000', '#E53935', '#FFD400', '#C2185B', '#12306B',
  '#3E8E8E', '#AB5831', '#7A7A7A', '#8ED1FC', '#1B5E20', '#6A1B9A', '#00897B',
];

test('every one of the fourteen colours produces a readable set of tokens', () => {
  for (const picked of FOURTEEN) {
    const t = resolveTheme({ color_primary: picked });
    assert.equal(t.brand, picked, picked);
    // The four guarantees from the Designer's table, one colour at a time.
    assert.ok(contrastRatio(t.brand_surface, t.on_brand) >= MIN_CONTRAST,
      `${picked}: text on the button is ${contrastRatio(t.brand_surface, t.on_brand).toFixed(2)}:1`);
    assert.ok(contrastRatio(t.brand_ink, t.brand_soft) >= MIN_CONTRAST,
      `${picked}: brand text on the pale chip is ${contrastRatio(t.brand_ink, t.brand_soft).toFixed(2)}:1`);
    assert.ok(contrastRatio(t.brand_ink, '#FFFFFF') >= MIN_CONTRAST, `${picked}: brand text on white`);
    assert.ok(contrastRatio(t.brand_line, '#EFF2F4') >= 3,
      `${picked}: a control border must clear 3:1 (WCAG 1.4.11)`);
    assert.ok(contrastRatio(t.brand_2, t.on_brand_2) >= MIN_CONTRAST,
      `${picked}: text on the card's bottom bar is ${contrastRatio(t.brand_2, t.on_brand_2).toFixed(2)}:1`);
    // Eight tokens, all of them real colours.
    for (const key of ['brand', 'brand_surface', 'on_brand', 'brand_ink', 'brand_soft',
      'brand_line', 'brand_2', 'on_brand_2']) {
      assert.equal(normalizeHex(t[key]), t[key], `${picked}: ${key} is ${t[key]}`);
    }
  }
});

test('the numbers the screen shows are the numbers the server used', () => {
  // The settings screen prints these five as a table rather than a pass mark,
  // so they have to be the real measurements and not a rounded promise.
  const t = resolveTheme({ color_primary: '#FFD400' });
  assert.equal(t.ratios.onSurface, Number(contrastRatio(t.brand_surface, t.on_brand).toFixed(2)));
  assert.equal(t.ratios.inkOnSoft, Number(contrastRatio(t.brand_ink, t.brand_soft).toFixed(2)));
  assert.equal(t.ratios.lineOnCanvas, Number(contrastRatio(t.brand_line, '#EFF2F4').toFixed(2)));
});

test('the ink on a colour is whichever of black and white can be read on it', () => {
  for (const [colour, ink] of [['#05603A', '#FFFFFF'], ['#FFD400', '#0E1418'],
    ['#111111', '#FFFFFF'], ['#8ED1FC', '#0E1418']]) {
    assert.equal(readableInk(colour), ink, colour);
    assert.ok(contrastRatio(colour, ink) >= MIN_CONTRAST, `${colour} on ${ink}`);
  }
});

test('the raw colour is kept, and the painted one is only nudged as far as it must be', () => {
  // A mid grey cannot carry either ink, so the surface moves -- but the colour
  // the owner chose is still handed back untouched under `brand`, because the
  // settings screen has to show them what they picked.
  const grey = resolveTheme({ color_primary: '#7A7A7A' });
  assert.equal(grey.brand, '#7A7A7A');
  assert.notEqual(grey.brand_surface, grey.brand);
  assert.ok(grey.warning, 'the screen is told the surface moved');
  assert.match(grey.warning, /อ่านยาก/);
  assert.match(grey.warning, /#7A7A7A/, 'and which colour it was that moved');

  // A colour that is already readable is not touched at all.
  const green = resolveTheme({ color_primary: '#05603A' });
  assert.equal(green.brand_surface, green.brand);
  assert.equal(green.warning, null);
});

test('the second colour is the owner own when they name one, and a relative when they do not', () => {
  const auto = resolveTheme({ color_primary: '#05603A' });
  assert.ok(luminance(auto.brand_2) < luminance(auto.brand_surface), 'darker, so it reads as the same colour twice');
  const picked = resolveTheme({ color_primary: '#05603A', color_secondary: '#8B0000' });
  assert.equal(picked.brand_2, '#8B0000');
  assert.ok(contrastRatio(picked.brand_2, picked.on_brand_2) >= MIN_CONTRAST);
});

test('a colour that is not a colour never reaches the card', () => {
  for (const nonsense of ['red', '#12345', 'rgb(1,2,3)', '', null, undefined, `#${'f'.repeat(7)}`]) {
    assert.equal(normalizeHex(nonsense), null, String(nonsense));
  }
  assert.equal(normalizeHex('#abc'), '#AABBCC', 'three digits are a colour people type');
  assert.equal(normalizeHex('05603a'), '#05603A', 'and so is one without a hash');
  assert.equal(resolveTheme(null).brand, '#05603A');
  assert.equal(resolveTheme({ color_primary: 'nonsense' }).brand, '#05603A');
});

test('the browser and the server work the colour out with the same file', () => {
  // The screen previews with Brand.deriveAll directly; the server calls it
  // through resolveTheme. If these two ever disagree, the card a member gets
  // is not the card the owner approved.
  const direct = Brand.deriveAll('#C2185B', null);
  const throughTheServer = resolveTheme({ color_primary: '#C2185B' });
  assert.equal(direct.brandSurface, throughTheServer.brand_surface);
  assert.equal(direct.brandInk, throughTheServer.brand_ink);
  assert.equal(direct.brandSoft, throughTheServer.brand_soft);
  assert.equal(direct.brandLine, throughTheServer.brand_line);
  assert.equal(direct.brand2, throughTheServer.brand_2);
  assert.deepEqual(direct.ratios, throughTheServer.ratios);
});

// ----------------------------------------------------------------- the logo

test('the colours in a logo are offered back, most used first, with the way home last', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  await call('put', '/gym/settings/logo', owner)
    .attach('logo', await logoFile({ colour: '#C2185B' }), { filename: 'logo.png' }).expect(200);
  const { palette } = (await call('get', '/gym/settings', owner).expect(200)).body;

  for (const colour of palette) assert.equal(normalizeHex(colour), colour);
  // The circle covers more of the picture than the bar across it.
  assert.ok(contrastRatio(palette[0], '#C2185B') < 1.6, `expected the pink first, got ${palette.join(' ')}`);
  // The system green is always the last one offered: the way back when the
  // colours off the logo turn out not to be what the owner wanted.
  assert.equal(palette[palette.length - 1], '#05603A');
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
  assert.ok(trimmed.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  const small = await logoFile({ width: 200, height: 200 });
  assert.equal(await prepareLogo(small), small, 'already small is left exactly as it arrived');
  await assert.rejects(() => prepareLogo(jpegBuffer()), /เปิดไม่ได้/);
});

test('the white plate under the logo is earned, not automatic', () => {
  // The rule is one line and it decides how the card looks: a dark logo on a
  // dark band disappears, a pale one on the same band does not need help, and
  // a plate nobody needs is a box inside a box (Designer, logoNeedsPlate).
  assert.equal(logoNeedsPlate('#0A3D2A', '#05603A'), true, 'dark green logo on the green band');
  assert.equal(logoNeedsPlate('#FFFFFF', '#05603A'), false, 'a white logo reads on green');
  assert.equal(logoNeedsPlate('#3E8E8E', '#12306B'), false, 'teal on navy is the Designer\'s own example');
});

// ------------------------------------------------------------- the endpoints

test('the login screen can read the gym colours without signing in', async t => {
  const { call } = counterFixture(t);
  const theme = await call('get', '/public/theme', null).expect(200);
  assert.equal(theme.body.theme.brand, '#05603A');
  assert.equal(theme.body.theme.appbar, 'light', 'a white bar with a brand line is the default');
  assert.equal(theme.body.has_logo, false);
  assert.equal(theme.body.logo_url, null);
  assert.equal(JSON.stringify(theme.body).includes('@'), false, 'nothing private is in it');
});

test('the owner sets the colours, and staff can only look', async t => {
  const { call, signIn, db, at } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');

  const before = await call('get', '/gym/settings', staff).expect(200);
  assert.equal(before.body.theme.brand, '#05603A');
  assert.equal(before.body.color_secondary_source, 'auto');
  // Staff open this page to answer the phone, so the contact details are on
  // it -- read from gym_profile, where they are edited, not copied here.
  assert.ok('phone' in before.body && 'address' in before.body);
  seedConfiguration(db, at());
  const withPhone = await call('get', '/gym/settings', staff).expect(200);
  assert.equal(withPhone.body.phone, '038541029', 'read from gym_profile, not copied into gym_settings');
  assert.ok(withPhone.body.address);
  await call('put', '/gym/settings', staff, { color_primary: '#C2185B' }).expect(403);

  const saved = await call('put', '/gym/settings', owner,
    { color_primary: '#c2185b', brand_short: 'สฟ', line_id: '@suklutai', appbar_style: 'brand' }).expect(200);
  assert.equal(saved.body.theme.brand, '#C2185B', 'stored the same whichever case it was typed in');
  assert.equal(saved.body.theme.on_brand, '#FFFFFF');
  assert.equal(saved.body.theme.appbar, 'brand');
  assert.equal(saved.body.brand_short, 'สฟ');
  assert.equal(saved.body.line_id, '@suklutai');
  assert.equal(saved.body.version, 2);

  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='gym.settings'").get();
  assert.ok(entry);
  assert.equal(JSON.parse(entry.after_json).color_primary, '#C2185B');
  assert.equal(entry.actor_id, db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id);

  assert.equal((await call('get', '/public/theme', null).expect(200)).body.theme.brand, '#C2185B');
});

test('a colour that is not a colour is refused before it reaches a card', async t => {
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  for (const bad of ['blue', '#12345', 'drop table']) {
    const refused = await call('put', '/gym/settings', owner, { color_primary: bad }).expect(400);
    assert.match(refused.body.error, /สีหลักไม่ถูกต้อง/);
  }
  await call('put', '/gym/settings', owner, { color_primary: '#FFD400', color_secondary: '#123456' }).expect(200);
  const cleared = await call('put', '/gym/settings', owner, { color_secondary: '' }).expect(200);
  assert.equal(cleared.body.color_secondary_source, 'auto');
  assert.equal(cleared.body.theme.brand_2, Brand.deriveAll('#FFD400', null).brand2);
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
  assert.ok(saved.body.palette.length >= 2);
  assert.equal(normalizeHex(saved.body.logo_avg), saved.body.logo_avg, 'the average colour is kept for the plate rule');
  assert.equal(saved.body.logo_stored_name, undefined, 'the path on disk never leaves the server');

  const files = readdirSync(join(root, 'logo'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f-]{36}\.png$/, 'the server chose the name, not the browser');

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
  assert.equal(removed.body.logo_avg, null);
  assert.equal(readdirSync(join(root, 'logo')).length, 0);
  await call('get', '/gym/logo', null).expect(404);
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

  // A seven-day link hands over the card as it is now, not as it was.
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

test('the way to reach the gym is on the card: phone, and LINE when there is one', async t => {
  const { call, signIn, addMember } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  const without = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);

  await call('put', '/gym/settings', owner, { line_id: '@suklutai' }).expect(200);
  const withLine = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.ok(!withLine.body.equals(without.body), 'the LINE id is printed on the card');

  const cleared = await call('put', '/gym/settings', owner, { line_id: '' }).expect(200);
  assert.equal(cleared.body.line_id, '');
  await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
});

test('a broken logo file does not take the card down with it', async t => {
  const { call, signIn, addMember, root, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const member = await addMember(owner);
  await call('put', '/gym/settings/logo', owner)
    .attach('logo', await logoFile(), { filename: 'logo.png', contentType: 'image/png' }).expect(200);

  const [stored] = readdirSync(join(root, 'logo'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'logo', stored), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 9)]));

  const card = await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  assert.equal(card.body.readUInt32BE(16), 1080);

  db.prepare('UPDATE gym_settings SET logo_stored_name=? WHERE id=1').run('00000000-0000-4000-a000-000000000000.png');
  await asBytes(call('get', `/members/${member.id}/card.png`, owner)).expect(200);
  await call('get', '/gym/logo', null).expect(404);
});
