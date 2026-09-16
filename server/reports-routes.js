// "ใช้ไม่ได้" with a picture of it.
//
// Anybody signed in can send one, because the person who sees the problem is
// whoever happens to be holding the tablet. Only the owner can read them back,
// because the picture is of a screen that usually has a member on it -- their
// name, their photograph, their telephone number. That asymmetry is the whole
// design: easy in, guarded out, and every look at a picture written down.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import multer from 'multer';
import { audit, transaction } from './db.js';
import { SlipError } from './slips.js';
import { MAX_REPORT_BYTES, prepareScreenshot, shortAgent, UnreadableScreenshot } from './reports.js';
import { HttpError, parse } from './validation.js';

const STATUSES = ['new', 'reading', 'done', 'not_a_bug'];

const reportSchema = z.object({
  message: z.string().trim().min(1, 'กรุณาเขียนสั้น ๆ ว่าใช้ไม่ได้อย่างไร')
    .max(2000, 'ข้อความยาวเกินไป กรุณาเขียนสั้นลง'),
  screen: z.string().trim().max(80).optional(),
  viewport: z.string().trim().max(40).optional(),
  app_revision: z.string().trim().max(40).optional(),
});

const updateSchema = z.object({
  status: z.enum(STATUSES).optional(),
  internal_note: z.string().trim().max(2000, 'บันทึกภายในยาวเกินไป').optional(),
}).strict();

/** What the owner's list shows. The picture itself is a separate request. */
const publicReport = (row, extra = {}) => ({
  id: row.id,
  reference: row.reference,
  message: row.message,
  screen: row.screen,
  status: row.status,
  has_image: !!row.image_stored_name,
  image_url: row.image_stored_name ? `/api/reports/${row.id}/image` : null,
  reported_by_email: row.reporter_email ?? null,
  reported_by_role: row.reporter_role ?? null,
  user_agent: row.user_agent,
  viewport: row.viewport,
  app_revision: row.app_revision,
  internal_note: row.internal_note,
  created_at: row.created_at,
  updated_at: row.updated_at,
  ...extra,
});

const SELECT = `SELECT r.*, u.email AS reporter_email, u.role AS reporter_role
  FROM problem_reports r LEFT JOIN users u ON u.id = r.reported_by`;

