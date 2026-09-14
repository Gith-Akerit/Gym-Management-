// Turning a gym that was already running into the counter app.
//
// The change of product rebuilds the members table, which is the one table
// everything else points at. Nobody's membership, entitlement, order or visit
// may be lost on the way, and the people who were already training here must
// still be able to walk in the next morning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, migrate, openDatabase, rollback } from '../server/db.js';
import { seedConfiguration } from '../server/seed.js';

const BEFORE = MIGRATIONS.filter(m => m.version <= 6);
const NOW = Date.parse('2026-09-01T10:00:00+07:00');

/** A gym as it stood before the change: members with logins, orders, visits. */
function oldGym(db) {
  const sql = (name, direction) =>
    new URL(`../server/migrations/${name}.${direction}.sql`, import.meta.url);
  for (const { version, name } of BEFORE) {
    db.exec(readFileSync(sql(name, 'up'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);
  }
  seedConfiguration(db, NOW);
  const userId = randomUUID(), memberId = randomUUID(), packageId = randomUUID();
  db.prepare("INSERT INTO users(id,email,role,created_at) VALUES(?,?,'member',?)").run(userId, 'old@example.test', NOW);
  db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,emergency_contact,status,joined_at,updated_at)
    VALUES(?,?,?,?,?,'',?,?,?)`).run(memberId, userId, 'GYM-OLDMEMBER01', 'เก่ง เคยสมัคร', '0891234567', 'active', NOW, NOW);
  db.prepare(`INSERT INTO packages(id,code,name_th,type,duration_days,session_limit,price_satang,
    description,status,sort_order,created_at,updated_at) VALUES(?,?,?,'unlimited',30,NULL,120000,'','active',0,?,?)`)
    .run(packageId, 'OLDMONTH', 'รายเดือนเดิม', NOW, NOW);
  const orderId = randomUUID();
  db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
    package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,status,
    manual_grant,created_at,expires_at,updated_at)
    VALUES(?,?,?,'OLDMONTH','รายเดือนเดิม','unlimited',30,NULL,120000,'paid',0,?,?,?)`)
    .run(orderId, memberId, packageId, NOW, NOW + 3600000, NOW);
  db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,expires_at,
    sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?)`)
    .run(randomUUID(), orderId, memberId, packageId, NOW, NOW + 30 * 86400000, NOW);
  db.prepare(`INSERT INTO check_ins(id,member_id,result,method,device_label,checked_in_at)
    VALUES(?,?,'allowed','qr','เคาน์เตอร์ 1',?)`).run(randomUUID(), memberId, NOW);
  // A grant that was never paid for, which the takings must keep excluding.
  const compId = randomUUID();
  db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
    package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,status,
    manual_grant,created_at,expires_at,updated_at)
    VALUES(?,?,?,'OLDMONTH','รายเดือนเดิม','unlimited',30,NULL,120000,'paid',1,?,?,?)`)
    .run(compId, memberId, packageId, NOW, NOW + 3600000, NOW);
  return { userId, memberId, orderId, compId };
}

test('every member, entitlement, order and visit survives the rebuild', t => {
  const db = openDatabase();
  t.after(() => db.close());
  const ids = oldGym(db);

  migrate(db);

  const member = db.prepare('SELECT * FROM members WHERE id=?').get(ids.memberId);
  assert.equal(member.name, 'เก่ง เคยสมัคร');
  assert.equal(member.member_code, 'GYM-OLDMEMBER01');
  assert.equal(member.phone, '0891234567');
  assert.equal(member.status, 'active');
  assert.equal(member.user_id, ids.userId, 'a member who had an account keeps it');
  assert.equal(member.card_version, 1, 'and is issued their first card');
  assert.equal(member.photo_stored_name, null);

  assert.equal(db.prepare('SELECT count(*) AS n FROM entitlements WHERE member_id=?').get(ids.memberId).n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM orders WHERE member_id=?').get(ids.memberId).n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM check_ins WHERE member_id=?').get(ids.memberId).n, 1);
  // Nothing may be left pointing at a row that is no longer there.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // How the gym was paid, deduced from what it already knew: the comped one was
  // never paid at all, the other arrived through the member app's PromptPay.
  assert.equal(db.prepare('SELECT payment_method FROM orders WHERE id=?').get(ids.orderId).payment_method, 'promptpay');
  assert.equal(db.prepare('SELECT payment_method FROM orders WHERE id=?').get(ids.compId).payment_method, 'none');

  // Staff accounts gain somewhere to put a password, and have none yet.
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(ids.userId).password_hash, null);
});

test('a member signed up at the counter has no account, and the rollback keeps them', t => {
  const db = openDatabase();
  t.after(() => db.close());
  oldGym(db);
  migrate(db);

  const walkIn = randomUUID();
  db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,emergency_contact,status,
    card_version,joined_at,updated_at) VALUES(?,NULL,?,?,?,'','active',1,?,?)`)
    .run(walkIn, 'GYM-WALKIN00001', 'วาสนา เดินเข้ามา', '0897654321', NOW, NOW);

  rollback(db);

  // Going back is a developer's move, not a gym's, but it must not throw
  // anybody away. The old table demands an account, so one is invented on an
  // address that can never receive mail.
  const row = db.prepare('SELECT * FROM members WHERE id=?').get(walkIn);
  assert.equal(row.name, 'วาสนา เดินเข้ามา');
  assert.ok(row.user_id, 'a placeholder account, not a deleted member');
  const user = db.prepare('SELECT email FROM users WHERE id=?').get(row.user_id);
  assert.match(user.email, /@counter\.invalid$/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('migrating a database on disk twice changes nothing the second time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gym-migrate-'));
  try {
    const path = join(dir, 'gym.sqlite');
    let db = openDatabase(path);
    const ids = oldGym(db);
    migrate(db);
    db.close();

    db = openDatabase(path);
    migrate(db);
    assert.equal(db.prepare('SELECT count(*) AS n FROM members').get().n, 1);
    assert.equal(db.prepare('SELECT card_version FROM members WHERE id=?').get(ids.memberId).card_version, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // And foreign keys are back on afterwards, not left off by the rebuild.
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
