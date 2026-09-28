// Getting back into a gym that is already running.
//
// The pilot box was installed before passwords existed. The owner's account is
// on it, it is an admin, and it opens nothing: there is no mail provider to
// send a reset through and no second admin to ask. The way in is a link printed
// at the terminal by whoever has shell access to the machine.
//
// What matters is that it works exactly once, dies on its own after a day, and
// leaves a trail -- issuing one is as good as being able to sign in as that
// person, so it has to be as visible as signing in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { counterFixture, PASSWORD } from './counter.js';
import { openDatabase, migrate } from '../server/db.js';
import { issueSetupToken, readSetupToken, SETUP_TTL_MS, setupPath } from '../server/password-setup.js';

const CLI = new URL('../server/admin-link.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** The account the real server has: an administrator with no password at all. */
function passwordlessAdmin(db, at, email = 'owner@gymalready.test') {
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,email,role,password_hash,created_at) VALUES(?,?,?,NULL,?)')
    .run(id, email, 'admin', at);
  return { id, email };
}

test('the link opens the set-password screen without signing in, and works once', async t => {
  const { call, db, at, tick } = counterFixture(t);
  const owner = passwordlessAdmin(db, at());
  const { token } = issueSetupToken(db, { userId: owner.id, now: at() });

  // Nothing about the account is reachable before the password exists.
  await call('post', '/auth/login', null, { email: owner.email, password: 'guess-me' }).expect(401);

  // The screen asks whose link this is before it shows a form: the owner opens
  // it in a browser that has never seen this gym.
  const opened = await call('get', `/auth/set-password/${token}`, null).expect(200);
  assert.equal(opened.body.email, owner.email);
  assert.equal(opened.body.expires_at, at() + SETUP_TTL_MS);

  const set = await call('post', '/auth/set-password', null,
    { token, password: 'a-real-password-now' }).expect(200);
  assert.equal(set.body.email, owner.email);

  // And that is the whole point: the owner can sign in.
  const signedIn = await call('post', '/auth/login', null,
    { email: owner.email, password: 'a-real-password-now' }).expect(200);
  assert.ok(signedIn.body.token);

  // The link is spent. A forwarded message or a browser's back button must not
  // hand the account to whoever opens it next.
  await call('get', `/auth/set-password/${token}`, null).expect(404);
  const reused = await call('post', '/auth/set-password', null,
    { token, password: 'somebody-elses-password' }).expect(404);
  assert.match(reused.body.error, /หมดอายุหรือถูกใช้ไปแล้ว/);
  tick(1000);
  await call('post', '/auth/login', null,
    { email: owner.email, password: 'a-real-password-now' }).expect(200);
});

test('a link dies after twenty-four hours whether anybody used it or not', async t => {
  const { call, db, at, tick } = counterFixture(t);
  const owner = passwordlessAdmin(db, at());
  const { token } = issueSetupToken(db, { userId: owner.id, now: at() });

  tick(SETUP_TTL_MS - 60000);
  await call('get', `/auth/set-password/${token}`, null).expect(200);
  tick(120000);
  await call('get', `/auth/set-password/${token}`, null).expect(404);
  await call('post', '/auth/set-password', null, { token, password: 'too-late-for-this' }).expect(404);
  // Expired rows do not sit on the disk of a gym that runs for years.
  assert.equal(readSetupToken(db, token, at()), null);
});

test('issuing a second link retires the first', async t => {
  const { call, db, at } = counterFixture(t);
  const owner = passwordlessAdmin(db, at());
  const first = issueSetupToken(db, { userId: owner.id, now: at() }).token;
  const second = issueSetupToken(db, { userId: owner.id, now: at() }).token;

  // Somebody who runs the command twice because the first message did not send
  // should not leave two working ways into the same account.
  await call('get', `/auth/set-password/${first}`, null).expect(404);
  await call('get', `/auth/set-password/${second}`, null).expect(200);
});

test('setting a password by link ends every session the account had open', async t => {
  const { call, db, signIn, at } = counterFixture(t);
  const token = await signIn('owner@example.test');
  await call('get', '/me', token).expect(200);
  const user = db.prepare('SELECT id,email FROM users WHERE email=?').get('owner@example.test');

  const link = issueSetupToken(db, { userId: user.id, now: at() }).token;
  await call('post', '/auth/set-password', null, { token: link, password: 'changed-by-the-owner' }).expect(200);

  // Whoever was holding a session on this account -- including whoever the
  // owner is taking it back from -- is signed out by the change.
  await call('get', '/me', token).expect(401);
  await call('post', '/auth/login', null, { email: user.email, password: PASSWORD }).expect(401);
  await call('post', '/auth/login', null, { email: user.email, password: 'changed-by-the-owner' }).expect(200);
});

