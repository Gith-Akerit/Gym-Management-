// Rebuilding the audit table on a database that already has one.
//
// Migration 018 copies every row of `audit_logs` into a new table and drops
// the old one. On the machine at the gym that table is not empty -- it holds
// the record of everything the staff have done since the day it was installed.
// A migration that loses those rows loses the only account of what happened,
// and it would do it silently, at boot, on a machine nobody was watching.
//
// So this runs the rebuild over populated data and counts what comes out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate, openDatabase, rollback } from '../server/db.js';

/** A gym's worth of history: accounts, and rows written by each of them. */
function populated(rows = 39) {
  const db = openDatabase();
  migrate(db);
  const now = Date.parse('2026-09-17T17:54:00+07:00');
  for (const [id, email, role] of [['u1', 'owner@example.test', 'admin'], ['u2', 'desk@example.test', 'staff']]) {
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, email, role, now);
  }
  const insert = db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_id,before_json,after_json,created_at,entity_type)
    VALUES(?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < rows; i += 1) {
    insert.run(randomUUID(), i % 2 ? 'u1' : 'u2', 'member.create', `m-${i}`,
      null, JSON.stringify({ name: `สมาชิก ${i}` }), now + i * 1000, 'member');
  }
  return db;
}

test('the rebuild keeps every row it was given', t => {
  const db = populated(39);
  t.after(() => db.close());
  const before = db.prepare('SELECT * FROM audit_logs ORDER BY created_at, id').all();
  assert.equal(before.length, 39);

  // Down to 17 and back up to 18: the same code path a machine takes when the
  // new version boots, run over data that is already there.
  rollback(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_logs').get().n, 39,
    'แม้แต่การถอยกลับก็ต้องไม่ทำแถวหาย');
  migrate(db);

  const after = db.prepare('SELECT * FROM audit_logs ORDER BY created_at, id').all();
  assert.equal(after.length, 39, 'แถวบันทึกต้องอยู่ครบหลัง migration');
  assert.deepEqual(after, before, 'ทุกคอลัมน์ต้องเหมือนเดิมทุกแถว ไม่ใช่แค่จำนวนเท่ากัน');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the placeholder exists once, cannot sign in, and is not a second account', t => {
  const db = populated(3);
  t.after(() => db.close());

  const placeholder = db.prepare("SELECT * FROM users WHERE id='deleted-user'").get();
  assert.ok(placeholder);
  assert.equal(placeholder.password_hash, null, 'บัญชีตัวแทนต้องไม่มีรหัสผ่าน');
  assert.equal(placeholder.status, 'suspended');

  // Running the migration twice must not make a second one, which is what
  // happens on every boot after the first.
  migrate(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE id='deleted-user'").get().n, 1);
});

test('deleting an account moves its rows rather than refusing', t => {
  const db = populated(6);
  t.after(() => db.close());

  const mine = db.prepare("SELECT count(*) AS n FROM audit_logs WHERE actor_id='u2'").get().n;
  assert.ok(mine > 0);
  db.prepare("DELETE FROM users WHERE id='u2'").run();

  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE actor_id='u2'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_logs WHERE actor_id='deleted-user'").get().n, mine,
    'แถวของบัญชีที่ถูกลบต้องย้ายไปที่บัญชีตัวแทน ไม่ใช่หายไป');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the three indexes the reports lean on are really there', t => {
  const db = populated(1);
  t.after(() => db.close());
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name);
  for (const index of ['audit_time', 'audit_actor', 'orders_paid', 'audit_entity']) {
    assert.ok(names.includes(index), `ขาดดัชนี ${index}`);
  }

  // And SQLite really uses them, rather than reading the whole table -- which
  // is the only reason to add an index at all.
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM audit_logs
    WHERE created_at >= 0 AND created_at < 1 ORDER BY created_at DESC`).all();
  assert.match(JSON.stringify(plan), /audit_time/);
});
