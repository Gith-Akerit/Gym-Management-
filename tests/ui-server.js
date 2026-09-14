// Test-only server: in-memory database and OTP inbox. Never imported by server/start.js.
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, migrate } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { createApp } from '../server/app.js';
// Two of these run side by side: the normal gym on 4310 and a pilot one on
// 4311, because pilot mode is a different app from the first screen onwards.
const PORT = Number(process.env.UI_PORT || 4310);
const PILOT = process.env.PILOT_MODE === '1';

const db = openDatabase(); migrate(db); seedConfiguration(db);
// Every browser journey signs in as its own account: asking for a code twice
// for one address inside a minute is refused, and that cooldown is a real rule
// rather than something the suite should be built to dodge. Numbering them
// makes it obvious how many are spare when a new spec needs one.
const seedUsers = (role, addresses) => {
  for (const address of addresses) {
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)')
      .run(randomUUID(), address, role, Date.now());
  }
};
seedUsers('staff', ['staff-ui@example.test',
  ...Array.from({ length: 5 }, (_, i) => `staff${i + 2}-ui@example.test`)]);
seedUsers('admin', ['admin@example.test',
  ...Array.from({ length: 11 }, (_, i) => `admin${i + 2}@example.test`)]);
const inbox = new Map();
const app = createApp({ db, secret: randomBytes(32).toString('hex'), origin: `http://127.0.0.1:${PORT}`,
  sendOtp: async ({ email, code }) => inbox.set(email, code),
  slipStore: new SlipStore(resolve(PILOT ? 'data/test-slips-pilot' : 'data/test-slips')),
  // Exactly what a pilot deployment has: no merchant account at all.
  promptPayId: PILOT ? null : '0899999999',
  pilotMode: PILOT });
// In pilot mode nothing is emailed, so the code comes from the same list the
// admin console reads. Test-only either way: this route does not exist in the
// real server.
app.get('/__test/code', (req, res) => res.json({
  code: inbox.get(req.query.email)
    ?? app.locals.pilotCodes?.().find(entry => entry.email === req.query.email)?.code,
}));
app.use(express.static(resolve('dist')));
const server = app.listen(PORT, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
