// npm run admin:set-password-link -- <email>
//
// Prints a one-time link that opens the set-password screen without signing in.
// For exactly one situation: an installed gym whose administrator account has
// no password, where reinstalling would take the members with it.
//
// Only an admin account, only once per run, and the link is recorded in the
// audit trail the moment it is issued -- issuing one is as good as being able
// to sign in as that person, so it has to be as visible as signing in.

import './load-env.js';
import { openDatabase, migrate, transaction } from './db.js';
import { issueSetupToken, setupPath, SETUP_TTL_MS } from './password-setup.js';
import { email as emailSchema, parse } from './validation.js';

const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
try {
  // Inside the try, so a mistyped address is one line of Thai rather than a
  // stack trace: this is run by whoever has shell access, not by a developer.
  const given = process.argv[2]?.trim();
  if (!given) throw new Error('Usage: npm run admin:set-password-link -- <email>');
  let address;
  try { address = parse(emailSchema, given); }
  catch { throw new Error(`"${given}" is not an email address.`); }

  migrate(db);
  const user = db.prepare('SELECT id,email,role,status FROM users WHERE email=?').get(address);
  if (!user) throw new Error(`No account for ${address}.`);
  if (user.role !== 'admin') throw new Error(`${address} is not an administrator; this is only for the owner's account.`);
  if (user.status !== 'active') throw new Error(`${address} is suspended; restore it first.`);

  const now = Date.now();
  const { token, expiresAt } = transaction(db, () => {
    const issued = issueSetupToken(db, { userId: user.id, now });
    db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_id,before_json,after_json,created_at,entity_type)
      VALUES(lower(hex(randomblob(16))),?,'user.password_link_cli',?,NULL,?,?, 'user')`)
      .run(user.id, user.id, JSON.stringify({ expires_at: issued.expiresAt, issued_from: 'cli' }), now);
    return issued;
  });

  const origin = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
  // The first line is the link and nothing else, so it can be copied straight
  // out of a terminal that has wrapped everything around it.
  console.log(`${origin}${setupPath(token)}`);
  console.log('');
  console.log(`ลิงก์ตั้งรหัสผ่านของ ${user.email} — ใช้ได้ครั้งเดียว หมดอายุใน ${SETUP_TTL_MS / 3600000} ชั่วโมง`);
  console.log(`หมดอายุ: ${new Date(expiresAt).toISOString()}`);
  console.log('ส่งให้เจ้าของบัญชีโดยตรง อย่าส่งลงกลุ่ม ใครเปิดลิงก์นี้ได้ก็ตั้งรหัสผ่านของบัญชีนี้ได้');
  if (!origin) {
    console.log('');
    console.log('(APP_ORIGIN ไม่ได้ตั้งไว้ จึงพิมพ์เป็น path ให้ ต่อหน้าด้วยที่อยู่เว็บของยิมเอง)');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not issue the link.');
  process.exitCode = 1;
} finally { db.close(); }
