// Test-only server: in-memory database and a known password. Never imported by
// server/start.js.
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, migrate } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { MAX_PHOTO_BYTES } from '../server/cards-routes.js';
import { hashPassword } from '../server/passwords.js';
import { createApp } from '../server/app.js';
// Two of these run side by side: the normal gym on 4310 and a pilot one on
// 4311, because pilot mode changes what the counter is offered.
const PORT = Number(process.env.UI_PORT || 4310);
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
seedUsers('admin', ['layout-admin@example.test', 'admin@example.test',
  ...Array.from({ length: 11 }, (_, i) => `admin${i + 2}@example.test`)]);
// One account with no password at all: the state an owner leaves somebody in
// when they add them before their first shift.
db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'staff',?)")
  .run(randomUUID(), 'nopassword-ui@example.test', Date.now());
const app = createApp({ db, secret: randomBytes(32).toString('hex'), origin: `http://127.0.0.1:${PORT}`,
  slipStore: new SlipStore(resolve(PILOT ? 'data/test-slips-pilot' : 'data/test-slips')),
  photoStore: new SlipStore(resolve(PILOT ? 'data/test-photos-pilot' : 'data/test-photos'),
    { maxBytes: MAX_PHOTO_BYTES }),
  // Exactly what a pilot deployment has: no merchant account at all.
  promptPayId: PILOT ? null : '0899999999',
  pilotMode: PILOT });
// The one thing a browser cannot find out for itself. Test-only: this route
// does not exist in the real server.
app.get('/__test/password', (req, res) => res.json({ password: UI_PASSWORD }));
app.use(express.static(resolve('dist')));
const server = app.listen(PORT, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
