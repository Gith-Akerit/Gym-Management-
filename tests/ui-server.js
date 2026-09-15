// Test-only server: in-memory database and a known password. Never imported by
// server/start.js.
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { openDatabase, migrate } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { MAX_PHOTO_BYTES } from '../server/cards-routes.js';
import { hashPassword } from '../server/passwords.js';
import { issueSetupToken } from '../server/password-setup.js';
import { createApp } from '../server/app.js';
// Two of these run side by side, on whichever pair of ports this run owns.
import { UI_PORT } from './ports.js';
const PORT = Number(process.env.UI_PORT || UI_PORT);
const PILOT = process.env.PILOT_MODE === '1';

/** Every browser journey signs in with this. It exists only here. */
export const UI_PASSWORD = 'counter-test-password';

const db = openDatabase(); migrate(db); seedConfiguration(db);
const secret = hashPassword(UI_PASSWORD);
// Numbered so it is obvious how many are spare when a new spec needs one.
const seedUsers = (role, addresses) => {
  for (const address of addresses) {
    db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), address, role, secret, Date.now(), Date.now());
  }
};
seedUsers('staff', ['staff-ui@example.test',
  ...Array.from({ length: 5 }, (_, i) => `staff${i + 2}-ui@example.test`)]);
seedUsers('admin', ['layout-admin@example.test', 'admin@example.test', 'contrast2-ui@example.test',
  ...Array.from({ length: 11 }, (_, i) => `admin${i + 2}@example.test`)]);
// One account with no password at all: the state an owner leaves somebody in
// when they add them before their first shift.
db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'staff',?)")
  .run(randomUUID(), 'nopassword-ui@example.test', Date.now());
// And an administrator in the same state: the machine that was installed
// before passwords existed, which the set-password link is for.
db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?)")
  .run(randomUUID(), 'relink-ui@example.test', Date.now());
// One more for the spec that measures what the set-password screen looks like.
db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?)")
  .run(randomUUID(), 'contrast-ui@example.test', Date.now());
const photoRoot = resolve(PILOT ? 'data/test-photos-pilot' : 'data/test-photos');
const app = createApp({ db, secret: randomBytes(32).toString('hex'), origin: `http://127.0.0.1:${PORT}`,
  slipStore: new SlipStore(resolve(PILOT ? 'data/test-slips-pilot' : 'data/test-slips')),
  photoStore: new SlipStore(photoRoot, { maxBytes: MAX_PHOTO_BYTES }),
  logoStore: new SlipStore(resolve(PILOT ? 'data/test-logo-pilot' : 'data/test-logo')),
  // Exactly what a pilot deployment has: no merchant account at all.
  promptPayId: PILOT ? null : '0899999999',
  pilotMode: PILOT });
// The one thing a browser cannot find out for itself. Test-only: this route
// does not exist in the real server.
app.get('/__test/password', (req, res) => res.json({ password: UI_PASSWORD }));
// Stands in for `npm run admin:set-password-link`, which a browser has no way
// to run. The command itself is covered in tests/set-password-link.test.js;
// what the browser suite checks is the screen the link opens.
// Corrupts a member's stored photograph, the way a half-written file or a bad
// block would. There is no way to reach that state through the app any more --
// the upload opens the file first -- but the screen still has to cope with the
// bytes going bad afterwards, and that is what this lets the browser check.
app.post('/__test/break-photo', express.json(), (req, res) => {
  const row = db.prepare('SELECT photo_stored_name FROM members WHERE id=?').get(req.body?.member_id ?? '');
  if (!row?.photo_stored_name) return res.status(404).json({ error: 'no photograph on that member' });
  writeFileSync(join(photoRoot, row.photo_stored_name),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(512, 0x7f)]));
  res.json({ broken: true });
});
app.post('/__test/setup-link', express.json(), (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(req.body?.email);
  if (!user) return res.status(404).json({ error: 'no such account' });
  res.json(issueSetupToken(db, { userId: user.id, now: Date.now() }));
});
app.use(express.static(resolve('dist')));
const server = app.listen(PORT, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
