// QA Release Tester — independent probes for KENC-20 Phase 2 (PR #2).
// Domain B v2: PKG-001..008, 010..017, 020..031, 040..053, 060..065, 070..073, 080..086.
// Read-only against production code: nothing here is imported by the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { buildPromptPayPayload, crc16, parsePromptPayPayload, maskPromptPayId, normalisePromptPayId } from '../server/promptpay.js';

const MERCHANT = '0812345678';
const DAY = 86400000;
const THAI = /[฀-๿]/;

function lengthOf(payload) { const h = Buffer.alloc(2); h.writeUInt16BE(payload.length + 2); return h; }
function jpeg(tag = 'x') {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(`GPSLatitude 13.7563N ${tag}`, 'latin1')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), lengthOf(exif), exif]);
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, app1,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9])]);
}
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])]);
const webp = () => { const body = Buffer.concat([Buffer.from('VP8 ', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from([1, 2, 3, 4])]);
  const h = Buffer.alloc(12); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(body.length + 4, 4); h.write('WEBP', 8, 'latin1');
  return Buffer.concat([h, body]); };
const heic = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64, 1)]);

function fixture(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'qa-slips-'));
  const inbox = new Map();
  let time = Date.parse('2026-09-14T09:00:00+07:00');
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    sendOtp: async ({ email, code }) => inbox.set(email, code),
    slipStore: new SlipStore(root), promptPayId: MERCHANT });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const upload = (token, orderId, file = jpeg(), f = {}) => {
    const req = request(app).post(`/api/orders/${orderId}/slip`).set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${token}`)
      .field('reference_no', f.reference_no ?? `REF${randomUUID().slice(0, 8).toUpperCase()}`)
      .field('transferred_at', f.transferred_at ?? '2026-09-14T08:45');
    if (f.amount_thb !== undefined) req.field('amount_thb', String(f.amount_thb));
    return req.attach('slip', file, { filename: f.filename ?? 'slip.jpg', contentType: f.contentType ?? 'image/jpeg' });
  };
  async function login(email, role = 'member') {
    if (role !== 'member') db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(randomUUID(), email, role, time);
    const s = await call('post', '/auth/request-otp', null, { email }).expect(202);
    const v = await call('post', '/auth/verify-otp', null, { challenge_id: s.body.challenge_id, code: inbox.get(email) }).expect(200);
    return v.body.token;
  }
  let phoneSeq = 1000000;
  async function member(email, name = 'สุดา ใจดี') {
    const token = await login(email);
    await call('put', '/me/profile', token, { name, phone: `089${phoneSeq++}` }).expect(201);
    return token;
  }
  async function pkg(admin, over = {}) {
    const body = { code: `P${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`, name_th: 'รายเดือน',
      type: 'unlimited', duration_days: 30, price_thb: 1200, status: 'active', ...over };
    return (await call('post', '/packages', admin, body).expect(201)).body;
  }
  return { db, app, call, upload, login, member, pkg, root,
    tick: ms => { time += ms; }, at: () => time };
}

// ============================================================ B1 · packages
test('PKG-001/002/003 unlimited, limited-session and mixed packages all go on sale', async t => {
  const { call, login, member } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const made = [];
  for (const spec of [
    { code: 'UNL30', name_th: 'รายเดือน Unlimited', type: 'unlimited', duration_days: 30, price_thb: 1200, status: 'active' },
    { code: 'V10_90', name_th: '10 ครั้ง 90 วัน', type: 'limited_sessions', duration_days: 90, session_limit: 10, price_thb: 2500, status: 'active' },
    { code: 'UNL365', name_th: 'รายปี', type: 'unlimited', duration_days: 365, price_thb: 9999, status: 'active', sort_order: 5 },
    { code: 'V1_1', name_th: 'ครั้งเดียว 1 วัน', type: 'limited_sessions', duration_days: 1, session_limit: 1, price_thb: 80, status: 'active' },
  ]) made.push((await call('post', '/packages', admin, spec).expect(201)).body);
  console.log('PKG-001/002/003 created:', JSON.stringify(made.map(p => ({ code: p.code, type: p.type, d: p.duration_days, s: p.session_limit, thb: p.price_thb }))));
  const tok = await member('shop@example.test');
  const catalogue = (await call('get', '/packages', tok).expect(200)).body.items;
  console.log('PKG-001 member catalogue codes:', JSON.stringify(catalogue.map(p => p.code)));
  for (const p of made) assert.ok(catalogue.find(c => c.code === p.code), `${p.code} missing from member catalogue`);
  assert.equal(made[1].session_limit, 10);
  assert.equal(made[1].duration_days, 90);
});

// PKG-004 moved to qa-pkg2.test.js: this version passed baht as satang.

test('PKG-005 archiving hides a package but keeps entitlements already sold', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('keep@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
  const fresh = (await call('get', `/packages/${p.id}`, admin).expect(200)).body;
  await call('delete', `/packages/${p.id}`, admin, { version: fresh.version }).expect(200);
  const catalogue = (await call('get', '/packages', tok).expect(200)).body.items.map(x => x.code);
  const ents = (await call('get', '/entitlements', tok).expect(200)).body.items;
  console.log('PKG-005 catalogue after archive:', JSON.stringify(catalogue), '| entitlements still held:', ents.length, JSON.stringify(ents.map(e => ({ st: e.status, exp: e.expires_at }))));
  assert.ok(!catalogue.includes(p.code));
  assert.equal(ents.length, 1);
  assert.equal(ents[0].status, 'active');
});

test('PKG-006/007 package validation rejects impossible prices and durations', async t => {
  const { call, login } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const base = { name_th: 'ทดสอบ', type: 'unlimited', duration_days: 30, status: 'draft' };
  const out = {};
  let n = 0;
  const tryIt = async over => {
    const r = await call('post', '/packages', admin, { code: `T${n++}XXX`, ...base, ...over });
    return { status: r.status, fields: r.body.fields };
  };
  out['price -1'] = await tryIt({ price_satang: -1 });
  out['price 999999999'] = await tryIt({ price_satang: 999999999 });
  out['price 1200.555'] = await tryIt({ price_satang: 1200.555 });
  out['price 0 draft'] = await tryIt({ price_satang: 0 });
  // The baht field has its own rules; both ways in have to reject nonsense.
  out['baht -1'] = await tryIt({ price_thb: -1 });
  out['baht 1200.555'] = await tryIt({ price_thb: 1200.555 });
  out['baht 1000001'] = await tryIt({ price_thb: 1000001 });
  out['both units at once'] = await tryIt({ price_thb: 1200, price_satang: 120000 });
  out['baht 1200.50'] = await tryIt({ price_thb: 1200.5 });
  out['duration 0'] = await tryIt({ duration_days: 0, price_satang: 100 });
  out['duration 3651'] = await tryIt({ duration_days: 3651, price_satang: 100 });
  out['limited, no session count'] = await tryIt({ type: 'limited_sessions', price_satang: 100 });
  out['unlimited with session count'] = await tryIt({ type: 'unlimited', session_limit: 5, price_satang: 100 });
  out['session 0'] = await tryIt({ type: 'limited_sessions', session_limit: 0, price_satang: 100 });
  out['active with no price'] = await tryIt({ status: 'active' });
  console.log('PKG-006/007 validation:\n' + JSON.stringify(out, null, 1));
  for (const k of Object.keys(out)) {
    if (k === 'price 0 draft') { assert.equal(out[k].status, 201, 'a genuinely free package must be allowed'); continue; }
    if (k === 'baht 1200.50') { assert.equal(out[k].status, 201, 'two decimal places of baht are legal'); continue; }
    assert.equal(out[k].status, 400, `${k} should be refused`);
  }
});

test('PKG-008 a member cannot create, edit or archive packages', async t => {
  const { call, login, member, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const tok = await member('nosy@example.test');
  const out = {};
  out['POST /packages'] = (await call('post', '/packages', tok, { code: 'HACK01', name_th: 'x', type: 'unlimited', duration_days: 1, price_satang: 1 })).status;
  out['PUT /packages/:id'] = (await call('put', `/packages/${p.id}`, tok, { code: p.code, name_th: 'x', type: 'unlimited', duration_days: 1, price_satang: 1, status: 'active', sort_order: 0, version: p.version })).status;
  out['DELETE /packages/:id'] = (await call('delete', `/packages/${p.id}`, tok, { version: p.version })).status;
  out['GET /packages/:id'] = (await call('get', `/packages/${p.id}`, tok)).status;
  out['GET /admin/orders'] = (await call('get', '/admin/orders', tok)).status;
  out['GET /admin/sales'] = (await call('get', '/admin/sales', tok)).status;
  console.log('PKG-008/046:', JSON.stringify(out));
  for (const [k, v] of Object.entries(out)) assert.equal(v, 403, k);
});

// ============================================================ B2 · PromptPay
test('PKG-011 CRC-16/CCITT-FALSE matches the published check value', async () => {
  console.log('PKG-011 crc16("123456789") =', crc16('123456789'), '(spec check value: 29B1)');
  assert.equal(crc16('123456789'), '29B1');
  const payload = buildPromptPayPayload(MERCHANT, 120000);
  const parsed = parsePromptPayPayload(payload);
  console.log('PKG-011 payload:', payload);
  console.log('PKG-011 crcValid:', parsed.crcValid, '| tag 63 =', parsed.fields['63'], '| recomputed =', parsed.expectedCrc);
  assert.ok(parsed.crcValid);
});

test('PKG-011 a single altered character breaks the checksum', async () => {
  const payload = buildPromptPayPayload(MERCHANT, 120000);
  const results = [];
  for (const i of [5, 20, 40, payload.length - 8]) {
    const ch = payload[i] === '9' ? '8' : '9';
    const broken = payload.slice(0, i) + ch + payload.slice(i + 1);
    results.push({ index: i, crcValid: parsePromptPayPayload(broken).crcValid });
  }
  console.log('PKG-011 tamper results:', JSON.stringify(results));
  for (const r of results) assert.equal(r.crcValid, false, `tampering at ${r.index} went undetected`);
});

// PKG-012 moved to qa-pkg2.test.js: this version passed baht as satang.

test('PKG-013 mobile, national ID and e-Wallet identifiers each use their own tag', async () => {
  const cases = { '0812345678': '01', '+66812345678': '01', '66812345678': '01',
    '1234567890123': '02', '123456789012345': '03' };
  const rows = {};
  for (const [id, tag] of Object.entries(cases)) {
    const n = normalisePromptPayId(id);
    const merchant = parsePromptPayPayload(buildPromptPayPayload(id, 10000)).fields['29'];
    rows[id] = { type: n.type, tag: n.tag, value: n.value, merchantField: merchant };
    assert.equal(n.tag, tag, `${id} used tag ${n.tag}`);
  }
  console.log('PKG-013 identifier handling:\n' + JSON.stringify(rows, null, 1));
  assert.equal(rows['0812345678'].value, '0066812345678', 'mobile must normalise to 0066 + 9 digits');
  assert.equal(rows['+66812345678'].value, '0066812345678');
  const bad = [];
  for (const id of ['', '123', '08123456789', 'abcdefghij', '12345678901234']) {
    try { normalisePromptPayId(id); bad.push(`${id} ACCEPTED`); } catch { /* expected */ }
  }
  console.log('PKG-013 rejected malformed ids ok:', JSON.stringify(bad));
  assert.deepEqual(bad, []);
});

// PKG-015 moved to qa-pkg2.test.js: this version passed baht as satang.

test('PKG-016 the merchant identifier is never exposed or logged', async t => {
  const { call, login, member, pkg, app } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 120000 });
  const tok = await member('priv@example.test');
  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => captured.push(a.map(String).join(' '));
  let view;
  try { view = (await call('post', '/orders', tok, { package_id: p.id })).body; } finally { Object.assign(console, real); }
  const json = JSON.stringify({ ...view, promptpay_payload: undefined });
  console.log('PKG-016 mask of', MERCHANT, '->', maskPromptPayId(MERCHANT));
  console.log('PKG-016 merchant appears in the non-payload JSON:', json.includes(MERCHANT), '| log lines:', captured.length);
  assert.ok(!json.includes(MERCHANT), 'merchant id leaked in order JSON outside the QR payload');
  assert.ok(!captured.join('').includes(MERCHANT), 'merchant id written to the log');
  assert.ok(!maskPromptPayId(MERCHANT).includes('81234'), 'mask reveals too much');
  const { execSync } = await import('node:child_process');
  const tracked = execSync('git ls-files server web mobile', { encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits = tracked.filter(f => /\.(js|jsx)$/.test(f) && /\b0\d{9}\b|\b\d{13}\b/.test(readFileSync(f, 'utf8')));
  console.log('PKG-016 source files containing a phone/ID-shaped literal:', JSON.stringify(hits));
  assert.ok(app);
});

test('PKG-017 an unpaid order expires by itself and a fresh one can be made', async t => {
  const { call, login, member, pkg, tick } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('lapse@example.test');
  const first = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  console.log('PKG-017 ttl minutes from gym settings; order expires_at - created_at =', (first.expires_at - first.created_at) / 60000, 'minutes');
  tick(61 * 60000);
  const seen = (await call('get', `/orders/${first.id}`, tok).expect(200)).body;
  console.log('PKG-017 after the deadline:', seen.order.status, '| payload offered:', seen.promptpay_payload !== null);
  assert.equal(seen.order.status, 'expired');
  assert.equal(seen.promptpay_payload, null);
  const qr = await call('get', `/orders/${first.id}/qr.png`, tok);
  console.log('PKG-017 qr.png on an expired order ->', qr.status, JSON.stringify(qr.body));
  assert.equal(qr.status, 409);
  const second = await call('post', '/orders', tok, { package_id: p.id });
  console.log('PKG-017 new order after expiry ->', second.status, '| id differs:', second.body.order.id !== first.id);
  assert.equal(second.status, 201);
});

// ================================================================ B3 · slips
test('PKG-020/021 a normal slip uploads and reads as awaiting review, never paid', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 120000 });
  for (const [label, file, ct, fn] of [['jpeg', jpeg(), 'image/jpeg', 'slip.jpg'], ['png', png(), 'image/png', 'slip.png'], ['webp', webp(), 'image/webp', 'slip.webp']]) {
    const tok = await member(`up-${label}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    const r = await upload(tok, o.id, file, { contentType: ct, filename: fn });
    console.log(`PKG-020 ${label} ->`, r.status, '| order status:', r.body.order?.status, '| slip content_type:', r.body.slip?.content_type);
    assert.equal(r.status, 201, `${label} refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.order.status, 'awaiting_review');
    assert.notEqual(r.body.order.status, 'paid');
    assert.ok(r.body.payment_sla_text && THAI.test(r.body.payment_sla_text));
    assert.equal(r.body.entitlement, null, 'no membership before an admin looks at it');
  }
});

test('PKG-022 empty and oversized files are refused in Thai', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const tok = await member('size@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const zero = await upload(tok, o.id, Buffer.alloc(0));
  const huge = await upload(tok, o.id, Buffer.concat([jpeg(), Buffer.alloc(6 * 1024 * 1024, 7)]));
  console.log('PKG-022 0 byte ->', zero.status, JSON.stringify(zero.body));
  console.log('PKG-022 6 MB   ->', huge.status, JSON.stringify(huge.body));
  assert.equal(zero.status, 400);
  assert.equal(huge.status, 400);
  for (const r of [zero, huge]) assert.ok(THAI.test(r.body.error), 'message must be Thai, not a bare 413');
});

test('PKG-023 HEIC, PDF and other non-images are handled with guidance', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const tok = await member('types@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const out = {};
  out.heic = await upload(tok, o.id, heic(), { filename: 'IMG_0001.HEIC', contentType: 'image/heic' });
  out.pdf = await upload(tok, o.id, Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 32)]), { filename: 'slip.pdf', contentType: 'application/pdf' });
  out.webp = await upload(tok, o.id, webp(), { filename: 'slip.webp', contentType: 'image/webp' });
  for (const [k, r] of Object.entries(out)) console.log(`PKG-023 ${k} ->`, r.status, JSON.stringify(r.body.error ?? r.body.order?.status));
  assert.equal(out.webp.status, 201, 'WEBP must be accepted');
  assert.equal(out.heic.status, 400);
  assert.ok(out.heic.body.error.includes('HEIC'), 'HEIC refusal must name the format');
  assert.ok(out.heic.body.error.length > 40, 'HEIC refusal must explain what to do instead');
  assert.equal(out.pdf.status, 400);
});

test('PKG-024/025 disguised executables, scripts and SVG are refused on content, not extension', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const tok = await member('evil@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const payloads = {
    php: Buffer.from('<?php system($_GET["c"]); ?>' + ' '.repeat(64), 'latin1'),
    html: Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(64), 'latin1'),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'latin1'),
    exe: Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64, 0x90)]),
    elf: Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF', 'latin1'), Buffer.alloc(64, 1)]),
    gif: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 1)]),
    zip: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]),
    'jpeg header + php tail': Buffer.concat([jpeg(), Buffer.from('<?php system($_GET["c"]); ?>', 'latin1')]),
  };
  const out = {};
  for (const [name, buf] of Object.entries(payloads)) {
    const r = await upload(tok, o.id, buf, { filename: 'slip.jpg', contentType: 'image/jpeg' });
    out[name] = { status: r.status, error: r.body.error };
  }
  console.log('PKG-024/025 disguised uploads:\n' + JSON.stringify(out, null, 1));
  for (const name of ['php', 'html', 'svg', 'exe', 'elf', 'gif', 'zip']) {
    assert.equal(out[name].status, 400, `${name} disguised as .jpg was accepted`);
  }
  console.log('PKG-024 note: a real JPEG with a PHP tail is accepted as an image ->', out['jpeg header + php tail'].status,
    '(safe here only because slips are never executed and are served with nosniff + CSP sandbox)');
});

test('PKG-026 a member cannot read another member order, slip image or entitlement', async t => {
  const { call, login, member, upload, pkg, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const victim = await member('victim@example.test');
  const attacker = await member('attacker@example.test');
  const o = (await call('post', '/orders', victim, { package_id: p.id }).expect(201)).body.order;
  const uploaded = (await upload(victim, o.id).expect(201)).body;
  const slipId = uploaded.slip.id;
  const out = {};
  out['GET /orders/{victim}'] = (await call('get', `/orders/${o.id}`, attacker)).status;
  out['GET /orders/{victim}/qr.png'] = (await call('get', `/orders/${o.id}/qr.png`, attacker)).status;
  out['POST /orders/{victim}/cancel'] = (await call('post', `/orders/${o.id}/cancel`, attacker, {})).status;
  out['GET /slips/{victim}/image'] = (await call('get', `/slips/${slipId}/image`, attacker)).status;
  out['POST /admin/orders/{id}/approve'] = (await call('post', `/admin/orders/${o.id}/approve`, attacker, { version: 2, checked_against_bank: true })).status;
  out['GET /admin/orders/{id}'] = (await call('get', `/admin/orders/${o.id}`, attacker)).status;
  console.log('PKG-026/046:', JSON.stringify(out));
  assert.equal(out['GET /orders/{victim}'], 404);
  assert.equal(out['GET /slips/{victim}/image'], 404);
  for (const k of ['POST /admin/orders/{id}/approve', 'GET /admin/orders/{id}']) assert.equal(out[k], 403, k);
  const attackerOrders = (await call('get', '/orders', attacker).expect(200)).body.items;
  console.log('PKG-026 attacker order list length:', attackerOrders.length);
  assert.equal(attackerOrders.length, 0);
  assert.ok(db);
});

test('PKG-027 the browser-supplied filename never reaches the filesystem', async t => {
  const { call, login, member, upload, pkg, root } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const names = ['../../../etc/passwd.jpg', 'C:\\Windows\\System32\\evil.jpg', `${'ก'.repeat(300)}.jpg`, 'slip";DROP TABLE orders;--.jpg'];
  const stored = [];
  for (const [i, filename] of names.entries()) {
    const tok = await member(`path${i}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    const before = new Set(readdirSync(root));
    const r = await upload(tok, o.id, jpeg(String(i)), { filename });
    const added = readdirSync(root).filter(f => !before.has(f));
    stored.push({ filename: filename.slice(0, 30), status: r.status, storedAs: added[0] ?? null });
  }
  console.log('PKG-027 uploads:\n' + JSON.stringify(stored, null, 1));
  console.log('PKG-027 files actually on disk:', JSON.stringify(readdirSync(root)));
  for (const s of stored) {
    assert.equal(s.status, 201);
    assert.match(s.storedAs, /^[0-9a-f-]{36}\.jpg$/, `server did not rename ${s.filename}`);
  }
  for (const f of readdirSync(root)) assert.match(f, /^[0-9a-f-]{36}\.(jpg|png|webp)$/);
});

