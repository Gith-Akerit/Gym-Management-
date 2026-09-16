// One app, one database and one way to sign in, shared by every test file.
//
// Every journey in this system starts with a member of staff signing in with a
// password, so that step is here rather than copied into eight fixtures. The
// password is the same everywhere and exists only in tests.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpClient } from './http.js';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/passwords.js';
import { SlipStore } from '../server/slips.js';

export const PASSWORD = 'counter-test-password';
/** Hashing is deliberately slow, so the fixtures share one hash. */
const HASH = hashPassword(PASSWORD);

// The files themselves live in fixtures.js, which the browser suite shares.
export { jpegBuffer, PHOTO_JPEG, PNG_PIXEL } from './fixtures.js';

/**
 * @param {object} t node:test context
 * @param {{now?: number, promptPayId?: string|null, pilotMode?: boolean}} [options]
 */
export function counterFixture(t, { now: start = Date.parse('2026-09-15T09:00:00+07:00'),
  promptPayId = '0899999999', pilotMode = false } = {}) {
  const db = openDatabase(); migrate(db);
  const root = mkdtempSync(join(tmpdir(), 'gym-counter-'));
  let time = start;
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos')),
    logoStore: new SlipStore(join(root, 'logo')),
    reportStore: new SlipStore(join(root, 'reports'), { maxBytes: 6e6 }),
    promptPayId, pilotMode,
  });
  t.after(() => {
    app.locals.stopSweeper?.();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const http = httpClient(app, t);

  const call = (method, path, token, body) => {
    const req = http[method](`/api${path}`).set('X-Gym-Client', 'mobile');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };

  /** Creates the account if it is not there yet, then signs in and returns a token. */
  async function signIn(email, role = 'admin', { password = PASSWORD } = {}) {
    if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
      db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), email, role, HASH, time, time);
    }
    const signedIn = await call('post', '/auth/login', null, { email, password }).expect(200);
    return signedIn.body.token;
  }

  /** A member signed up at the counter: a name, a phone, and no account. */
  async function addMember(token, values = {}) {
    const created = await call('post', '/members', token, {
      name: 'สุดา ใจดี', phone: '0891110001', ...values,
    }).expect(201);
    return created.body;
  }

  return { db, app, http, call, signIn, addMember, root, tick: ms => { time += ms; }, at: () => time };
}
