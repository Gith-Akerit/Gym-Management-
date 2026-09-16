// QA Release Tester — migration 012 on a gym that already has reports.
//
// The reference is the number a member of staff is told to write down. Moving
// it from `MAX(reference)+1` to a counter is only safe if the counter starts
// past whatever this gym has already handed out — otherwise the upgrade itself
// reissues numbers, which is the bug it was meant to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openDatabase, migrate, rollback } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';
import { MAX_REPORT_BYTES } from '../server/reports.js';

const PASSWORD = 'counter-password-2569';
const at = db => db.prepare('SELECT max(version) v FROM schema_migrations').get().v;

/** A gym rolled back to just before the counter existed. */
function gymAtEleven(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-counter-'));
  const db = openDatabase(join(dir, 'gym.sqlite'));
  migrate(db); seedConfiguration(db, Date.now());
  // Down to 11: the schema the running gym is on right now.
  while (at(db) > 11) rollback(db);
  t.after(() => {
    db.close();
    for (let i = 0; i < 15; i++) {
      try { return rmSync(dir, { recursive: true, force: true }); } catch { /* still held */ }
    }
  });
  return { db, dir };
}

function serve(db, dir, t) {
  let time = Date.now();
  const app = createApp({ db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(dir, 'slips')),
    photoStore: new SlipStore(join(dir, 'photos'), { maxBytes: 8e6 }),
    logoStore: new SlipStore(join(dir, 'logo')),
    reportStore: new SlipStore(join(dir, 'reports'), { maxBytes: MAX_REPORT_BYTES }),
    promptPayId: '0812345678' });
  t.after(() => app.locals.stopSweeper?.());
  const signIn = async (email, role) => {
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.prepare(`INSERT INTO users(id,email,role,status,password_hash,password_set_at,created_at)
        VALUES(?,?,?,'active',?,?,?)`).run(randomUUID(), email, role, hashPassword(PASSWORD), time, time);
    }
    const res = await request(app).post('/api/auth/login').set('X-Gym-Client', 'mobile')
      .send({ email, password: PASSWORD });
    return res.body.token;
  };
  const send = (token, message) => request(app).post('/api/reports')
    .set('X-Gym-Client', 'mobile').set('Authorization', `Bearer ${token}`)
    .field('message', message).field('screen', 'สมาชิก');
  const drop = (token, id) => request(app).delete(`/api/reports/${id}`)
    .set('X-Gym-Client', 'mobile').set('Authorization', `Bearer ${token}`).send({});
  return { app, signIn, send, drop };
}

test('MIG-012-01 the counter starts past what this gym already handed out', async t => {
  const { db, dir } = gymAtEleven(t);
  console.log('MIG-012-01 the gym starts at schema version', at(db));
  assert.equal(at(db), 11, 'could not get back to the schema the running gym is on');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='counters'").get().n, 0,
    'the counter table exists before the migration that adds it');

  // Three reports as the OLD code wrote them, then the newest deleted — the
  // exact state that produced the bug, and a state a real gym can be in when
  // the upgrade lands. Written with SQL rather than through the route: the
  // route at this commit draws from the counter, which is what migration 012
  // is about to add, so running it here would be new code on an old schema —
  // a combination that never happens, because `migrate()` runs at startup.
  const at2 = Date.now();
  const made = [1, 2, 3].map(reference => {
    const id = randomUUID();
    db.prepare(`INSERT INTO problem_reports(id,reference,message,screen,reported_by,user_agent,
      viewport,app_revision,image_stored_name,image_content_type,status,internal_note,created_at,updated_at)
      VALUES(?,?,?,'สมาชิก',NULL,'','','',NULL,NULL,'new','',?,?)`)
      .run(id, reference, `เรื่องที่ ${reference}`, at2, at2);
    return { id, reference };
  });
  console.log('MIG-012-01 handed out before the upgrade:', JSON.stringify(made.map(r => r.reference)));
  db.prepare('DELETE FROM problem_reports WHERE id=?').run(made[2].id);
  const highestLeft = db.prepare('SELECT COALESCE(MAX(reference),0) t FROM problem_reports').get().t;
  console.log('MIG-012-01 the newest was deleted · highest still in the table:', highestLeft);
  assert.equal(highestLeft, 2);

  // The upgrade.
  migrate(db);
  console.log('MIG-012-01 after migrate(), schema version is', at(db));
  assert.equal(at(db), 12);
  const seeded = db.prepare("SELECT value FROM counters WHERE name='problem_report'").get();
  console.log('MIG-012-01 the counter was seeded at:', JSON.stringify(seeded));
  // Seeded from what is IN the table. #3 was deleted, so a gym in this state
  // can still reissue 3 once — the upgrade cannot know about numbers whose
  // rows are already gone. What it must never do is go backwards from 2.
  assert.ok(seeded.value >= highestLeft,
    `the counter starts at ${seeded.value}, below the ${highestLeft} already in the table`);

  const after = serve(db, dir, t);
  const owner2 = await after.signIn('owner@example.test', 'admin');
  const next = await after.send(owner2, 'เรื่องหลังอัปเกรด').expect(201);
  const live = db.prepare('SELECT reference FROM problem_reports ORDER BY reference').all().map(r => r.reference);
  console.log('MIG-012-01 the first report after the upgrade got:', next.body.reference,
    '· every reference now in the table:', JSON.stringify(live));
  assert.ok(next.body.reference > highestLeft,
    `the first report after the upgrade got ${next.body.reference}, colliding with one still in the table`);
  assert.equal(new Set(live).size, live.length, 'two reports in the table share a reference');
});

