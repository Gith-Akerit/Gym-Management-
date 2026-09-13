import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Ordered list of schema versions. Add new files here; never edit an applied one.
export const MIGRATIONS = [
  { version: 1, name: '001_foundation' },
  { version: 2, name: '002_gym_config' },
];

const sql = (name, direction) =>
  readFileSync(new URL(`./migrations/${name}.${direction}.sql`, import.meta.url), 'utf8');

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
const applied = (db, version) => !!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version);

export function migrate(db) {
  for (const { version, name } of MIGRATIONS) {
    if (applied(db, version)) continue;
    transaction(db, () => {
      db.exec(sql(name, 'up'));
      db.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);
    });
  }
}
/** Rolls back the newest applied migration, or every one when `all` is set. */
export function rollback(db, { all = false } = {}) {
  for (const { version, name } of [...MIGRATIONS].reverse()) {
    if (!applied(db, version)) continue;
    transaction(db, () => {
      db.exec(sql(name, 'down'));
      db.prepare('DELETE FROM schema_migrations WHERE version=?').run(version);
    });
    if (!all) return;
  }
}
export const memberSelect = `SELECT m.*, u.email FROM members m JOIN users u ON u.id=m.user_id`;
export function getMember(db, id) { return db.prepare(`${memberSelect} WHERE m.id=?`).get(id); }
export function publicMember(row) {
  if (!row) return null;
  const { user_id, ...member } = row;
  return member;
}
export function audit(db, actor, action, id, before, after, now, entityType = 'member') {
  db.prepare(`INSERT INTO audit_logs(id,actor_id,action,entity_id,before_json,after_json,created_at,entity_type)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    randomUUID(), actor, action, id, before ? JSON.stringify(publicMember(before)) : null,
    after ? JSON.stringify(publicMember(after)) : null, now, entityType);
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

// ---------------------------------------------------------------- gym profile

export const WEEKDAYS_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

export function getGym(db) {
  const profile = db.prepare('SELECT * FROM gym_profile WHERE id=1').get() ?? null;
  const hours = db.prepare('SELECT weekday,closed,open_time,close_time FROM gym_hours ORDER BY weekday').all()
    .map(row => ({ ...row, closed: !!row.closed, label: WEEKDAYS_TH[row.weekday] }));
  if (!profile) return { profile: null, hours };
  const { version, updated_at, hours_confirmed, ...rest } = profile;
  return { profile: { ...rest, hours_confirmed: !!hours_confirmed, version, updated_at }, hours };
}
/** What a member is allowed to see: contact details minus whatever staff hid. */
export function publicGym(db) {
  const { profile, hours } = getGym(db);
  if (!profile) return { profile: null, hours };
  const { phone_primary, phone_secondary, phone_display, version, ...rest } = profile;
  const phone = phone_display === 'hidden' ? null
    : phone_display === 'secondary' ? phone_secondary : phone_primary;
  return { profile: { ...rest, phone: phone ?? null }, hours };
}

// ------------------------------------------------------------------- packages

export function publicPackage(row) {
  if (!row) return null;
  const { price_satang, session_limit, ...rest } = row;
  return {
    ...rest,
    session_limit: session_limit ?? null,
    price_satang: price_satang ?? null,
    // null means "the gym has not published a price yet" — never render it as 0.
    price_thb: price_satang === null || price_satang === undefined ? null : price_satang / 100,
  };
}
export const getPackage = (db, id) => db.prepare('SELECT * FROM packages WHERE id=?').get(id);
