// QA Release Tester — the counter application (release/pilot at cf6fa58).
//
// Two things in this round can lose something that cannot be recovered: the
// migration that rebuilds the members table under a gym that already has
// people in it, and the card, which is now a permanent signed token in a
// picture that lives in somebody's phone for years.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate, rollback, getMember } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { cardQrFor, cardSignature, decodeCardQr, encodeCardQr } from '../server/cards.js';

const DAY = 86400000;
const THAI = /[฀-๿]/;

/** A real photograph: something the drawing code can actually put on a card. */
async function photograph() {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8a27a'; ctx.fillRect(0, 0, 600, 600);
  ctx.fillStyle = '#3b2a1d';
  ctx.beginPath(); ctx.arc(300, 250, 120, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(300, 560, 200, 180, 0, 0, Math.PI * 2); ctx.fill();
  return canvas.toBuffer('image/png');
}

/**
 * A photograph that decodes AND carries the coordinates a phone would have
 * written into it. Since `a08b7cd` the upload refuses anything it cannot draw,
 * so the EXIF case needs a real picture with an APP1 segment spliced in after
 * the SOI marker -- decoders skip that segment, the card still draws, and what
 * is left to prove is that the server does not keep it.
 */
async function photographWithExif(tag = 'qa') {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8a27a'; ctx.fillRect(0, 0, 600, 600);
  ctx.fillStyle = '#3b2a1d';
  ctx.beginPath(); ctx.arc(300, 250, 120, 0, Math.PI * 2); ctx.fill();
  const real = canvas.toBuffer('image/jpeg');
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from(`GPS 13.7563,100.5018 ${tag}`, 'latin1')]);
  const length = Buffer.alloc(2); length.writeUInt16BE(exif.length + 2);
  return Buffer.concat([real.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, exif, real.subarray(2)]);
}

/** The smallest bytes a browser will accept as a JPEG, with EXIF to strip. */
function jpeg(tag = 'qa') {
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from(`GPS 13.7563,100.5018 ${tag}`, 'latin1')]);
  const length = Buffer.alloc(2); length.writeUInt16BE(exif.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xe1]), length, exif,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

function counter(t) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const photos = mkdtempSync(join(tmpdir(), 'qa-photo-'));
  const slips = mkdtempSync(join(tmpdir(), 'qa-slip-'));
  const secret = randomBytes(32).toString('hex');
  let time = Date.parse('2026-09-15T09:00:00+07:00');
  const photoStore = new SlipStore(photos, { maxBytes: 8 * 1024 * 1024 });
  const app = createApp({ db, secret, now: () => time,
    slipStore: new SlipStore(slips), photoStore, promptPayId: '0812345678' });
  t.after(() => {
    app.locals.stopSweeper?.(); db.close();
    for (const dir of [photos, slips]) rmSync(dir, { recursive: true, force: true });
  });

  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'web');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const session = userId => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), userId, time + 365 * DAY);
    return token;
  };
  const staffUser = (email, role) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, email, role, time);
    return { id, token: session(id) };
  };
  let seq = 1;
  const member = (name = 'สุดา ใจดี') => {
    const id = randomUUID();
    db.prepare(`INSERT INTO members(id,member_code,name,phone,status,joined_at,updated_at)
      VALUES(?,?,?,?,'active',?,?)`)
      .run(id, `GYM-QA${String(seq).padStart(10, '0')}`, name, `08900000${String(seq++).padStart(2, '0')}`, time, time);
    return getMember(db, id);
  };
  return { db, app, call, session, staffUser, member, photos, photoStore, secret,
    tick: ms => { time += ms; }, at: () => time };
}