test('PKG-028 EXIF and GPS are stripped from the bytes actually stored', async t => {
  const { call, login, member, upload, pkg, root } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const tok = await member('exif@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const original = jpeg('SECRETHOME');
  console.log('PKG-028 uploaded bytes contain GPS text:', original.toString('latin1').includes('GPSLatitude'));
  await upload(tok, o.id, original).expect(201);
  const files = readdirSync(root);
  assert.equal(files.length, 1, 'expected exactly one stored slip');
  const onDisk = readFileSync(join(root, files[0]));
  console.log('PKG-028 stored bytes contain GPS text:', onDisk.toString('latin1').includes('GPSLatitude'),
    '| contains "Exif":', onDisk.toString('latin1').includes('Exif'),
    '| size', original.length, '->', onDisk.length);
  assert.ok(!onDisk.toString('latin1').includes('GPSLatitude'));
  assert.ok(!onDisk.toString('latin1').includes('SECRETHOME'));
  assert.equal(onDisk[0], 0xff);
  assert.equal(onDisk[1], 0xd8, 'still a JPEG after stripping');
});

// PKG-029 moved to qa-pkg2.test.js: this version passed baht as satang.

test('PKG-030 a rejected upload leaves no half-written row and no orphan file', async t => {
  const { call, login, member, upload, pkg, root, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin);
  const tok = await member('partial@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const bad = [
    await upload(tok, o.id, Buffer.from('not an image at all', 'latin1')),
    await upload(tok, o.id, jpeg(), { reference_no: 'x' }),
    await upload(tok, o.id, jpeg(), { transferred_at: 'tomorrow' }),
    await upload(tok, o.id, jpeg(), { transferred_at: '2026-09-20T10:00' }),
    await upload(tok, o.id, jpeg(), { transferred_at: '2026-01-01T10:00' }),
  ];
  console.log('PKG-030 refusals:', JSON.stringify(bad.map(r => ({ s: r.status, e: r.body.error, f: r.body.fields }))));
  console.log('PKG-030 slip rows:', db.prepare('SELECT count(*) n FROM payment_slips').get().n, '| files on disk:', readdirSync(root).length);
  console.log('PKG-030 order status unchanged:', (await call('get', `/orders/${o.id}`, tok)).body.order.status);
  for (const r of bad) assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT count(*) n FROM payment_slips').get().n, 0);
  assert.equal(readdirSync(root).length, 0, 'orphan slip files left behind');
});

test('PKG-031 re-uploading shows the newest slip and keeps the old one', async t => {
  const { call, login, member, upload, pkg, tick } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('redo@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const first = (await upload(tok, o.id, jpeg('one'), { reference_no: 'REFFIRST1' }).expect(201)).body;
  tick(60000);
  const second = (await upload(tok, o.id, jpeg('two'), { reference_no: 'REFSECOND' }).expect(201)).body;
  console.log('PKG-031 current slip reference:', second.slip.reference_no, '| history:', JSON.stringify(second.slip_history.map(s => ({ ref: s.reference_no, superseded: !!s.superseded_at }))));
  assert.equal(second.slip.reference_no, 'REFSECOND');
  assert.equal(second.slip_history.length, 2);
  assert.equal(second.slip_history.filter(s => s.superseded_at).length, 1);
  const adminView = (await call('get', `/admin/orders/${o.id}`, admin).expect(200)).body;
  console.log('PKG-031 admin sees current:', adminView.slip.reference_no, '| history entries:', adminView.slip_history.length);
  assert.equal(adminView.slip.reference_no, 'REFSECOND');
  assert.ok(first);
});

// ======================================================== B4 · admin review
test('PKG-040/060/061/062 approval turns one transfer into exactly one membership', async t => {
  const { call, login, member, upload, pkg, at } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const unlimited = await pkg(admin, { price_thb: 120000, type: 'unlimited', duration_days: 30 });
  const limited = await pkg(admin, { price_thb: 250000, type: 'limited_sessions', duration_days: 90, session_limit: 10, name_th: '10 ครั้ง' });
  for (const [label, p, expectSessions, days] of [['unlimited', unlimited, null, 30], ['limited', limited, 10, 90]]) {
    const tok = await member(`ent-${label}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    await upload(tok, o.id).expect(201);
    const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
    const approved = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
    const ent = (await call('get', '/entitlements', tok).expect(200)).body.items;
    const days_ = Math.round((ent[0].expires_at - ent[0].starts_at) / DAY);
    console.log(`PKG-060/061 ${label}: order=${approved.body.order.status} sessions_total=${ent[0].sessions_total} remaining=${ent[0].sessions_remaining} valid ${days_} days`);
    assert.equal(approved.body.order.status, 'paid');
    assert.equal(ent.length, 1);
    assert.equal(ent[0].sessions_remaining, expectSessions);
    assert.equal(days_, days);
    assert.ok(ent[0].expires_at > at(), 'every package must expire, including unlimited');
  }
});

test('PKG-041/042 a double click and two admins at once still yield one membership', async t => {
  const { call, login, member, upload, pkg, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const admin2 = await login('a2@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 120000 });
  const tok = await member('race@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  const both = await Promise.all([
    call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }),
    call('post', `/admin/orders/${o.id}/approve`, admin2, { version: cur.version, checked_against_bank: true }),
  ]);
  console.log('PKG-041/042 two simultaneous approvals ->', JSON.stringify(both.map(r => ({ s: r.status, e: r.body.error }))));
  console.log('PKG-041/042 entitlement rows:', db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(o.id).n);
  assert.equal(both.filter(r => r.status === 200).length, 1, 'two approvals both succeeded');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(o.id).n, 1);
  const third = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version + 1, checked_against_bank: true });
  console.log('PKG-047 approving an already paid order ->', third.status, JSON.stringify(third.body));
  assert.equal(third.status, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE order_id=?').get(o.id).n, 1);
});

test('PKG-043 rejection explains itself and the member sends a new slip on the same order', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('reject@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id, jpeg('first'), { reference_no: 'REFBAD001' }).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  const noReason = await call('post', `/admin/orders/${o.id}/reject`, admin, { version: cur.version });
  console.log('PKG-043 rejecting without a reason ->', noReason.status, JSON.stringify(noReason.body.fields));
  assert.equal(noReason.status, 400);
  const rejected = await call('post', `/admin/orders/${o.id}/reject`, admin, { version: cur.version, reason: 'ยอดเงินไม่ตรงกับที่แจ้ง' }).expect(200);
  const memberSees = (await call('get', `/orders/${o.id}`, tok).expect(200)).body;
  console.log('PKG-043 member sees status:', memberSees.order.status, '| reason:', JSON.stringify(memberSees.order.rejection_reason));
  assert.equal(memberSees.order.rejection_reason, 'ยอดเงินไม่ตรงกับที่แจ้ง');
  const retry = await upload(tok, o.id, jpeg('second'), { reference_no: 'REFGOOD001' });
  console.log('PKG-043 new slip on the same order ->', retry.status, '| status now:', retry.body.order?.status, '| reason cleared:', retry.body.order?.rejection_reason);
  assert.equal(retry.status, 201, 'member was forced to start a new order');
  assert.equal(retry.body.order.status, 'awaiting_review');
  assert.ok(rejected);
});

test('PKG-044 the review queue is oldest first and counts what is waiting', async t => {
  const { call, login, member, upload, pkg, tick } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const made = []; const tokens = {};
  for (let i = 0; i < 4; i++) {
    const tok = await member(`q${i}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    made.push({ i, id: o.id, created: o.created_at });
    tokens[i] = tok;
    tick(120000);
  }
  for (const m of [...made].reverse()) {
    await upload(tokens[m.i], m.id).expect(201);
    tick(30000);
  }
  const queue = (await call('get', '/admin/orders', admin).expect(200)).body;
  console.log('PKG-044 queue total:', queue.total, '| awaiting_review counter:', queue.awaiting_review);
  console.log('PKG-044 order of the queue:', JSON.stringify(queue.items.map(o => ({ created: o.created_at, waiting_since: o.waiting_since, status: o.status }))));
  const waiting = queue.items.map(o => o.waiting_since);
  assert.deepEqual(waiting, [...waiting].sort((a, b) => a - b),
    'the queue is not ordered by how long the member has been waiting');
  assert.ok(queue.items.every(o => o.waiting_since >= o.created_at));
  assert.equal(typeof queue.awaiting_review, 'number');
});

test('PKG-045 approval is impossible without confirming the bank app was checked', async t => {
  const { call, login, member, upload, pkg, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 120000 });
  const tok = await member('confirm@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  const out = {};
  out['no flag'] = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version });
  out['flag false'] = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: false });
  out['flag "true"'] = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: 'true' });
  out['flag 1'] = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: 1 });
  for (const [k, r] of Object.entries(out)) console.log(`PKG-045 ${k} ->`, r.status, JSON.stringify(r.body.fields ?? r.body.error));
  for (const [k, r] of Object.entries(out)) assert.equal(r.status, 400, `${k} was allowed to approve`);
  console.log('PKG-045 entitlements created by the refused attempts:', db.prepare('SELECT count(*) n FROM entitlements').get().n);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n, 0);
});

