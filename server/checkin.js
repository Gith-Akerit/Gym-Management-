// Checking in at the counter.
//
// What a member shows is the card the gym sent them: a picture, with a signed
// token in it that does not expire. Nothing in the token is readable — a member
// id and a signature — and a copy forwarded to a friend gets that friend as far
// as the counter, where the photograph on the screen is somebody else's face.
// That check is a person's, not the system's, which is why the scan result puts
// the face first and the verdict second.
//
// The short-lived one-time QR the old member app minted is still accepted while
// unexpired ones remain, so the change of product does not turn anybody away.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { cardSignatureMatches, decodeCardQr } from './cards.js';
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

export function registerCheckInRoutes({ app, db, now, admin, counter, secret, limit }) {
  const sign = id => createHmac('sha256', secret).update(`checkin:${id}`).digest('hex');

  const settings = () => db.prepare('SELECT check_in_window_minutes, check_in_token_seconds FROM gym_profile WHERE id=1').get()
    ?? { check_in_window_minutes: 5, check_in_token_seconds: 60 };

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
    qr: z.string().trim().min(1, 'กรุณาสแกน QR หรือพิมพ์รหัสสมาชิก').max(200, 'รหัสยาวเกินไป'),
    device_label: z.string().trim().max(60, 'ชื่ออุปกรณ์ยาวได้ไม่เกิน 60 ตัวอักษร').default(''),
  }).strict();

  const memberRow = id => db.prepare('SELECT m.*, u.email FROM members m LEFT JOIN users u ON u.id=m.user_id WHERE m.id=?').get(id);
  const UNREADABLE = 'QR ไม่ถูกต้อง กรุณาให้สมาชิกเปิดรูปบัตรอีกครั้ง';
  const NO_SUCH_CODE = 'ไม่พบรหัสสมาชิกนี้ กรุณาตรวจตัวอักษรอีกครั้ง หรือให้สมาชิกเปิดรูปบัตรให้สแกน';

  /**
   * The member code printed under the QR, typed in by hand.
   *
   * Staff read it off the card when the camera cannot (ผลทดสอบของผู้ใช้ ข้อ 2):
   * before this, the only thing this endpoint understood was the signed payload
   * *inside* the QR, so a correctly typed `GYM-…` was filed as an unreadable
   * scan and the counter was told "ไม่ทราบสมาชิก" about a member who was
   * standing right there and whose card scanned fine.
   *
   * It is a name, not a secret -- it is printed on the card in plain sight --
   * so it proves nothing on its own. It does not have to: only signed-in staff
   * reach this route, and what stops a card being passed between friends is
   * the photograph the screen puts in front of the person at the counter, not
   * the code. For the same reason a typed code is not stopped by the card
   * version: the member is not holding a cancelled card, they are being looked
   * up by name.
   */
  function resolveMemberCode(raw) {
    const typed = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
    // Both halves of what people actually type: the whole code off the card,
    // or just the part after the prefix everybody's code shares.
    const code = /^[0-9A-Z]{12}$/.test(typed) ? `GYM-${typed}` : typed;
    if (!/^GYM-[0-9A-Z]{12}$/.test(code)) return null;
    const member = db.prepare(`SELECT m.*, u.email FROM members m
      LEFT JOIN users u ON u.id=m.user_id WHERE m.member_code=?`).get(code);
    if (!member) return { denied: NO_SUCH_CODE };
    return { member, by_code: true };
  }

  /**
   * A card. The signature covers the card number, so a card the gym replaced
   * fails here rather than anywhere near the member's row -- which is what
   * makes "ออกบัตรใหม่" a single counter going up instead of a hunt for
   * whatever copies of the old picture exist in the world.
   */
  function resolveCard(raw) {
    const card = decodeCardQr(raw);
    if (!card) return { denied: UNREADABLE };
    const id = `${card.member.slice(0, 8)}-${card.member.slice(8, 12)}-${card.member.slice(12, 16)}-${card.member.slice(16, 20)}-${card.member.slice(20)}`;
    const member = memberRow(id);
    if (!member) return { denied: UNREADABLE };
    if (!cardSignatureMatches(secret, member.id, card.version, card.signature)) return { denied: UNREADABLE };
    if (card.version !== member.card_version) {
      return { denied: 'บัตรใบนี้ถูกยกเลิกแล้ว กรุณาส่งบัตรใบใหม่ให้สมาชิก', extra: { member_id: member.id } };
    }
    return { member };
  }

  /**
   * The QR the old member app minted a minute at a time. Kept so a member who
   * has one in front of them is not turned away; nothing issues them any more.
   */
  function resolveOneTimeToken(decoded, req) {
    const expected = sign(decoded.id);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(decoded.signature, 'hex'))) return { denied: UNREADABLE };
    const token = db.prepare('SELECT * FROM check_in_tokens WHERE id=?').get(decoded.id);
    if (!token) return { denied: UNREADABLE };
    const extra = { member_id: token.member_id, token_id: token.id };
    if (token.consumed_at !== null) return { denied: 'QR นี้ถูกใช้ไปแล้ว กรุณาให้สมาชิกเปิดรหัสใหม่', extra };
    // Always the server clock: a member whose phone is an hour out still works,
    // and one whose phone is set forward gains nothing.
    if (token.expires_at <= now()) return { denied: 'QR หมดอายุแล้ว กรุณาให้สมาชิกกดรีเฟรชรหัส', extra };
    // One-time use: claim the token first, and only proceed if this request is
    // the one that claimed it. Two scanners at once cannot both win.
    const claimed = db.prepare('UPDATE check_in_tokens SET consumed_at=?, consumed_by=? WHERE id=? AND consumed_at IS NULL')
      .run(now(), req.user.id, token.id);
    if (claimed.changes !== 1) return { denied: 'QR นี้ถูกใช้ไปแล้ว กรุณาให้สมาชิกเปิดรหัสใหม่', extra };
    return { member: memberRow(token.member_id), token_id: token.id };
  }

  app.post('/api/check-ins/verify', counter, (req, res) => {
    limit(`checkin-verify:${req.user.id}`, 300, 900000);
    const input = parse(scanSchema, req.body);
    const decoded = decodeCheckInQr(input.qr);
    const deny = (reason, extra = {}) => ({
      result: 'denied', failure_reason: reason, device_label: input.device_label,
      scanned_by: req.user.id, ...extra,
    });

    const outcome = transaction(db, () => {
      // Three kinds of code arrive at this scanner. The card is the one members
      // carry now: a picture in a chat app, signed, good until the gym issues
      // a new one. The old one-time QR is still honoured while any remain
      // unexpired, so nobody who had the member app is turned away mid-week.
      // And the member code printed under the QR, which staff type when the
      // camera will not read the screen in front of them.
      const resolved = decoded ? resolveOneTimeToken(decoded, req)
        : resolveMemberCode(input.qr) ?? resolveCard(input.qr);
      if (resolved.denied) return record(deny(resolved.denied, resolved.extra ?? {}));

      const { member, token_id: tokenId } = resolved;
      const base = { member_id: member.id, token_id: tokenId ?? null, device_label: input.device_label, scanned_by: req.user.id };

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
      audit(db, req.user.id, 'checkin.allowed', checkIn.id, null,
        { member_id: member.id, entitlement_id: entitlement.id, entry: resolved.by_code ? 'member_code' : 'qr' },
        now(), 'check_in');
      return { ...checkIn, _entitlement: after };
    });

    // The photograph is the answer, not a detail. The person at the counter has
    // to compare a face with the person in front of them before they let anyone
    // in -- a card is a picture in a chat app and can be forwarded to a friend,
    // so the screen has to make looking easier than not looking (Designer).
    const member = outcome.member_id
      ? db.prepare('SELECT id, name, member_code, status, photo_stored_name FROM members WHERE id=?').get(outcome.member_id)
      : null;
    const entitlement = outcome._entitlement ?? null;
    res.status(outcome.result === 'allowed' ? 200 : 409).json({
      result: outcome.result,
      failure_reason: outcome.failure_reason,
      checked_in_at: outcome.checked_in_at,
      member: member && {
        id: member.id, name: member.name, member_code: member.member_code, status: member.status,
        has_photo: !!member.photo_stored_name,
        photo_url: member.photo_stored_name ? `/api/members/${member.id}/photo` : null,
      },
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
