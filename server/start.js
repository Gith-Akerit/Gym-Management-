import './load-env.js';
import express from 'express';
import { resolve } from 'node:path';
import { openDatabase, migrate } from './db.js';
import { createApp } from './app.js';
import { SlipStore } from './slips.js';
import { MAX_PHOTO_BYTES } from './cards-routes.js';
import { MAX_LOGO_BYTES } from './theme.js';
import { MAX_REPORT_BYTES } from './reports.js';
import { loadPromptPayId } from './promptpay.js';
import { cardSecret } from './secret.js';

/**
 * Pilot mode now means one thing: the gym has no PromptPay account yet. Staff
 * sign in with a password either way, and members never sign in at all, so
 * nothing here depends on a mail provider any more.
 */
const pilotMode = process.env.PILOT_MODE === '1';
if (pilotMode) {
  // Somebody who has filled in a PromptPay account and then left this flag on
  // will otherwise wonder why the old slip queue never shows a QR.
  const ignored = ['PROMPTPAY_ID'].filter(name => process.env[name]);
  console.warn(JSON.stringify({
    event: 'pilot_mode',
    message: 'PILOT_MODE=1: PromptPay is off. Packages are sold across the counter.',
    ...(ignored.length && {
      ignored,
      warning: `${ignored.join(', ')} is configured but will NOT be used while PILOT_MODE=1. `
        + 'Remove PILOT_MODE to go live.',
    }),
  }));
}

const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
migrate(db);
const app = createApp({
  db,
  // Renamed from OTP_SECRET: it signs the QR on every membership card, so it
  // is a key that can never be rotated without invalidating every card the gym
  // has already sent out. The old name is still read so an installed gym keeps
  // working across the upgrade, and warns rather than silently depending on it.
  secret: cardSecret(),
  origin: process.env.APP_ORIGIN,
  production: process.env.NODE_ENV === 'production',
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  slipStore: new SlipStore(process.env.SLIP_STORAGE_PATH || './data/slips'),
  // Member photographs, kept apart from slips: different people may need to be
  // given one directory and not the other, and a backup of faces is a different
  // conversation from a backup of bank slips.
  photoStore: new SlipStore(process.env.PHOTO_STORAGE_PATH || './data/photos', { maxBytes: MAX_PHOTO_BYTES }),
  // The gym's own logo. Its own directory because it is the one image here
  // that is not personal data -- it is served without a session -- and a
  // backup of faces should not be a backup of shop signs.
  logoStore: new SlipStore(process.env.LOGO_STORAGE_PATH || './data/logo', { maxBytes: MAX_LOGO_BYTES }),
  // Screenshots attached to problem reports. Its own directory because these
  // are pictures of whatever was on screen -- usually a member -- and only the
  // owner may read them back, so nobody should be able to hand out this folder
  // by handing out another.
  reportStore: new SlipStore(process.env.REPORT_STORAGE_PATH || './data/reports', { maxBytes: MAX_REPORT_BYTES }),
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
