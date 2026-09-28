// Pilot mode, which now means one thing: the gym has no PromptPay account yet.
//
// It used to mean "no mail provider either", because sign-in went through an
// emailed code. Nothing does any more -- staff sign in with a password and
// members do not sign in at all -- so the flag has shrunk to the one fact it
// was always really about, and a gym can run the counter without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { hashPassword } from '../server/passwords.js';

const PASSWORD = 'counter-test-password';
const HASH = hashPassword(PASSWORD);

function fixture(t, { pilotMode = true } = {}) {
  const db = openDatabase(); migrate(db); seedConfiguration(db, Date.now());
  const root = mkdtempSync(join(tmpdir(), 'gym-pilot-'));
  let time = Date.parse('2026-09-15T09:00:00+07:00');
  const options = {
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos')),
    promptPayId: pilotMode ? null : '0812345678',
    pilotMode,
  };
  let app = createApp(options);
  let http = httpClient(app, t);
  t.after(() => { app.locals.stopSweeper?.(); db.close(); rmSync(root, { recursive: true, force: true }); });

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  async function login(email, role = 'admin') {
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), email, role, HASH, time, time);
    }
    return (await call('post', '/auth/login', null, { email, password: PASSWORD }).expect(200)).body.token;
  }
  /** Restarts the app with the flag the other way, keeping the same database. */
  function restartAs(mode) {
    app.locals.stopSweeper?.();
    app = createApp({ ...options, pilotMode: mode, promptPayId: mode ? null : '0812345678' });
    http = httpClient(app, t);
    return { call, app };
  }
  return { db, call, login, restartAs, tick: ms => { time += ms; } };
}

test('the counter runs with no PromptPay account and no mail server at all', async t => {
  const { call, login } = fixture(t);
  await call('get', '/health').expect(200);
  // The one fact the login screen needs before anybody has signed in.
  const config = await call('get', '/public/config').expect(200);
  assert.deepEqual(config.body, { pilot_mode: true });

  // And the whole counter still works: sign in, sign somebody up, take cash,
  // hand over the card, scan them in.
  const owner = await login('owner@example.test');
  const pkg = (await call('post', '/packages', owner, {
    code: 'MONTH', name_th: 'รายเดือน', type: 'unlimited', duration_days: 30,
    price_thb: 1200, status: 'active',
  }).expect(201)).body;
  const who = (await call('post', '/members', owner, { name: 'วาสนา ทดลอง', phone: '0891112233' }).expect(201)).body;
  await call('post', `/members/${who.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);
  const card = await call('get', `/members/${who.id}/card`, owner).expect(200);
  const scan = await call('post', '/check-ins/verify', owner, { qr: card.body.qr }).expect(200);
  assert.equal(scan.body.result, 'allowed');
});

test('turning pilot mode off keeps everything pilot mode created', async t => {
  const { call, login, restartAs, db } = fixture(t);
  const owner = await login('owner@example.test');
  const pkg = (await call('post', '/packages', owner, {
    code: 'MONTH', name_th: 'รายเดือน', type: 'unlimited', duration_days: 30,
    price_thb: 1200, status: 'active',
  }).expect(201)).body;
  const who = (await call('post', '/members', owner, { name: 'ยังอยู่ ครบถ้วน', phone: '0894445566' }).expect(201)).body;
  await call('post', `/members/${who.id}/grant`, owner)
    .field('package_id', pkg.id).field('payment_method', 'cash').expect(201);

  const live = restartAs(false);
  const config = await live.call('get', '/public/config').expect(200);
  assert.deepEqual(config.body, { pilot_mode: false });

  const again = await live.call('post', '/auth/login', null, { email: 'owner@example.test', password: PASSWORD }).expect(200);
  const listed = await live.call('get', '/members', again.body.token).expect(200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].name, 'ยังอยู่ ครบถ้วน');
  assert.equal(db.prepare('SELECT count(*) n FROM entitlements').get().n, 1);
  // The card is the same card: nothing about it depended on the flag.
  const card = await live.call('get', `/members/${who.id}/card`, again.body.token).expect(200);
  assert.equal(card.body.card_version, 1);
});

test('no password anywhere means no way in, whatever the flag says', async t => {
  const { db, call } = fixture(t);
  db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?)")
    .run(randomUUID(), 'nopassword@example.test', Date.now());
  // The first administrator gets a password at install time from bootstrap.
  // Without one there is no back door, in pilot mode or out of it.
  await call('post', '/auth/login', null, { email: 'nopassword@example.test', password: PASSWORD }).expect(401);
});