// =========================================================== the card token
test('CARD-01 a card only opens the door of the member it was drawn for', async t => {
  const { db, call, staffUser, member, secret } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member('สุดา ใจดี');
  const anon = member('อนงค์ ใจเย็น');

  const real = cardQrFor(secret, suda);
  const decoded = decodeCardQr(real);
  console.log('CARD-01 what the QR carries:', JSON.stringify(decoded));
  assert.equal(decoded.version, 1);
  assert.ok(!real.includes(suda.name) && !real.includes(suda.phone) && !real.includes(suda.member_code),
    'the card token spells out something about the member');

  // Every way of editing the token that a person with a card could try.
  const forged = {
    'somebody else in my signature': encodeCardQr(anon.id, 1, decoded.signature),
    'my card, bumped a version': encodeCardQr(suda.id, 2, decoded.signature),
    'version zero': encodeCardQr(suda.id, 0, decoded.signature),
    'a signature of the right shape': encodeCardQr(suda.id, 1, 'a'.repeat(32)),
    'a signature one character short': `GYMCARD1.${suda.id.replaceAll('-', '')}.1.${'a'.repeat(31)}`,
    'the old one-time format': `GYMCHK1.${randomUUID()}.${'0'.repeat(64)}`,
    'nothing at all': '',
  };
  const answers = {};
  for (const [name, qr] of Object.entries(forged)) {
    const res = await call('post', '/check-ins/verify', staff.token, { qr, device_label: 'เคาน์เตอร์' });
    answers[name] = { status: res.status, result: res.body.result, reason: res.body.failure_reason ?? res.body.error };
  }
  console.log('CARD-01 forged cards at the counter:\n' + JSON.stringify(answers, null, 1));
  for (const [name, row] of Object.entries(answers)) {
    assert.notEqual(row.result, 'allowed', `${name} was let in`);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM check_ins WHERE result='allowed'").get().n, 0);

  // And the real one is recognised, even with nothing to spend.
  const honest = await call('post', '/check-ins/verify', staff.token, { qr: real, device_label: 'เคาน์เตอร์' });
  console.log('CARD-01 the real card ->', honest.status, JSON.stringify({
    result: honest.body.result, who: honest.body.member?.name, reason: honest.body.failure_reason }));
  assert.equal(honest.status, 409, 'a member with nothing left was let in');
  assert.equal(honest.body.result, 'denied');
  assert.equal(honest.body.member?.name, 'สุดา ใจดี', 'the counter cannot tell whose card this is');
});

test('CARD-02 reissuing kills the card somebody is carrying, and only an admin may', async t => {
  const { db, call, staffUser, member, secret } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const admin = staffUser('owner@example.test', 'admin');
  const suda = member('สุดา ใจดี');
  const old = cardQrFor(secret, suda);

  const refused = await call('post', `/members/${suda.id}/card/reissue`, staff.token, { reason: 'ทำหาย' });
  console.log('CARD-02 staff tries to reissue ->', refused.status, JSON.stringify(refused.body.error));
  assert.equal(refused.status, 403, 'anybody at the counter can cancel a card');

  const noReason = await call('post', `/members/${suda.id}/card/reissue`, admin.token, {});
  const blank = await call('post', `/members/${suda.id}/card/reissue`, admin.token, { reason: '  ' });
  console.log('CARD-02 without a reason ->', noReason.status, '| blank reason ->', blank.status);
  assert.equal(noReason.status, 400);
  assert.equal(blank.status, 400);

  const done = await call('post', `/members/${suda.id}/card/reissue`, admin.token, { reason: 'ลูกค้าทำโทรศัพท์หาย' });
  console.log('CARD-02 reissue ->', done.status, JSON.stringify({
    version: done.body.member?.card_version, qr: done.body.qr }));
  assert.equal(done.status, 200);
  assert.equal(done.body.member?.card_version, 2);

  const dead = await call('post', '/check-ins/verify', staff.token, { qr: old, device_label: 'เคาน์เตอร์' });
  const fresh = await call('post', '/check-ins/verify', staff.token,
    { qr: cardQrFor(secret, getMember(db, suda.id)), device_label: 'เคาน์เตอร์' });
  console.log('CARD-02 the card already in the customer\'s phone ->', JSON.stringify({
    result: dead.body.result, reason: dead.body.failure_reason }));
  console.log('CARD-02 the new card ->', JSON.stringify({ result: fresh.body.result, who: fresh.body.member?.name }));
  assert.notEqual(dead.body.result, 'allowed', 'the cancelled card still works');
  assert.ok(THAI.test(dead.body.failure_reason ?? ''), 'the counter is told why in English');
  assert.equal(fresh.body.member?.name, 'สุดา ใจดี');

  const trail = db.prepare("SELECT * FROM audit_logs WHERE action='member.card_reissue'").all();
  console.log('CARD-02 audit:', trail.length, '| reason recorded:', JSON.stringify(JSON.parse(trail[0].after_json ?? '{}').reason
    ?? trail[0].after_json?.slice(0, 60)));
  assert.equal(trail.length, 1, 'cancelling a card left no trace');
  assert.equal(trail[0].actor_id, admin.id);
});

test('CARD-03 the signature is the only thing standing between a member and the secret', async t => {
  const { member, secret } = counter(t);
  const suda = member();
  const other = randomBytes(32).toString('hex');
  const mine = cardSignature(secret, suda.id, 1);

  const checks = {
    'same member, same version, same secret': cardSignature(secret, suda.id, 1) === mine,
    'same member, next version': cardSignature(secret, suda.id, 2) === mine,
    'different member': cardSignature(secret, randomUUID(), 1) === mine,
    'different secret': cardSignature(other, suda.id, 1) === mine,
  };
  console.log('CARD-03 signatures that match the real one:\n' + JSON.stringify(checks, null, 1));
  assert.equal(checks['same member, same version, same secret'], true);
  assert.equal(checks['same member, next version'], false, 'the version is not covered by the signature');
  assert.equal(checks['different member'], false);
  assert.equal(checks['different secret'], false);

  // The token is a hex string, so it cannot be used to smuggle anything into a
  // screen that renders it.
  const qr = cardQrFor(secret, suda);
  console.log('CARD-03 the whole token:', qr);
  assert.match(qr, /^GYMCARD1\.[0-9a-f]{32}\.\d+\.[0-9a-f]{32}$/);
  assert.equal(decodeCardQr(`${qr}.extra`), null, 'a token with a fifth part is accepted');
  assert.equal(decodeCardQr(qr.replace('GYMCARD1', 'GYMCARD2')), null);
});

// ============================================================ the photograph
test('PHOTO-01 a face is stored like a bank slip, and reaches nobody who is not at the counter', async t => {
  const { app, db, call, staffUser, member, photos } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member('สุดา ใจดี');

  const unauthenticated = {
    'GET /members/:id/photo': (await call('get', `/members/${suda.id}/photo`, null)).status,
    'GET /members/:id/card': (await call('get', `/members/${suda.id}/card`, null)).status,
    'GET /members/:id/card.png': (await call('get', `/members/${suda.id}/card.png`, null)).status,
    'PUT /members/:id/photo': (await call('put', `/members/${suda.id}/photo`, null)).status,
    'POST card/reissue': (await call('post', `/members/${suda.id}/card/reissue`, null, { reason: 'x' })).status,
  };
  console.log('PHOTO-01 with no session at all:\n' + JSON.stringify(unauthenticated, null, 1));
  for (const [name, status] of Object.entries(unauthenticated)) {
    assert.equal(status, 401, `${name} is open to anybody`);
  }

  const uploaded = await request(app).put(`/api/members/${suda.id}/photo`)
    .set('X-Gym-Client', 'web').set('Authorization', `Bearer ${staff.token}`)
    .attach('photo', await photographWithExif('GPS-should-not-survive'), { filename: 'IMG_0421.jpg', contentType: 'image/jpeg' });
  console.log('PHOTO-01 upload ->', uploaded.status, JSON.stringify({
    has_photo: uploaded.body.has_photo, leaked: Object.keys(uploaded.body).filter(k => /stored|path|file/.test(k)) }));
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.has_photo, true);
  assert.ok(!JSON.stringify(uploaded.body).includes('IMG_0421'), 'the name the phone gave the file came back');

  const onDisk = readdirSync(photos);
  const bytes = readFileSync(join(photos, onDisk[0]));
  console.log('PHOTO-01 what is on disk:', JSON.stringify(onDisk), bytes.length, 'bytes');
  assert.equal(onDisk.length, 1);
  assert.ok(!onDisk[0].includes('IMG_0421'), 'the stored file kept the name the phone chose');
  assert.ok(!bytes.includes(Buffer.from('GPS-should-not-survive')),
    'the photograph still carries where it was taken');
  assert.equal(db.prepare('SELECT photo_stored_name FROM members WHERE id=?').get(suda.id).photo_stored_name, onDisk[0]);

  const served = await call('get', `/members/${suda.id}/photo`, staff.token);
  console.log('PHOTO-01 served to the counter ->', served.status, served.headers['content-type'],
    '| cache:', served.headers['cache-control']);
  assert.equal(served.status, 200);
  assert.match(served.headers['content-type'], /image\/jpeg/);
  assert.match(served.headers['cache-control'] ?? '', /no-store/,
    'a shared counter tablet is allowed to keep the face in its cache');
});

