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
 * @param {{now?: number, promptPayId?: string|null, pilotMode?: boolean,
 *   selfSignup?: boolean}} [options]
 */
export function counterFixture(t, { now: start = Date.parse('2026-09-15T09:00:00+07:00'),
  promptPayId = '0899999999', pilotMode = false,
  // The gym runs with the public sign-up form off. The tests that cover it
  // open it themselves, so what every other test meets is the front door the
  // gym actually has.
  selfSignup = false } = {}) {
  // Every letter the app tries to send, kept rather than posted. The links in
  // them are the only way a test can walk the journey a person walks, and
  // "nothing was sent at all" is itself something several tests have to prove.
  const outbox = [];
  let refusal = null;
  let mailWorks = true;
  const db = openDatabase(); migrate(db);
  const root = mkdtempSync(join(tmpdir(), 'gym-counter-'));
  let time = start;
  const app = createApp({
    db, secret: randomBytes(32).toString('hex'), now: () => time,
    slipStore: new SlipStore(join(root, 'slips')),
    photoStore: new SlipStore(join(root, 'photos')),
    logoStore: new SlipStore(join(root, 'logo')),
    reportStore: new SlipStore(join(root, 'reports'), { maxBytes: 6e6 }),
    promptPayId, pilotMode, selfSignup,
    // A mailbox that always accepts, until a test says otherwise. `refuseMail`
    // is how the failures a real Office 365 hands back -- a wrong password, a
    // blocked port -- get exercised without one.
    mailer: {
      get ready() { return mailWorks !== false; },
      send: async message => {
        outbox.push(message);
        return refusal ? { sent: false, ...refusal } : { sent: true };
      },
    },
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

  /** The token out of the most recent letter of that kind, or null. */
  const linkFrom = pattern => {
    for (let at = outbox.length - 1; at >= 0; at -= 1) {
      const found = pattern.exec(outbox[at].text ?? '');
      if (found) return found[1];
    }
    return null;
  };

  return {
    db, app, http, call, signIn, addMember, root, outbox,
    /** The next letter is refused, the way a mailbox with a wrong password is. */
    refuseMail: (reason = { reason: 'auth', message: 'รหัสผ่านไม่ถูกต้อง' }) => { refusal = reason; },
    /** The gym has not filled in its mailbox at all. */
    noMailbox: () => { mailWorks = false; },
    verifyToken: () => linkFrom(/[?&]verify=([A-Za-z0-9_-]{43})/),
    resetToken: () => linkFrom(/[?&]setpw=([A-Za-z0-9_-]{43})/),
    tick: ms => { time += ms; }, at: () => time,
  };
}
