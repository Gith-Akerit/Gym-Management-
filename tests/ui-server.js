// Test-only server: in-memory database and a known password. Never imported by
// server/start.js.
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { openDatabase, migrate } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';
import { SlipStore } from '../server/slips.js';
import { MAX_PHOTO_BYTES } from '../server/cards-routes.js';
import { hashPassword } from '../server/passwords.js';
import { issueSetupToken } from '../server/password-setup.js';
import { createApp } from '../server/app.js';
import { registerMachineFallback } from '../server/content-routes.js';
import { importContent } from '../server/content-import.js';
// Two of these run side by side, on whichever pair of ports this run owns.
import { UI_PORT } from './ports.js';
const PORT = Number(process.env.UI_PORT || UI_PORT);
const PILOT = process.env.PILOT_MODE === '1';
const SELF_SIGNUP = process.env.SELF_SIGNUP === '1';
// A throwaway key per run, so the mail settings screen behaves the way it does
// on a machine that has been set up rather than the way it does on one that
// has not. The "no key" path is covered in tests/mail-settings.test.js.
process.env.SETTINGS_ENC_KEY = process.env.SETTINGS_ENC_KEY || randomBytes(32).toString('hex');

/** Every browser journey signs in with this. It exists only here. */
export const UI_PASSWORD = 'counter-test-password';

const db = openDatabase(); migrate(db); seedConfiguration(db);
// The member portal has nothing to show without content, and the browser suite
// walks the same journey a member does. Loaded from the file the gym's own
// import reads, so the specs meet the real shapes rather than invented ones.
importContent(db, JSON.parse(readFileSync(resolve('docs/content/member-content.json'), 'utf8')), Date.now());
const secret = hashPassword(UI_PASSWORD);
// Numbered so it is obvious how many are spare when a new spec needs one.
const seedUsers = (role, addresses) => {
  for (const address of addresses) {
    db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), address, role, secret, Date.now(), Date.now());
  }
};
seedUsers('staff', ['staff-ui@example.test', 'brand-staff@example.test', 'menu-staff@example.test', 'report-staff@example.test', 'forgot-twice@example.test', 'mail-staff@example.test', 'changepw-staff@example.test', 'hotfix-staff@example.test', 'portal-staff@example.test',
  ...Array.from({ length: 5 }, (_, i) => `staff${i + 2}-ui@example.test`)]);
