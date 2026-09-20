// The five reports, and the rules they all share.
//
// Everything here is a read. No report writes an audit row, because opening a
// report is not touching a customer's data -- and a trail that fills up with
// "somebody looked at a table" is a trail nobody reads.
//
// Three decisions from the spec shape the whole file.
//
// A sale is counted from `reviewed_at`, the moment money changed hands at the
// counter, and only while `status='paid'` and `manual_grant=0`. Reversing an
// order rewrites both, so yesterday's total can drop today -- the reports say
// so out loud rather than pretending otherwise, and show the reversals in a
// block of their own.
//
// The scan history is read from `check_ins`, not from `audit_logs`. Only
// successful scans ever reached the audit table, and that row writes the
// check-in's own id into `entity_id` while leaving `entity_type` at its
// default 'member' -- so joining it to members finds nothing. The rows are
// fine; the reading of them has to be right.
//
// And `before_json`/`after_json` never leave this file. They hold a member's
// name, telephone number and address. What a report may say is WHICH FIELDS
// changed, in Thai, and nothing about their contents.

import { createRequire } from 'node:module';
import { z } from 'zod';
import { HttpError, parse } from './validation.js';

const { formatPhone } = createRequire(import.meta.url)('../shared/phone.cjs');

/** The gym is in Bangkok and so is every date in every report. */
const TZ_OFFSET_MS = 7 * 3600000;
const DAY_MS = 86400000;
/** One request may not ask for more than a year, or return more than this. */
const MAX_DAYS = 366;
export const MAX_ROWS = 5000;

/** `date(x/1000,'unixepoch','+7 hours')` — the rule the rest of the app uses. */
const thaiDay = column => `date(${column}/1000,'unixepoch','+7 hours')`;

/** The placeholder migration 018 moves deleted accounts' history to. */
const DELETED_USER = 'deleted-user';
export const DELETED_ACCOUNT_LABEL = 'บัญชีที่ถูกลบ';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD');

/**
 * `from`/`to` in Thai days to a half-open range of milliseconds.
 *
 * Both ends are inclusive to the person reading the screen -- "17 to 19" means
 * three whole days -- which is a range that ends at the start of the 20th.
 */
export function rangeFrom({ from, to }, { days = 30 } = {}) {
  const today = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
  const end = to ?? today;
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  if (start > end) throw new HttpError(400, 'ช่วงวันที่ไม่ถูกต้อง วันเริ่มต้องไม่เกินวันสิ้นสุด');
  const startMs = Date.parse(`${start}T00:00:00Z`) - TZ_OFFSET_MS;
  const endMs = Date.parse(`${end}T00:00:00Z`) - TZ_OFFSET_MS + DAY_MS;
  if ((endMs - startMs) / DAY_MS > MAX_DAYS) {
    throw new HttpError(400, 'ช่วงวันที่ยาวเกินไป กรุณาเลือกไม่เกิน 1 ปี');
  }
  return { from: start, to: end, startMs, endMs };
}

/** `2026-09-20T14:05:32+07:00` — sortable by Excel and by a script. */
export const isoTime = ms => (ms == null ? ''
  : `${new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 19)}+07:00`);

/** `20/09/2569 14:05` — the one a person reads. */
export function thaiTime(ms) {
  if (ms == null) return '';
  const at = new Date(ms + TZ_OFFSET_MS);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(at.getUTCDate())}/${pad(at.getUTCMonth() + 1)}/${at.getUTCFullYear() + 543} `
    + `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** `2026-09-20` → `20/09/2569`, for the columns that carry a day and no clock. */
export function thaiDate(day) {
  if (!day) return '';
  const [year, month, date] = day.split('-');
  return `${date}/${month}/${Number(year) + 543}`;
}

/** Satang to `1200.00`: no thousands separator, no currency sign, SUM-able. */
export const baht = satang => ((satang ?? 0) / 100).toFixed(2);

/**
 * Every action this system writes, in Thai, with the group it belongs to.
 *
 * `tests/report-actions.test.js` reads `server/*.js` for the actions actually
 * written and fails if one of them is missing here -- an action added next
 * month and never translated shows up as a failing test rather than as a row
 * of raw code on the owner's screen.
 */
