// What the front door offers, and the ways back in behind it.
//
// The gym decided its front door is for the four people who work here. That
// is a decision, not a deletion: everything the public sign-up form does still
// exists and is still tested, behind one flag. What this file proves is that
// with the flag off there is no door at all -- not a hidden button, not a form
// that answers politely, nothing that accepts a request.
//
// And that when there is no door, there is still a way in for somebody who
// forgot their password and a gym whose mailbox is not set up yet: a link the
// owner makes and hands over. Never a link on a public screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture } from './counter.js';

const APPLICANT = {
  email: 'nid@example.test', name: 'นิด ขยันมาก', phone: '0891112222',
  password: 'counter-test-password',
};

test('with sign-up off there is no form, no queue and nothing that accepts a request', async t => {
  const { call, signIn, db, outbox } = counterFixture(t);
  const owner = await signIn('owner@example.test');

  // 404, not 403: "this does not exist here" is the truth, and it is also
  // what tells somebody scanning for open sign-up forms the least.
  const shut = await call('post', '/auth/signup', null, APPLICANT).expect(404);
  assert.match(shut.body.error, /[ก-๙]/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 0);
  assert.equal(outbox.length, 0, 'ประตูที่ปิดอยู่ต้องไม่ส่งเมลหาใครเลย');

  // The screen reads this to decide what to draw, before anybody has signed in.
  assert.equal((await call('get', '/public/theme', null).expect(200)).body.self_signup, false);

  // The queue is empty rather than absent as a concept: the owner may still
  // have somebody waiting from before the door was shut.
  assert.equal((await call('get', '/users/requests', owner).expect(200)).body.items.length, 0);
});

test('with sign-up on, the whole journey is still there', async t => {
  const { call, signIn } = counterFixture(t, { selfSignup: true });
  await signIn('owner@example.test');
  assert.equal((await call('get', '/public/theme', null).expect(200)).body.self_signup, true);
  await call('post', '/auth/signup', null, APPLICANT).expect(202);
});

test('the owner makes a link and hands it over, and it works exactly once', async t => {
  const { call, signIn, db, tick } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  // A member of staff, which is the case the terminal command cannot cover --
  // it is limited to administrators because it runs with nobody signed in.
  await signIn('desk@example.test', 'staff');
  const desk = db.prepare('SELECT id FROM users WHERE email=?').get('desk@example.test');

  const issued = (await call('post', `/users/${desk.id}/password-link`, owner, {}).expect(200)).body;
  assert.equal(issued.email, 'desk@example.test');
  assert.match(issued.url, /\/\?setpw=[A-Za-z0-9_-]{43}$/);
  const token = /setpw=([A-Za-z0-9_-]{43})/.exec(issued.url)[1];

  // Handed over, opened, used, dead.
  assert.equal((await call('get', `/auth/set-password/${token}`, null).expect(200)).body.email, 'desk@example.test');
  await call('post', '/auth/set-password', null, { token, password: 'a-brand-new-password' }).expect(200);
  await call('post', '/auth/set-password', null, { token, password: 'another-one-here' }).expect(404);
  await call('post', '/auth/login', null, { email: 'desk@example.test', password: 'a-brand-new-password' }).expect(200);

  // A day, like the link the terminal command makes: this one is handed over
  // by hand and may sit in a chat overnight.
  const next = (await call('post', `/users/${desk.id}/password-link`, owner, {}).expect(200)).body;
  tick(25 * 3600000);
  await call('get', `/auth/set-password/${/setpw=([A-Za-z0-9_-]{43})/.exec(next.url)[1]}`, null).expect(404);
});

test('a link is the owner\'s to make, and never appears on a public screen', async t => {
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const desk = await signIn('desk@example.test', 'staff');
  const deskId = db.prepare('SELECT id FROM users WHERE email=?').get('desk@example.test').id;

  // Staff cannot make one for anybody, including themselves. The whole value
  // of the link is that an owner took responsibility for the press.
  await call('post', `/users/${deskId}/password-link`, desk, {}).expect(403);
  await call('post', `/users/${deskId}/password-link`, null, {}).expect(401);

  // A suspended account does not get a way back in by the back door.
  await call('post', `/users/${deskId}/suspend`, owner, {}).expect(200);
  await call('post', `/users/${deskId}/password-link`, owner, {}).expect(409);

  // And the public page still answers one sentence with no link in it,
  // whoever asks. A link on that screen would let anybody set anybody's
  // password from a page that needs no session at all.
  const forgot = await call('post', '/auth/forgot', null, { email: 'owner@example.test' }).expect(200);
  assert.equal(JSON.stringify(forgot.body).includes('setpw'), false, 'หน้าลืมรหัสผ่านต้องไม่มีลิงก์บนจอเด็ดขาด');
});