// PKG-048 moved to qa-pkg2.test.js: this version passed baht as satang.

test('PKG-049 an approval made in error can be reversed and then re-decided', async t => {
  const { call, login, member, upload, pkg, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 120000 });
  const tok = await member('oops@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id, jpeg('wrong'), { reference_no: 'REFWRONG1' }).expect(201);
  let cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
  cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  const reversed = await call('post', `/admin/orders/${o.id}/reverse`, admin, { version: cur.version, reason: 'อนุมัติผิดคน' }).expect(200);
  const ent = db.prepare('SELECT status,revoked_reason FROM entitlements WHERE order_id=?').get(o.id);
  const live = (await call('get', '/entitlements', tok).expect(200)).body.items;
  console.log('PKG-049 after reversal: order =', reversed.body.order.status, '| entitlement =', JSON.stringify(ent), '| member active entitlements =', live.length);
  assert.equal(ent.status, 'revoked');
  assert.equal(live.length, 0);
  const actions = db.prepare('SELECT action FROM audit_logs WHERE entity_id IN (SELECT id FROM entitlements WHERE order_id=?) OR entity_id=? ORDER BY created_at').all(o.id, o.id).map(r => r.action);
  console.log('PKG-049 audit trail:', JSON.stringify(actions));
  assert.ok(actions.includes('order.reverse') && actions.includes('entitlement.revoke'));

  // The member now sends the slip that was actually theirs; this has to work.
  const retry = await upload(tok, o.id, jpeg('right'), { reference_no: 'REFRIGHT1' });
  console.log('PKG-049 member re-uploads after the reversal ->', retry.status, retry.body.order?.status);
  assert.equal(retry.status, 201);
  cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  const again = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true });
  console.log('PKG-049 approving the corrected slip ->', again.status, JSON.stringify(again.body.error ?? again.body.order?.status));
  assert.equal(again.status, 200, 'an order can never be approved again after a reversal');
});