export const ACTIONS = {
  'member.create': ['สมัครสมาชิก', 'สมัครสมาชิกใหม่'],
  'order.counter_sale': ['ขาย/รับเงิน', 'ขายแพ็กเกจ'],
  'order.grant_manual': ['ขาย/รับเงิน', 'แถมแพ็กเกจ (ไม่ได้รับเงิน)'],
  'order.reverse': ['ขาย/รับเงิน', 'กลับรายการขาย'],
  'order.approve': ['ขาย/รับเงิน', 'ตรวจสลิป: อนุมัติ'],
  'order.reject': ['ขาย/รับเงิน', 'ตรวจสลิป: ปฏิเสธ'],
  'order.reopen': ['ขาย/รับเงิน', 'ตรวจสลิป: เปิดใหม่'],
  'order.create': ['ขาย/รับเงิน', 'เปิดคำสั่งซื้อ'],
  'order.cancel': ['ขาย/รับเงิน', 'ยกเลิกคำสั่งซื้อ'],
  'order.slip': ['ขาย/รับเงิน', 'แนบสลิป'],
  'entitlement.revoke': ['ขาย/รับเงิน', 'ยกเลิกสิทธิ์ของสมาชิก'],
  'checkin.allowed': ['เช็คอิน', 'เช็คอิน — เข้าใช้ได้'],
  'checkin.duplicate': ['เช็คอิน', 'เช็คอิน — สแกนซ้ำ'],
  'checkin.denied': ['เช็คอิน', 'เช็คอิน — ไม่ผ่าน'],
  'member.card_link': ['บัตรและลิงก์', 'ส่งบัตรซ้ำ (ลิงก์ 7 วัน)'],
  'member.card_emailed': ['บัตรและลิงก์', 'ส่งบัตรทางอีเมล'],
  'member.card_reissue': ['บัตรและลิงก์', 'ออกบัตรใหม่ (บัตรเดิมใช้ไม่ได้)'],
  'member.portal_link_issued': ['บัตรและลิงก์', 'สร้างลิงก์เข้าช่วยเล่น'],
  'member.update': ['แก้ข้อมูลสมาชิก', 'แก้ข้อมูลสมาชิก'],
  'member.deactivate': ['แก้ข้อมูลสมาชิก', 'ระงับสมาชิก'],
  'member.reactivate': ['แก้ข้อมูลสมาชิก', 'คืนสถานะสมาชิก'],
  'member.delete': ['แก้ข้อมูลสมาชิก', 'ลบสมาชิก'],
  'member.photo': ['แก้ข้อมูลสมาชิก', 'เปลี่ยนรูปถ่ายสมาชิก'],
  'user.create': ['บัญชีผู้ใช้', 'สร้างบัญชี'],
  'user.role': ['บัญชีผู้ใช้', 'เปลี่ยนสิทธิ์'],
  'user.suspend': ['บัญชีผู้ใช้', 'ระงับบัญชี'],
  'user.restore': ['บัญชีผู้ใช้', 'คืนสิทธิ์บัญชี'],
  'user.password': ['บัญชีผู้ใช้', 'ตั้งรหัสให้'],
  'user.password_changed': ['บัญชีผู้ใช้', 'เปลี่ยนรหัสของตัวเอง'],
  'user.password_link_issued': ['บัญชีผู้ใช้', 'สร้างลิงก์ตั้งรหัส'],
  'user.password_link_cli': ['บัญชีผู้ใช้', 'สร้างลิงก์ตั้งรหัสจากเครื่อง'],
  'user.password_set_by_link': ['บัญชีผู้ใช้', 'ตั้งรหัสจากลิงก์'],
  'user.password_reset_requested': ['บัญชีผู้ใช้', 'ขอลิงก์ลืมรหัสผ่าน'],
  'user.approve': ['บัญชีผู้ใช้', 'อนุมัติคำขอเปิดบัญชี'],
  'user.reject': ['บัญชีผู้ใช้', 'ปฏิเสธคำขอเปิดบัญชี'],
  'user.signup_requested': ['บัญชีผู้ใช้', 'ขอเปิดบัญชีเอง'],
  'user.email_verified': ['บัญชีผู้ใช้', 'ยืนยันอีเมลแล้ว'],
  'user.verify_resent': ['บัญชีผู้ใช้', 'ส่งอีเมลยืนยันอีกครั้ง'],
  'user.bootstrap_admin': ['บัญชีผู้ใช้', 'ตั้งผู้ดูแลระบบคนแรก'],
  'user.login': ['เข้าสู่ระบบ', 'เข้าสู่ระบบ'],
  'user.logout': ['เข้าสู่ระบบ', 'ออกจากระบบ'],
  'gym.update': ['ตั้งค่ายิม', 'แก้ข้อมูลยิม'],
  'gym.update_hours': ['ตั้งค่ายิม', 'แก้เวลาเปิด'],
  'gym.settings': ['ตั้งค่ายิม', 'แก้สีและแบรนด์'],
  'gym.logo': ['ตั้งค่ายิม', 'เปลี่ยนโลโก้'],
  'gym.logo_remove': ['ตั้งค่ายิม', 'เอาโลโก้ออก'],
  'gym.mail_settings_changed': ['ตั้งค่ายิม', 'แก้การตั้งค่าอีเมลของระบบ'],
  'package.create': ['ตั้งค่ายิม', 'เพิ่มแพ็กเกจ'],
  'package.update': ['ตั้งค่ายิม', 'แก้แพ็กเกจ'],
  'package.archive': ['ตั้งค่ายิม', 'ปิดการขายแพ็กเกจ'],
  'content.machine_edited': ['เนื้อหาช่วยเล่น', 'แก้เนื้อหาเครื่อง'],
  'content.program_edited': ['เนื้อหาช่วยเล่น', 'แก้เนื้อหาโปรแกรม'],
  'content.article_edited': ['เนื้อหาช่วยเล่น', 'แก้เนื้อหาบทความ'],
  'content.safety_changed': ['เนื้อหาช่วยเล่น', 'แก้หรืออนุมัติข้อความความปลอดภัย'],
  'report.create': ['แจ้งปัญหา', 'แจ้งปัญหา'],
  'report.update': ['แจ้งปัญหา', 'เปลี่ยนสถานะเรื่อง'],
  'report.delete': ['แจ้งปัญหา', 'ลบเรื่อง'],
  'report.view_image': ['แจ้งปัญหา', 'เปิดดูภาพหน้าจอของเรื่อง'],
};

