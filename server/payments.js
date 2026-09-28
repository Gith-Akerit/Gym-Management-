// Money, all of it taken at the counter.
//
// There is no payment provider and no customer-facing checkout: the member pays
// the person at the desk, who records which way, and the package is handed over
// on the spot. The slip queue further down belongs to orders the old member app
// created, and is kept so those can still be finished.
//
// Granting twice would hand out a free membership, so it is guarded both in the
// transaction and by a UNIQUE constraint underneath.

import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import {
  activeEntitlements, audit, currentSlip, getOrder, getPackage,
  publicEntitlement, publicOrder, publicSlip, transaction,
} from './db.js';
import { buildPromptPayPayload } from './promptpay.js';
import { MAX_SLIP_BYTES, SlipError } from './slips.js';
import {
  approveMismatchSchema, approveSchema, counterSaleSchema, grantSchema, HttpError,
  parse, rejectSchema, reverseSchema,
} from './validation.js';

const DAY_MS = 86400000;

export function registerPaymentRoutes({ app, db, now, admin, counter, slipStore, promptPayId, pilotMode = false }) {
  // Staff at the counter sell packages and can see what is waiting. Deciding a
  // slip somebody transferred against the old member app stays with an admin.
  const readQueue = counter;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SLIP_BYTES, files: 1 } });

  const settings = () => db.prepare('SELECT payment_sla_text, order_ttl_minutes FROM gym_profile WHERE id=1').get()
    ?? { payment_sla_text: 'ภายใน 30 นาทีในเวลาทำการ', order_ttl_minutes: 60 };

