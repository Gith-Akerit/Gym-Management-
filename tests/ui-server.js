// Test-only server: in-memory database and OTP inbox. Never imported by server/start.js.
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, migrate } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';
import { createApp } from '../server/app.js';
const db = openDatabase(); migrate(db); seedConfiguration(db);
for (const address of ['admin@example.test', 'admin2@example.test']) {
  db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'admin',?)").run(randomUUID(), address, Date.now());
}
const inbox = new Map();
const app = createApp({ db, secret: randomBytes(32).toString('hex'), origin: 'http://127.0.0.1:4310', sendOtp: async ({ email, code }) => inbox.set(email, code) });
app.get('/__test/code', (req, res) => res.json({ code: inbox.get(req.query.email) }));
app.use(express.static(resolve('dist')));
const server = app.listen(4310, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
