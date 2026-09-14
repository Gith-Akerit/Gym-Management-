#!/usr/bin/env node
/**
 * Issue the first sign-in code for an administrator, in pilot mode.
 *
 *   npm run pilot:code -- owner@example.com
 *
 * Pilot mode shows codes in the admin console instead of emailing them, which
 * leaves the very first administrator with nowhere to read their own: the
 * console they would read it from is behind the login they are trying to pass.
 * This is the way through, and it is deliberately narrow -- it runs only while
 * PILOT_MODE=1, only for an account that is already an admin, and only for
 * somebody who is already root on the server.
 *
 * It mints a fresh code rather than recovering an old one. There is nothing to
 * recover: the database holds an HMAC, and guessing digits against it until one
 * matches is not a tool anybody should be handed.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { audit, openDatabase, transaction } from './db.js';
import { otpCodeHash } from './otp.js';

const CODE_LIFETIME_MS = 300000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const email = (process.argv[2] ?? '').trim();
if (!email || process.argv.length > 3) {
  fail('ใช้: npm run pilot:code -- <อีเมลของผู้ดูแลระบบ>');
}
if (process.env.PILOT_MODE !== '1') {
  fail('คำสั่งนี้ใช้ได้เฉพาะตอนเปิดโหมดทดลอง (PILOT_MODE=1) เท่านั้น\n'
    + 'เมื่อเปิดใช้จริงแล้ว รหัสจะถูกส่งทางอีเมลตามปกติ');
}
const secret = process.env.OTP_SECRET ?? '';
if (secret.length < 32) fail('OTP_SECRET ยังไม่ได้ตั้งหรือสั้นเกินไป');

const db = openDatabase(process.env.DATABASE_PATH || './data/gym.sqlite');
const now = Date.now();

const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
if (!user) fail(`ไม่พบบัญชี ${email} ในระบบ`);
// Narrow on purpose. A member's code is readable from the admin console by the
// people who are supposed to read it; this path exists only for the account
// that cannot reach that console yet.
if (user.role !== 'admin') {
  fail(`บัญชี ${email} ไม่ใช่ผู้ดูแลระบบ คำสั่งนี้ออกรหัสให้เฉพาะผู้ดูแลระบบ\n`
    + 'รหัสของสมาชิกและพนักงานดูได้จากแท็บ "รหัส OTP" ในหน้าผู้ดูแลระบบ');
}

const id = randomUUID();
const code = String(randomInt(0, 1000000)).padStart(6, '0');
transaction(db, () => {
  // Same rule as the login screen: asking for a code retires the one before it,
  // so only the newest set of digits ever opens the door.
  db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL').run(now, email);
  db.prepare('INSERT INTO otp_challenges(id,email,code_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(id, email, otpCodeHash(secret, id, code), now, now + CODE_LIFETIME_MS);
  // The code is never written anywhere, including here. What is recorded is
  // that somebody with root on this machine issued one, and for whom.
  audit(db, user.id, 'auth.pilot_code_cli', user.id, null, null, now, 'user');
});
db.close();

const origin = (process.env.APP_ORIGIN || '').replace(/\/$/, '');
const until = new Intl.DateTimeFormat('th-TH', { timeStyle: 'short', timeZone: 'Asia/Bangkok' })
  .format(new Date(now + CODE_LIFETIME_MS));

console.log(`\nรหัสเข้าใช้งานของ ${email}\n`);
console.log(`    ${code}\n`);
console.log(`ใช้ได้ครั้งเดียว ภายใน 5 นาที (ถึงเวลา ${until} น.)`);
if (origin) {
  console.log('\nเปิดลิงก์นี้บนมือถือแล้วกรอกรหัสข้างบน:');
  console.log(`    ${origin}/?challenge=${id}`);
  console.log('\nถ้าเปิดหน้าเว็บค้างไว้อยู่แล้ว ให้ใช้ลิงก์นี้แทน เพราะการขอรหัสใหม่');
  console.log('จะยกเลิกรหัสก่อนหน้าเสมอ');
}
console.log('');