export const KINDS = [...new Set(Object.values(ACTIONS).map(([group]) => group)), 'อื่น ๆ'];

/** An action nobody has translated is shown raw, never hidden. */
export const describeAction = action => ACTIONS[action] ?? ['อื่น ๆ', action];

/** Thai names for the member fields, for "แก้: เบอร์โทร, อีเมล". */
const FIELD_NAMES = {
  name: 'ชื่อ', phone: 'เบอร์โทร', email: 'อีเมล', date_of_birth: 'วันเกิด',
  emergency_contact: 'ผู้ติดต่อฉุกเฉิน', status: 'สถานะ',
  photo_stored_name: 'รูปถ่าย', card_version: 'เลขที่บัตร',
};

/**
 * Which fields changed — never what they changed to.
 *
 * The two JSON columns carry a member's name, telephone number and address.
 * This is the only thing any report is allowed to learn from them.
 */
export function changedFields(beforeJson, afterJson) {
  const read = value => { try { return JSON.parse(value ?? 'null') ?? {}; } catch { return {}; } };
  const before = read(beforeJson);
  const after = read(afterJson);
  if (!Object.keys(before).length || !Object.keys(after).length) return '';
  const changed = Object.keys({ ...before, ...after })
    .filter(key => FIELD_NAMES[key] && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => FIELD_NAMES[key]);
  return changed.length ? `แก้: ${changed.join(', ')}` : '';
}

/**
 * Why a scan failed, in groups, by keyword.
 *
 * `failure_reason` is free Thai text written in the code, not an enum, so
 * comparing whole strings would make the statistics break the day somebody
 * fixes a typo. The raw sentence still travels in its own column.
 */
export function failureGroup(reason) {
  const text = reason ?? '';
  if (!text) return 'อื่น ๆ';
  if (text.includes('ยกเลิก') && text.includes('บัตร')) return 'บัตรถูกยกเลิก (ออกบัตรใหม่แล้ว)';
  if (text.includes('หมดอายุ') || text.includes('ใช้ครบ')) return 'แพ็กเกจหมดอายุ / ใช้ครบแล้ว';
  if (text.includes('ยังไม่มีแพ็กเกจ')) return 'ยังไม่มีแพ็กเกจ';
  if (text.includes('ระงับ')) return 'สมาชิกถูกระงับ';
  if (text.includes('QR')) return 'QR ไม่ถูกต้อง';
  if (text.includes('เช็คอินไปแล้ว')) return 'สแกนซ้ำ (ไม่ได้หักสิทธิ์)';
  return 'อื่น ๆ';
}

// ------------------------------------------------------------------------ CSV

/** A field, quoted only when it has to be. */
const cell = value => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/**
 * A CSV Excel on Windows opens without mangling Thai.
 *
 * The BOM is not decoration: without it Excel reads the file in the system
 * code page and every Thai character becomes rubbish. CRLF for the same
 * reason -- it is what Excel writes, so it is what Excel expects.
 */