test('a made-up token tells a guesser nothing, and a weak password is refused', async t => {
  const { call, db, at } = counterFixture(t);
  const owner = passwordlessAdmin(db, at());
  const { token } = issueSetupToken(db, { userId: owner.id, now: at() });

  for (const guess of ['x'.repeat(43), 'short', '../../etc/passwd', token.toUpperCase()]) {
    await call('get', `/auth/set-password/${encodeURIComponent(guess)}`, null)
      .expect(response => assert.equal(response.status, 404, `${guess} should not open anything`));
    await call('post', '/auth/set-password', null, { token: guess, password: 'trying-my-luck' })
      .expect(response => assert.ok(response.status >= 400, `${guess} should not set anything`));
  }
  const weak = await call('post', '/auth/set-password', null, { token, password: 'sh0rt' }).expect(400);
  assert.ok(weak.body.fields?.password || weak.body.error);
  // The refusal must not have spent the link: the owner is standing there
  // about to type a longer one.
  await call('post', '/auth/set-password', null, { token, password: 'long-enough-to-keep' }).expect(200);
});

// ------------------------------------------------------------------- the CLI

function cliFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gym-adminlink-'));
  const file = join(dir, 'gym.sqlite');
  const open = () => { const db = openDatabase(file); handles.push(db); return db; };
  const handles = [];
  // Windows will not delete a file that is still open, so every handle this
  // fixture handed out is closed before the directory goes.
  t.after(() => {
    for (const db of handles) { try { db.close(); } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (args, env = {}) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, DATABASE_PATH: file, ENV_FILE: join(dir, 'no-such.env'), ...env },
        encoding: 'utf8',
      }) };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  return { file, run, open };
}

test('the CLI prints a working link for the owner and writes it down', async t => {
  const { run, open } = cliFixture(t);
  // A database made the way the real box has one: migrated, with the owner's
  // account already on it and no password against it.
  const setup = open(); migrate(setup);
  const owner = passwordlessAdmin(setup, Date.now());
  setup.close();

  const issued = run([owner.email], { APP_ORIGIN: 'https://gym.example.com/' });
  assert.equal(issued.code, 0, issued.stderr);
  const [firstLine] = issued.stdout.split(/\r?\n/);
  // The first line is the link and nothing else, so it survives being copied
  // out of a terminal that wrapped the rest.
  assert.match(firstLine, /^https:\/\/gym\.example\.com\/\?setpw=[A-Za-z0-9_-]{43}$/);
  assert.match(issued.stdout, /ใช้ได้ครั้งเดียว/);
  const token = firstLine.split('setpw=')[1];

  const db = open();
  assert.ok(readSetupToken(db, token, Date.now()), 'the printed token is the one on disk');
  // Only the hash is stored: a copy of the database is not a way in.
  const row = db.prepare('SELECT * FROM password_setup_tokens').get();
  assert.ok(!JSON.stringify(row).includes(token));

  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='user.password_link_cli'").get();
  assert.ok(entry, 'issuing one is as good as signing in, so it is written down');
  assert.equal(entry.entity_id, owner.id);
  assert.equal(JSON.parse(entry.after_json).issued_from, 'cli');
});

test('the CLI refuses an address it should not be used on', async t => {
  const { run, open } = cliFixture(t);
  const db = open(); migrate(db);
  const now = Date.now();
  db.prepare('INSERT INTO users(id,email,role,password_hash,created_at) VALUES(?,?,?,NULL,?)')
    .run(randomUUID(), 'desk@example.test', 'staff', now);
  db.prepare('INSERT INTO users(id,email,role,password_hash,status,created_at) VALUES(?,?,?,NULL,?,?)')
    .run(randomUUID(), 'gone@example.test', 'admin', 'suspended', now);
  db.close();

  // Not a way to mint a password for the staff account, or to wake a suspended
  // owner up: both of those are decisions somebody makes in the app.
  assert.equal(run(['nobody@example.test']).code, 1);
  const staff = run(['desk@example.test']);
  assert.equal(staff.code, 1);
  assert.match(staff.stderr, /not an administrator/);
  const suspended = run(['gone@example.test']);
  assert.equal(suspended.code, 1);
  assert.match(suspended.stderr, /suspended/);
  assert.equal(run(['not-an-email']).code, 1);

  const after = open();
  assert.equal(after.prepare('SELECT count(*) AS n FROM password_setup_tokens').get().n, 0);
});

test('the path is relative so it works on whatever hostname the gym uses', () => {
  assert.equal(setupPath('abc'), '/?setpw=abc');
});
