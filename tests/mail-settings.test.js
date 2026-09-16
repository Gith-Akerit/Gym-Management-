// The gym's own mailbox, and the two doors that depend on it.
//
// One idea is load-bearing across this whole file: the mailbox password is
// typed in by the owner and never comes back out. Not to a screen, not to an
// audit row, not to the log. Everything else here -- the sealing, the test
// button, the link the owner hands over when mail is not set up yet -- exists
// because of that one constraint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { counterFixture } from './counter.js';
import { newKey, open, readKey, seal } from '../server/secret-box.js';

/** The key lives in the environment, so a test that needs one puts it there. */
function withKey(t, value = newKey()) {
  const before = process.env.SETTINGS_ENC_KEY;
  process.env.SETTINGS_ENC_KEY = value;
  t.after(() => {
    if (before === undefined) delete process.env.SETTINGS_ENC_KEY;
    else process.env.SETTINGS_ENC_KEY = before;
  });
  return value;
}

const MAILBOX = {
  host: 'smtp.office365.com', port: 587, starttls: true,
  username: 'info@suklutai.co.th', password: 'app-password-here',
  from_email: 'info@suklutai.co.th', from_name: '',
};

test('a sealed password needs the right key, and says nothing without it', t => {
  const key = withKey(t);
  const sealed = seal('app-password-here');

  // Not the password, not a hash of it, not recoverable by looking at it.
  assert.equal(sealed.includes('app-password-here'), false);
  assert.match(sealed, /^v1\./);
  assert.equal(open(sealed), 'app-password-here');

  // A stolen .sqlite is a stolen file, not a stolen mailbox: the key is in
  // .env, which the database backup does not carry.
  assert.equal(open(sealed, readKey(newKey())), null);
  assert.equal(open(sealed, null), null);

  // A tampered ciphertext fails loudly rather than decrypting into rubbish
  // that would then be typed at a real SMTP server.
  const [version, iv, tag, body] = sealed.split('.');
  assert.equal(open([version, iv, tag, `${body}AAAA`].join('.')), null);
  assert.equal(open('not-a-sealed-value'), null);
  assert.ok(key);
});

test('a key that is not 32 bytes is refused rather than padded into one', t => {
  withKey(t, 'too-short');
  assert.equal(readKey(), null);
  assert.equal(readKey('  '), null);
  // Hex is what the documented one-liner makes; base64 is what a password
  // manager tends to produce. Both are 32 bytes and both are accepted.
  assert.equal(readKey(randomBytes(32).toString('hex'))?.length, 32);
  assert.equal(readKey(randomBytes(32).toString('base64'))?.length, 32);
});

test('the owner fills in the mailbox, and the password never comes back out', async t => {
  withKey(t);
  const { call, signIn, db } = counterFixture(t);
  const owner = await signIn('owner@example.test');

  const empty = (await call('get', '/gym/mail-settings', owner).expect(200)).body;
  assert.equal(empty.key_ready, true);
  assert.equal(empty.has_password, false);
  assert.equal(empty.ready, false);
  // Office 365 out of the box, because that is what this gym has.
  assert.equal(empty.host, 'smtp.office365.com');
  assert.equal(empty.port, 587);

  const saved = (await call('put', '/gym/mail-settings', owner,
    { ...MAILBOX, version: empty.version }).expect(200)).body;
  assert.equal(saved.has_password, true);
  assert.equal(saved.ready, true);
  // Byte for byte: there is no route in this system that returns it.
  assert.equal(JSON.stringify(saved).includes('app-password-here'), false);
  const audited = db.prepare("SELECT after_json FROM audit_logs WHERE action='gym.mail_settings_changed'").get();
  assert.equal(audited.after_json.includes('app-password-here'), false);
  assert.equal(db.prepare('SELECT password_sealed p FROM mail_settings WHERE id=1').get().p.includes('app-password-here'), false);

  // Saving again without a password keeps the one that is stored. A form that
  // cannot show the current value has to mean "leave it alone" by default, or
  // every change of the sender name wipes the mailbox.
  const again = (await call('put', '/gym/mail-settings', owner,
    { host: MAILBOX.host, port: 587, username: MAILBOX.username, from_email: MAILBOX.from_email,
      from_name: 'สุขฤทัย ฟิตเนส', version: saved.version }).expect(200)).body;
  assert.equal(again.has_password, true);
  assert.equal(again.from_name, 'สุขฤทัย ฟิตเนส');

  // An explicit empty string is the other instruction, and it is obeyed.
  const cleared = (await call('put', '/gym/mail-settings', owner,
    { ...MAILBOX, password: '', version: again.version }).expect(200)).body;
  assert.equal(cleared.has_password, false);
  assert.equal(cleared.ready, false);

  // Two owners on two tablets must not overwrite each other silently.
  await call('put', '/gym/mail-settings', owner, { ...MAILBOX, version: 1 }).expect(409);
});