test('MIG-012-02 emptying the table does not send the numbers back to the start', async t => {
  const { db, dir } = gymAtEleven(t);
  migrate(db);
  const { signIn, send, drop } = serve(db, dir, t);
  const owner = await signIn('owner@example.test', 'admin');

  const first = [];
  for (const words of ['หนึ่ง', 'สอง', 'สาม', 'สี่']) {
    first.push((await send(owner, words).expect(201)).body);
  }
  console.log('MIG-012-02 four reports:', JSON.stringify(first.map(r => r.reference)));

  // The owner clears the whole list, which is a thing an owner does.
  for (const row of first) await drop(owner, row.id).expect(200);
  assert.equal(db.prepare('SELECT count(*) n FROM problem_reports').get().n, 0);
  const counter = db.prepare("SELECT value FROM counters WHERE name='problem_report'").get().value;
  console.log('MIG-012-02 table emptied · the counter still reads', counter);

  const after = [];
  for (const words of ['ห้า', 'หก']) {
    after.push((await send(owner, words).expect(201)).body.reference);
  }
  console.log('MIG-012-02 the next two reports got:', JSON.stringify(after));
  const everIssued = [...first.map(r => r.reference), ...after];
  assert.equal(new Set(everIssued).size, everIssued.length,
    `a number was handed out twice: ${JSON.stringify(everIssued)}`);
  assert.ok(Math.min(...after) > Math.max(...first.map(r => r.reference)),
    'the numbers restarted after the table was emptied');
});

test('MIG-012-03 going back down and up again keeps the numbers moving forwards', async t => {
  const { db, dir } = gymAtEleven(t);
  migrate(db);
  const { signIn, send } = serve(db, dir, t);
  const owner = await signIn('owner@example.test', 'admin');
  const before = [];
  for (const words of ['ก่อนถอย 1', 'ก่อนถอย 2']) {
    before.push((await send(owner, words).expect(201)).body.reference);
  }

  // A rollback is what happens when a deploy is undone. The table goes, and
  // the next `migrate()` has to seed from the rows rather than from zero.
  rollback(db);
  console.log('MIG-012-03 rolled back to version', at(db),
    '· counters table present:',
    db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='counters'").get().n === 1);
  migrate(db);
  const seeded = db.prepare("SELECT value FROM counters WHERE name='problem_report'").get().value;
  console.log('MIG-012-03 up again · the counter reseeded at', seeded,
    '· highest in the table', Math.max(...before));
  assert.ok(seeded >= Math.max(...before), 'the reseed landed below what is already in the table');

  const after = serve(db, dir, t);
  const owner2 = await after.signIn('owner@example.test', 'admin');
  const next = (await after.send(owner2, 'หลังถอยแล้วขึ้นใหม่').expect(201)).body.reference;
  console.log('MIG-012-03 the next report got:', next);
  assert.ok(!before.includes(next), `${next} was already handed out before the rollback`);
});
