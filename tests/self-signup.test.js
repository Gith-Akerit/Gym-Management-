// Asking for an account, and the owner deciding.
//
// Two things are load-bearing and neither is visible on the screen.
//
// The sign-up form must not become the tool that tells somebody which email
// addresses belong to this gym. The login screen was built carefully not to
// say that -- "no such account", "no password set" and "wrong password" all
// answer the same sentence -- and a sign-up form that replies differently for
// an address that already exists gives the whole thing away in one request.
//
// And an account that is waiting must open nothing. Not "shows fewer menus":
// the session must not be issued at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterFixture } from './counter.js';
import { createMailer, ownerNotice } from '../server/mail.js';
import { letter, variablesUsed } from '../server/letters.js';

const APPLICANT = { email: 'nid@example.test', name: 'นิด ขยันมาก', phone: '0891112222', password: 'counter-test-password' };

const signup = (call, values = {}) => call('post', '/auth/signup', null, { ...APPLICANT, ...values });

/** Signs up and then opens the link in the letter, the way a person does. */
async function signupAndVerify(fixture, values = {}) {
  await signup(fixture.call, values).expect(202);
  const token = fixture.verifyToken();
  assert.ok(token, 'ต้องมีลิงก์ยืนยันอีเมลในจดหมายฉบับแรก');
  await fixture.call('get', `/auth/verify/${token}`, null).expect(200);
  return token;
}

test('a request arrives, opens nothing, and is visible to the owner', async t => {
  const { call, signIn, db, at } = counterFixture(t, { selfSignup: true });
  const owner = await signIn('owner@example.test');

  const sent = await signup(call).expect(202);
  assert.equal(sent.body.pending, true);
  assert.match(sent.body.message, /อนุมัติ/);

  const row = db.prepare('SELECT * FROM users WHERE email=?').get(APPLICANT.email);
  assert.equal(row.approval, 'pending');
  assert.equal(row.name, 'นิด ขยันมาก');
  assert.equal(row.phone, '0891112222');
  assert.equal(row.requested_at, at());
  // The password is theirs from the start: approving does not mean handing one
  // out, which is what made the old flow need a link for every new person.
  assert.ok(row.password_hash);

  // The right password and still no way in.
  const refused = await call('post', '/auth/login', null,
    { email: APPLICANT.email, password: APPLICANT.password }).expect(403);
  assert.match(refused.body.error, /รอเจ้าของยิมอนุมัติ/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1, 'มี session ของเจ้าของคนเดียว');

  const waiting = await call('get', '/users/requests', owner).expect(200);
  assert.equal(waiting.body.items.length, 1);
  assert.equal(waiting.body.items[0].name, 'นิด ขยันมาก');
  assert.equal(waiting.body.items[0].approval, 'pending');
});

test('the form says the same thing about an address that already has an account', async t => {
  const { call, signIn, db } = counterFixture(t, { selfSignup: true });
  await signIn('owner@example.test');

  const first = await signup(call).expect(202);
  // Same status, same body. Anything that differs here is the answer to "does
  // this gym know that address?", which is not a question this form answers.
  const again = await signup(call, { name: 'คนอื่น', phone: '0899998888' }).expect(202);
  assert.deepEqual(again.body, first.body);

  // And nothing was written the second time: the name of the first request is
  // still the one the owner sees.
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 1);
  assert.equal(db.prepare('SELECT name FROM users WHERE email=?').get(APPLICANT.email).name, 'นิด ขยันมาก');

  // The same holds for an address that belongs to a working account.
  const known = await signup(call, { email: 'owner@example.test' }).expect(202);
  assert.deepEqual(known.body, first.body);
  const owner = db.prepare('SELECT * FROM users WHERE email=?').get('owner@example.test');
  assert.equal(owner.approval, 'approved', 'บัญชีที่ใช้งานอยู่ต้องไม่ถูกคำขอใหม่แตะ');
  assert.equal(owner.role, 'admin');
});

