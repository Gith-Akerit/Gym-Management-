import express from 'express';
import { resolve } from 'node:path';
import { openDatabase, migrate } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './mail.js';
import { SlipStore } from './slips.js';
import { loadPromptPayId } from './promptpay.js';

/**
 * Pilot mode lets a gym try the system before it has a mail provider or a
 * PromptPay account: the OTP is read out at the counter and the admin hands
 * packages over directly. Everything else -- members, packages, check-in --
 * works normally, and turning the flag off later changes nothing that was
 * recorded while it was on.
 */
const pilotMode = process.env.PILOT_MODE === '1';
if (pilotMode) {
  // Somebody who has filled in a PromptPay account or a mail server, then left
  // this flag on, will otherwise wonder for a week why no email ever arrives.
  const ignored = ['PROMPTPAY_ID', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']
    .filter(name => process.env[name]);
  console.warn(JSON.stringify({
    event: 'pilot_mode',
    message: 'PILOT_MODE=1: OTP codes are shown in the admin console instead of emailed, '
      + 'and packages are granted by an admin instead of paid for.',
    ...(ignored.length && {
      ignored,
      warning: `${ignored.join(', ')} ${ignored.length > 1 ? 'are' : 'is'} configured but will NOT be used `
        + 'while PILOT_MODE=1. Remove PILOT_MODE to go live.',
    }),
  }));
}

const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
migrate(db);
const app = createApp({
  db,
  sendOtp: pilotMode ? async () => {} : createMailer(),
  secret: process.env.OTP_SECRET,
  origin: process.env.APP_ORIGIN,
  production: process.env.NODE_ENV === 'production',
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  slipStore: new SlipStore(process.env.SLIP_STORAGE_PATH || './data/slips'),
  promptPayId: pilotMode ? null : loadPromptPayId(),
  pilotMode,
});
app.use(express.static(resolve('dist')));
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'ready', port: Number(process.env.PORT || 3000), pilot_mode: pilotMode }));
});
// Sweeping expired rows now lives in createApp, so any entry point gets it.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.locals.stopSweeper?.(); server.close(() => { db.close(); process.exit(0); });
});