export function registerReportRoutes({ app, db, now, admin, counter, reportStore }) {
  // The door is wider than the logo's because a screenshot of a 4K desktop is
  // genuinely large before the server shrinks it; what is kept is a JPEG.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_REPORT_BYTES, files: 1 } });

  const receiveShot = (req, res, next) => upload.single('screenshot')(req, res, error => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400,
        `ภาพหน้าจอใหญ่เกิน ${Math.round(MAX_REPORT_BYTES / 1024 / 1024)} MB กรุณาส่งเรื่องโดยไม่แนบภาพ`));
    }
    if (typeof error?.code === 'string' && error.code.startsWith('LIMIT_')) {
      return next(new HttpError(400, 'แนบไฟล์ได้ครั้งละหนึ่งภาพเท่านั้น'));
    }
    next(error);
  });

  const load = id => {
    const row = db.prepare(`${SELECT} WHERE r.id=?`).get(id);
    if (!row) throw new HttpError(404, 'ไม่พบเรื่องที่แจ้งนี้');
    return row;
  };

  /**
   * Sending one.
   *
   * Multipart even when there is no picture, so the screen has one code path
   * whether the capture worked, failed, or was switched off by the reporter.
   */
  app.post('/api/reports', counter, receiveShot, async (req, res) => {
    const input = parse(reportSchema, req.body ?? {});

    let saved = null;
    const bytes = req.file?.buffer;
    if (bytes?.length) {
      if (!reportStore) throw new HttpError(503, 'ระบบยังไม่ได้ตั้งค่าที่เก็บภาพ กรุณาแจ้งผู้ดูแลระบบ');
      let prepared;
      try { prepared = await prepareScreenshot(bytes); }
      catch (error) {
        if (error instanceof UnreadableScreenshot) throw new HttpError(400, error.message);
        throw error;
      }
      // The store names the file and reports the type it detected in the
      // bytes, which after re-encoding is the JPEG we just made.
      try { saved = reportStore.save(prepared.bytes); }
      catch (error) {
        if (error instanceof SlipError) throw new HttpError(400, error.message);
        throw error;
      }
    }

    const id = randomUUID();
    const at = now();
    transaction(db, () => {
      // The reference is the highest so far plus one rather than a count, so
      // deleting a report never hands its number to the next one.
      const { top } = db.prepare('SELECT COALESCE(MAX(reference),0) AS top FROM problem_reports').get();
      db.prepare(`INSERT INTO problem_reports(id,reference,message,screen,reported_by,user_agent,viewport,
        app_revision,image_stored_name,image_content_type,status,internal_note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?, 'new','',?,?)`).run(
        id, top + 1, input.message, input.screen ?? '', req.user.id,
        shortAgent(req.get('user-agent')), input.viewport ?? '', input.app_revision ?? '',
        saved?.storedName ?? null, saved?.contentType ?? null, at, at);
      audit(db, req.user.id, 'report.create', id, null, null, at, 'report');
    });
    const row = load(id);
    res.status(201).json(publicReport(row));
  });

  /** Reading them back. The owner's, and nobody else's. */
  app.get('/api/reports', admin, (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = status
      ? db.prepare(`${SELECT} WHERE r.status=? ORDER BY r.created_at DESC LIMIT 200`).all(status)
      : db.prepare(`${SELECT} ORDER BY r.created_at DESC LIMIT 200`).all();
    const counts = Object.fromEntries(STATUSES.map(name => [name, 0]));
    for (const { status: name, n } of db.prepare(
      'SELECT status, COUNT(*) AS n FROM problem_reports GROUP BY status').all()) counts[name] = n;
    res.json({ items: rows.map(row => publicReport(row)), counts });
  });

  app.get('/api/reports/:id', admin, (req, res) => res.json(publicReport(load(req.params.id))));

  /**
   * The picture.
   *
   * Written down every time, because this is the one endpoint in the system
   * that hands a member's face and name to somebody looking at a bug report,
   * and "who looked at it" is a question that only has an answer if it was
   * recorded before anybody thought to ask.
   */
  app.get('/api/reports/:id/image', admin, (req, res) => {
    const row = load(req.params.id);
    if (!row.image_stored_name) throw new HttpError(404, 'เรื่องนี้ไม่มีภาพหน้าจอ');
    let bytes = null;
    try { bytes = reportStore?.read(row.image_stored_name) ?? null; } catch { bytes = null; }
    if (!bytes) throw new HttpError(404, 'ไม่พบไฟล์ภาพหน้าจอ');
    audit(db, req.user.id, 'report.view_image', row.id, null, null, now(), 'report');
    res.set('Content-Type', row.image_content_type || 'image/jpeg');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  });

  app.patch('/api/reports/:id', admin, (req, res) => {
    const input = parse(updateSchema, req.body ?? {});
    if (input.status === undefined && input.internal_note === undefined) {
      throw new HttpError(400, 'ไม่มีอะไรให้บันทึก');
    }
    const before = load(req.params.id);
    transaction(db, () => {
      const fields = {};
      if (input.status !== undefined) fields.status = input.status;
      if (input.internal_note !== undefined) fields.internal_note = input.internal_note;
      const columns = Object.keys(fields).map(name => `${name}=?`).join(',');
      db.prepare(`UPDATE problem_reports SET ${columns},updated_at=? WHERE id=?`)
        .run(...Object.values(fields), now(), before.id);
      audit(db, req.user.id, 'report.update', before.id, null, null, now(), 'report');
    });
    res.json(publicReport(load(before.id)));
  });

  app.delete('/api/reports/:id', admin, (req, res) => {
    const row = load(req.params.id);
    transaction(db, () => {
      db.prepare('DELETE FROM problem_reports WHERE id=?').run(row.id);
      audit(db, req.user.id, 'report.delete', row.id, null, null, now(), 'report');
    });
    // After the row, never before: a file removed first would leave a report
    // pointing at nothing if the delete failed.
    if (row.image_stored_name) reportStore?.remove(row.image_stored_name);
    res.json({ deleted: true });
  });
}