test('the owner approves, chooses the role, and the person is in', async t => {
  const fixture = counterFixture(t, { selfSignup: true });
  const { call, signIn, db } = fixture;
  const owner = await signIn('owner@example.test');
  await signupAndVerify(fixture);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  const approved = await call('post', `/users/${request.id}/approve`, owner, { role: 'staff' }).expect(200);
  assert.equal(approved.body.approval, 'approved');
  assert.equal(approved.body.role, 'staff');

  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='user.approve'").get();
  assert.ok(entry, 'การอนุมัติต้องถูกบันทึกว่าใครอนุมัติ');
  assert.equal(entry.actor_id, db.prepare('SELECT id FROM users WHERE email=?').get('owner@example.test').id);

  // In, with the password they chose when they asked. No link, no handover.
  const signedIn = await call('post', '/auth/login', null,
    { email: APPLICANT.email, password: APPLICANT.password }).expect(200);
  assert.equal(signedIn.body.role, 'staff');

  // The queue is empty and deciding twice is refused rather than silently redone.
  assert.equal((await call('get', '/users/requests', owner)).body.items.length, 0);
  await call('post', `/users/${request.id}/approve`, owner, { role: 'admin' }).expect(409);
});

test('a refusal keeps the record, says why, and does not free the address', async t => {
  const { call, signIn, db } = counterFixture(t, { selfSignup: true });
  const owner = await signIn('owner@example.test');
  await signup(call).expect(202);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  await call('post', `/users/${request.id}/reject`, owner, { reason: '' }).expect(400);
  const rejected = await call('post', `/users/${request.id}/reject`, owner,
    { reason: 'ไม่ใช่พนักงานของยิมนี้' }).expect(200);
  assert.equal(rejected.body.approval, 'rejected');
  assert.equal(rejected.body.reject_reason, 'ไม่ใช่พนักงานของยิมนี้');

  const refused = await call('post', '/auth/login', null,
    { email: APPLICANT.email, password: APPLICANT.password }).expect(403);
  assert.match(refused.body.error, /ไม่ได้รับอนุมัติ/);

  // The row stays: deleting it would let the same address ask again a minute
  // later and would throw away the fact that somebody said no.
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE email=?').get(APPLICANT.email).n, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_logs WHERE action='user.reject'").get());
  await signup(call).expect(202);
  assert.equal(db.prepare('SELECT approval FROM users WHERE email=?').get(APPLICANT.email).approval, 'rejected');
});

test('deciding belongs to the owner, and the form to nobody in particular', async t => {
  const { call, signIn } = counterFixture(t, { selfSignup: true });
  const owner = await signIn('owner@example.test');
  const staff = await signIn('desk@example.test', 'staff');
  await signup(call).expect(202);
  const request = (await call('get', '/users/requests', owner).expect(200)).body.items[0];

  await call('get', '/users/requests', staff).expect(403);
  await call('post', `/users/${request.id}/approve`, staff, { role: 'admin' }).expect(403);
  await call('post', `/users/${request.id}/reject`, staff, { reason: 'ไม่' }).expect(403);
  await call('get', '/users/requests', null).expect(401);
  // Signing up needs no session at all -- that is the point of it.
  await signup(call, { email: 'another@example.test' }).expect(202);
});

test('what the form refuses to accept', async t => {
  const { call } = counterFixture(t, { selfSignup: true });
  for (const [what, values] of Object.entries({
    'อีเมลไม่ถูกต้อง': { email: 'not-an-email' },
    'ไม่มีชื่อ': { name: '   ' },
    'เบอร์ไม่ใช่มือถือไทย': { phone: '021234567' },
    'รหัสผ่านสั้นเกิน': { password: 'sn' },
  })) {
    const refused = await signup(call, values).expect(400);
    assert.match(JSON.stringify(refused.body), /[ก-๙]/, `${what} ต้องตอบเป็นภาษาไทย`);
  }
});

test('one address cannot send sixty requests', async t => {
  const { call } = counterFixture(t, { selfSignup: true });
  for (let n = 0; n < 10; n += 1) await signup(call, { email: `n${n}@example.test` }).expect(202);
  const stopped = await signup(call, { email: 'eleventh@example.test' }).expect(429);
  assert.match(stopped.body.error, /[ก-๙]/);
});

