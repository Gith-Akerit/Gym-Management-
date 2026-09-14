// QA Release Tester — the two links (release/pilot at bb1aa74).
//
// Both hand somebody something without a session: one opens a member's card,
// the other sets the owner's password. A link that outlives what it was issued
// against is the failure worth hunting here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate, getMember } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';

const DAY = 86400000;
const THAI = /[฀-๿]/;

async function photograph() {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(400, 400);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8a27a'; ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = '#3b2a1d';
  ctx.beginPath(); ctx.arc(200, 170, 80, 0, Math.PI * 2); ctx.fill();
  return canvas.toBuffer('image/png');
}

function gym(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-link-'));
  const dbPath = join(dir, 'gym.sqlite');
  const db = openDatabase(dbPath); migrate(db); seedConfiguration(db, Date.now());
  const secret = randomBytes(32).toString('hex');
  let time = Date.parse('2026-09-15T09:00:00+07:00');
  const app = createApp({ db, secret, now: () => time,
    slipStore: new SlipStore(join(dir, 'slips')),
    photoStore: new SlipStore(join(dir, 'photos'), { maxBytes: 8 * 1024 * 1024 }),
    promptPayId: '0812345678', origin: 'http://localhost:5173' });
  t.after(() => {
    app.locals.stopSweeper?.(); db.close();
    for (let i = 0; i < 15; i++) {
      try { return rmSync(dir, { recursive: true, force: true }); } catch { /* still held */ }
    }
  });

  const call = (method, path, token, body) => {
    const req = request(app)[method](path.startsWith('/api') ? path : `/api${path}`).set('X-Gym-Client', 'web');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const raw = (method, path) => request(app)[method](path);
  const session = userId => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), userId, time + 365 * DAY);
    return token;
  };
  const staffUser = (email, role) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, email, role, time);
    return { id, email, token: session(id) };
  };
  let seq = 1;
  const member = (name = 'สุดา ใจดี') => {
    const id = randomUUID();
    db.prepare(`INSERT INTO members(id,member_code,name,phone,status,joined_at,updated_at)
      VALUES(?,?,?,?,'active',?,?)`)
      .run(id, `GYM-LK${String(seq).padStart(10, '0')}`, name, `08811100${String(seq++).padStart(2, '0')}`, time, time);
    return getMember(db, id);
  };
  /** Runs the CLI against this same database, the way the box does. */
  const cli = (args, env = {}) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, ['server/admin-link.js', ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_PATH: dbPath, APP_ORIGIN: 'https://gym.example.test', ...env },
      }), stderr: '' };
    } catch (e) { return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
  };
  return { db, app, call, raw, session, staffUser, member, cli, secret,
    tick: ms => { time += ms; }, at: () => time };
}

