import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Ordered list of schema versions. Add new files here; never edit an applied one.
export const MIGRATIONS = [
  { version: 1, name: '001_foundation' },
  { version: 2, name: '002_gym_config' },
  { version: 3, name: '003_orders' },
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
  const { phone_primary, phone_secondary, phone_display, version, order_ttl_minutes, ...rest } = profile;
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

// ------------------------------------------------------------ orders & slips

export const ORDER_OPEN = ['pending_payment', 'awaiting_review', 'rejected'];

export const getOrder = (db, id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);

export function publicOrder(row) {
  if (!row) return null;
  const { price_satang_snapshot, session_limit_snapshot, reviewed_by, ...rest } = row;
  return {
    ...rest,
    session_limit_snapshot: session_limit_snapshot ?? null,
    price_satang_snapshot,
    price_thb: price_satang_snapshot / 100,
  };
}

/** Slip metadata only — the image itself is fetched through an authorised route. */
export function publicSlip(row) {
  if (!row) return null;
  const { amount_satang_claimed, ...rest } = row;
  return {
    ...rest,
    amount_satang_claimed: amount_satang_claimed ?? null,
    amount_thb_claimed: amount_satang_claimed === null || amount_satang_claimed === undefined
      ? null : amount_satang_claimed / 100,
  };
}

export const currentSlip = (db, orderId) =>
  db.prepare('SELECT * FROM payment_slips WHERE order_id=? AND superseded_at IS NULL ORDER BY uploaded_at DESC LIMIT 1')
    .get(orderId);

export function publicEntitlement(row) {
  if (!row) return null;
  const { sessions_total, sessions_remaining, ...rest } = row;
  return { ...rest, sessions_total: sessions_total ?? null, sessions_remaining: sessions_remaining ?? null };
}

/**
 * Live entitlements, soonest expiry first. Phase 3 deducts from the head of
 * this list; ties are broken by purchase order, as agreed on KENC-20.
 */
export const activeEntitlements = (db, memberId, now) =>
  db.prepare(`SELECT * FROM entitlements WHERE member_id=? AND status='active' AND expires_at>?
    ORDER BY expires_at, created_at`).all(memberId, now);

/**
 * Moves unpaid orders past their deadline to 'expired'. Called before any read
 * of order state so a member never sees a dead order as still payable.
 */
export function expireStaleOrders(db, now) {
  return db.prepare(`UPDATE orders SET status='expired', version=version+1, updated_at=?
    WHERE status IN ('pending_payment','rejected') AND expires_at<=?`).run(now, now).changes;
}