test('staff are told whether mail works and nothing else about the mailbox', async t => {
  withKey(t);
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const version = (await call('get', '/gym/mail-settings', owner).expect(200)).body.version;
  await call('put', '/gym/mail-settings', owner, { ...MAILBOX, version }).expect(200);

  // The tab is on their screen too, because "is email working?" is a question
  // a member of staff gets asked at the counter. One sentence is the whole
  // answer -- no host, no username, and above all no hint of the mailbox the
  // gym signs in with (Designer, screen 8).
  const desk = await signIn('desk@example.test', 'staff');
  const seen = (await call('get', '/gym/mail-settings', desk).expect(200)).body;
  assert.deepEqual(Object.keys(seen).sort(), ['ready', 'staff']);
  assert.equal(seen.ready, true);

  // Everything that changes or proves anything stays with the owner.
  await call('put', '/gym/mail-settings', desk, { ...MAILBOX, version: 1 }).expect(403);
  await call('post', '/gym/mail-settings/test', desk, {}).expect(403);
  await call('get', '/gym/mail-settings', null).expect(401);
});

test('without a key the form refuses a password rather than storing one in the clear', async t => {
  withKey(t, '');
  const { call, signIn } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const view = (await call('get', '/gym/mail-settings', owner).expect(200)).body;
  assert.equal(view.key_ready, false);
  const refused = await call('put', '/gym/mail-settings', owner, { ...MAILBOX, version: view.version }).expect(409);
  assert.match(refused.body.error, /SETTINGS_ENC_KEY/);
});

test('the test button reports what the mail server really said', async t => {
  withKey(t);
  const { call, signIn, outbox } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const view = (await call('get', '/gym/mail-settings', owner).expect(200)).body;

  // Nothing filled in: there is nothing to prove, and saying so beats a green
  // tick that only means "we saved your form".
  await call('post', '/gym/mail-settings/test', owner, {}).expect(409);

  await call('put', '/gym/mail-settings', owner, { ...MAILBOX, version: view.version }).expect(200);
  const sent = await call('post', '/gym/mail-settings/test', owner, {}).expect(200);
  // To whoever pressed it, never to an address in the request body: a button
  // that posts anywhere sends mail in this gym's name to anybody.
  assert.equal(sent.body.to, 'owner@example.test');
  assert.equal(outbox.at(-1).to, 'owner@example.test');
  assert.equal(outbox.at(-1).senderName, 'ยิม', 'ผู้รับต้องเห็นชื่อยิม ไม่ใช่ที่อยู่กล่องจดหมาย');

  const after = (await call('get', '/gym/mail-settings', owner).expect(200)).body;
  assert.ok(after.tested_at, 'ผลการทดสอบต้องถูกบันทึกไว้ให้หน้าจอบอกได้ว่าใช้ได้ตั้งแต่เมื่อไหร่');
  assert.equal(after.test_ok, true);
});

test('a refusal from the mail server is written down in words the owner can act on', async t => {
  withKey(t);
  const { call, signIn, refuseMail } = counterFixture(t);
  const owner = await signIn('owner@example.test');
  const view = (await call('get', '/gym/mail-settings', owner).expect(200)).body;
  await call('put', '/gym/mail-settings', owner, { ...MAILBOX, version: view.version }).expect(200);

  refuseMail({ reason: 'auth', message: 'รหัสผ่านไม่ถูกต้อง หรือกล่องนี้ยังไม่ได้เปิด Authenticated SMTP' });
  const failed = await call('post', '/gym/mail-settings/test', owner, {}).expect(502);
  assert.match(failed.body.error, /Authenticated SMTP/);

  const after = (await call('get', '/gym/mail-settings', owner).expect(200)).body;
  assert.equal(after.test_ok, false);
  assert.match(after.test_detail, /Authenticated SMTP/);
  // And it still says a password is stored: the password is not what failed,
  // the mailbox is, and clearing it would make the owner type it again for
  // nothing.
  assert.equal(after.has_password, true);
});
