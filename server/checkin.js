// Checking in with a QR code.
//
// The QR a member shows is a short-lived, one-time token. It carries no name,
// no member code and nothing else readable — only a random id and a signature —
// so a photo of somebody's screen is worth nothing a minute later, and a QR
// lifted from a chat group cannot be replayed at the counter.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audit, transaction } from './db.js';
import { HttpError, parse } from './validation.js';

const PREFIX = 'GYMCHK1';

/** `GYMCHK1.<token id>.<signature>` — nothing about the member is in here. */
export const encodeCheckInQr = (id, signature) => `${PREFIX}.${id}.${signature}`;

export function decodeCheckInQr(raw) {
  const parts = String(raw ?? '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, id, signature] = parts;
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  return { id, signature };
}

export function registerCheckInRoutes({ app, db, now, admin, secret, limit }) {
  const sign = id => createHmac('sha256', secret).update(`checkin:${id}`).digest('hex');

  /** Staff and admins may scan and read; only admins manage members and money. */
  const counter = (req, res, next) => (['staff', 'admin'].includes(req.user.role)
    ? next() : next(new HttpError(403, 'เฉพาะพนักงานและผู้ดูแลระบบเท่านั้น')));

  const settings = () => db.prepare('SELECT check_in_window_minutes, check_in_token_seconds FROM gym_profile WHERE id=1').get()
    ?? { check_in_window_minutes: 5, check_in_token_seconds: 60 };

  function requireActiveMember(req) {
    const member = db.prepare('SELECT * FROM members WHERE user_id=?').get(req.user.id);
    if (!member) throw new HttpError(403, 'สำหรับบัญชีสมาชิกเท่านั้น');
    return member;
  }

  // ------------------------------------------------------------------ member

  /**
   * Issues the QR the member shows at the counter. Asking for a new one retires
   * every earlier unused token for that member, so only the code currently on
   * screen can work — the screenshot a friend was sent is already dead.
   */
  app.post('/api/me/check-in-token', (req, res) => {
    // The screen renews about once a minute, so 120 in 15 minutes leaves room
    // for two hours of watching it while still bounding what one account can
    // write. Every write here competes with the counter for the same lock.
    limit(`checkin-token:${req.user.id}`, 120, 900000);
    const member = requireActiveMember(req);
    if (member.status !== 'active') {
      throw new HttpError(403, member.status === 'suspended'
        ? 'บัญชีสมาชิกถูกระงับ กรุณาติดต่อพนักงานที่ยิม'
        : 'สถานะสมาชิกหมดอายุ กรุณาติดต่อพนักงานที่ยิม');
    }
    const ttl = settings().check_in_token_seconds * 1000;
    const id = randomUUID();
    transaction(db, () => {
      db.prepare('UPDATE check_in_tokens SET expires_at=? WHERE member_id=? AND consumed_at IS NULL AND expires_at>?')
        .run(now(), member.id, now());
      db.prepare('INSERT INTO check_in_tokens(id,member_id,issued_at,expires_at) VALUES(?,?,?,?)')
        .run(id, member.id, now(), now() + ttl);
    });
    res.status(201).json({
      qr: encodeCheckInQr(id, sign(id)),
      expires_at: now() + ttl,
      expires_in: settings().check_in_token_seconds,
    });
  });

  app.get('/api/me/check-ins', (req, res) => {
    const member = requireActiveMember(req);
    res.json({ items: db.prepare(`SELECT id, result, failure_reason, checked_in_at
      FROM check_ins WHERE member_id=? ORDER BY checked_in_at DESC LIMIT 50`).all(member.id) });
  });

  // ------------------------------------------------------------------- staff

  /** Picks the entitlement that runs out first; ties go to the one bought first. */
  const nextEntitlement = memberId => db.prepare(`SELECT * FROM entitlements
    WHERE member_id=? AND status='active' AND expires_at>?
      AND (sessions_remaining IS NULL OR sessions_remaining>0)
    ORDER BY expires_at, created_at LIMIT 1`).get(memberId, now());

  /**
   * Records the outcome whatever it is. A refusal at the counter is the case
   * somebody asks about afterwards, so it is kept with its reason.
   */
  function record(values) {
    const id = randomUUID();
    db.prepare(`INSERT INTO check_ins(id,member_id,entitlement_id,token_id,result,failure_reason,
      device_label,scanned_by,checked_in_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, values.member_id ?? null, values.entitlement_id ?? null, values.token_id ?? null,
        values.result, values.failure_reason ?? null, values.device_label ?? '', values.scanned_by, now());
    return db.prepare('SELECT * FROM check_ins WHERE id=?').get(id);
  }

  const scanSchema = z.object({
    qr: z.string().trim().min(1, 'กรุณาสแกน QR ของสมาชิก').max(200, 'รหัสยาวเกินไป'),
    device_label: z.string().trim().max(60, 'ชื่ออุปกรณ์ยาวได้ไม่เกิน 60 ตัวอักษร').default(''),
  }).strict();

  app.post('/api/check-ins/verify', counter, (req, res) => {
    limit(`checkin-verify:${req.user.id}`, 300, 900000);
    const input = parse(scanSchema, req.body);
    const decoded = decodeCheckInQr(input.qr);
    const deny = (reason, extra = {}) => ({
      result: 'denied', failure_reason: reason, device_label: input.device_label,
      scanned_by: req.user.id, ...extra,
    });

    const outcome = transaction(db, () => {
      if (!decoded) return record(deny('QR ไม่ถูกต้อง กรุณาให้สมาชิกเปิดรหัสใหม่จากแอป'));
      // Constant-time so a wrong signature cannot be found by timing the reply.
      const expected = sign(decoded.id);
      const valid = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(decoded.signature, 'hex'));
      if (!valid) return record(deny('QR ไม่ถูกต้อง กรุณาให้สมาชิกเปิดรหัสใหม่จากแอป'));

      const token = db.prepare('SELECT * FROM check_in_tokens WHERE id=?').get(decoded.id);
      if (!token) return record(deny('QR ไม่ถูกต้อง กรุณาให้สมาชิกเปิดรหัสใหม่จากแอป'));
      if (token.consumed_at !== null) {
        return record(deny('QR นี้ถูกใช้ไปแล้ว กรุณาให้สมาชิกเปิดรหัสใหม่', { member_id: token.member_id, token_id: token.id }));
      }
      // Always the server clock: a member whose phone is an hour out still works,
      // and one whose phone is set forward gains nothing.
      if (token.expires_at <= now()) {
        return record(deny('QR หมดอายุแล้ว กรุณาให้สมาชิกกดรีเฟรชรหัส', { member_id: token.member_id, token_id: token.id }));
      }

      // One-time use: claim the token first, and only proceed if this request is
      // the one that claimed it. Two scanners at once cannot both win.
      const claimed = db.prepare('UPDATE check_in_tokens SET consumed_at=?, consumed_by=? WHERE id=? AND consumed_at IS NULL')
        .run(now(), req.user.id, token.id);
      if (claimed.changes !== 1) {
        return record(deny('QR นี้ถูกใช้ไปแล้ว กรุณาให้สมาชิกเปิดรหัสใหม่', { member_id: token.member_id, token_id: token.id }));
      }

      const member = db.prepare('SELECT m.*, u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=?')
        .get(token.member_id);
      const base = { member_id: member.id, token_id: token.id, device_label: input.device_label, scanned_by: req.user.id };

      // Membership status comes before any package: a suspended member is
      // refused even while their package is still valid.
      if (member.status !== 'active') {
        return record({ ...base, result: 'denied', failure_reason: member.status === 'suspended'
          ? 'สมาชิกถูกระงับ กรุณาติดต่อผู้ดูแลระบบ' : 'สถานะสมาชิกหมดอายุ กรุณาติดต่อผู้ดูแลระบบ' });
      }

      // A second scan inside the window is the same visit, not another one, so
      // the quota is not touched again.
      const window = settings().check_in_window_minutes * 60000;
      const recent = db.prepare(`SELECT * FROM check_ins WHERE member_id=? AND result='allowed' AND checked_in_at>?
        ORDER BY checked_in_at DESC LIMIT 1`).get(member.id, now() - window);
      if (recent) {
        const duplicate = record({ ...base, result: 'duplicate', entitlement_id: recent.entitlement_id,
          failure_reason: 'เช็คอินไปแล้วเมื่อไม่นานนี้ ไม่ได้หักสิทธิ์ซ้ำ' });
        // "How many do I have left?" is the question asked most at the counter,
        // and it is asked just as often by somebody who walked back in.
        return { ...duplicate, _entitlement: recent.entitlement_id
          ? db.prepare('SELECT * FROM entitlements WHERE id=?').get(recent.entitlement_id)
          : nextEntitlement(member.id) };
      }

      const entitlement = nextEntitlement(member.id);
      if (!entitlement) {
        const expired = db.prepare(`SELECT expires_at FROM entitlements WHERE member_id=? AND status='active'
          ORDER BY expires_at DESC LIMIT 1`).get(member.id);
        return record({ ...base, result: 'denied', failure_reason: expired
          ? 'แพ็กเกจหมดอายุหรือใช้ครบจำนวนครั้งแล้ว กรุณาซื้อแพ็กเกจใหม่'
          : 'ยังไม่มีแพ็กเกจที่ใช้งานได้ กรุณาซื้อแพ็กเกจก่อนเข้าใช้บริการ' });
      }

      // Atomic: the row only decrements while it still has a session left, so a
      // quota can never be driven below zero however many scanners are running.
      if (entitlement.sessions_remaining !== null) {
        const used = db.prepare(`UPDATE entitlements SET sessions_remaining=sessions_remaining-1
          WHERE id=? AND status='active' AND sessions_remaining>0 AND expires_at>?`).run(entitlement.id, now());
        if (used.changes !== 1) {
          return record({ ...base, result: 'denied', failure_reason: 'สิทธิ์ถูกใช้ไปพอดี กรุณาลองสแกนอีกครั้ง' });
        }
      }
      const after = db.prepare('SELECT * FROM entitlements WHERE id=?').get(entitlement.id);
      const checkIn = record({ ...base, result: 'allowed', entitlement_id: entitlement.id });
      audit(db, req.user.id, 'checkin.allowed', checkIn.id, null, { member_id: member.id, entitlement_id: entitlement.id },
        now(), 'check_in');
      return { ...checkIn, _entitlement: after };
    });

    const member = outcome.member_id
      ? db.prepare('SELECT name, member_code, status FROM members WHERE id=?').get(outcome.member_id) : null;
    const entitlement = outcome._entitlement ?? null;
    res.status(outcome.result === 'allowed' ? 200 : 409).json({
      result: outcome.result,
      failure_reason: outcome.failure_reason,
      checked_in_at: outcome.checked_in_at,
      member,
      remaining: entitlement
        ? { sessions_remaining: entitlement.sessions_remaining, expires_at: entitlement.expires_at }
        : null,
    });
  });

  app.get('/api/check-ins', counter, (req, res) => {
    const { date, q, page = 1, scope = 'all' } = parse(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ใช้รูปแบบวันที่ YYYY-MM-DD').optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
      scope: z.enum(['all', 'identified', 'unknown'], { error: 'กรุณาเลือกชุดข้อมูลที่ถูกต้อง' }).optional(),
    }).strict(), req.query);

    const where = [];
    const params = [];
    // A scan of a forged or unreadable QR belongs to nobody. Everything is still
    // recorded and the default still returns all of it; the screen asks for one
    // side or the other so a spray of junk cannot bury the day's real visits.
    if (scope === 'unknown') where.push('c.member_id IS NULL');
    if (scope === 'identified') where.push('c.member_id IS NOT NULL');
    if (date) { where.push("date(c.checked_in_at/1000,'unixepoch','+7 hours')=?"); params.push(date); }
    if (q) {
      const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(m.name LIKE ? ESCAPE '\\' OR m.member_code LIKE ? ESCAPE '\\')");
      params.push(term, term);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) AS total FROM check_ins c
      LEFT JOIN members m ON m.id=c.member_id ${clause}`).get(...params).total;
    const items = db.prepare(`SELECT c.id, c.result, c.failure_reason, c.checked_in_at, c.device_label,
      m.name AS member_name, m.member_code FROM check_ins c
      LEFT JOIN members m ON m.id=c.member_id ${clause}
      ORDER BY c.checked_in_at DESC LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20);
    res.json({
      items, total, page, scope,
      unknown_total: db.prepare('SELECT count(*) AS n FROM check_ins WHERE member_id IS NULL').get().n,
    });
  });

  /** What the counter sees at a glance: how busy today has been. */
  app.get('/api/check-ins/summary', counter, (req, res) => {
    const rows = db.prepare(`SELECT date(checked_in_at/1000,'unixepoch','+7 hours') AS day,
      sum(CASE WHEN result='allowed' THEN 1 ELSE 0 END) AS allowed,
      sum(CASE WHEN result='denied' THEN 1 ELSE 0 END) AS denied,
      sum(CASE WHEN result='duplicate' THEN 1 ELSE 0 END) AS duplicate
      FROM check_ins GROUP BY day ORDER BY day DESC LIMIT 30`).all();
    res.json({ items: rows });
  });
}