test('the mailer keeps the flow alive when the gym has not filled in its mailbox', async t => {
  assert.ok(t);
  // Not configured: it says so and does not throw, which is what lets every
  // screen above it be finished before the owner has typed a mailbox password.
  const quiet = createMailer({ load: () => null });
  assert.equal(quiet.ready, false);
  assert.deepEqual(await quiet.send({ to: 'a@b.test', subject: 'x', text: 'y' }),
    { sent: false, reason: 'not_configured' });
  // Half-filled counts as not configured. A host with no password is a form
  // somebody abandoned, not a mailbox.
  const half = createMailer({ load: () => ({ host: 'smtp.office365.com', port: 587, username: 'info@gym.test' }) });
  assert.equal(half.ready, false);

  // Configured: one SMTP message carrying both halves of the letter, with the
  // gym's own name as the sender rather than the word no-reply.
  const sent = [];
  const settings = { host: 'smtp.office365.com', port: 587, starttls: true,
    username: 'info@suklutai.co.th', password: 'app-password', from_email: 'info@suklutai.co.th', from_name: 'ยิม' };
  let options = null;
  const live = createMailer({
    load: () => settings,
    transportFor: config => { options = config; return { sendMail: async message => { sent.push(message); return { accepted: [message.to] }; } }; },
  });
  const built = letter('2-approved', {
    gym_name: 'สุขฤทัย ฟิตเนส', gym_phone: '038-541-029', email: 'nid@example.test',
    role: 'staff', brand_surface: '#DD610B', on_brand: '#0E1418',
    login_url: 'https://gym.example', signin_method: 'อีเมลและรหัสผ่านที่คุณตั้งไว้ตอนสมัคร',
  });
  assert.deepEqual(await live.send({ to: 'nid@example.test', senderName: 'สุขฤทัย ฟิตเนส', ...built }), { sent: true });

  // 587 is STARTTLS. requireTLS is the part that matters: without it a server
  // that fails to offer STARTTLS gets the mailbox password in the clear.
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.auth.user, 'info@suklutai.co.th');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].from.name, 'สุขฤทัย ฟิตเนส', 'ผู้รับต้องเห็นชื่อยิม ไม่ใช่คำว่า no-reply');
  assert.equal(sent[0].from.address, 'info@suklutai.co.th');
  assert.ok(sent[0].text, 'ต้องมีฉบับข้อความล้วนเสมอ');
  assert.ok(sent[0].html, 'และฉบับ HTML คู่กัน');
  // Transactional mail: a newsletter header gets it filed as a newsletter.
  assert.equal(JSON.stringify(sent[0]).includes('List-Unsubscribe'), false);

  // A mailbox that refuses the password must never become a gym that cannot
  // approve somebody: the decision is already written down. And the answer has
  // to be one the owner can act on, not the provider's English.
  const refused = createMailer({
    load: () => settings,
    transportFor: () => ({ sendMail: async () => { const error = new Error('535 5.7.139 Authentication unsuccessful'); error.responseCode = 535; throw error; } }),
  });
  const failure = await refused.send({ to: 'a@b.test', subject: 'x', text: 'y' });
  assert.equal(failure.sent, false);
  assert.equal(failure.reason, 'auth');
  assert.match(failure.message, /Authenticated SMTP/);

  const offline = createMailer({
    load: () => settings,
    transportFor: () => ({ sendMail: async () => { const error = new Error('connect ECONNREFUSED'); error.code = 'ECONNREFUSED'; throw error; } }),
  });
  assert.equal((await offline.send({ to: 'a@b.test', subject: 'x', text: 'y' })).reason, 'network');
});

