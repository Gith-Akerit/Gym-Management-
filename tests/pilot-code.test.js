// The way the first administrator gets in, in pilot mode. It hands out a code
// that signs somebody in, so the narrow conditions on it are the whole point:
// pilot mode only, admin accounts only, and root on the server only -- the last
// of which is the terminal, not this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';

const CLI = new URL('../server/pilot-code.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gym-pilot-cli-'));
  const file = join(dir, 'gym.sqlite');
  const db = openDatabase(file); migrate(db); seedConfiguration(db, Date.now());
  // Two of these tests hand the file to a running app and close this handle
  // first, so the sweep up has to tolerate an already closed database.
  t.after(() => { try { db.close(); } catch { /* closed by the test */ } rmSync(dir, { recursive: true, force: true }); });

  const user = (email, role) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, email, role, Date.now());
    return id;
  };
  const run = (args, extra = {}) => {
    const env = { ...process.env, PILOT_MODE: '1', OTP_SECRET: SECRET, DATABASE_PATH: file,
      APP_ORIGIN: 'https://gym.example.test', ...extra };
    for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }) };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  const challenges = () => db.prepare('SELECT * FROM otp_challenges ORDER BY created_at').all();
  return { db, file, user, run, challenges };
}

const digitsIn = text => text.match(/^\s{2,}(\d{6})\s*$/m)?.[1];

test('an admin gets a code that actually signs them in', async t => {
  const { db, file, user, run, challenges } = fixture(t);
  user('owner@example.test', 'admin');

  const result = run(['owner@example.test']);
  assert.equal(result.code, 0, result.stderr);
  const code = digitsIn(result.stdout);
  assert.match(code ?? '', /^\d{6}$/, `no code in output:\n${result.stdout}`);

  // One live challenge, and the code is not sitting in the database next to it.
  const [challenge] = challenges();
  assert.equal(challenges().length, 1);
  assert.equal(challenge.email, 'owner@example.test');
  assert.equal(challenge.consumed_at, null);
  assert.ok(!JSON.stringify(challenge).includes(code));

  // The link carries the challenge the code belongs to, so the phone lands on
  // the right one instead of starting another.
  assert.ok(result.stdout.includes(`https://gym.example.test/?challenge=${challenge.id}`), result.stdout);

  // Issuing a code is recorded; the code itself is not.
  const entry = db.prepare("SELECT * FROM audit_logs WHERE action='auth.pilot_code_cli'").get();
  assert.ok(entry, 'nothing in the audit trail');
  assert.equal(entry.before_json, null);
  assert.equal(entry.after_json, null);
  assert.ok(!JSON.stringify(entry).includes(code));

  // The real proof: the running app accepts it. The CLI hashing the code its
  // own way would pass every check above and fail here.
  db.close();
  const live = openDatabase(file);
  const app = createApp({ db: live, secret: SECRET, sendOtp: async () => {}, pilotMode: true });
  const http = httpClient(app, t);
  const signedIn = await http.post('/api/auth/verify-otp').set('X-Gym-Client', 'mobile')
    .send({ challenge_id: challenge.id, code }).expect(200);
  assert.equal(signedIn.body.role, 'admin');
  // Closed here rather than in a hook: the fixture removes the directory the
  // file lives in, and Windows will not delete a file somebody still has open.
  app.locals.stopSweeper?.(); live.close();
});

test('a second code retires the first, so only the newest opens the door', async t => {
  const { file, user, run, challenges, db } = fixture(t);
  user('owner@example.test', 'admin');
  const first = digitsIn(run(['owner@example.test']).stdout);
  const second = digitsIn(run(['owner@example.test']).stdout);
  assert.notEqual(first, second);

  const rows = challenges();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].consumed_at, 'the earlier challenge is still live');
  assert.equal(rows[1].consumed_at, null);

  db.close();
  const live = openDatabase(file);
  const app = createApp({ db: live, secret: SECRET, sendOtp: async () => {}, pilotMode: true });
  const http = httpClient(app, t);
  const send = (id, code) => http.post('/api/auth/verify-otp').set('X-Gym-Client', 'mobile').send({ challenge_id: id, code });
  await send(rows[0].id, first).expect(400);
  await send(rows[1].id, second).expect(200);
  app.locals.stopSweeper?.(); live.close();
});

test('it refuses everyone it is not for', async t => {
  const { user, run, challenges } = fixture(t);
  user('owner@example.test', 'admin');
  user('member@example.test', 'member');
  user('counter@example.test', 'staff');

  // Off in a live gym: there the code is emailed, and a terminal command that
  // mints one for any administrator would be a way around that.
  const live = run(['owner@example.test'], { PILOT_MODE: undefined });
  assert.equal(live.code, 1);
  assert.match(live.stderr, /PILOT_MODE=1/);
  const off = run(['owner@example.test'], { PILOT_MODE: '0' });
  assert.equal(off.code, 1);

  // Members and staff read their codes from the admin console, which is the
  // point of pilot mode; this path is only for the account that cannot.
  for (const email of ['member@example.test', 'counter@example.test']) {
    const refused = run([email]);
    assert.equal(refused.code, 1, email);
    assert.match(refused.stderr, /ไม่ใช่ผู้ดูแลระบบ/);
  }

  assert.equal(run(['nobody@example.test']).code, 1);
  assert.equal(run([]).code, 1);
  assert.equal(run(['owner@example.test', 'extra']).code, 1);
  assert.equal(run(['owner@example.test'], { OTP_SECRET: 'too-short' }).code, 1);

  // Not one of those wrote anything a login could use.
  assert.equal(challenges().length, 0);
});
