// QA Release Tester — หมวด L: แจ้งปัญหา (release/pilot at b4cd3a1).
//
// A screenshot of a counter screen is nearly always a picture of a member: a
// name, a face, a telephone number. The feature is deliberately easy to send
// and hard to read back, so what these probe is the guarded side — who can
// reach a picture, what is written down when somebody does, and whether the
// file really leaves the disk when the report does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';
import { MAX_REPORT_BYTES } from '../server/reports.js';

const THAI = /[฀-๿]/;
const PASSWORD = 'counter-password-2569';
const DAY = 86400000;

function gym(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-report-'));
  const dbPath = join(dir, 'gym.sqlite');
  const reports = join(dir, 'reports');
  const db = openDatabase(dbPath); migrate(db); seedConfiguration(db, Date.now());
  let time = Date.now();
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(dir, 'slips')),
    photoStore: new SlipStore(join(dir, 'photos'), { maxBytes: 8e6 }),
    logoStore: new SlipStore(join(dir, 'logo')),
    reportStore: new SlipStore(reports, { maxBytes: MAX_REPORT_BYTES }),
    promptPayId: '0812345678' });
  t.after(() => {
    app.locals.stopSweeper?.(); db.close();
    for (let i = 0; i < 15; i++) {
      try { return rmSync(dir, { recursive: true, force: true }); } catch { /* still held */ }
    }
  });
  const call = (method, path, token, body) => {
    const req = request(app)[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const signIn = async (email, role) => {
    db.prepare(`INSERT INTO users(id,email,role,status,password_hash,password_set_at,created_at)
      VALUES(?,?,?,'active',?,?,?)`).run(randomUUID(), email, role, hashPassword(PASSWORD), time, time);
    const res = await request(app).post('/api/auth/login').set('X-Gym-Client', 'mobile')
      .send({ email, password: PASSWORD });
    return res.body.token;
  };
  /** Sends a report the way the screen does: multipart, picture optional. */
  const send = (token, { message = 'กดปุ่มแล้วไม่มีอะไรเกิดขึ้น', screen = 'สแกนเช็คอิน',
    shot = null, revision = 'abc1234', viewport = '1280x900' } = {}) => {
    const req = request(app).post('/api/reports').set('X-Gym-Client', 'mobile')
      .set('Authorization', `Bearer ${token}`)
      .field('message', message).field('screen', screen)
      .field('viewport', viewport).field('app_revision', revision);
    if (shot) req.attach('screenshot', shot, { filename: 'shot.png', contentType: 'image/png' });
    return req;
  };
  const cli = (args, env = {}) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, ['server/prune-reports.js', ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_PATH: dbPath, REPORT_STORAGE_PATH: reports, ...env },
      }) };
    } catch (e) { return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
  };
  return { db, app, call, signIn, send, cli, dir, reports,
    files: () => readdirSync(reports), tick: ms => { time += ms; },
    at: () => time, setTime: ms => { time = ms; } };
}

/** A screenshot the size a browser really produces. */
async function screenshot(label = 'QA') {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(1440, 900);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0D1512'; ctx.fillRect(0, 0, 1440, 900);
  ctx.fillStyle = '#DD610B'; ctx.fillRect(0, 0, 1440, 68);
  ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 48px sans-serif';
  ctx.fillText(label, 60, 300);
  ctx.fillRect(60, 360, 700, 240);
  return canvas.toBuffer('image/png');
}