/**
   * A QR is worth showing whenever money is still owed — which includes a
   * rejected order, because the commonest rejection is "no transfer arrived"
   * and that member has to pay (QA P2-BUG-06). A free package owes nothing.
   */
  const owesMoney = order => order.price_satang_snapshot > 0
    && (order.status === 'pending_payment' || order.status === 'rejected');

  /** Everything a member screen needs about one order, in a single response. */
  function orderView(order, { includePayload = true } = {}) {
    const slip = currentSlip(db, order.id);
    const history = db.prepare('SELECT * FROM payment_slips WHERE order_id=? ORDER BY uploaded_at DESC').all(order.id);
    const entitlement = db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(order.id);
    const view = publicOrder(order, now());
    return {
      order: view,
      slip: publicSlip(slip),
      slip_history: history.map(publicSlip),
      entitlement: publicEntitlement(entitlement),
      payment_sla_text: settings().payment_sla_text,
      free: order.price_satang_snapshot === 0,
      promptpay_payload: promptPayId && includePayload && view.status === order.status && owesMoney(order)
        ? buildPromptPayPayload(promptPayId, order.price_satang_snapshot) : null,
    };
  }

  // ----------------------------------------------------------------- counter

  /**
   * What is still good, for the member page and the card. Staff read it while
   * the member is standing there asking how many visits are left.
   */
  app.get('/api/members/:id/entitlements', readQueue, (req, res) => {
    const member = db.prepare('SELECT id FROM members WHERE id=?').get(req.params.id);
    if (!member) throw new HttpError(404, 'ไม่พบสมาชิก');
    res.json({ items: activeEntitlements(db, member.id, now()).map(publicEntitlement) });
  });

  /**
   * What this member has paid, and the slip that came with each payment.
   *
   * The queue screen this replaces existed for slips members uploaded
   * themselves, and there is no member app left to upload one. What a counter
   * actually asks is about one person: "she says she paid last month -- did
   * she, and who took it?" So the history hangs off the member, with the slip
   * beside the amount and the name of whoever recorded it.
   *
   * Who took the money comes from the audit trail rather than a column on the
   * order: it is already written there, and a second copy is a second thing to
   * keep true.
   */
  app.get('/api/members/:id/payments', counter, (req, res) => {
    const member = db.prepare('SELECT id FROM members WHERE id=?').get(req.params.id);
    if (!member) throw new HttpError(404, 'ไม่พบสมาชิก');
    const rows = db.prepare(`SELECT o.*,
      (SELECT u.email FROM audit_logs a JOIN users u ON u.id=a.actor_id
       WHERE a.entity_id=o.id AND a.action IN ('order.counter_sale','order.grant_manual')
       ORDER BY a.created_at LIMIT 1) AS recorded_by
      FROM orders o WHERE o.member_id=? ORDER BY o.created_at DESC LIMIT 50`).all(member.id);
    res.json({
      items: rows.map(row => ({
        ...publicOrder(row, now()),
        slip: publicSlip(currentSlip(db, row.id)),
      })),
    });
  });

  // ------------------------------------------------------------------- admin

  /** Same transfer reused for another order — reference number or identical image. */
  const duplicatesOf = slip => (slip ? db.prepare(`SELECT s.id, s.order_id, s.reference_no, s.uploaded_at,
      CASE WHEN s.file_hash=? THEN 'file' ELSE 'reference' END AS kind
      FROM payment_slips s WHERE s.order_id<>? AND (s.file_hash=? OR s.reference_no=?)
      ORDER BY s.uploaded_at DESC LIMIT 10`)
    .all(slip.file_hash, slip.order_id, slip.file_hash, slip.reference_no) : []);

  app.get('/api/admin/orders', readQueue, (req, res) => {
    const { status = 'awaiting_review', page = 1 } = parse(z.object({
      status: z.enum(['awaiting_review', 'pending_payment', 'paid', 'rejected', 'expired', 'cancelled', 'all']).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
    }).strict(), req.query);
    const where = status === 'all' ? '' : 'WHERE o.status=?';
    const params = status === 'all' ? [] : [status];
    const total = db.prepare(`SELECT count(*) AS total FROM orders o ${where}`).get(...params).total;
    // Longest wait first: the member has already paid and is waiting on us.
    // "Longest wait first" has to mean the wait the screen shows: the moment the
    // slip arrived. Ordering by created_at put a late slip on an early order
    // ahead of somebody who had been waiting longer.
    const rows = db.prepare(`SELECT o.*, m.name AS member_name, m.member_code,
      COALESCE((SELECT min(s.uploaded_at) FROM payment_slips s WHERE s.order_id=o.id), o.created_at) AS waiting_since
      FROM orders o JOIN members m ON m.id=o.member_id ${where}
      ORDER BY waiting_since LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20);
    res.json({
      items: rows.map(row => {
        const slip = currentSlip(db, row.id);
        return { ...publicOrder(row, now()), slip: publicSlip(slip), waiting_since: row.waiting_since };
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

  app.get('/api/admin/orders/:id', readQueue, (req, res) => {
    const order = adminOrder(req);
    const slip = currentSlip(db, order.id);
    const member = db.prepare('SELECT m.*, u.email FROM members m LEFT JOIN users u ON u.id=m.user_id WHERE m.id=?')
      .get(order.member_id);
    const { user_id, photo_stored_name, photo_content_type, ...memberView } = member;
    res.json({
      ...orderView(order, { includePayload: false }),
      member: { ...memberView, has_photo: !!photo_stored_name },
      duplicates: duplicatesOf(slip),
      // Flagged, not blocked: only the admin can judge a partial payment.
      amount_mismatch: slip?.amount_satang_claimed != null
        && slip.amount_satang_claimed !== order.price_satang_snapshot,
    });
  });

  /** The slip image, for whoever is working the counter and nobody else. */
  app.get('/api/slips/:id/image', readQueue, (req, res) => {
    const slip = db.prepare('SELECT * FROM payment_slips WHERE id=?').get(req.params.id);
    if (!slip) throw new HttpError(404, 'ไม่พบสลิป');
    res.set('Content-Type', slip.content_type);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(slipStore.read(slip.stored_name));
  });

  /**
   * The membership itself, from an order that has just become paid.
   *
   * order_id is UNIQUE, which is what stops a double-click minting a second
   * membership. After a reversal the revoked row is still there, so this
   * inserts and reinstates in one statement rather than colliding with it
   * (P2-BUG-02).
   */
  function grantEntitlement(order) {
    const limited = order.package_type_snapshot === 'limited_sessions';
    db.prepare(`INSERT INTO entitlements(id,order_id,member_id,package_id,starts_at,expires_at,
      sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET
        member_id=excluded.member_id, package_id=excluded.package_id,
        starts_at=excluded.starts_at, expires_at=excluded.expires_at,
        sessions_total=excluded.sessions_total, sessions_remaining=excluded.sessions_remaining,
        status='active', revoked_at=NULL, revoked_reason=NULL, created_at=excluded.created_at`)
      .run(randomUUID(), order.id, order.member_id, order.package_id, now(),
        now() + order.duration_days_snapshot * DAY_MS,
        limited ? order.session_limit_snapshot : null,
        limited ? order.session_limit_snapshot : null, now());
  }

  /**
   * Taking the money and handing over the package, in one action at the desk.
   *
   * This is now the only way a membership is sold. The member paid in cash or
   * transferred while standing there, and staff record which -- a slip photo is
   * welcome but optional, because a gym that takes notes across a counter has
   * no slip to photograph.
   *
   * `payment_method: 'none'` is the old manual grant: a comped membership with
   * nobody paying. It still demands a written reason and is still flagged
   * manual_grant, so the daily total reconciled against the bank leaves it out.
   * A sale that was actually paid is real revenue and is counted.
   */
  app.post('/api/members/:id/grant', counter, upload.single('slip'), (req, res) => {
    const input = parse(counterSaleSchema, req.body);
    const withSlip = !!req.file;
    let stored = null;
    if (withSlip) {
      try { stored = slipStore.save(req.file.buffer); }
      catch (e) { throw e instanceof SlipError ? new HttpError(400, e.message) : e; }
    }
    try {
      const result = transaction(db, () => {
        const member = db.prepare('SELECT * FROM members WHERE id=?').get(req.params.id);
        if (!member) throw new HttpError(404, 'ไม่พบสมาชิก');
        if (member.status !== 'active') throw new HttpError(409, 'สมาชิกรายนี้ถูกระงับ กรุณาแก้สถานะสมาชิกก่อนมอบแพ็กเกจ');
        const pkg = getPackage(db, input.package_id);
        if (!pkg) throw new HttpError(404, 'ไม่พบแพ็กเกจนี้');
        // The price is recorded even when nobody paid it: it is what the
        // membership would have cost, and the report needs it to say what was
        // given away. A package with no price yet has no such number.
        if (pkg.price_satang === null) throw new HttpError(409, 'แพ็กเกจนี้ยังไม่ได้กำหนดราคา กรุณากรอกราคาก่อน');
        // "Not on sale yet" and "we stopped selling this" have to mean
        // something on the server, not only in the list the screen draws. A
        // tablet left open at the counter is still holding yesterday's list,
        // and a price the owner withdrew would otherwise turn up in today's
        // takings without them agreeing to it (QA BUG-SALE-09).
        if (pkg.status !== 'active') {
          throw new HttpError(409, pkg.status === 'archived'
            ? 'แพ็กเกจนี้ปิดการขายไปแล้ว กรุณาเลือกแพ็กเกจอื่น หรือเปิดขายอีกครั้งที่หน้าแพ็กเกจ'
            : 'แพ็กเกจนี้ยังไม่ได้เปิดขาย กรุณาเปิดขายก่อนที่หน้าแพ็กเกจ หรือเลือกแพ็กเกจอื่น');
        }

        const comped = input.payment_method === 'none';
        const id = randomUUID();
        db.prepare(`INSERT INTO orders(id,member_id,package_id,package_code_snapshot,package_name_snapshot,
          package_type_snapshot,duration_days_snapshot,session_limit_snapshot,price_satang_snapshot,
          status,manual_grant,payment_method,reviewed_by,reviewed_at,review_note,created_at,expires_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'paid',?,?,?,?,?,?,?,?)`)
          .run(id, member.id, pkg.id, pkg.code, pkg.name_th, pkg.type, pkg.duration_days,
            pkg.session_limit, pkg.price_satang, comped ? 1 : 0, input.payment_method,
            req.user.id, now(), input.note, now(), now(), now());
        if (stored) {
          db.prepare(`INSERT INTO payment_slips(id,order_id,stored_name,content_type,byte_size,file_hash,
            reference_no,transferred_at,amount_satang_claimed,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(), id, stored.storedName, stored.contentType, stored.byteSize,
              stored.fileHash, input.reference_no ?? '', now(), pkg.price_satang, now());
        }
        const order = getOrder(db, id);
        grantEntitlement(order);
        audit(db, req.user.id, comped ? 'order.grant_manual' : 'order.counter_sale', id, null, order, now(), 'order');
        return order;
      });
      res.status(201).json(orderView(result, { includePayload: false }));
    } catch (e) {
      // Never leave an orphan file behind when the row could not be written.
      if (stored) slipStore.remove(stored.storedName);
      throw e;
    }
  });

  /**
   * Turns a confirmed transfer into membership. The UPDATE is conditional on the
   * order still being under review, so a second click changes zero rows and is
   * rejected rather than granting a second entitlement.
   */
  app.post('/api/admin/orders/:id/approve', admin, (req, res) => {
    const result = transaction(db, () => {
      const before = adminOrder(req);
      // A short payment needs a written reason; anything else does not. And a
      // free package has no transfer at all, so the admin is granting rather
      // than confirming, and is never asked to tick the bank box.
      const slip = currentSlip(db, before.id);
      const mismatch = slip?.amount_satang_claimed != null
        && slip.amount_satang_claimed !== before.price_satang_snapshot;
      const schema = before.price_satang_snapshot === 0 ? grantSchema
        : mismatch ? approveMismatchSchema : approveSchema;
      const input = parse(schema, req.body);
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดคำสั่งซื้อล่าสุดก่อนอนุมัติ');
      if (before.status !== 'awaiting_review') throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');
      const member = db.prepare('SELECT status FROM members WHERE id=?').get(before.member_id);
      if (member?.status !== 'active') throw new HttpError(409, 'สมาชิกรายนี้ถูกระงับ กรุณาแก้สถานะสมาชิกก่อนอนุมัติ');

      const claimed = db.prepare('UPDATE orders SET status=\'paid\',reviewed_by=?,reviewed_at=?,review_note=?,'
        + 'version=version+1,updated_at=? WHERE id=? AND status=\'awaiting_review\'')
        .run(req.user.id, now(), input.note, now(), before.id);
      if (claimed.changes !== 1) throw new HttpError(409, 'คำสั่งซื้อนี้ถูกดำเนินการไปแล้ว');

      grantEntitlement(before);

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

  /**
   * Brings an expired order back. Orders stranded before the expiry rule was
   * narrowed still exist, and a member who transferred money needs a way back
   * in that does not involve paying twice.
   */
  app.post('/api/admin/orders/:id/reopen', admin, (req, res) => {
    const input = parse(z.object({
      version: z.coerce.number().int().positive(),
      minutes: z.coerce.number().int().min(5).max(10080).default(60),
    }).strict(), req.body);
    const result = transaction(db, () => {
      const before = adminOrder(req);
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดคำสั่งซื้อล่าสุดก่อน');
      // Reads project a lapsed pending order as expired before the sweeper has
      // written that down, so judge the same way the admin's screen does.
      const lapsed = before.status === 'pending_payment' && before.expires_at <= now();
      if (!lapsed && !['expired', 'cancelled'].includes(before.status)) {
        throw new HttpError(409, 'เปิดกลับได้เฉพาะคำสั่งซื้อที่หมดอายุหรือถูกยกเลิกแล้ว');
      }
      // A slip already on file means the member paid: put it back in the queue.
      const status = currentSlip(db, before.id) ? 'awaiting_review' : 'pending_payment';
      db.prepare('UPDATE orders SET status=?,expires_at=?,version=version+1,updated_at=? WHERE id=?')
        .run(status, now() + input.minutes * 60000, now(), before.id);
      const after = getOrder(db, before.id);
      audit(db, req.user.id, 'order.reopen', before.id, before, after, now(), 'order');
      return after;
    });
    res.json(orderView(result, { includePayload: false }));
  });

  /** Daily totals of approved orders, for reconciling against the bank statement. */
  app.get('/api/admin/sales', admin, (req, res) => {
    const rows = db.prepare(`SELECT date(reviewed_at/1000,'unixepoch','+7 hours') AS day,
      count(*) AS orders,
      sum(CASE WHEN manual_grant=0 THEN price_satang_snapshot ELSE 0 END) AS total_satang,
      sum(manual_grant) AS manual_grants
      FROM orders WHERE status='paid' GROUP BY day ORDER BY day DESC LIMIT 90`).all();
    res.json({ items: rows.map(row => ({ ...row, total_thb: row.total_satang / 100 })) });
  });
}
