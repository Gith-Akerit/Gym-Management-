// The member's photograph and the card it goes on.
//
// Both are counter work: whoever is at the desk signs somebody up, takes their
// picture, and hands them the card. Only reissuing is the owner's, because a
// reissue quietly cancels the card somebody is already carrying.

import multer from 'multer';
import { z } from 'zod';
import { audit, getGym, getMember, publicMember, transaction } from './db.js';
import { cardQrFor, CardRenderError, renderCard } from './cards.js';
import { SlipError } from './slips.js';
import { HttpError, parse } from './validation.js';

/** A face needs far fewer bytes than a bank slip, and phones send far more. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const dateTh = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' })
  .format(new Date(value));

export function registerCardRoutes({ app, db, now, admin, counter, photoStore, secret }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });

  const load = id => {
    const member = getMember(db, id);
    if (!member) throw new HttpError(404, 'ไม่พบสมาชิก');
    return member;
  };

  /** What the bottom of the card says: the package, or why there is not one. */
  function subtitleFor(memberId) {
    const entitlement = db.prepare(`SELECT e.*, p.name_th FROM entitlements e
      JOIN packages p ON p.id=e.package_id
      WHERE e.member_id=? AND e.status='active' AND e.expires_at>?
      ORDER BY e.expires_at DESC LIMIT 1`).get(memberId, now());
    if (!entitlement) return 'ยังไม่มีแพ็กเกจที่ใช้งานได้';
    const sessions = entitlement.sessions_remaining === null
      ? 'ไม่จำกัดครั้ง' : `เหลือ ${entitlement.sessions_remaining} ครั้ง`;
    return `${entitlement.name_th} · ${sessions} · ใช้ได้ถึง ${dateTh(entitlement.expires_at)}`;
  }

  // ------------------------------------------------------------- photograph

  app.put('/api/members/:id/photo', counter, upload.single('photo'), (req, res) => {
    if (!photoStore) throw new HttpError(503, 'ระบบยังไม่ได้ตั้งค่าที่เก็บรูป กรุณาติดต่อผู้ดูแลระบบ');
    const member = load(req.params.id);
    let saved;
    try { saved = photoStore.save(req.file?.buffer); }
    catch (error) {
      if (error instanceof SlipError) throw new HttpError(400, error.message);
      throw error;
    }
    const result = transaction(db, () => {
      db.prepare(`UPDATE members SET photo_stored_name=?,photo_content_type=?,photo_updated_at=?,
        version=version+1,updated_at=? WHERE id=?`)
        .run(saved.storedName, saved.contentType, now(), now(), member.id);
      const after = getMember(db, member.id);
      audit(db, req.user.id, 'member.photo', member.id, member, after, now());
      return after;
    });
    // Only once the row points at the new file, so a failed write never leaves
    // a member whose photograph is a path to nothing.
    if (member.photo_stored_name) photoStore.remove(member.photo_stored_name);
    res.json(publicMember(result));
  });

  app.get('/api/members/:id/photo', counter, (req, res) => {
    const member = load(req.params.id);
    if (!member.photo_stored_name) throw new HttpError(404, 'สมาชิกรายนี้ยังไม่มีรูปถ่าย');
    let bytes;
    try { bytes = photoStore?.read(member.photo_stored_name); }
    catch { throw new HttpError(404, 'ไม่พบไฟล์รูปถ่าย'); }
    if (!bytes) throw new HttpError(404, 'ไม่พบไฟล์รูปถ่าย');
    res.set('Content-Type', member.photo_content_type);
    // no-store is set for every /api response: a face is not something a shared
    // counter tablet should keep in its disk cache.
    res.send(bytes);
  });

  // -------------------------------------------------------------- the card

  app.get('/api/members/:id/card', counter, (req, res) => {
    const member = load(req.params.id);
    res.json({
      member: publicMember(member),
      qr: cardQrFor(secret, member),
      subtitle: subtitleFor(member.id),
      card_version: member.card_version,
      card_issued_at: member.card_issued_at,
    });
  });

  app.get('/api/members/:id/card.png', counter, async (req, res, next) => {
    try {
      const member = load(req.params.id);
      const photo = member.photo_stored_name
        ? (() => { try { return photoStore?.read(member.photo_stored_name); } catch { return null; } })()
        : null;
      const png = await renderCard({
        member,
        gym: db.prepare('SELECT * FROM gym_profile WHERE id=1').get() ?? getGym(db).profile,
        qr: cardQrFor(secret, member),
        photo,
        subtitle: subtitleFor(member.id),
      });
      res.set('Content-Type', 'image/png');
      // The name the browser suggests when staff save it to send on: a folder
      // of card.png files helps nobody.
      res.set('Content-Disposition', `inline; filename="${member.member_code}.png"`);
      res.send(png);
    } catch (error) {
      if (error instanceof CardRenderError) return next(new HttpError(503, error.message));
      next(error);
    }
  });

  /**
   * Reissuing. The old card stops working the moment this returns, because the
   * counter goes up and every signature is over the counter -- there is no
   * list of cancelled cards to keep, and nothing to go and find.
   */
  app.post('/api/members/:id/card/reissue', admin, (req, res) => {
    const input = parse(z.object({
      reason: z.string().trim().min(1, 'กรุณาระบุเหตุผลที่ออกบัตรใหม่').max(300, 'เหตุผลยาวได้ไม่เกิน 300 ตัวอักษร'),
    }).strict(), req.body);
    const result = transaction(db, () => {
      const before = load(req.params.id);
      db.prepare('UPDATE members SET card_version=card_version+1,card_issued_at=?,version=version+1,updated_at=? WHERE id=?')
        .run(now(), now(), before.id);
      const after = getMember(db, before.id);
      audit(db, req.user.id, 'member.card_reissue', before.id,
        { card_version: before.card_version }, { card_version: after.card_version, reason: input.reason }, now());
      return after;
    });
    res.json({ member: publicMember(result), qr: cardQrFor(secret, result) });
  });
}