export function toCsv(blocks) {
  const lines = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.title) lines.push(cell(block.title));
    if (block.headers) lines.push(block.headers.map(cell).join(','));
    for (const row of block.rows ?? []) lines.push(row.map(cell).join(','));
    lines.push('');                                   // a blank line between blocks
  }
  return `﻿${lines.join('\r\n')}`;
}

export const csvFilename = (name, { from, to }) => `${name}-${from}-${to}.csv`;

/** Sends either shape from one place, so no report can disagree with another. */
export function answer(res, { format, name, range, payload, csv }) {
  if (format !== 'csv') return res.json(payload);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${csvFilename(name, range)}"`);
  return res.send(toCsv(csv));
}

/** Every day in the range, so a quiet Tuesday is a row of zeros, not a gap. */
export function everyDay({ from, to }) {
  const days = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

export const querySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  format: z.enum(['json', 'csv']).optional(),
  actor: z.string().trim().max(64).optional(),
  kind: z.string().trim().max(64).optional(),
  bucket: z.enum(['day', 'month']).optional(),
  view: z.enum(['active', 'expiring', 'expired', 'new']).optional(),
  status: z.enum(['open', 'all']).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
}).strict();

export function registerAdminReportRoutes({ app, db, now, admin }) {
  const read = req => parse(querySchema, req.query);

  /** The label a report shows for whoever did something. */
  const actorLabel = (email, id) => (id === DELETED_USER || !email ? DELETED_ACCOUNT_LABEL : email);

  // ------------------------------------------- 1 · what the staff have done

  app.get('/api/admin/reports/staff-activity', admin, (req, res) => {
    const input = read(req);
    const range = rangeFrom(input, { days: 1 });
    const rows = db.prepare(`
      SELECT ts, actor_id, actor, action, entity_type, entity_id, before_json, after_json,
             result, failure_reason, device_label FROM (
        SELECT a.created_at AS ts, a.actor_id AS actor_id, u.email AS actor, a.action AS action,
               a.entity_type AS entity_type, a.entity_id AS entity_id,
               a.before_json AS before_json, a.after_json AS after_json,
               NULL AS result, NULL AS failure_reason, NULL AS device_label
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.created_at >= ? AND a.created_at < ? AND a.action <> 'checkin.allowed'
        UNION ALL
        SELECT c.checked_in_at AS ts, c.scanned_by AS actor_id, u.email AS actor,
               'checkin.' || c.result AS action, 'member' AS entity_type, c.member_id AS entity_id,
               NULL AS before_json, NULL AS after_json,
               c.result AS result, c.failure_reason AS failure_reason, c.device_label AS device_label
        FROM check_ins c LEFT JOIN users u ON u.id = c.scanned_by
        WHERE c.checked_in_at >= ? AND c.checked_in_at < ?
      ) ORDER BY ts DESC`).all(range.startMs, range.endMs, range.startMs, range.endMs);

    const memberName = db.prepare('SELECT member_code, name FROM members WHERE id=?');
    const orderRow = db.prepare('SELECT rejection_reason FROM orders WHERE id=?');
    const reportRow = db.prepare('SELECT reference FROM problem_reports WHERE id=?');
    const machineRow = db.prepare('SELECT name_th FROM machines WHERE code=?');
    const programRow = db.prepare('SELECT name_th FROM programs WHERE code=?');

    const RESULTS = { allowed: 'ผ่าน', duplicate: 'ซ้ำ', denied: 'ไม่ผ่าน' };
    const about = row => {
      if (row.entity_type === 'member') {
        if (!row.entity_id) return '';
        const member = memberName.get(row.entity_id);
        return member ? `${member.name} (${member.member_code})` : '';
      }
      if (row.entity_type === 'order') return row.entity_id.slice(0, 8);
      if (row.entity_type === 'report') {
        const found = reportRow.get(row.entity_id);
        return found ? `#${found.reference}` : '';
      }
      if (row.entity_type === 'machine') return machineRow.get(row.entity_id)?.name_th ?? row.entity_id;
      if (row.entity_type === 'program') return programRow.get(row.entity_id)?.name_th ?? row.entity_id;
      return '';
    };
    const reason = row => {
      if (row.failure_reason) return row.failure_reason;
      if (row.action === 'order.reverse') return orderRow.get(row.entity_id)?.rejection_reason ?? '';
      return changedFields(row.before_json, row.after_json);
    };

    const all = rows.map(row => {
      const [kind, label] = describeAction(row.action);
      return {
        ts: row.ts, actor_id: row.actor_id, iso: isoTime(row.ts), when: thaiTime(row.ts),
        actor: actorLabel(row.actor, row.actor_id), kind, action: row.action, label,
        about: about(row), result: RESULTS[row.result] ?? '',
        reason: reason(row), device: row.device_label ?? '',
      };
    });
    const filtered = all.filter(row =>
      (!input.actor || input.actor === 'all' || row.actor_id === input.actor)
      && (!input.kind || input.kind === 'all' || row.kind === input.kind));

    // Per person per day, which is the question an owner actually asks.
    const totals = new Map();
    for (const row of filtered) {
      const day = new Date(row.ts + TZ_OFFSET_MS).toISOString().slice(0, 10);
      const key = `${day} ${row.actor}`;
      const bucket = totals.get(key)
        ?? { day, actor: row.actor, total: 0, signups: 0, sales: 0, checkin_ok: 0, checkin_other: 0 };
      bucket.total += 1;
      if (row.action === 'member.create') bucket.signups += 1;
      if (row.action === 'order.counter_sale' || row.action === 'order.grant_manual') bucket.sales += 1;
      if (row.action === 'checkin.allowed') bucket.checkin_ok += 1;
      if (row.action === 'checkin.denied' || row.action === 'checkin.duplicate') bucket.checkin_other += 1;
      totals.set(key, bucket);
    }
    const summary = [...totals.values()].sort((a, b) => (a.day === b.day ? b.total - a.total : b.day.localeCompare(a.day)));
    const items = filtered.map(({ ts, actor_id, action, ...rest }) => rest);

    answer(res, {
      format: input.format, name: 'staff-activity', range,
      payload: {
        range: { from: range.from, to: range.to },
        items: items.slice(0, MAX_ROWS), total: items.length,
        truncated: items.length > MAX_ROWS, summary,
        actors: db.prepare(`SELECT id, email FROM users WHERE role IN ('admin','staff') AND id<>?
          ORDER BY email`).all(DELETED_USER),
        kinds: KINDS,
      },
      csv: [
        { title: `สรุปการทำรายการพนักงาน ${thaiDate(range.from)} – ${thaiDate(range.to)}`,
          headers: ['เวลา (ISO)', 'วันที่', 'บัญชี', 'ประเภท', 'รายการ', 'เกี่ยวกับ', 'ผลลัพธ์', 'เหตุผล', 'จุดสแกน'],
          rows: items.map(row => [row.iso, row.when, row.actor, row.kind, row.label,
            row.about, row.result, row.reason, row.device]) },
        { title: 'ยอดรวมต่อคนต่อวัน',
          headers: ['วันที่', 'บัญชี', 'ทั้งหมด', 'สมัครสมาชิก', 'ขาย/แถม', 'เช็คอินผ่าน', 'เช็คอินอื่น ๆ'],
          rows: [...summary.map(row => [thaiDate(row.day), row.actor, row.total, row.signups,
            row.sales, row.checkin_ok, row.checkin_other]),
          ['รวม', '', items.length, '', '', '', '']] },
      ],
    });
  });

  // ------------------------------------------------------------- 2 · sales

  app.get('/api/admin/reports/sales', admin, (req, res) => {
    const input = read(req);
    const today = new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
    const range = rangeFrom({ from: input.from ?? `${today.slice(0, 7)}-01`, to: input.to });
    const bucket = input.bucket ?? 'day';
    const key = bucket === 'month'
      ? `strftime('%Y-%m', reviewed_at/1000,'unixepoch','+7 hours')`
      : thaiDay('reviewed_at');

    const rows = db.prepare(`SELECT ${key} AS period, package_name_snapshot AS package,
      payment_method, count(*) AS orders, sum(price_satang_snapshot) AS satang
      FROM orders WHERE status='paid' AND manual_grant=0
        AND reviewed_at >= ? AND reviewed_at < ?
      GROUP BY period, package, payment_method
      ORDER BY period DESC, satang DESC`).all(range.startMs, range.endMs);

    const PAYMENT = { cash: 'เงินสด', transfer: 'โอน', promptpay: 'พร้อมเพย์', none: 'ไม่ได้รับเงิน' };
    const items = rows.map(row => ({
      period: row.period, period_label: bucket === 'month' ? row.period : thaiDate(row.period),
      package: row.package, payment_method: PAYMENT[row.payment_method] ?? row.payment_method,
      orders: row.orders, satang: row.satang, baht: baht(row.satang),
    }));
    const totalSatang = items.reduce((sum, row) => sum + row.satang, 0);
    const totalOrders = items.reduce((sum, row) => sum + row.orders, 0);

    // Kept apart from the money on purpose: a package given away is not income,
    // and a reversal is the reason an old day's total moved.
    const granted = db.prepare(`SELECT ${thaiDay('reviewed_at')} AS period, package_name_snapshot AS package,
      count(*) AS orders, sum(price_satang_snapshot) AS satang, group_concat(review_note, ' · ') AS note
      FROM orders WHERE status='paid' AND manual_grant=1 AND reviewed_at >= ? AND reviewed_at < ?
      GROUP BY period, package ORDER BY period DESC`).all(range.startMs, range.endMs);
    const reversed = db.prepare(`SELECT ${thaiDay('reviewed_at')} AS period, package_name_snapshot AS package,
      price_satang_snapshot AS satang, rejection_reason AS reason
      FROM orders WHERE status='rejected' AND reviewed_at >= ? AND reviewed_at < ?
      ORDER BY reviewed_at DESC`).all(range.startMs, range.endMs);

    answer(res, {
      format: input.format, name: 'sales', range,
      payload: {
        range: { from: range.from, to: range.to }, bucket,
        items, total_orders: totalOrders, total_satang: totalSatang, total_baht: baht(totalSatang),
        granted: granted.map(row => ({ ...row, period_label: thaiDate(row.period), baht: baht(row.satang) })),
        reversed: reversed.map(row => ({ ...row, period_label: thaiDate(row.period), baht: baht(row.satang) })),
        note: 'ยอดนี้นับเฉพาะรายการที่ยังไม่ถูกกลับรายการ · รายการที่กลับรายการแล้วดูได้ในบล็อกด้านล่าง',
      },
      csv: [
        { title: `ยอดขาย ${thaiDate(range.from)} – ${thaiDate(range.to)}`,
          headers: [bucket === 'month' ? 'เดือน' : 'วันที่', 'แพ็กเกจ', 'วิธีชำระ', 'จำนวนรายการ', 'บาท'],
          rows: [...items.map(row => [row.period_label, row.package, row.payment_method, row.orders, row.baht]),
            ['รวม', '', '', totalOrders, baht(totalSatang)]] },
        { title: 'แถมให้ (ไม่ได้รับเงิน)',
          headers: ['วันที่', 'แพ็กเกจ', 'จำนวนรายการ', 'มูลค่า (บาท)', 'เหตุผล'],
          rows: granted.map(row => [thaiDate(row.period), row.package, row.orders, baht(row.satang), row.note ?? '']) },
        { title: 'กลับรายการในช่วงนี้',
          headers: ['วันที่กลับรายการ', 'แพ็กเกจ', 'บาท', 'เหตุผล'],
          rows: reversed.map(row => [thaiDate(row.period), row.package, baht(row.satang), row.reason ?? '']) },
      ],
    });
  });

  // --------------------------------------------------------- 3 · check-ins

  app.get('/api/admin/reports/checkins', admin, (req, res) => {
    const input = read(req);
    const range = rangeFrom(input, { days: 7 });
    const rows = db.prepare(`SELECT ${thaiDay('checked_in_at')} AS day,
      sum(CASE WHEN result='allowed'   THEN 1 ELSE 0 END) AS allowed,
      sum(CASE WHEN result='duplicate' THEN 1 ELSE 0 END) AS duplicate,
      sum(CASE WHEN result='denied'    THEN 1 ELSE 0 END) AS denied,
      count(DISTINCT CASE WHEN result='allowed' THEN member_id END) AS unique_members
      FROM check_ins WHERE checked_in_at >= ? AND checked_in_at < ?
      GROUP BY day ORDER BY day DESC`).all(range.startMs, range.endMs);
    const byDay = new Map(rows.map(row => [row.day, row]));
    // A day with no scans is a row of zeros, filled in here rather than on the
    // screen: a gap in a table reads as missing data, not as a quiet day.
    const items = everyDay(range).reverse().map(day => {
      const row = byDay.get(day) ?? { allowed: 0, duplicate: 0, denied: 0, unique_members: 0 };
      return { day, day_label: thaiDate(day), ...row, day_key: undefined };
    }).map(({ day_key, ...rest }) => rest);

    const hours = db.prepare(`SELECT cast(strftime('%H', checked_in_at/1000,'unixepoch','+7 hours') AS INTEGER) AS hour,
      count(*) AS total FROM check_ins
      WHERE result='allowed' AND checked_in_at >= ? AND checked_in_at < ?
      GROUP BY hour ORDER BY hour`).all(range.startMs, range.endMs);
    const byHour = new Map(hours.map(row => [row.hour, row.total]));
    const busiest = Array.from({ length: 24 }, (_, hour) => ({ hour, total: byHour.get(hour) ?? 0 }));

    const failures = db.prepare(`SELECT failure_reason, count(*) AS total FROM check_ins
      WHERE result<>'allowed' AND checked_in_at >= ? AND checked_in_at < ?
      GROUP BY failure_reason`).all(range.startMs, range.endMs);
    const grouped = new Map();
    for (const row of failures) {
      const group = failureGroup(row.failure_reason);
      grouped.set(group, (grouped.get(group) ?? 0) + row.total);
    }
    const reasons = [...grouped.entries()].map(([group, total]) => ({ group, total }))
      .sort((a, b) => b.total - a.total);

    const sum = field => items.reduce((total, row) => total + row[field], 0);
    answer(res, {
      format: input.format, name: 'checkins', range,
      payload: { range: { from: range.from, to: range.to }, items, busiest, reasons },
      csv: [
        { title: `การเข้าใช้บริการ ${thaiDate(range.from)} – ${thaiDate(range.to)}`,
          headers: ['วันที่', 'เข้าใช้ได้', 'สแกนซ้ำ', 'ไม่ผ่าน', 'จำนวนคน (ไม่นับซ้ำ)'],
          rows: [...items.map(row => [row.day_label, row.allowed, row.duplicate, row.denied, row.unique_members]),
            ['รวม', sum('allowed'), sum('duplicate'), sum('denied'), '']] },
        { title: 'ช่วงเวลาที่คนเยอะ',
          headers: ['ชั่วโมง', 'เข้าใช้ได้'],
          rows: busiest.map(row => [`${String(row.hour).padStart(2, '0')}:00`, row.total]) },
        { title: 'เหตุผลที่ไม่ผ่าน',
          headers: ['เหตุผล', 'จำนวนครั้ง'],
          rows: reasons.map(row => [row.group, row.total]) },
      ],
    });
  });

  // ----------------------------------------------------------- 4 · members

  app.get('/api/admin/reports/members', admin, (req, res) => {
    const input = read(req);
    const view = input.view ?? 'expiring';
    const days = input.days ?? 7;
    const at = now();

    // One row per member: the entitlement that runs longest among those still
    // usable, which is the one the member screen shows. Somebody who bought a
    // second package before the first ran out has two, and the report must
    // agree with the screen about which one represents them.
    const base = `WITH live AS (
      SELECT e.member_id, e.expires_at, e.sessions_remaining, e.sessions_total,
             o.package_name_snapshot AS package,
             row_number() OVER (PARTITION BY e.member_id ORDER BY e.expires_at DESC) AS rank
      FROM entitlements e LEFT JOIN orders o ON o.id = e.order_id
      WHERE e.status='active' AND e.expires_at > ${at}
        AND (e.sessions_total IS NULL OR e.sessions_remaining > 0)
    )
    SELECT m.id, m.member_code, m.name, m.phone, m.joined_at, m.status,
           l.expires_at AS expires_at, l.sessions_remaining AS sessions_remaining,
           l.sessions_total AS sessions_total, l.package AS package
    FROM members m LEFT JOIN live l ON l.member_id = m.id AND l.rank = 1
    WHERE m.status <> 'suspended'`;

    let rows = [];
    let range = rangeFrom(input, { days: 30 });
    if (view === 'new') {
      rows = db.prepare(`${base} AND m.joined_at >= ? AND m.joined_at < ?
        ORDER BY m.joined_at DESC`).all(range.startMs, range.endMs);
    } else if (view === 'active') {
      rows = db.prepare(`${base} AND l.expires_at IS NOT NULL ORDER BY l.expires_at`).all();
    } else if (view === 'expiring') {
      rows = db.prepare(`${base} AND l.expires_at IS NOT NULL AND l.expires_at <= ?
        ORDER BY l.expires_at`).all(at + days * DAY_MS);
    } else {
      rows = db.prepare(`${base} AND l.expires_at IS NULL
        AND EXISTS (SELECT 1 FROM entitlements e WHERE e.member_id=m.id AND e.status='active')
        ORDER BY m.name`).all();
    }

    const item = row => ({
      member_code: row.member_code, name: row.name, phone: formatPhone(row.phone) ?? '',
      package: row.package ?? '', expires_at: row.expires_at ?? null,
      expires_on: row.expires_at ? thaiTime(row.expires_at).slice(0, 10) : '',
      days_left: row.expires_at ? Math.ceil((row.expires_at - at) / DAY_MS) : '',
      sessions_left: row.sessions_total === null ? 'ไม่จำกัด' : (row.sessions_remaining ?? ''),
      joined_on: thaiTime(row.joined_at).slice(0, 10),
    });
    const items = rows.map(item);

    // A membership the gym took back is not a membership that ran out. Its own
    // block, with the date and the reason, so nobody reads one as the other.
    const revoked = view === 'expired' ? db.prepare(`SELECT m.member_code, m.name, m.phone,
      o.package_name_snapshot AS package, e.revoked_at, e.revoked_reason
      FROM entitlements e JOIN members m ON m.id = e.member_id
      LEFT JOIN orders o ON o.id = e.order_id
      WHERE e.status='revoked' ORDER BY e.revoked_at DESC`).all() : [];

    answer(res, {
      format: input.format, name: `members-${view}`, range,
      payload: {
        view, days, range: { from: range.from, to: range.to },
        items: items.slice(0, MAX_ROWS), total: items.length, truncated: items.length > MAX_ROWS,
        revoked: revoked.map(row => ({
          member_code: row.member_code, name: row.name, phone: formatPhone(row.phone) ?? '',
          package: row.package ?? '', revoked_on: thaiTime(row.revoked_at),
          reason: row.revoked_reason ?? '', status: 'ถูกยกเลิก',
        })),
      },
      csv: [
        { title: `สมาชิก · ${{ active: 'ใช้งานอยู่', expiring: `จะหมดอายุใน ${days} วัน`, expired: 'หมดอายุแล้ว', new: 'สมัครใหม่' }[view]}`,
          headers: ['รหัสสมาชิก', 'ชื่อ', 'เบอร์โทร', 'แพ็กเกจ', 'หมดอายุ', 'เหลือกี่วัน', 'ครั้งคงเหลือ', 'วันที่สมัคร'],
          rows: [...items.map(row => [row.member_code, row.name, row.phone, row.package,
            row.expires_on, row.days_left, row.sessions_left, row.joined_on]),
          ['รวม', items.length, '', '', '', '', '', '']] },
        revoked.length ? { title: 'สิทธิ์ที่ถูกยกเลิก (ไม่ใช่หมดอายุ)',
          headers: ['รหัสสมาชิก', 'ชื่อ', 'เบอร์โทร', 'แพ็กเกจ', 'ยกเลิกเมื่อ', 'เหตุผล'],
          rows: revoked.map(row => [row.member_code, row.name, formatPhone(row.phone) ?? '',
            row.package ?? '', thaiTime(row.revoked_at), row.revoked_reason ?? '']) } : null,
      ],
    });
  });

  // ------------------------------------------------------------ 5 · issues

  app.get('/api/admin/reports/issues', admin, (req, res) => {
    const input = read(req);
    const status = input.status ?? 'open';
    const range = rangeFrom(input, { days: 365 });
    const where = status === 'open' ? "AND r.status IN ('new','reading')" : '';
    const rows = db.prepare(`SELECT r.reference, r.message, r.screen, r.status, r.app_revision,
      r.created_at, r.reported_by, u.email AS reporter
      FROM problem_reports r LEFT JOIN users u ON u.id = r.reported_by
      WHERE r.created_at >= ? AND r.created_at < ? ${where}
      ORDER BY r.created_at`).all(range.startMs, range.endMs);

    const LABEL = { new: 'ใหม่', reading: 'กำลังดู', done: 'แก้แล้ว', not_a_bug: 'ไม่ใช่ปัญหา' };
    const items = rows.map(row => ({
      reference: `#${row.reference}`, iso: isoTime(row.created_at), when: thaiTime(row.created_at),
      waiting_days: Math.floor((now() - row.created_at) / DAY_MS),
      status: LABEL[row.status] ?? row.status,
      reporter: actorLabel(row.reporter, row.reported_by),
      screen: row.screen ?? '', app_revision: row.app_revision ?? '', message: row.message,
    }));

    answer(res, {
      format: input.format, name: 'issues', range,
      payload: { range: { from: range.from, to: range.to }, status,
        items: items.slice(0, MAX_ROWS), total: items.length, truncated: items.length > MAX_ROWS },
      csv: [
        { title: `แจ้งปัญหา ${thaiDate(range.from)} – ${thaiDate(range.to)}`,
          headers: ['เลขเรื่อง', 'วันที่แจ้ง', 'ค้างมากี่วัน', 'สถานะ', 'ผู้แจ้ง', 'หน้าที่เกิด', 'รุ่นที่ใช้', 'ข้อความ'],
          rows: [...items.map(row => [row.reference, row.when, row.waiting_days, row.status,
            row.reporter, row.screen, row.app_revision, row.message]),
          ['รวม', '', '', '', '', '', '', items.length]] },
      ],
    });
  });
}
