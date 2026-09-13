import express from 'express';
import { resolve } from 'node:path';
import { openDatabase, migrate } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './mail.js';
const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
migrate(db);
const app = createApp({ db, sendOtp: createMailer(), secret: process.env.OTP_SECRET,
  origin: process.env.APP_ORIGIN, production: process.env.NODE_ENV === 'production' });
app.use(express.static(resolve('dist')));
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'ready', port: Number(process.env.PORT || 3000) }));
});
const cleanup = setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM otp_challenges WHERE expires_at<?').run(now - 900000);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
  db.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(now);
}, 60000).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(cleanup); server.close(() => { db.close(); process.exit(0); });
});
