// The gym owner runs this in a hosting panel's browser terminal to put their
// own PromptPay ID and mail key on the server. Nobody is watching when they do,
// so the ways it can go wrong all have to be closed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const SCRIPT = new URL('../server/env-set.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function fixture(t, initial = '# ค่าคอนฟิกของยิม\nPORT=3000\nPROMPTPAY_ID=\n') {
  const dir = mkdtempSync(join(tmpdir(), 'gym-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, initial);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args, input) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args],
        { env: { ...process.env, ENV_FILE: file }, input, encoding: 'utf8' });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  return { file, run, text: () => readFileSync(file, 'utf8'), env: () => parseEnv(readFileSync(file, 'utf8')) };
}

test('a value goes in once and the rest of the file is left alone', async t => {
  const { run, text, env } = fixture(t);
  const first = run(['PROMPTPAY_ID=0812345678']);
  assert.equal(first.code, 0);
  assert.equal(env().PROMPTPAY_ID, '0812345678');

  // The comment, the order and the other values all survive: this file is the
  // whole configuration of a running gym, not a scratch pad.
  assert.match(text(), /^# ค่าคอนฟิกของยิม\nPORT=3000\n/);
  assert.equal(env().PORT, '3000');

  // Setting it again replaces the line rather than adding a second one that
  // would shadow it depending on which the reader saw first.
  run(['PROMPTPAY_ID=0899999999']);
  assert.equal(text().match(/^PROMPTPAY_ID=/gm).length, 1);
  assert.equal(env().PROMPTPAY_ID, '0899999999');

  // A key that was not there before is appended.
  run(['SMTP_USER=gym@example.test', 'MAIL_FROM=noreply@example.test']);
  assert.equal(env().SMTP_USER, 'gym@example.test');
  assert.equal(env().MAIL_FROM, 'noreply@example.test');
});

test('an SMTP key full of punctuation comes back out exactly as it went in', async t => {
  // A mail provider's key is whatever they decided to generate. If one
  // character of it is lost in the file, nothing fails loudly -- members simply
  // stop receiving the code they are standing there waiting for.
  const { run, env } = fixture(t);
  const awkward = [
    'xsmtpsib-0123456789abcdef-AbC#dEf',
    'has spaces and a # hash',
    'quotes "inside" it',
    "an apostrophe's key",
    'back`tick',
    'mixed "double" and \'single\'',
    'trailing-space ',
  ];
  for (const value of awkward) {
    assert.equal(run([`SMTP_PASSWORD=${value}`]).code, 0, `refused: ${value}`);
    assert.equal(env().SMTP_PASSWORD, value, `mangled: ${value}`);
  }
});

test('nothing is printed that a shared screen should not show', async t => {
  const { run } = fixture(t);
  const secret = 'xsmtpsib-super-secret-value';
  const wrote = run([`SMTP_PASSWORD=${secret}`]);
  assert.ok(!wrote.stdout.includes(secret), 'the value was echoed back onto the screen');
  assert.match(wrote.stdout, /added\s+SMTP_PASSWORD/);

  const listed = run(['--list']);
  assert.ok(!listed.stdout.includes(secret));
  assert.match(listed.stdout, /set\s+SMTP_PASSWORD/);
  assert.match(listed.stdout, /EMPTY\s+PROMPTPAY_ID/, 'the point of the list is seeing what is still missing');
});

test('a value can be piped in instead of typed on the command line', async t => {
  const { run, env } = fixture(t);
  assert.equal(run(['--stdin', 'SMTP_PASSWORD'], 'piped-secret\n').code, 0);
  // The newline the shell adds is not part of the key.
  assert.equal(env().SMTP_PASSWORD, 'piped-secret');
});

test('a mistyped command changes nothing at all', async t => {
  const { run, text } = fixture(t);
  const before = text();
  for (const args of [['promptpay_id=1'], ['PROMPTPAY-ID=1'], ['=1'], ['--stdin']]) {
    const result = run(args);
    assert.equal(result.code, 1, `${args} should have been refused`);
    assert.equal(text(), before, `${args} changed the file`);
  }
  // A value containing all three quote characters cannot be represented in a
  // way Node reads back intact, so it is refused rather than half-written.
  const impossible = run([`X=${'a"b\'c`d'}`]);
  assert.equal(impossible.code, 1);
  assert.equal(text(), before);
});