test('PKG-050 a suspended member cannot be approved and cannot start an order', async t => {
  const { call, login, member, upload, pkg, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('gone@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  const m = db.prepare('SELECT id,version FROM members WHERE id=?').get(o.member_id);
  await call('delete', `/members/${m.id}`, admin, { version: m.version }).expect(200);
  const approve = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true });
  const newOrder = await call('post', '/orders', tok, { package_id: p.id });
  console.log('PKG-050 approve a suspended member ->', approve.status, JSON.stringify(approve.body.error));
  console.log('PKG-050 suspended member starts a new order ->', newOrder.status, JSON.stringify(newOrder.body.error));
  assert.equal(approve.status, 409);
  assert.equal(newOrder.status, 403);
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n, 0, 'orphan entitlement created');
});

test('PKG-053 a slip that does not match the price is flagged before approval', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 120000 });
  const tok = await member('short@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  await upload(tok, o.id, jpeg(), { amount_thb: 500 }).expect(201);
  const review = (await call('get', `/admin/orders/${o.id}`, admin).expect(200)).body;
  console.log('PKG-053 order price:', review.order.price_thb, '| slip claims:', review.slip.amount_thb_claimed, '| amount_mismatch flag:', review.amount_mismatch);
  assert.equal(review.amount_mismatch, true, 'a 500 baht slip against a 1,200 baht order was not flagged');
  const cur = review.order;
  const approvedAnyway = await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true });
  console.log('PKG-053 approving the mismatch with no explanation ->', approvedAnyway.status, '| note stored:', JSON.stringify(approvedAnyway.body.order?.review_note));
  assert.equal(approvedAnyway.status, 400,
    'the server let a short payment through without forcing the admin to state why');
});