// ============================================== L1 · who can read one back
test('REPORT-01 anybody at the counter can send one, only the owner can read it back', async t => {
  const { call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');

  const sent = await send(staff, { message: 'พนักงานแจ้งเรื่องนี้' }).expect(201);
  const id = sent.body.id;
  console.log('REPORT-01 a member of staff sending one ->', sent.status,
    JSON.stringify({ reference: sent.body.reference, by: sent.body.reported_by_email }));

  const doors = {
    'GET /reports (the list)': token => call('get', '/reports', token),
    'GET /reports/:id': token => call('get', `/reports/${id}`, token),
    'GET /reports/:id/image': token => call('get', `/reports/${id}/image`, token),
    'PATCH /reports/:id': token => call('patch', `/reports/${id}`, token, { status: 'done' }),
    'DELETE /reports/:id': token => call('delete', `/reports/${id}`, token, {}),
  };
  const report = {};
  for (const [what, run] of Object.entries(doors)) {
    report[what] = { 'nobody signed in': (await run(null)).status,
      'the member of staff who sent it': (await run(staff)).status };
  }
  console.log('REPORT-01 reading them back:\n' + JSON.stringify(report, null, 1));
  for (const [what, row] of Object.entries(report)) {
    assert.equal(row['nobody signed in'], 401, `${what} is open to anybody`);
    assert.equal(row['the member of staff who sent it'], 403,
      `a member of staff can ${what} — including the one who sent it`);
  }
  // And the owner can, which is the point.
  assert.equal((await call('get', '/reports', owner)).status, 200);
});

test('REPORT-02 nothing about a report is reachable without a session', async t => {
  const { call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const shot = await screenshot('ความลับ');
  const sent = await send(owner, { shot }).expect(201);

  // The picture must not be guessable from outside, and must not have been
  // hung anywhere that skips the session check.
  const outside = {
    '/api/public/reports': await request(gym).get?.length ? null : null,
  };
  const guesses = [
    `/public/reports/${sent.body.id}/image`,
    `/public/reports`,
    `/reports/${sent.body.id}/image`,
  ];
  const answers = {};
  for (const path of guesses) answers[`/api${path}`] = (await call('get', path, null)).status;
  console.log('REPORT-02 with no session at all:\n' + JSON.stringify(answers, null, 1));
  for (const [path, status] of Object.entries(answers)) {
    assert.ok(status === 401 || status === 404, `${path} answered ${status}`);
  }
  assert.ok(!sent.body.image_url.startsWith('/api/public/'),
    `the picture is served from ${sent.body.image_url}`);
  assert.match(sent.body.image_url, /^\/api\/reports\//);
  assert.ok(outside);
});

test('REPORT-03 every look at a picture is written down', async t => {
  const { db, call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const shot = await screenshot('หน้าสมาชิก');
  const sent = await send(owner, { shot }).expect(201);
  assert.equal(sent.body.has_image, true, 'the picture did not arrive with the report');

  const before = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='report.view_image'").get().n;
  const looks = [];
  for (let i = 0; i < 3; i++) {
    const res = await call('get', `/reports/${sent.body.id}/image`, owner);
    looks.push({ status: res.status, type: res.headers['content-type'],
      nosniff: res.headers['x-content-type-options'], csp: res.headers['content-security-policy'] });
  }
  const after = db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='report.view_image'").get().n;
  console.log('REPORT-03 three looks at the same picture:', JSON.stringify(looks[0]));
  console.log(`REPORT-03 audit rows before ${before} -> after ${after}`);
  for (const look of looks) {
    assert.equal(look.status, 200);
    assert.match(look.type, /image\/jpeg/);
    assert.equal(look.nosniff, 'nosniff');
  }
  // Every time, not just the first: "who looked at it" only has an answer if
  // each look was recorded.
  assert.equal(after - before, 3, 'opening the picture three times was written down fewer times');

  const row = db.prepare("SELECT * FROM audit_logs WHERE action='report.view_image' ORDER BY created_at DESC").get();
  console.log('REPORT-03 what the audit row says:',
    JSON.stringify({ actor: row.actor_id?.slice(0, 8), entity: row.entity_id === sent.body.id }));
  assert.equal(row.entity_id, sent.body.id);
  assert.ok(row.actor_id);
});

// ====================================== L2 · the picture, and switching it off
test('REPORT-04 sending without a picture writes no file at all', async t => {
  const { call, signIn, send, files } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  assert.deepEqual(files(), [], 'the store did not start empty');

  const withNone = await send(owner, { message: 'ไม่ส่งภาพมาด้วย' }).expect(201);
  console.log('REPORT-04 with the tick off ->', withNone.status,
    JSON.stringify({ has_image: withNone.body.has_image, image_url: withNone.body.image_url }),
    '| files on disk:', JSON.stringify(files()));
  assert.equal(withNone.body.has_image, false);
  assert.equal(withNone.body.image_url, null);
  assert.deepEqual(files(), [], 'a file was written for a report that carries no picture');

  const asked = await call('get', `/reports/${withNone.body.id}/image`, owner);
  console.log('REPORT-04 asking for a picture that was never sent ->', asked.status,
    JSON.stringify(asked.body.error));
  assert.equal(asked.status, 404);
  assert.ok(THAI.test(asked.body.error ?? ''));

  // And with the tick on, exactly one file appears.
  const withOne = await send(owner, { shot: await screenshot() }).expect(201);
  console.log('REPORT-04 with the tick on -> files on disk:', JSON.stringify(files()));
  assert.equal(withOne.body.has_image, true);
  assert.equal(files().length, 1);
});

test('REPORT-05 a picture that cannot be opened is refused, and the report still goes', async t => {
  const { signIn, send, files } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  // Real PNG magic bytes, nothing behind them: the half-sent upload again.
  const truncated = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  ]);
  const refused = await send(owner, { shot: truncated });
  console.log('REPORT-05 a half-sent screenshot ->', refused.status, JSON.stringify(refused.body.error));
  assert.ok(refused.status >= 400 && refused.status < 500);
  assert.ok(THAI.test(refused.body.error ?? ''), 'refused in English');
  assert.deepEqual(files(), [], 'a screenshot that cannot be opened was kept anyway');

  // The reporter must not be stuck: sending the same words without the picture
  // has to work, because the words are the part that matters.
  const anyway = await send(owner, { message: 'ส่งใหม่โดยไม่แนบภาพ' }).expect(201);
  console.log('REPORT-05 the same report without the picture ->', anyway.status);
  assert.equal(anyway.body.has_image, false);
});

test('REPORT-06 what the browser sends is shrunk and re-encoded before it is kept', async t => {
  const { signIn, send, files, reports } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const shot = await screenshot('จอกว้าง');
  const sent = await send(owner, { shot }).expect(201);
  const { readFileSync } = await import('node:fs');
  const kept = readFileSync(join(reports, files()[0]));
  const { loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(kept);
  console.log(`REPORT-06 sent ${shot.length} bytes of PNG at 1440x900 ->`
    + ` kept ${kept.length} bytes at ${image.width}x${image.height} as ${files()[0].split('.').pop()}`);
  assert.ok(image.width <= 1280, `the kept picture is ${image.width}px wide`);
  assert.equal(Math.round((image.height / image.width) * 100), Math.round((900 / 1440) * 100),
    'the picture was squashed rather than scaled');
  // Kept as JPEG, which is the whole reason a 4K screenshot fits on a volume
  // shared with the database. Byte size is NOT asserted: this fixture is flat
  // colour, which PNG stores better than JPEG, so a synthetic shot can legally
  // grow. What matters is the format and the cap on the long edge.
  assert.match(files()[0], /\.jpe?g$/);
  assert.equal(sent.body.has_image, true);
});

// ================================================ L3 · the trail and the disk
test('REPORT-07 deleting a report takes its picture off the disk', async t => {
  const { db, call, signIn, send, files } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const keep = await send(owner, { shot: await screenshot('เก็บไว้'), message: 'เรื่องที่เก็บไว้' }).expect(201);
  const drop = await send(owner, { shot: await screenshot('ลบทิ้ง'), message: 'เรื่องที่จะลบ' }).expect(201);
  console.log('REPORT-07 two reports, two files:', JSON.stringify(files()));
  assert.equal(files().length, 2);

  const gone = await call('delete', `/reports/${drop.body.id}`, owner, {}).expect(200);
  const left = files();
  console.log('REPORT-07 after deleting one ->', JSON.stringify(gone.body), '| files:', JSON.stringify(left));
  assert.equal(left.length, 1, 'the picture of the deleted report is still on the disk');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_reports').get().n, 1);
  // The one that was kept must still open, not just still exist.
  assert.equal((await call('get', `/reports/${keep.body.id}/image`, owner)).status, 200);
  assert.equal((await call('get', `/reports/${drop.body.id}`, owner)).status, 404);

  const trail = db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'report.%' ORDER BY created_at").all();
  console.log('REPORT-07 the trail:', JSON.stringify(trail.map(r => r.action)));
  assert.ok(trail.some(r => r.action === 'report.delete'));
});

test('REPORT-08 the reference never repeats, even after a delete', async t => {
  const { call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const first = await send(owner, { message: 'เรื่องที่หนึ่ง' }).expect(201);
  const second = await send(owner, { message: 'เรื่องที่สอง' }).expect(201);
  await call('delete', `/reports/${second.body.id}`, owner, {}).expect(200);
  const third = await send(owner, { message: 'เรื่องที่สาม' }).expect(201);
  const seen = [first.body.reference, second.body.reference, third.body.reference];
  console.log('REPORT-08 references issued, with the second one deleted:', JSON.stringify(seen));
  assert.equal(new Set(seen).size, 3, 'a deleted report handed its number to the next one');
  assert.ok(third.body.reference > second.body.reference);
});

test('REPORT-09 the sweep keeps half a year and takes the file before the row', async t => {
  const { db, signIn, send, cli, files, setTime } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const now = Date.now();

  // One from today, one from the day before the window closes, one past it.
  setTime(now);
  const today = await send(owner, { shot: await screenshot('วันนี้'), message: 'วันนี้' }).expect(201);
  setTime(now - 179 * DAY);
  const nearly = await send(owner, { shot: await screenshot('179 วัน'), message: '179 วัน' }).expect(201);
  setTime(now - 181 * DAY);
  const old = await send(owner, { shot: await screenshot('181 วัน'), message: '181 วัน' }).expect(201);
  setTime(now);
  console.log('REPORT-09 three reports, three files:', files().length);
  assert.equal(files().length, 3);

  const preview = cli(['--dry-run']);
  console.log('REPORT-09 a dry run says:', preview.stdout.trim());
  assert.equal(files().length, 3, 'a dry run deleted something');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM problem_reports').get().n, 3);

  const run = cli([]);
  console.log('REPORT-09 and the real one:', run.stdout.trim());
  const rows = db.prepare('SELECT id FROM problem_reports').all().map(r => r.id);
  console.log('REPORT-09 left afterwards ->', rows.length, 'rows ·', files().length, 'files');
  assert.equal(rows.length, 2, 'the sweep took the wrong number of reports');
  assert.ok(rows.includes(today.body.id) && rows.includes(nearly.body.id));
  assert.ok(!rows.includes(old.body.id), 'the report past the window is still there');
  assert.equal(files().length, 2, 'the picture of the swept report is still on the disk');
});

// =========================================== L4 · what travels with a report
test('REPORT-10 a report carries which build it was seen on, and who saw it', async t => {
  const { call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');
  const sent = await send(staff, { revision: 'b4cd3a1', screen: 'สแกนเช็คอิน', viewport: '390x844' })
    .expect(201);
  const seen = (await call('get', `/reports/${sent.body.id}`, owner).expect(200)).body;
  console.log('REPORT-10 what the owner sees on a report:\n' + JSON.stringify({
    reference: seen.reference, screen: seen.screen, viewport: seen.viewport,
    app_revision: seen.app_revision, by: seen.reported_by_email, role: seen.reported_by_role,
    agent: seen.user_agent, status: seen.status }, null, 1));
  assert.equal(seen.app_revision, 'b4cd3a1', 'the build the reporter was on did not travel with it');
  assert.equal(seen.screen, 'สแกนเช็คอิน');
  assert.equal(seen.viewport, '390x844');
  assert.equal(seen.reported_by_email, 'counter@example.test');
  assert.equal(seen.reported_by_role, 'staff');
  assert.equal(seen.status, 'new');

  // A report with no revision is honest about it rather than guessing.
  const blank = await send(staff, { revision: '' }).expect(201);
  console.log('REPORT-10 one sent with no build number ->', JSON.stringify(blank.body.app_revision));
  assert.equal(blank.body.app_revision, '');
});

test('REPORT-11 the internal note is the owner\'s alone, and the fields are checked', async t => {
  const { call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const staff = await signIn('counter@example.test', 'staff');
  const sent = await send(staff).expect(201);

  const noted = await call('patch', `/reports/${sent.body.id}`, owner,
    { status: 'reading', internal_note: 'คุยกับพนักงานแล้ว รอทีมแก้' }).expect(200);
  console.log('REPORT-11 after the owner writes a note ->',
    JSON.stringify({ status: noted.body.status, note: noted.body.internal_note }));
  assert.equal(noted.body.status, 'reading');
  assert.match(noted.body.internal_note, /รอทีมแก้/);

  // The person who sent it must not be able to read what the owner wrote.
  const asStaff = await call('get', `/reports/${sent.body.id}`, staff);
  console.log('REPORT-11 the member of staff who sent it asking for it back ->', asStaff.status);
  assert.equal(asStaff.status, 403);

  const bad = {
    'a status that is not one of the four': { status: 'urgent' },
    'nothing at all': {},
    'a field nobody asked for': { reported_by: 'somebody else' },
  };
  const report = {};
  for (const [name, body] of Object.entries(bad)) {
    const res = await call('patch', `/reports/${sent.body.id}`, owner, body);
    report[name] = { status: res.status, error: res.body.error };
  }
  console.log('REPORT-11 what the update refuses:\n' + JSON.stringify(report, null, 1));
  for (const [name, row] of Object.entries(report)) {
    assert.ok(row.status >= 400, `${name} was accepted`);
    assert.ok(THAI.test(JSON.stringify(row.error)), `${name} was refused in English`);
  }
});

test('REPORT-12 the message field is checked, and a suspended account cannot send', async t => {
  const { call, signIn, send } = gym(t);
  const owner = await signIn('owner@example.test', 'admin');
  const leaving = await signIn('gone@example.test', 'staff');

  const attempts = {
    'empty': '',
    'spaces only': '    ',
    'two thousand and one characters': 'ก'.repeat(2001),
    'two thousand exactly': 'ก'.repeat(2000),
  };
  const report = {};
  for (const [name, message] of Object.entries(attempts)) {
    const res = await send(owner, { message });
    report[name] = { status: res.status, error: res.body.error ?? res.body.fields?.message };
  }
  console.log('REPORT-12 what the message field accepts:\n' + JSON.stringify(report, null, 1));
  assert.equal(report['two thousand exactly'].status, 201);
  for (const name of ['empty', 'spaces only', 'two thousand and one characters']) {
    assert.ok(report[name].status >= 400, `${name} was accepted`);
    assert.ok(THAI.test(JSON.stringify(report[name].error)), `${name} was refused in English`);
  }

  const users = await call('get', '/users', owner).expect(200);
  const id = users.body.items.find(u => u.email === 'gone@example.test').id;
  await call('post', `/users/${id}/suspend`, owner, { reason: 'QA ทดสอบ' }).expect(200);
  const after = await send(leaving, { message: 'ยังส่งได้อยู่ไหม' });
  console.log('REPORT-12 a suspended account sending one ->', after.status);
  assert.ok(after.status === 401 || after.status === 403,
    `a suspended account sent a report (${after.status})`);
});