test('everybody can change their own password, and the old one is required', async t => {
  const { call, signIn, db } = counterFixture(t);
  // Staff, not just the owner: handing somebody a temporary password is only
  // safe if they can replace it themselves.
  const desk = await signIn('desk@example.test', 'staff');
  const phone = await signIn('desk@example.test', 'staff');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);

  // The session is exactly what an unattended tablet hands to a stranger, so
  // being signed in proves nothing at this particular moment.
  const wrong = await call('post', '/auth/change-password', desk,
    { current_password: 'not-the-password', password: 'a-brand-new-password' }).expect(403);
  assert.match(wrong.body.error, /รหัสผ่านเดิม/);

  await call('post', '/auth/change-password', desk,
    { current_password: 'counter-test-password', password: 'counter-test-password' }).expect(400);

  const done = await call('post', '/auth/change-password', desk,
    { current_password: 'counter-test-password', password: 'a-brand-new-password' }).expect(200);
  assert.equal(done.body.other_sessions_closed, 1);

  // The other copy is signed out; the tablet in the hand of the person doing
  // the right thing is not.
  await call('get', '/me', phone).expect(401);
  await call('get', '/me', desk).expect(200);
  await call('post', '/auth/login', null,
    { email: 'desk@example.test', password: 'a-brand-new-password' }).expect(200);
  await call('post', '/auth/login', null,
    { email: 'desk@example.test', password: 'counter-test-password' }).expect(401);
});

test('a member with an address gets their card, and one without is not a broken button', async t => {
  const { call, signIn, addMember, outbox, db, noMailbox } = counterFixture(t);
  const desk = await signIn('desk@example.test', 'staff');

  const anonymous = await addMember(desk, { name: 'ไม่มีอีเมล', phone: '0899000001' });
  await call('post', `/members/${anonymous.id}/welcome`, desk, {}).expect(409);

  const member = await addMember(desk, { name: 'มีอีเมล จริง', phone: '0899000002', email: 'member@example.test' });
  const sent = await call('post', `/members/${member.id}/welcome`, desk, {}).expect(200);
  assert.equal(sent.body.to, 'member@example.test');

  const letter = outbox.at(-1);
  assert.match(letter.subject, /บัตรสมาชิก/);
  // The card is an attachment, not an image in the body: a mail client that
  // blocks remote images must not turn a member's card into an empty box.
  assert.equal(letter.attachments.length, 1);
  assert.equal(letter.attachments[0].contentType, 'image/png');
  assert.equal(letter.attachments[0].filename, `${member.member_code}.png`);
  assert.equal(letter.attachments[0].content.subarray(1, 4).toString(), 'PNG');
  assert.equal(letter.html.includes('<img'), false, 'จดหมายต้องไม่มีรูปฝังในเนื้อ');
  assert.equal(/\{\{[a-z_]+\}\}/.test(letter.text), false, 'ต้องไม่มีตัวแปรที่ยังไม่ถูกแทนค่าเหลือ');
  // Somebody who joined without buying anything has no expiry date, so the
  // line is gone rather than printed with a dash.
  assert.equal(letter.text.includes('แพ็กเกจ'), false);
  assert.ok(letter.text.includes(member.member_code));

  assert.ok(db.prepare('SELECT welcome_sent_at w FROM members WHERE id=?').get(member.id).w,
    'ส่งแล้วต้องบันทึกไว้ หน้าจอจะได้บอกว่าเคยส่งไปแล้ว');

  // And a gym that has not filled in its mailbox is told so, rather than
  // being given a tick for a letter that went nowhere.
  noMailbox();
  const refused = await call('post', `/members/${member.id}/welcome`, desk, {}).expect(409);
  assert.match(refused.body.error, /ตั้งค่าอีเมล/);
});

test('staff fix an address at the counter, and are told if the card already went', async t => {
  // QA-01: there was no screen for this at all. An address mistyped by one
  // character meant the member's card -- a QR that opens the door, in a PNG --
  // had been emailed to a stranger, and nothing on any screen could change it.
  const fixture = counterFixture(t);
  const { call, signIn, addMember, db } = fixture;
  const desk = await signIn('desk@example.test', 'staff');
  const member = await addMember(desk, { name: 'พิมพ์ผิด ทดสอบ', phone: '0899000777', email: 'wrogn@example.test' });

  // Before the card goes out, a correction is just a correction.
  const quiet = (await call('put', `/members/${member.id}`, desk,
    { name: member.name, phone: member.phone, email: 'right@example.test', version: member.version }).expect(200)).body;
  assert.equal(quiet.email, 'right@example.test');
  assert.equal(quiet.card_went_to, undefined, 'ยังไม่เคยส่งบัตร ไม่ต้องเตือน');
  // Staff, not only the owner -- and the audit row is what makes that safe.
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='member.update' AND entity_id=?").get(member.id));

  // Now the card goes out, and the address turns out to be wrong after all.
  await call('post', `/members/${member.id}/welcome`, desk, {}).expect(200);
  assert.ok(db.prepare('SELECT welcome_sent_at w FROM members WHERE id=?').get(member.id).w);

  const after = (await call('put', `/members/${member.id}`, desk, {
    name: member.name, phone: member.phone, email: 'actually-right@example.test',
    version: quiet.version,
  }).expect(200)).body;
  // The screen has to be able to say WHERE it went, because the answer to
  // "a stranger has the card" is a new card and the answer to "that was my
  // old address" is nothing at all.
  assert.equal(after.card_went_to, 'right@example.test');
  // And the new address has not been sent anything, which puts the bar back
  // on the card screen rather than leaving it looking sent.
  assert.equal(db.prepare('SELECT welcome_sent_at w FROM members WHERE id=?').get(member.id).w, null);

  // Deactivating is still the owner's: it is a decision, not a correction.
  await call('delete', `/members/${member.id}`, desk, { version: after.version }).expect(403);
});