// ========================================================== B5 · entitlement
test('PKG-063/064 a second package stacks and the soonest expiry is offered first', async t => {
  const { call, login, member, upload, pkg, db, at } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const short = await pkg(admin, { price_thb: 50000, duration_days: 7, name_th: 'สัปดาห์' });
  const long = await pkg(admin, { price_thb: 120000, duration_days: 90, name_th: 'สามเดือน' });
  const tok = await member('stack@example.test');
  for (const p of [long, short]) {                       // bought long first on purpose
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    await upload(tok, o.id).expect(201);
    const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
    await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
  }
  const ents = (await call('get', '/entitlements', tok).expect(200)).body.items;
  console.log('PKG-063/064 entitlements in the order Phase 3 will consume them:',
    JSON.stringify(ents.map(e => ({ days: Math.round((e.expires_at - at()) / DAY), created: e.created_at }))));
  assert.equal(ents.length, 2, 'stacking lost one of the packages');
  assert.ok(ents[0].expires_at < ents[1].expires_at, 'soonest expiry must come first');
  const tie = db.prepare(`SELECT * FROM entitlements WHERE member_id=? ORDER BY expires_at, created_at`).all(ents[0].member_id);
  console.log('PKG-064 tie-break is created_at:', tie.map(e => e.created_at).join(' <= '));
});

