import express from 'express';
import { resolve } from 'node:path';
import { openDatabase, migrate } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './mail.js';
const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
migrate(db);
const app = createApp({ db, sendOtp: createMailer(), secret: process.env.OTP_SECRET,
  origin: process.env.APP_ORIGIN, production: process.env.NODE_ENV === 'production',
  trustProxy: Number(process.env.TRUST_PROXY ?? 1) });
app.use(express.static(resolve('dist')));
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'ready', port: Number(process.env.PORT || 3000) }));
});
// Sweeping expired rows now lives in createApp, so any entry point gets it.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.locals.stopSweeper?.(); server.close(() => { db.close(); process.exit(0); });
});
