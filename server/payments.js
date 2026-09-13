// Buying a package: PromptPay QR, slip upload, admin review, entitlement.
//
// There is no payment provider in this design — the gym receives the transfer
// directly and a human confirms it. That has two consequences the code has to
// take seriously: the approval is the only record that money arrived, so it is
// audited in full; and approving twice would hand out a free membership, so it
// is guarded both in the transaction and by a UNIQUE constraint underneath.

import { randomUUID } from 'node:crypto';
import multer from 'multer';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  activeEntitlements, audit, currentSlip, expireStaleOrders, getOrder, getPackage,
  publicEntitlement, publicOrder, publicSlip, transaction,
} from './db.js';
import { buildPromptPayPayload } from './promptpay.js';
import { MAX_SLIP_BYTES, SlipError } from './slips.js';
import {
  approveSchema, bangkokLocalToEpoch, HttpError, orderSchema, parse,
  rejectSchema, reverseSchema, slipSchema,
} from './validation.js';

const DAY_MS = 86400000;

export function registerPaymentRoutes({ app, db, now, admin, slipStore, promptPayId }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SLIP_BYTES, files: 1 } });

  /** The signed-in member's own profile row, or 403 for staff and admins. */
  function requireMember(req) {
    const member = db.prepare('SELECT * FROM members WHERE user_id=?').get(req.user.id);
    if (!member) throw new HttpError(403, 'สำหรับบัญชีสมาชิกเท่านั้น');
    if (member.status !== 'active') {
      throw new HttpError(403, 'บัญชีสมาชิกถูกระงับหรือหมดอายุ กรุณาติดต่อพนักงานที่ยิม');
    }
    return member;
  }

  const settings = () => db.prepare('SELECT payment_sla_text, order_ttl_minutes FROM gym_profile WHERE id=1').get()
    ?? { payment_sla_text: 'ภายใน 30 นาทีในเวลาทำการ', order_ttl_minutes: 60 };

  /** Everything a member screen needs about one order, in a single response. */
  function orderView(order, { includePayload = true } = {}) {
    const slip = currentSlip(db, order.id);
    const history = db.prepare('SELECT * FROM payment_slips WHERE order_id=? ORDER BY uploaded_at DESC').all(order.id);
    const entitlement = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(order.id);
    return {
      order: publicOrder(order),
      slip: publicSlip(slip),
      slip_history: history.map(publicSlip),
      entitlement: publicEntitlement(entitlement),
      payment_sla_text: settings().payment_sla_text,
      // The payload is only useful while the order can still be paid.
      promptpay_payload: includePayload && order.status === 'pending_payment'
        ? buildPromptPayPayload(promptPayId, order.price_satang_snapshot) : null,
    };
  }

  // ------------------------------------------------------------------ member

  app.post('/api/orders', (req, res) => {
    const member = requireMember(req);
    const input = parse(orderSchema, req.body);
    const result = transaction(db, () => {
      expireStaleOrders(db, now());
      const pkg = getPackage(db, input.package_id);
      if (!pkg || pkg.status !== 'active') throw new HttpError(404, 'ไม่พบแพ็กเกจนี้ หรือแพ็กเกจปิดการขายแล้ว');
      // Trusting a price from the client would let anyone buy for 1 baht.
      if (pkg.price_satang === null) throw new HttpError(409, 'แพ็กเกจนี้ยังไม่ได้กำหนดราคา กรุณาติดต่อพนักงาน');

      // Tapping buy five times in a row must not create five orders to pay.
      const open = db.prepare(`SELECT * FROM orders WHERE member_id=? AND package_id=?
        AND status IN ('pending_payment','awaiting_review') ORDER BY created_at DESC LIMIT 1`)
        .get(member.id, input.package_id);
      if (open) return { order: open, reused: true };

      const id = randomUUID();
      const ttl = settings().order_ttl_minutes * 60000;
      db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
        package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
        created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, member.id, pkg.id, pkg.code, pkg.name_th, pkg.type, pkg.duration_days,
          pkg.session_limit, pkg.price_satang, now(), now() + ttl, now());
      const order = getOrder(db, id);
      audit(db, req.user.id, 'order.create', id, null, order, now(), 'order');
      return { order, reused: false };
    });
    res.status(result.reused ? 200 : 201).json(orderView(result.order));
  });

  app.get('/api/orders', (req, res) => {
    const member = requireMember(req);
    expireStaleOrders(db, now());
    const rows = db.prepare('SELECT * FROM orders WHERE member_id=? ORDER BY created_at DESC LIMIT 50').all(member.id);
    res.json({ items: rows.map(publicOrder) });
  });

  /** A member may only ever read their own order. */
  function memberOrder(req) {
    const member = requireMember(req);
    expireStaleOrders(db, now());
    const order = getOrder(db, req.params.id);
    if (!order || order.member_id !== member.id) throw new HttpError(404, 'ไม่พบคำสั่งซื้อ');
    return { member, order };
  }

  app.get('/api/orders/:id', (req, res) => res.json(orderView(memberOrder(req).order)));

  app.get('/api/orders/:id/qr.png', async (req, res) => {
    const { order } = memberOrder(req);
    if (order.status !== 'pending_payment') throw new HttpError(409, 'คำสั่งซื้อนี้ไม่อยู่ในสถานะรอชำระเงินแล้ว');
    const png = await QRCode.toBuffer(buildPromptPayPayload(promptPayId, order.price_satang_snapshot),
      { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="promptpay-${order.id.slice(0, 8)}.png"`);
    res.send(png);
  });

  app.post('/api/orders/:id/cancel', (req, res) => {
    const { order } = memberOrder(req);
    if (order.status !== 'pending_payment') throw new HttpError(409, 'ยกเลิกได้เฉพาะคำสั่งซื้อที่ยังไม่ได้ส่งสลิป');
    transaction(db, () => {
      db.prepare("UPDATE orders SET status='cancelled',version=version+1,updated_at=? WHERE id=? AND status='pending_payment'")
        .run(now(), order.id);
      audit(db, req.user.id, 'order.cancel', order.id, order, getOrder(db, order.id), now(), 'order');
    });
    res.json(orderView(getOrder(db, order.id)));
  });

  app.post('/api/orders/:id/slip', upload.single('slip'), (req, res) => {
    const { order } = memberOrder(req);
    if (!['pending_payment', 'awaiting_review', 'rejected'].includes(order.status)) {
      throw new HttpError(409, 'คำสั่งซื้อนี้ส่งสลิปเพิ่มไม่ได้แล้ว');
    }
    if (order.expires_at <= now()) throw new HttpError(409, 'คำสั่งซื้อหมดอายุแล้ว กรุณาสั่งซื้อใหม่');
    if (!req.file) throw new HttpError(400, 'กรุณาแนบรูปสลิปการโอนเงิน');
    const input = parse(slipSchema, req.body);

    const transferredAt = bangkokLocalToEpoch(input.transferred_at);
    if (transferredAt > now() + 300000) throw new HttpError(400, 'เวลาที่โอนอยู่ในอนาคต กรุณาตรวจสอบอีกครั้ง');
    if (transferredAt < now() - 30 * DAY_MS) throw new HttpError(400, 'เวลาที่โอนเก่าเกิน 30 วัน กรุณาตรวจสอบอีกครั้ง');

    let stored;
    try { stored = slipStore.save(req.file.buffer); }
    catch (e) { throw e instanceof SlipError ? new HttpError(400, e.message) : e; }

    try {
      transaction(db, () => {
        // Replacing a slip keeps the old one: the admin may need to compare.
        db.prepare('UPDATE payment_slips SET superseded_at=? WHERE order_id=? AND superseded_at IS NULL')
          .run(now(), order.id);
        db.prepare(`INSERT INTO payment_slips(id,order_id,stored_name,content_type,byte_size,file_hash,
          reference_no,transferred_at,amount_satang_claimed,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), order.id, stored.storedName, stored.contentType, stored.byteSize,
            stored.fileHash, input.reference_no, transferredAt, input.amount_thb, now());
        db.prepare(`UPDATE orders SET status='awaiting_review',rejection_reason=NULL,
          version=version+1,updated_at=? WHERE id=?`).run(now(), order.id);
        audit(db, req.user.id, 'order.slip_upload', order.id, order, getOrder(db, order.id), now(), 'order');
      });
    } catch (e) {
      // Never leave an orphan file behind when the row could not be written.
      slipStore.remove(stored.storedName);
      throw e;
    }
    res.status(201).json(orderView(getOrder(db, order.id)));
  });

  app.get('/api/entitlements', (req, res) => {
    const member = requireMember(req);
    res.json({ items: activeEntitlements(db, member.id, now()).map(publicEntitlement) });
  });

  // ------------------------------------------------------------------- admin

  /** Same transfer reused for another order — reference number or identical image. */
  const duplicatesOf = slip => (slip ? db.prepare(`SELECT s.id, s.order_id, s.reference_no, s.uploaded_at,
      CASE WHEN s.file_hash=? THEN 'file' ELSE 'reference' END AS kind
      FROM payment_slips s WHERE s.order_id<>? AND (s.file_hash=? OR s.reference_no=?)
      ORDER BY s.uploaded_at DESC LIMIT 10`)
    .all(slip.file_hash, slip.order_id, slip.file_hash, slip.reference_no) : []);

  app.get('/api/admin/orders', admin, (req, res) => {
    expireStaleOrders(db, now());
    const { status = 'awaiting_review', page = 1 } = parse(z.object({
      status: z.enum(['awaiting_review', 'pending_payment', 'paid', 'rejected', 'expired', 'cancelled', 'all']).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
    }).strict(), req.query);
    const where = status === 'all' ? '' : 'WHERE o.status=?';
    const params = status === 'all' ? [] : [status];
    const total = db.prepare(`SELECT count(*) AS total FROM orders o ${where}`).get(...params).total;
    // Longest wait first: the member has already paid and is waiting on us.
    const rows = db.prepare(`SELECT o.*, m.name AS member_name, m.member_code
      FROM orders o JOIN members m ON m.id=o.member_id ${where}
      ORDER BY o.created_at LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20);
    res.json({
      items: rows.map(row => {
        const slip = currentSlip(db, row.id);
        return { ...publicOrder(row), slip: publicSlip(slip), waiting_since: slip?.uploaded_at ?? row.created_at };
      }),
      total,
      page,
      awaiting_review: db.prepare("SELECT count(*) AS n FROM orders WHERE status='awaiting_review'").get().n,
    });
  });

  function adminOrder(req) {
    const order = getOrder(db, req.params.id);
    if (!order) throw new HttpError(404, 'ไม่พบคำสั่งซื้อ');
    return order;
  }

  app.get('/api/admin/orders/:id', admin, (req, res) => {
    const order = adminOrder(req);
    const slip = currentSlip(db, order.id);
    const member = db.prepare('SELECT m.*, u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=?')
      .get(order.member_id);
    const { user_id, ...memberView } = member;
    res.json({
      ...orderView(order, { includePayload: false }),
      member: memberView,
      duplicates: duplicatesOf(slip),
      // Flagged, not blocked: only the admin can judge a partial payment.
      amount_mismatch: slip?.amount_satang_claimed != null
        && slip.amount_satang_claimed !== order.price_satang_snapshot,
    });
  });

  /** The slip image, for the admin or the member it belongs to — nobody else. */
  app.get('/api/slips/:id/image', (req, res) => {
    const slip = db.prepare('SELECT * FROM payment_slips WHERE id=?').get(req.params.id);
    if (!slip) throw new HttpError(404, 'ไม่พบสลิป');
    if (req.user.role !== 'admin') {
      const member = db.prepare('SELECT id FROM members WHERE user_id=?').get(req.user.id);
      const order = getOrder(db, slip.order_id);
      if (!member || order.member_id !== member.id) throw new HttpError(404, 'ไม่พบสลิป');
    }
    res.set('Content-Type', slip.content_type);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(slipStore.read(slip.stored_name));
  });

  /**
   * Turns a confirmed transfer into membership. The UPDATE is conditional on the
   * order still being under review, so a second click changes zero rows and is
   * rejected rather than granting a second entitlement.
   */
  app.post('/api/admin/orders/:id/approve', admin, (req, res) => {
    const input = parse(approveSchema, req.body);
    const result = transaction(db, () => {
      const before = adminOrder(req);
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดคำสั่งซื้อล่าสุดก่อนอนุมัติ');
      if (before.status !== 'awaiting_review') throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');
      const member = db.prepare('SELECT status FROM members WHERE id=?').get(before.member_id);
      if (member?.status !== 'active') throw new HttpError(409, 'สมาชิกรายนี้ถูกระงับ กรุณาแก้สถานะสมาชิกก่อนอนุมัติ');

      const claimed = db.prepare('UPDATE orders SET status=\'paid\',reviewed_by=?,reviewed_at=?,review_note=?,'
        + 'version=version+1,updated_at=? WHERE id=? AND status=\'awaiting_review\'')
        .run(req.user.id, now(), input.note, now(), before.id);
      if (claimed.changes !== 1) throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');

      const limited = before.package_type_snapshot === 'limited_sessions';
      db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,expires_at,
        sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), before.id, before.member_id, before.package_id, now(),
          now() + before.duration_days_snapshot * DAY_MS,
          limited ? before.session_limit_snapshot : null,
          limited ? before.session_limit_snapshot : null, now());

      const after = getOrder(db, before.id);
      audit(db, req.user.id, 'order.approve', before.id, before, after, now(), 'order');
      return after;
    });
    res.json(orderView(result, { includePayload: false }));
  });

  app.post('/api/admin/orders/:id/reject', admin, (req, res) => {
    const input = parse(rejectSchema, req.body);
    const result = transaction(db, () => {
      const before = adminOrder(req);
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดคำสั่งซื้อล่าสุดก่อน');
      if (before.status !== 'awaiting_review') throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');
      const changed = db.prepare('UPDATE orders SET status=\'rejected\',rejection_reason=?,reviewed_by=?,'
        + 'reviewed_at=?,version=version+1,updated_at=? WHERE id=? AND status=\'awaiting_review\'')
        .run(input.reason, req.user.id, now(), now(), before.id);
      if (changed.changes !== 1) throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');
      const after = getOrder(db, before.id);
      audit(db, req.user.id, 'order.reject', before.id, before, after, now(), 'order');
      return after;
    });
    res.json(orderView(result, { includePayload: false }));
  });

  /** Undo an approval made in error: revoke the membership, keep both records. */
  app.post('/api/admin/orders/:id/reverse', admin, (req, res) => {
    const input = parse(reverseSchema, req.body);
    const result = transaction(db, () => {
      const before = adminOrder(req);
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดคำสั่งซื้อล่าสุดก่อน');
      if (before.status !== 'paid') throw new HttpError(409, 'ยกเลิกการอนุมัติได้เฉพาะคำสั่งซื้อที่อนุมัติแล้ว');
      const changed = db.prepare('UPDATE orders SET status=\'rejected\',rejection_reason=?,reviewed_by=?,'
        + 'reviewed_at=?,version=version+1,updated_at=? WHERE id=? AND status=\'paid\'')
        .run(input.reason, req.user.id, now(), now(), before.id);
      if (changed.changes !== 1) throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');
      const entitlement = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(before.id);
      if (entitlement) {
        db.prepare("UPDATE entitlements SET status='revoked',revoked_at=?,revoked_reason=? WHERE id=?")
          .run(now(), input.reason, entitlement.id);
        audit(db, req.user.id, 'entitlement.revoke', entitlement.id, entitlement,
          db.prepare('SELECT * FROM entitlements WHERE id=?').get(entitlement.id), now(), 'entitlement');
      }
      const after = getOrder(db, before.id);
      audit(db, req.user.id, 'order.reverse', before.id, before, after, now(), 'order');
      return after;
    });
    res.json(orderView(result, { includePayload: false }));
  });

  /** Daily totals of approved orders, for reconciling against the bank statement. */
  app.get('/api/admin/sales', admin, (req, res) => {
    const rows = db.prepare(`SELECT date(reviewed_at/1000,'unixepoch','+7 hours') AS day,
      count(*) AS orders, sum(price_satang_snapshot) AS total_satang
      FROM orders WHERE status='paid' GROUP BY day ORDER BY day DESC LIMIT 90`).all();
    res.json({ items: rows.map(row => ({ ...row, total_thb: row.total_satang / 100 })) });
  });
}