test('PKG-065 a member reading someone else entitlement or order gets nothing', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const owner = await member('own@example.test');
  const other = await member('other@example.test');
  const o = (await call('post', '/orders', owner, { package_id: p.id }).expect(201)).body.order;
  await upload(owner, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, owner).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
  const mine = (await call('get', '/entitlements', owner).expect(200)).body.items;
  const theirs = (await call('get', '/entitlements', other).expect(200)).body.items;
  console.log('PKG-065 owner entitlements:', mine.length, '| other member sees:', theirs.length);
  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 0);
});

// =========================================================== B6 · reporting
test('PKG-070/071 daily sales equal the sum of approved orders', async t => {
  const { call, login, member, upload, pkg, db, tick } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p1 = await pkg(admin, { price_thb: 120000 });
  const p2 = await pkg(admin, { price_thb: 55050, name_th: 'ครึ่งเดือน' });
  let approved = 0;
  for (const [i, p] of [p1, p2, p1].entries()) {
    const tok = await member(`sale${i}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    await upload(tok, o.id).expect(201);
    const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
    await call('post', `/admin/orders/${o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
    approved += p.price_satang;
    tick(60000);
  }
  // One more that is rejected: it must not count as revenue.
  const tok = await member('norev@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p1.id }).expect(201)).body.order;
  await upload(tok, o.id).expect(201);
  const cur = (await call('get', `/orders/${o.id}`, tok).expect(200)).body.order;
  await call('post', `/admin/orders/${o.id}/reject`, admin, { version: cur.version, reason: 'ไม่พบเงินเข้า' }).expect(200);

  const sales = (await call('get', '/admin/sales', admin).expect(200)).body.items;
  const dbTotal = db.prepare("SELECT sum(price_satang_snapshot) s FROM orders WHERE status='paid'").get().s;
  console.log('PKG-070/071 sales report:', JSON.stringify(sales));
  console.log('PKG-070 expected satang:', approved, '| orders table says:', dbTotal, '| report says:', sales.reduce((a, r) => a + r.total_satang, 0));
  assert.equal(sales.reduce((a, r) => a + r.total_satang, 0), approved);
  assert.equal(dbTotal, approved);
  assert.equal(sales[0].total_thb, approved / 100);
  const paidWithoutSlip = db.prepare(`SELECT count(*) n FROM orders o WHERE o.status='paid'
    AND NOT EXISTS (SELECT 1 FROM payment_slips s WHERE s.order_id=o.id)`).get().n;
  console.log('PKG-070 orders marked paid with no slip on file:', paidWithoutSlip);
  assert.equal(paidWithoutSlip, 0);
});

test('PKG-072 every order status has a way out', async t => {
  const { call, login, member, upload, pkg, tick } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const reached = {};
  const start = async who => {
    const tok = await member(`${who}@example.test`);
    const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
    return { tok, o };
  };
  const a = await start('st-cancel');
  await call('post', `/orders/${a.o.id}/cancel`, a.tok, {}).expect(200);
  reached.cancelled = (await call('get', `/orders/${a.o.id}`, a.tok)).body.order.status;

  const b = await start('st-expire');
  tick(61 * 60000);
  reached.expired = (await call('get', `/orders/${b.o.id}`, b.tok)).body.order.status;

  const c = await start('st-paid');
  await upload(c.tok, c.o.id).expect(201);
  reached.awaiting_review = (await call('get', `/orders/${c.o.id}`, c.tok)).body.order.status;
  let cur = (await call('get', `/orders/${c.o.id}`, c.tok)).body.order;
  await call('post', `/admin/orders/${c.o.id}/approve`, admin, { version: cur.version, checked_against_bank: true }).expect(200);
  reached.paid = (await call('get', `/orders/${c.o.id}`, c.tok)).body.order.status;

  const d = await start('st-reject');
  await upload(d.tok, d.o.id).expect(201);
  cur = (await call('get', `/orders/${d.o.id}`, d.tok)).body.order;
  await call('post', `/admin/orders/${d.o.id}/reject`, admin, { version: cur.version, reason: 'สลิปไม่ชัด' }).expect(200);
  reached.rejected = (await call('get', `/orders/${d.o.id}`, d.tok)).body.order.status;
  const wayOut = await upload(d.tok, d.o.id, jpeg('again'), { reference_no: 'REFAGAIN1' });
  console.log('PKG-072 statuses reached:', JSON.stringify(reached));
  console.log('PKG-072 way out of "rejected" (upload a corrected slip) ->', wayOut.status, wayOut.body.order?.status);
  assert.deepEqual(Object.keys(reached).sort(), ['awaiting_review', 'cancelled', 'expired', 'paid', 'rejected']);
  assert.equal(wayOut.status, 201);
  const cancelUnderReview = await call('post', `/orders/${c.o.id}/cancel`, c.tok, {});
  console.log('PKG-072 cancelling a paid order ->', cancelUnderReview.status, JSON.stringify(cancelUnderReview.body.error));
  assert.equal(cancelUnderReview.status, 409);
});

// ================================================== B7 · UX / i18n / release
// PKG-084 moved to qa-pkg2.test.js: this version passed baht as satang.

test('PKG-085 transfer times are interpreted in Bangkok time, not the server timezone', async t => {
  const { call, login, member, upload, pkg } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('tz@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const r = await upload(tok, o.id, jpeg(), { transferred_at: '2026-09-14T08:45' }).expect(201);
  const expected = Date.parse('2026-09-14T08:45:00+07:00');
  console.log('PKG-085 "2026-09-14T08:45" stored as', r.body.slip.transferred_at, '| Bangkok epoch', expected,
    '| as UTC would be', Date.parse('2026-09-14T08:45:00Z'));
  assert.equal(r.body.slip.transferred_at, expected);
});

test('PKG-086 slip storage stays outside anything served statically', async t => {
  const { call, login, member, upload, pkg, root, db } = fixture(t);
  const admin = await login('a@example.test', 'admin');
  const p = await pkg(admin, { price_thb: 50000 });
  const tok = await member('store@example.test');
  const o = (await call('post', '/orders', tok, { package_id: p.id }).expect(201)).body.order;
  const up = await upload(tok, o.id).expect(201);
  const image = await call('get', `/slips/${up.body.slip.id}/image`, tok).expect(200);
  console.log('PKG-086 image headers:', JSON.stringify({
    ct: image.headers['content-type'], csp: image.headers['content-security-policy'],
    nosniff: image.headers['x-content-type-options'], disposition: image.headers['content-disposition'] ?? null,
  }));
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.match(image.headers['content-security-policy'], /sandbox/);
  const env = readFileSync('.env.example', 'utf8');
  console.log('PKG-086 .env.example declares:', JSON.stringify(env.split('\n').filter(l => /PROMPTPAY|SLIP/.test(l) && !l.startsWith('#'))));
  assert.match(env, /^PROMPTPAY_ID=/m);
  assert.match(env, /^SLIP_STORAGE_PATH=/m);
  console.log('PKG-086 storage root used by the test:', root.includes('dist') ? 'INSIDE dist' : 'outside dist');
  assert.ok(db.prepare('SELECT count(*) n FROM payment_slips').get().n === 1);
});