test('PHOTO-02 the upload refuses what it should, and a suspended account gets nothing', async t => {
  const { app, call, staffUser, member, db, photos } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member();

  const attempts = {
    'no file at all': await request(app).put(`/api/members/${suda.id}/photo`)
      .set('X-Gym-Client', 'web').set('Authorization', `Bearer ${staff.token}`),
    'a PDF wearing a jpg name': await request(app).put(`/api/members/${suda.id}/photo`)
      .set('X-Gym-Client', 'web').set('Authorization', `Bearer ${staff.token}`)
      .attach('photo', Buffer.from('%PDF-1.4 not a picture'), { filename: 'face.jpg', contentType: 'image/jpeg' }),
    'a member who does not exist': await request(app).put(`/api/members/${randomUUID()}/photo`)
      .set('X-Gym-Client', 'web').set('Authorization', `Bearer ${staff.token}`)
      .attach('photo', jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' }),
  };
  const report = {};
  for (const [name, res] of Object.entries(attempts)) report[name] = { status: res.status, error: res.body.error };
  console.log('PHOTO-02 uploads that must not be kept:\n' + JSON.stringify(report, null, 1));
  for (const [name, row] of Object.entries(report)) {
    assert.ok(row.status >= 400, `${name} was accepted`);
    assert.ok(THAI.test(row.error ?? ''), `${name} was refused in English`);
  }
  console.log('PHOTO-02 files written by the refused uploads:', readdirSync(photos).length);
  assert.equal(readdirSync(photos).length, 0, 'a refused upload still left bytes on the disk');

  // A suspended account keeps nothing, including the right to look at faces.
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(staff.id);
  const after = await call('get', `/members/${suda.id}/photo`, staff.token);
  console.log('PHOTO-02 a suspended account asking for a photo ->', after.status, JSON.stringify(after.body.error));
  assert.equal(after.status, 403);
});

// =============================================================== migration 007
test('MIG-01 a gym full of people survives the move to the counter application', async t => {
  const db = openDatabase();
  migrate(db);
  seedConfiguration(db, Date.now());
  const now = Date.parse('2026-09-10T09:00:00+07:00');

  // Back to the shape a running gym is in before this round.
  // Roll back one migration at a time rather than a fixed number, so this
  // keeps testing the 007 boundary as migrations are added after it.
  const at = () => db.prepare('SELECT max(version) v FROM schema_migrations').get().v;
  while (at() > 6) rollback(db);
  const version = db.prepare('SELECT max(version) v FROM schema_migrations').get().v;
  console.log('MIG-01 rolled the schema back to version', version);
  assert.equal(version, 6);

  // A gym as it actually looks: members who signed up in the app, one
  // suspended, memberships bought and given, a slip on file, visits recorded.
  const pkg = randomUUID();
  db.prepare(`INSERT INTO packages(id,code,name_th,type,duration_days,session_limit,price_satang,
    description,status,sort_order,created_at,updated_at)
    VALUES(?,'OLD_MONTH','รายเดือน','unlimited',30,NULL,120000,'','active',0,?,?)`).run(pkg, now, now);
  const people = [];
  for (let i = 1; i <= 4; i++) {
    const userId = randomUUID(), memberId = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,email_verified_at,created_at) VALUES(?,?,?,?,?)')
      .run(userId, `old-${i}@example.test`, 'member', now, now);
    db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,status,joined_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(memberId, userId, `GYM-OLD${i}`, `สมาชิกเก่า ${i}`,
      `08811110${i}`, i === 4 ? 'suspended' : 'active', now, now);
    const orderId = randomUUID();
    const manual = i === 3 ? 1 : 0;
    db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
      package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
      status,manual_grant,reviewed_by,reviewed_at,review_note,created_at,expires_at,updated_at)
      VALUES(?,?,?,'OLD_MONTH','รายเดือน','unlimited',30,NULL,120000,'paid',?,NULL,?,?,?,?,?)`)
      .run(orderId, memberId, pkg, manual, now, manual ? 'แถมให้' : null, now, now + 3600000, now);
    db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,expires_at,
      sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?)`)
      .run(randomUUID(), orderId, memberId, pkg, now, now + 30 * DAY, now);
    db.prepare(`INSERT INTO check_ins(id,member_id,entitlement_id,result,checked_in_at,device_label)
      VALUES(?,?,NULL,'allowed',?,'เคาน์เตอร์เก่า')`).run(randomUUID(), memberId, now + i * 1000);
    people.push({ userId, memberId, orderId, manual });
  }
  db.prepare(`INSERT INTO payment_slips(id,order_id,stored_name,content_type,byte_size,file_hash,
    reference_no,transferred_at,amount_satang_claimed,superseded_at,uploaded_at)
    VALUES(?,?,'stored.jpg','image/jpeg',100,'hash','REF0001',?,120000,NULL,?)`)
    .run(randomUUID(), people[0].orderId, now, now);
  const before = {
    members: db.prepare('SELECT count(*) n FROM members').get().n,
    orders: db.prepare('SELECT count(*) n FROM orders').get().n,
    entitlements: db.prepare('SELECT count(*) n FROM entitlements').get().n,
    check_ins: db.prepare('SELECT count(*) n FROM check_ins').get().n,
    slips: db.prepare('SELECT count(*) n FROM payment_slips').get().n,
    users: db.prepare('SELECT count(*) n FROM users').get().n,
  };
  console.log('MIG-01 the gym before the migration:', JSON.stringify(before));

  migrate(db);
  const after = {
    members: db.prepare('SELECT count(*) n FROM members').get().n,
    orders: db.prepare('SELECT count(*) n FROM orders').get().n,
    entitlements: db.prepare('SELECT count(*) n FROM entitlements').get().n,
    check_ins: db.prepare('SELECT count(*) n FROM check_ins').get().n,
    slips: db.prepare('SELECT count(*) n FROM payment_slips').get().n,
    users: db.prepare('SELECT count(*) n FROM users').get().n,
  };
  console.log('MIG-01 and after:                  ', JSON.stringify(after));
  assert.deepEqual(after, before, 'the migration lost or invented rows');

  const broken = db.prepare('PRAGMA foreign_key_check').all();
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const enforcing = db.prepare('PRAGMA foreign_keys').get();
  console.log('MIG-01 foreign_key_check:', JSON.stringify(broken), '| integrity:', JSON.stringify(integrity),
    '| foreign keys back on:', JSON.stringify(enforcing));
  assert.deepEqual(broken, [], 'the rebuilt members table left dangling references');
  assert.equal(integrity[0].integrity_check, 'ok');
  assert.equal(Object.values(enforcing)[0], 1, 'foreign keys were left switched off after the migration');

  // Everything that pointed at a member still points at the same member.
  for (const person of people) {
    const row = getMember(db, person.memberId);
    assert.ok(row, 'a member disappeared');
    assert.equal(row.user_id, person.userId, 'a member lost the account they had');
    assert.equal(row.card_version, 1, 'an existing member did not get a first card');
    assert.equal(db.prepare('SELECT count(*) n FROM entitlements WHERE member_id=?').get(person.memberId).n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM check_ins WHERE member_id=?').get(person.memberId).n, 1);
  }
  const suspended = db.prepare("SELECT count(*) n FROM members WHERE status='suspended'").get().n;
  const methods = db.prepare('SELECT manual_grant, payment_method, count(*) n FROM orders GROUP BY 1,2').all();
  console.log('MIG-01 suspended members kept:', suspended, '| payment_method filled in as:', JSON.stringify(methods));
  assert.equal(suspended, 1);
  for (const row of methods) {
    assert.ok(row.payment_method, 'an old order was left with no payment method');
    if (row.manual_grant === 1) assert.equal(row.payment_method, 'none');
  }

  // Cards work for people who joined before cards existed.
  const secret = randomBytes(32).toString('hex');
  const qr = cardQrFor(secret, getMember(db, people[0].memberId));
  console.log('MIG-01 a member from before the pivot now has a card:', qr);
  assert.match(qr, /^GYMCARD1\./);

  // And running it again changes nothing.
  migrate(db);
  const twice = db.prepare('SELECT count(*) n FROM members').get().n;
  console.log('MIG-01 members after migrating a second time:', twice);
  assert.equal(twice, before.members);
  db.close();
});

