// The content behind the QR stickers, and who may read which part of it.
//
// Two rules decide everything here, and they pull in opposite directions.
//
// The machine pages are PUBLIC. There is a sticker on the side of every
// machine; somebody standing at it with a phone has not signed in and is not
// going to, and a page that asks them to is a sticker nobody scans twice.
//
// The programmes are NOT. They are what the membership pays for, and the
// check is per request -- a membership that ran out on Tuesday must not keep
// working until the session expires on Wednesday.
//
// The third thing this file guards is quieter: a number nobody at the gym has
// checked must never be printed as though the gym said it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { counterFixture } from './counter.js';
import { importContent } from '../server/content-import.js';
import { youTubeId } from '../server/content-routes.js';

const CONTENT = JSON.parse(readFileSync(new URL('../docs/content/member-content.json', import.meta.url), 'utf8'));
const MEMBER = { name: 'สมชาย ขยันมาก', phone: '0891234567', email: 'somchai@example.test' };
const PORTAL_PASSWORD = 'a-password-of-my-own';

/** A member with a live membership and a password, the way one really arrives. */
async function joinedMember(fixture) {
  const { call, signIn, addMember } = fixture;
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');
  const member = await addMember(desk, MEMBER);
  const pkg = (await call('post', '/packages', owner, {
    code: 'MONTH', name_th: 'รายเดือน', type: 'unlimited', duration_days: 30,
    price_thb: 1200, status: 'active',
  }).expect(201)).body;
  await call('post', `/members/${member.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);
  await call('post', `/members/${member.id}/welcome`, desk, {}).expect(200);
  await call('post', '/auth/set-password', null,
    { token: fixture.resetToken(), password: PORTAL_PASSWORD }).expect(200);
  const portal = (await call('post', '/auth/member/login', null,
    { email: MEMBER.email, password: PORTAL_PASSWORD }).expect(200)).body.token;
  return { member, owner, portal };
}

test('the importer adds, updates, and refuses to overwrite what a trainer checked', async t => {
  const { db } = counterFixture(t);
  const first = importContent(db, CONTENT, 1000);
  assert.equal(first.machines.filter(row => row.action === 'added').length, CONTENT.machines.length);
  assert.equal(first.programs.length, CONTENT.programs.length);
  assert.equal(first.articles.length, CONTENT.articles.length);

  // Run twice: a second import must bring rows up to date, not duplicate them.
  const again = importContent(db, CONTENT, 2000);
  assert.ok(again.machines.every(row => row.action === 'updated'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM machines').get().n, CONTENT.machines.length);

  // The trainer goes through the numbers on one machine and signs it off.
  db.prepare("UPDATE machines SET name_th='ชื่อที่เทรนเนอร์แก้',reviewed_by='trainer@gym',reviewed_at=? WHERE code=?")
    .run(3000, CONTENT.machines[0].code);
  const third = importContent(db, CONTENT, 4000);
  assert.equal(third.machines.find(row => row.code === CONTENT.machines[0].code).action, 'kept');
  // Their wording survives. Without this the next import from the team silently
  // replaces what somebody at the gym decided, and nobody finds out.
  assert.equal(db.prepare('SELECT name_th FROM machines WHERE code=?').get(CONTENT.machines[0].code).name_th,
    'ชื่อที่เทรนเนอร์แก้');
});

test('the machine page is public, and costs one request with no script', async t => {
  const { call, http, db } = counterFixture(t);
  importContent(db, CONTENT, 1000);
  const code = CONTENT.machines[0].code;

  // No session, no cookie, no token. That is the whole point of the sticker.
  const page = await http.get(`/m/${code}`).expect(200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.ok(page.text.includes(CONTENT.machines[0].name_th));
  assert.ok(page.text.includes(CONTENT.machines[0].steps[0]));
  // The gym's own safety footer comes with it.
  assert.ok(page.text.includes(CONTENT.safety.machine_footer[0]));

  // Lower case works too: somebody types the code off the sticker.
  await http.get(`/m/${code.toLowerCase()}`).expect(200);
  await http.get('/m/M-99').expect(404);

  // No React, no bundle: the page is the answer, not a loader for one.
  assert.equal(page.text.includes('/assets/'), false, 'หน้าเครื่องต้องไม่โหลด bundle ของแอป');

  // The video is a still and a button until somebody presses it. An iframe
  // that exists on load is a megabyte of YouTube on gym wifi per clip.
  assert.equal(page.text.includes('<iframe'), false, 'ต้องไม่มี iframe ก่อนกดเล่น');
  assert.ok(page.text.includes('i.ytimg.com'), 'ควรมีภาพนิ่งของคลิป');
  // The four lines that build the player come from a file rather than from an
  // inline <script>, because this is the one page a stranger can open and
  // loosening `script-src` for it would be the wrong trade.
  assert.equal(/<script>/.test(page.text), false, 'ต้องไม่มีสคริปต์ inline บนหน้าที่เปิดสาธารณะ');
  assert.ok(page.text.includes('/m/_play.js'), 'ต้องโหลดสคริปต์เล่นคลิปเป็นไฟล์');
  const player = await http.get('/m/_play.js').expect(200);
  assert.ok(player.text.includes('youtube-nocookie.com/embed'), 'และสร้าง iframe ตอนกด');
  // And it says what to do when the clip has been taken down by its owner.
  assert.match(page.text, /เจ้าของคลิปลบไปแล้ว/);

  const api = await call('get', '/public/machines', null).expect(200);
  assert.equal(api.body.items.length, CONTENT.machines.length);
});

test('a programme is for members whose membership is still live, checked every time', async t => {
  const fixture = counterFixture(t);
  const { call, db } = fixture;
  importContent(db, CONTENT, 1000);
  const { member, portal } = await joinedMember(fixture);
  const code = CONTENT.programs[0].code;

  const home = (await call('get', '/m/home', portal).expect(200)).body;
  assert.equal(home.programs.length, CONTENT.programs.length);
  assert.ok(home.safety.body.length, 'หน้าแรกต้องมีข้อความความปลอดภัย');

  const program = (await call('get', `/m/programs/${code}`, portal).expect(200)).body;
  // Every station names a machine, and the screen needs its name and whether
  // the page it links to exists.
  assert.ok(program.program.stations.every(station => station.machine_name));
  assert.ok(program.program.stations.every(station => station.machine_exists));
  assert.ok(program.before_start.length);

  // Nobody at the gym has been through the numbers yet, and the payload says
  // so -- a set count printed with the gym's name on it reads as instruction
  // from the gym whether or not anybody meant it to.
  assert.equal(program.program.values_are_examples, true);

  // The membership ends. Nothing about the session changes.
  db.prepare("UPDATE entitlements SET status='revoked',revoked_at=? WHERE member_id=?")
    .run(fixture.at(), member.id);
  const shut = await call('get', `/m/programs/${code}`, portal).expect(402);
  assert.equal(shut.body.expired, true);
  assert.ok(shut.body.expired_on, 'ต้องบอกวันที่หมดอายุ ไม่ใช่แค่ปฏิเสธ');
  await call('get', '/m/home', portal).expect(402);

  // But the machine pages keep working, because they were never the paid part.
  await fixture.http.get(`/m/${CONTENT.machines[0].code}`).expect(200);
  await call('get', '/public/machines', null).expect(200);
});

test('only the owner edits content, and signing numbers off means something', async t => {
  const fixture = counterFixture(t);
  const { call, signIn, db } = fixture;
  importContent(db, CONTENT, 1000);
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');
  const { portal } = await joinedMember(fixture);
  const code = CONTENT.programs[0].code;

  for (const token of [desk, portal, null]) {
    const answer = await call('get', '/api/machines'.replace('/api', ''), token);
    assert.ok([401, 403].includes(answer.status), `สถานะ ${answer.status} — ต้องเป็นของเจ้าของยิมเท่านั้น`);
  }

  const current = (await call('get', '/programs', owner).expect(200)).body.items
    .find(item => item.code === code);
  const saved = (await call('put', `/programs/${code}`, owner, {
    name_th: current.name_th,
    stations: current.stations.map(station => ({ ...station, sets: '3 เซ็ต' })),
    values_are_examples: false,
    reviewed: true,
    version: current.version,
  }).expect(200)).body;

  // The flag is off, so the member's screen stops disclaiming the numbers.
  assert.equal(saved.values_are_examples, false);
  const seen = (await call('get', `/m/programs/${code}`, portal).expect(200)).body;
  assert.equal(seen.program.values_are_examples, false);
  assert.equal(seen.program.stations[0].sets, '3 เซ็ต');

  // And the import stops overwriting it, which is what the press really means.
  assert.equal(importContent(db, CONTENT, 5000).programs[0].action, 'kept');

  // Two owners on two tablets must not overwrite each other in silence.
  await call('put', `/programs/${code}`, owner,
    { name_th: 'x', stations: [], values_are_examples: true, version: 1 }).expect(409);
});

test('a YouTube link is read out of every shape people paste', async t => {
  assert.ok(t);
  assert.equal(youTubeId('https://www.youtube.com/watch?v=Udz8Wa0o6-o'), 'Udz8Wa0o6-o');
  assert.equal(youTubeId('https://youtu.be/Udz8Wa0o6-o'), 'Udz8Wa0o6-o');
  assert.equal(youTubeId('https://www.youtube.com/embed/Udz8Wa0o6-o'), 'Udz8Wa0o6-o');
  // Anything else draws no player rather than an embed of who knows what.
  assert.equal(youTubeId('https://vimeo.com/12345'), null);
  assert.equal(youTubeId(''), null);
  assert.equal(youTubeId(undefined), null);
});

test('the QR sheet is one page per gym, not per person, and belongs to the owner', async t => {
  const fixture = counterFixture(t);
  const { call, signIn, http, db } = fixture;
  importContent(db, CONTENT, 1000);
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');

  await http.get('/api/machines/qr-sheet').expect(401);
  await http.get('/api/machines/qr-sheet').set('Authorization', `Bearer ${desk}`).expect(403);

  const sheet = await http.get('/api/machines/qr-sheet').set('Authorization', `Bearer ${owner}`).expect(200);
  assert.match(sheet.headers['content-type'], /text\/html/);
  // One card per machine, each with a real QR image in it.
  assert.equal((sheet.text.match(/class="qr"/g) ?? []).length, CONTENT.machines.length);
  assert.equal((sheet.text.match(/data:image\/png;base64,/g) ?? []).length, CONTENT.machines.length);
  for (const machine of CONTENT.machines) assert.ok(sheet.text.includes(machine.name_th));
  // And it tells whoever prints it that no login is needed on the other end,
  // because that is the question they will be asked when they hand it over.
  assert.match(sheet.text, /ไม่ต้องเข้าสู่ระบบ/);
  assert.ok(call);
});
