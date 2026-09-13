import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY) STRICT');
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function migrate(db) {
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) {
    transaction(db, () => {
      db.exec(readFileSync(new URL('./migrations/001_foundation.up.sql', import.meta.url), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (1)').run();
    });
  }
}
export function rollback(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) {
    transaction(db, () => {
      db.exec(readFileSync(new URL('./migrations/001_foundation.down.sql', import.meta.url), 'utf8'));
      db.prepare('DELETE FROM schema_migrations WHERE version=1').run();
    });
  }
}
export const memberSelect = `SELECT m.*, u.email FROM members m JOIN users u ON u.id=m.user_id`;
export function getMember(db, id) { return db.prepare(`${memberSelect} WHERE m.id=?`).get(id); }
export function publicMember(row) {
  if (!row) return null;
  const { user_id, ...member } = row;
  return member;
}
export function audit(db, actor, action, id, before, after, now) {
  db.prepare('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?)').run(
    randomUUID(), actor, action, id, before ? JSON.stringify(publicMember(before)) : null,
    after ? JSON.stringify(publicMember(after)) : null, now);
}
export function createMember(db, userId, values, actor, now) {
  const id = randomUUID();
  const code = `GYM-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  db.prepare(`INSERT INTO members(id,user_id,member_code,name,phone,date_of_birth,emergency_contact,status,joined_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, userId, code, values.name, values.phone, values.date_of_birth,
    values.emergency_contact, values.status ?? 'active', now, now);
  const row = getMember(db, id);
  audit(db, actor, 'member.create', id, null, row, now);
  return publicMember(row);
}