test('MIG-02 going back does not leave a counter member without a row', async t => {
  const db = openDatabase();
  migrate(db); seedConfiguration(db, Date.now());
  const now = Date.now();
  // Two people who could not exist before this round: no account at all.
  for (let i = 1; i <= 2; i++) {
    db.prepare(`INSERT INTO members(id,member_code,name,phone,status,joined_at,updated_at)
      VALUES(?,?,?,?,'active',?,?)`)
      .run(randomUUID(), `GYM-NEW${i}`, `สมาชิกใหม่ ${i}`, `08999990${i}`, now, now);
  }
  const before = db.prepare('SELECT count(*) n FROM members').get().n;
  const at = () => db.prepare('SELECT max(version) v FROM schema_migrations').get().v;
  while (at() > 6) rollback(db);
  const after = db.prepare('SELECT count(*) n FROM members').get().n;
  const placeholders = db.prepare("SELECT email FROM users WHERE email LIKE '%@counter.invalid'").all();
  console.log('MIG-02 members before going back:', before, '| after:', after);
  console.log('MIG-02 stand-in accounts made for them:', JSON.stringify(placeholders.map(p => p.email)));
  assert.equal(after, before, 'going back dropped the people who had no account');
  assert.equal(placeholders.length, 2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // .invalid can never receive mail, so none of these is a way in.
  for (const row of placeholders) assert.match(row.email, /@counter\.invalid$/);
  db.close();
});

// ============================================== what the old app left behind
test('GONE-01 every route the member app used answers 404, not 401', async t => {
  const { call, staffUser } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const gone = ['/orders', '/entitlements', '/me/check-in-token', '/me/profile',
    '/auth/request-otp', '/auth/verify-otp', '/admin/pilot/otp-codes'];
  const answers = {};
  for (const path of gone) {
    answers[`GET ${path}`] = (await call('get', path, staff.token)).status;
    answers[`POST ${path}`] = (await call('post', path, staff.token, {})).status;
  }
  console.log('GONE-01 what is left of the member app:\n' + JSON.stringify(answers, null, 1));
  for (const [name, status] of Object.entries(answers)) {
    assert.equal(status, 404, `${name} is still wired to something`);
  }
});

// ====================================== the picture the member actually holds
test('CARD-06 the card is the size it claims, and a scanner can read the QR on it', async t => {
  const { app, call, staffUser, member, secret } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member('สุขฤทัย ณ บางคล้า');
  await request(app).put(`/api/members/${suda.id}/photo`)
    .set('X-Gym-Client', 'web').set('Authorization', `Bearer ${staff.token}`)
    .attach('photo', await photograph(), { filename: 'face.png', contentType: 'image/png' }).expect(200);

  const png = await call('get', `/members/${suda.id}/card.png`, staff.token);
  console.log('CARD-06 card.png ->', png.status, png.headers['content-type'],
    '|', png.body.length, 'bytes |', png.headers['content-disposition']);
  assert.equal(png.status, 200);
  assert.match(png.headers['content-type'], /image\/png/);
  assert.ok(png.headers['content-disposition'].includes(suda.member_code),
    'the file the staff member saves is not named after the member');

  // Read it back the way a phone would: decode the pixels and find the QR.
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(png.body);
  console.log('CARD-06 the picture is', image.width, 'x', image.height);
  assert.equal(image.width, 1080, 'the card is not the width the spec asks for');
  assert.equal(image.height, 1350, 'the card is not 4:5, so a chat app will crop it');

  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { default: jsQR } = await import('jsqr');
  const pixels = ctx.getImageData(0, 0, image.width, image.height);
  const found = jsQR(new Uint8ClampedArray(pixels.data), image.width, image.height);
  console.log('CARD-06 what a scanner reads off the card:', JSON.stringify(found?.data));
  assert.ok(found, 'no QR could be read from the card at full size');
  assert.equal(found.data, cardQrFor(secret, suda), 'the QR on the card is not this card token');

  // And the same card at the size a chat app resends it, which is the size it
  // will actually be scanned at.
  const small = createCanvas(540, 675);
  small.getContext('2d').drawImage(image, 0, 0, 540, 675);
  const shrunk = small.getContext('2d').getImageData(0, 0, 540, 675);
  const stillReadable = jsQR(new Uint8ClampedArray(shrunk.data), 540, 675);
  console.log('CARD-06 readable after being halved to 540 x 675:', !!stillReadable);
  assert.ok(stillReadable, 'the QR stops being readable once a chat app shrinks the picture');
});

test('PHOTO-03 a photograph the card cannot draw is turned away, and the good one is kept', async t => {
  const { app, call, staffUser, member } = counter(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member('รับไว้ แล้วพัง');
  const send = (bytes, filename) => request(app).put(`/api/members/${suda.id}/photo`)
    .set('X-Gym-Client', 'web').set('Authorization', `Bearer ${staff.token}`)
    .attach('photo', bytes, { filename, contentType: 'image/jpeg' });

  // Real JPEG magic bytes, nothing behind them: what a half-finished upload
  // from a phone that lost signal looks like on the way in. Until `a08b7cd`
  // this was kept, and from then on the member had no card at all.
  const truncated = await send(jpeg(), 'half-sent.jpg');
  console.log('PHOTO-03 a half-sent JPEG ->', truncated.status, JSON.stringify(truncated.body.error));
  assert.equal(truncated.status, 400, 'bytes the card cannot draw were stored again');
  assert.ok(THAI.test(truncated.body.error ?? ''), 'the refusal is not in Thai');

  const card = await call('get', `/members/${suda.id}/card.png`, staff.token);
  const detail = await call('get', `/members/${suda.id}/card`, staff.token);
  console.log('PHOTO-03 the card of somebody with no photograph ->', card.status,
    JSON.stringify(card.headers['content-type']), '| photo_readable:', detail.body.photo_readable);
  assert.equal(card.status, 200, 'the silhouette fallback stopped working');
  assert.equal(detail.body.photo_readable, null, 'a member with no photograph should report null');

  // The second half of the fix: a bad upload must not take away a good picture
  // that is already on file.
  const good = await send(await photographWithExif('kept'), 'face.jpg');
  const spoilt = await send(jpeg(), 'half-sent-again.jpg');
  const afterwards = await call('get', `/members/${suda.id}/card`, staff.token);
  console.log('PHOTO-03 a good photograph ->', good.status,
    '| a bad one on top of it ->', spoilt.status,
    '| the good one survived:', afterwards.body.member.has_photo,
    '| readable:', afterwards.body.photo_readable);
  assert.equal(good.status, 200);
  assert.equal(spoilt.status, 400);
  assert.equal(afterwards.body.member.has_photo, true, 'a refused upload wiped the photograph on file');
  assert.equal(afterwards.body.photo_readable, true);
});

// ===================================================== what may be sold at all
test('SALE-09 a package the owner has not opened for sale cannot be sold', async t => {
  const { call, staffUser, member } = counter(t);
  const owner = staffUser('owner@example.test', 'admin');
  const staff = staffUser('counter@example.test', 'staff');
  const buyer = member('ลูกค้า ที่ยืนรออยู่');

  const make = (code, status, price) => call('post', '/packages', owner.token, {
    code, name_th: `แพ็กเกจ ${code}`, type: 'unlimited', duration_days: 30,
    ...(price === null ? {} : { price_thb: price }), status, description: '' });
  const packages = {
    'priced and open for sale': await make('OPEN_30D', 'active', 1500),
    'priced but still a draft': await make('DRAFT_30D', 'draft', 1500),
    'priced and taken off sale': await make('ARCHIVED_30D', 'archived', 1500),
    'a draft with no price yet': await make('NOPRICE_30D', 'draft', null),
  };
  const sold = {};
  for (const [label, created] of Object.entries(packages)) {
    assert.equal(created.status, 201, `could not create the ${label} package`);
    const res = await call('post', `/members/${buyer.id}/grant`, staff.token,
      { package_id: created.body.id, payment_method: 'cash', note: 'ทดสอบ' });
    sold[label] = { status: res.status, error: res.body.error };
  }
  console.log('SALE-09 what a member of staff can sell:\n' + JSON.stringify(sold, null, 1));

  // The sell screen filters on `price_thb !== null && status === 'active'`, so
  // none of the last three is offered. That filter is the only thing stopping
  // them: a tablet left open on the counter keeps a list from before the owner
  // closed the package, and the money still lands in the day's takings.
  assert.equal(sold['priced and open for sale'].status, 201);
  assert.equal(sold['a draft with no price yet'].status, 409, 'a package with no price was sold');
  assert.equal(sold['priced but still a draft'].status, 409,
    'a package the owner has not opened for sale was sold anyway');
  assert.equal(sold['priced and taken off sale'].status, 409,
    'a package the owner took off sale was sold anyway');
  for (const [label, row] of Object.entries(sold)) {
    if (row.status >= 400) assert.ok(THAI.test(row.error ?? ''), `${label} was refused in English`);
  }
});