test('the four letters come out filled in, in Thai, with nothing left over', async t => {
  assert.ok(t);
  const context = {
    gym_name: 'สุขฤทัย ฟิตเนส', gym_phone: '038-541-029',
    brand_surface: '#DD610B', on_brand: '#0E1418', email: 'nid@example.test',
  };
  const built = {
    '1-verify-email': letter('1-verify-email', { ...context, name: 'นิด', verify_url: 'https://gym.example/?verify=t' }),
    '2-approved': letter('2-approved', { ...context, name: 'นิด', role: 'admin', login_url: 'https://gym.example', signin_method: 'บัญชี Google ของคุณ' }),
    '3-rejected': letter('3-rejected', { ...context, name: 'นิด' }),
    '4-reset-password': letter('4-reset-password', { ...context, name: 'นิด', reset_url: 'https://gym.example/?setpw=t' }),
  };
  for (const [key, mail] of Object.entries(built)) {
    assert.match(mail.subject, /[ก-๙]/, key);
    assert.match(mail.subject, /สุขฤทัย ฟิตเนส/, `${key}: หัวเรื่องต้องมีชื่อยิม`);
    // A hole nobody filled is the failure that reaches a real inbox looking
    // like {{name}}, so both halves are checked.
    assert.equal((mail.html.match(/\{\{[a-z_]+\}\}/g) ?? []).length, 0, `${key}: HTML ยังมีตัวแปรค้าง`);
    assert.equal((mail.text.match(/\{\{[a-z_]+\}\}/g) ?? []).length, 0, `${key}: ข้อความล้วนยังมีตัวแปรค้าง`);
    // The Designer's rules, checked rather than trusted.
    assert.equal((mail.html.match(/<img/gi) ?? []).length, 0, `${key}: อีเมลต้องไม่มีรูป`);
    assert.equal((mail.html.match(/<script/gi) ?? []).length, 0, `${key}: ต้องไม่มีสคริปต์`);
    assert.equal((mail.html.match(/<style/gi) ?? []).length, 0, `${key}: CSS ต้อง inline ทั้งหมด`);
    assert.ok(mail.html.length < 20000, `${key}: ยาวเกินจนอาจถูกตัด`);
    // Every line of the plain-text twin fits in a terminal-width mailbox.
    for (const line of mail.text.split('\n')) {
      assert.ok([...line].length <= 78, `${key}: บรรทัดยาวเกิน 78 ตัวอักษร -> ${line}`);
    }
  }
  // Exactly one link, and it is the one that letter is about.
  assert.equal((built['3-rejected'].html.match(/https?:\/\//g) ?? []).length, 0,
    'ฉบับปฏิเสธต้องไม่มีลิงก์เลย');
  assert.match(built['4-reset-password'].text, /30 นาที/);

  // The colour comes from the same engine that paints the card, not a
  // hardcoded white on a hardcoded green.
  assert.match(built['2-approved'].html, /#DD610B/);
  assert.match(built['2-approved'].html, /#0E1418/);

  assert.ok(variablesUsed().includes('gym_phone'));
});

test('a gym with no telephone number does not send a letter saying "โทร -"', async t => {
  assert.ok(t);
  const quiet = letter('3-rejected', { gym_name: 'ยิมไม่มีเบอร์', email: 'a@b.test', name: 'เอ' });
  assert.doesNotMatch(quiet.text, /โทร/, 'ต้องตัดทั้งประโยคออก ไม่ใช่ขึ้นว่า โทร -');
  assert.doesNotMatch(quiet.html, /โทร/);
  assert.equal((quiet.text.match(/\{\{[a-z_]+\}\}/g) ?? []).length, 0);
  // And the rest of the letter is still whole.
  assert.match(quiet.text, /ยิมไม่มีเบอร์/);
});

test('the note to the owner carries enough to decide with', async t => {
  assert.ok(t);
  const note = ownerNotice({ gym: 'ยิม', name: 'นิด', email: 'nid@example.test', phone: '0891112222' });
  assert.match(note.subject, /[ก-๙]/);
  assert.match(note.text, /nid@example.test/);
  assert.match(note.text, /0891112222/);
  // The warning the Designer asked for, where the owner reads it.
  assert.match(note.text, /รู้จักตัวจริง/);
});