// ==================================================== the card link (7 days)
test('LINK-01 the link opens the card with no session, and only that card', async t => {
  const { app, call, raw, staffUser, member } = gym(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member('สุดา ใจดี');
  const other = member('อนงค์ ใจเย็น');
  await request(app).put(`/api/members/${suda.id}/photo`).set('X-Gym-Client', 'web')
    .set('Authorization', `Bearer ${staff.token}`)
    .attach('photo', await photograph(), { filename: 'face.png', contentType: 'image/png' }).expect(200);

  const issued = await call('post', `/members/${suda.id}/card/link`, staff.token, {});
  console.log('LINK-01 what the counter gets to send:', JSON.stringify({
    url: issued.body.url, days: Math.round((issued.body.expires_at - Date.now()) / DAY), version: issued.body.card_version }));
  assert.equal(issued.status, 200);
  assert.equal(issued.body.card_version, 1);

  const opened = await raw('get', issued.body.url);
  console.log('LINK-01 the customer opens it ->', opened.status, opened.headers['content-type'],
    '| cache:', opened.headers['cache-control'], '|', opened.body.length, 'bytes');
  assert.equal(opened.status, 200);
  assert.match(opened.headers['content-type'], /image\/png/);
  assert.match(opened.headers['cache-control'] ?? '', /no-store/);

  // The same link with somebody else's id in it.
  const swapped = issued.body.url.replace(suda.id, other.id);
  const refused = await raw('get', swapped);
  console.log('LINK-01 the same link pointed at another member ->', refused.status, JSON.stringify(refused.text));
  assert.equal(refused.status, 404);
  assert.ok(THAI.test(refused.text ?? ''));
});

test('LINK-02 every way of editing the link fails, and all of them the same way', async t => {
  const { call, raw, staffUser, member } = gym(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member();
  const url = (await call('post', `/members/${suda.id}/card/link`, staff.token, {})).body.url;
  const query = Object.fromEntries(new URLSearchParams(url.split('?')[1]));

  const edits = {
    'bumped the version': url.replace(`v=${query.v}`, `v=${Number(query.v) + 1}`),
    'pushed the expiry out': url.replace(`e=${query.e}`, `e=${Number(query.e) + DAY}`),
    'one character off in the signature':
      url.replace(query.s, query.s.slice(0, -1) + (query.s.endsWith('a') ? 'b' : 'a')),
    'no signature at all': url.split('&s=')[0],
    'no query at all': url.split('?')[0],
  };
  const answers = {};
  for (const [name, edited] of Object.entries(edits)) {
    const res = await raw('get', edited);
    answers[name] = { status: res.status, said: (res.text ?? '').slice(0, 60) };
  }
  console.log('LINK-02 edited links:\n' + JSON.stringify(answers, null, 1));
  const said = new Set(Object.values(answers).map(a => `${a.status} ${a.said}`));
  for (const [name, row] of Object.entries(answers)) assert.equal(row.status, 404, `${name} still opened a card`);
  assert.equal(said.size, 1, 'the replies differ, so a guesser learns which part they got right');
});

test('LINK-03 reissuing the card kills the link that is already out there', async t => {
  const { db, call, raw, staffUser, member, tick } = gym(t);
  const staff = staffUser('counter@example.test', 'staff');
  const admin = staffUser('owner@example.test', 'admin');
  const suda = member();

  const sent = (await call('post', `/members/${suda.id}/card/link`, staff.token, {})).body;
  assert.equal((await raw('get', sent.url)).status, 200, 'the link did not work to begin with');

  await call('post', `/members/${suda.id}/card/reissue`, admin.token, { reason: 'ลูกค้าทำโทรศัพท์หาย' }).expect(200);
  const afterReissue = await raw('get', sent.url);
  console.log('LINK-03 the link the customer already has, after a reissue ->',
    afterReissue.status, JSON.stringify((afterReissue.text ?? '').slice(0, 70)));
  assert.equal(afterReissue.status, 404, 'a cancelled card is still downloadable from the old link');

  // A fresh link is for the new card and works.
  const replacement = (await call('post', `/members/${suda.id}/card/link`, staff.token, {})).body;
  console.log('LINK-03 the replacement link is for card', replacement.card_version,
    '->', (await raw('get', replacement.url)).status);
  assert.equal(replacement.card_version, 2);
  assert.equal((await raw('get', replacement.url)).status, 200);

  // And a link stops working once its week is up.
  tick(7 * DAY + 60000);
  const stale = await raw('get', replacement.url);
  console.log('LINK-03 the same link eight days later ->', stale.status);
  assert.equal(stale.status, 404, 'the link outlived the week it was issued for');

  const trail = db.prepare("SELECT count(*) n FROM audit_logs WHERE action='member.card_link'").get().n;
  console.log('LINK-03 links recorded in the audit:', trail);
  assert.equal(trail, 2, 'sending a card out left no trace');
});

test('LINK-04 issuing a link is counter work, and asking for one needs a session', async t => {
  const { call, staffUser, member } = gym(t);
  const staff = staffUser('counter@example.test', 'staff');
  const suda = member();
  const anonymous = await call('post', `/members/${suda.id}/card/link`, null, {});
  const byStaff = await call('post', `/members/${suda.id}/card/link`, staff.token, {});
  const unknown = await call('post', `/members/${randomUUID()}/card/link`, staff.token, {});
  console.log('LINK-04 anonymous ->', anonymous.status, '| staff ->', byStaff.status,
    '| a member who does not exist ->', unknown.status);
  assert.equal(anonymous.status, 401);
  assert.equal(byStaff.status, 200, 'the person at the counter cannot send a customer their card');
  assert.equal(unknown.status, 404);
});

// ============================================== the set-password link (24 h)
test('SETPW-01 the link the owner is sent works once, and then never again', async t => {
  const { db, call, cli, staffUser } = gym(t);
  const owner = staffUser('owner@example.test', 'admin');

  const issued = cli([owner.email]);
  const link = issued.stdout.split('\n')[0].trim();
  const token = new URL(link).searchParams.get('setpw');
  console.log('SETPW-01 the first line the CLI prints:', link);
  console.log('SETPW-01 the rest, for whoever runs it:\n'
    + issued.stdout.split('\n').slice(1).filter(Boolean).map(l => '   ' + l).join('\n'));
  assert.equal(issued.code, 0);
  assert.match(link, /^https:\/\/gym\.example\.test\//, 'the first line is not a link that can be copied');
  assert.ok(THAI.test(issued.stdout), 'nothing tells the operator what this is, in Thai');

  const opened = await call('get', `/auth/set-password/${token}`, null);
  console.log('SETPW-01 opening the link ->', opened.status, JSON.stringify(opened.body));
  assert.equal(opened.status, 200);
  assert.equal(opened.body.email, owner.email);

  const set = await call('post', '/auth/set-password', null, { token, password: 'ยิมสุขฤทัย-2569!' });
  console.log('SETPW-01 setting the password ->', set.status, JSON.stringify(set.body));
  assert.equal(set.status, 200);

  const signedIn = await call('post', '/auth/login', null, { email: owner.email, password: 'ยิมสุขฤทัย-2569!' });
  console.log('SETPW-01 signing in with it ->', signedIn.status, JSON.stringify({ role: signedIn.body.role }));
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.role, 'admin');

  // The same link a second time, which is what happens when somebody submits
  // the form twice or the message gets forwarded.
  const again = await call('post', '/auth/set-password', null, { token, password: 'อีกรหัสหนึ่ง-2569!' });
  const reopened = await call('get', `/auth/set-password/${token}`, null);
  console.log('SETPW-01 using the link a second time ->', again.status, JSON.stringify(again.body.error));
  console.log('SETPW-01 opening it again ->', reopened.status);
  assert.equal(again.status, 404, 'the link can be used more than once');
  assert.equal(reopened.status, 404);
  const stillWorks = await call('post', '/auth/login', null, { email: owner.email, password: 'ยิมสุขฤทัย-2569!' });
  console.log('SETPW-01 the password from the first use still works ->', stillWorks.status);
  assert.equal(stillWorks.status, 200, 'the second attempt changed the password anyway');

  const trail = db.prepare(`SELECT action FROM audit_logs
    WHERE action IN ('user.password_link_cli','user.password_set_by_link') ORDER BY created_at`).all();
  console.log('SETPW-01 audit:', JSON.stringify(trail.map(r => r.action)));
  assert.deepEqual(trail.map(r => r.action), ['user.password_link_cli', 'user.password_set_by_link']);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes('ยิมสุขฤทัย-2569'),
    'the password reached the audit trail');
});

test('SETPW-02 the CLI issues one for the owner and nobody else', async t => {
  const { db, cli, staffUser } = gym(t);
  staffUser('owner@example.test', 'admin');
  staffUser('counter@example.test', 'staff');
  const suspended = staffUser('left@example.test', 'admin');
  db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(suspended.id);

  const refused = {
    'a staff account': cli(['counter@example.test']),
    'an address with no account': cli(['nobody@example.test']),
    'a suspended administrator': cli(['left@example.test']),
    'not an address': cli(['not-an-email']),
    'no argument at all': cli([]),
  };
  const report = {};
  for (const [name, out] of Object.entries(refused)) {
    report[name] = { exit: out.code, said: (out.stderr || out.stdout).trim().split('\n').pop()?.slice(0, 80) };
  }
  console.log('SETPW-02 who the CLI refuses:\n' + JSON.stringify(report, null, 1));
  for (const [name, out] of Object.entries(refused)) {
    assert.notEqual(out.code, 0, `${name} was given a link`);
    assert.ok(!/https?:\/\//.test(out.stdout), `${name} had a link printed anyway`);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM password_setup_tokens').get().n, 0,
    'a refused request still wrote a token somebody could try to guess');
});

test('SETPW-03 a link that is late, altered or invented opens nothing', async t => {
  const { call, cli, staffUser, tick } = gym(t);
  const owner = staffUser('owner@example.test', 'admin');
  const token = new URL(cli([owner.email]).stdout.split(/\r?\n/)[0].trim()).searchParams.get('setpw');

  const attempts = {
    'one character changed': token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'),
    'a token of the right shape, invented': randomBytes(token.length / 2 || 24).toString('hex').slice(0, token.length),
    'empty': 'x',
  };
  const answers = {};
  for (const [name, bad] of Object.entries(attempts)) {
    const res = await call('post', '/auth/set-password', null, { token: bad, password: 'รหัสผ่านที่ยาวพอ-2569' });
    answers[name] = { status: res.status, error: res.body.error };
  }
  console.log('SETPW-03 tokens that are not the one:\n' + JSON.stringify(answers, null, 1));
  for (const [name, row] of Object.entries(answers)) {
    assert.ok(row.status >= 400, `${name} set a password`);
    assert.ok(THAI.test(row.error ?? ''), `${name} was refused in English`);
  }

  // And the real one, a day and a minute later.
  tick(DAY + 60000);
  const late = await call('post', '/auth/set-password', null, { token, password: 'รหัสผ่านที่ยาวพอ-2569' });
  const peek = await call('get', `/auth/set-password/${token}`, null);
  console.log('SETPW-03 the real link after 24 hours ->', late.status, '| opening it ->', peek.status);
  assert.equal(late.status, 404, 'the link outlived the day it was issued for');
  assert.equal(peek.status, 404);
});

test('SETPW-04 setting a password by link closes whatever that account had open', async t => {
  const { db, call, cli, staffUser } = gym(t);
  const owner = staffUser('owner@example.test', 'admin');
  const before = await call('get', '/me', owner.token);
  // Somebody has been guessing at the account, and it is locked.
  for (let i = 0; i < 5; i++) {
    await call('post', '/auth/login', null, { email: owner.email, password: 'wrong-guess-here' });
  }
  const locked = await call('post', '/auth/login', null, { email: owner.email, password: 'wrong-guess-here' });

  const token = new URL(cli([owner.email]).stdout.split(/\r?\n/)[0].trim()).searchParams.get('setpw');
  await call('post', '/auth/set-password', null, { token, password: 'รหัสใหม่ของเจ้าของยิม-2569' }).expect(200);

  const after = await call('get', '/me', owner.token);
  const signedIn = await call('post', '/auth/login', null,
    { email: owner.email, password: 'รหัสใหม่ของเจ้าของยิม-2569' });
  console.log('SETPW-04 the session the account already had:', before.status, '->', after.status);
  console.log('SETPW-04 it was locked out before:', locked.status, '| signing in after the reset ->', signedIn.status);
  assert.equal(before.status, 200);
  assert.equal(after.status, 401, 'a session opened before the reset kept working');
  assert.equal(signedIn.status, 200, 'the lockout survived the reset, so the owner still cannot get in');
  assert.equal(db.prepare('SELECT count(*) n FROM otp_lockouts WHERE email=?').get(owner.email).n, 0);
});
