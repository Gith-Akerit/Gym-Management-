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

/** The smallest thing a browser will hand over that is genuinely a JPEG. */
export function jpegBuffer() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

/** A one-pixel PNG that real image decoders will actually open. */
export const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

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