seedUsers('admin', ['layout-admin@example.test', 'admin@example.test', 'contrast2-ui@example.test',
  'brand-admin@example.test', 'menu-admin@example.test', 'report-admin@example.test', 'signup-admin@example.test', 'forgot-admin@example.test', 'invite-admin@example.test', 'mail-admin@example.test', 'diag-admin@example.test', 'hotfix-admin@example.test', 'portal-admin@example.test',
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
/**
 * The post office, with nothing beyond the front door.
 *
 * Every letter this server would have sent is kept here instead, so a browser
 * journey can do what the person receiving it does: open the letter and press
 * the link. Without it the sign-up journey stops dead at "ยืนยันอีเมล", which
 * is the one step a browser cannot take on its own.
 */
const outbox = [];
// What the next letter should pretend the mail server said. The three failures
// a real Office 365 hands back are the whole reason the settings screen has
// three different sets of instructions on it, and a browser cannot provoke
// them without a mailbox that is genuinely misconfigured.
let refusal = null;
const photoRoot = resolve(PILOT ? 'data/test-photos-pilot' : 'data/test-photos');
const app = createApp({ db, secret: randomBytes(32).toString('hex'), origin: `http://127.0.0.1:${PORT}`,
  slipStore: new SlipStore(resolve(PILOT ? 'data/test-slips-pilot' : 'data/test-slips')),
  photoStore: new SlipStore(photoRoot, { maxBytes: MAX_PHOTO_BYTES }),
  logoStore: new SlipStore(resolve(PILOT ? 'data/test-logo-pilot' : 'data/test-logo')),
  reportStore: new SlipStore(resolve(PILOT ? 'data/test-reports-pilot' : 'data/test-reports'), { maxBytes: 6e6 }),
  machineStore: new SlipStore(resolve(PILOT ? 'data/test-machines-pilot' : 'data/test-machines'), { maxBytes: 6e6 }),
  mailer: {
    ready: true,
    send: async message => {
      outbox.push(message);
      if (!refusal) return { sent: true };
      const answer = refusal; refusal = null;   // one letter, then back to normal
      return { sent: false, ...answer };
    },
  },
  // Exactly what a pilot deployment has: no merchant account at all.
  promptPayId: PILOT ? null : '0899999999',
  selfSignup: SELF_SIGNUP,
  pilotMode: PILOT });
// The real server allows 60 sign-ins per quarter of an hour from one address,
// which is generous for a gym and far too little for a browser suite: every
// spec signs in, they all come from 127.0.0.1, and the fifty-somethingth one
// starts being told to wait fifteen minutes. Cleared here rather than raised
// in the app, so the limit the gym runs with is the limit that is tested.
setInterval(() => db.prepare('DELETE FROM rate_limits').run(), 2000).unref();

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
// The letters, newest first. Test-only, and the reason it can exist at all is
// that this server posts nothing: in the real one these bodies carry one-time
// links and are never written down anywhere, not even to the log.
app.get('/__test/outbox', (req, res) => {
  const to = req.query.to;
  res.json({ items: [...outbox].reverse().filter(letter => !to || letter.to === to) });
});
// Test-only: the next letter is refused the way a misconfigured mailbox
// refuses one. There is no equivalent in the real server.
// Test-only: ends a membership the way the counter does when somebody does not
// renew. There is no button for this in the app -- memberships end by the
// clock -- and a browser cannot wait a month.
/**
 * Ends a membership the way time ends one: the entitlement is still a good
 * entitlement, its last day has simply gone by.
 *
 * It used to set status='revoked' and call that "expired", which is why the
 * screen could print "หมดอายุ" over a date a month in the future for a
 * membership the gym had taken back and nothing caught it (QA BUG-12). The
 * two endings are different facts and the suite now asks for them separately.
 */
app.post('/__test/expire-membership', express.json(), (req, res) => {
  const member = db.prepare('SELECT id FROM members WHERE phone=?').get(req.body?.phone ?? '');
  if (!member) return res.status(404).json({ error: 'no such member' });
  const yesterday = Date.now() - 86400000;
  const changed = db.prepare("UPDATE entitlements SET expires_at=? WHERE member_id=? AND status='active'")
    .run(yesterday, member.id).changes;
  res.json({ expired: changed });
});
/** And the other ending: the gym took the entitlement back, before its date. */
app.post('/__test/revoke-membership', express.json(), (req, res) => {
  const member = db.prepare('SELECT id FROM members WHERE phone=?').get(req.body?.phone ?? '');
  if (!member) return res.status(404).json({ error: 'no such member' });
  const changed = db.prepare("UPDATE entitlements SET status='revoked',revoked_at=? WHERE member_id=?")
    .run(Date.now(), member.id).changes;
  res.json({ revoked: changed });
});
app.post('/__test/refuse-mail', express.json(), (req, res) => {
  refusal = { reason: req.body?.reason ?? 'unknown', message: req.body?.message ?? 'ส่งไม่สำเร็จ',
    raw: req.body?.raw ?? '535 5.7.139 SmtpClientAuthentication is disabled for the Mailbox' };
  res.json({ armed: true });
});
app.post('/__test/setup-link', express.json(), (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(req.body?.email);
  if (!user) return res.status(404).json({ error: 'no such account' });
  res.json(issueSetupToken(db, { userId: user.id, now: Date.now() }));
});
/**
 * The member portal's two screens are the single-page app, so a deep link and
 * a refresh both have to reach index.html. `/m/<machine code>` is handled
 * above this by the server itself and never gets here.
 */
app.get(['/m/login', '/m/portal'], (req, res) => res.sendFile(resolve('dist/index.html')));
app.use(express.static(resolve('dist')));
// The same last line as server/start.js, so the browser suite meets the page a
// member would meet. tests/machine-page.test.js checks these two stay in step.
registerMachineFallback({ app, db });
const server = app.listen(PORT, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
