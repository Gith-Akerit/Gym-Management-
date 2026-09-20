// The member's photograph and the card it goes on.
//
// Both are counter work: whoever is at the desk signs somebody up, takes their
// picture, and hands them the card. Only reissuing is the owner's, because a
// reissue quietly cancels the card somebody is already carrying.

import { createHmac, timingSafeEqual } from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { audit, getGym, getMember, publicMember, transaction } from './db.js';
import { cardQrFor, CardRenderError, photoIsDrawable, PhotoUnreadableError, preparePhoto, renderCard } from './cards.js';
import { detectImageType, SlipError } from './slips.js';
import { resolveTheme } from './theme.js';
import { brandShort, settingsRow } from './settings-routes.js';
import { HttpError, parse } from './validation.js';

/** A face needs far fewer bytes than a bank slip, and phones send far more. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * How long a "send the card again" link lives.
 *
 * Seven days, because the reason it exists is that a member lost the picture
 * and messaged the gym about it -- a link that dies before somebody gets round
 * to opening it is a link that generates a second phone call. It is signed and
 * carries the card number, so it stops working the moment the card is reissued.
 */
export const CARD_LINK_TTL_MS = 7 * 86400000;

const dateTh = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' })
  .format(new Date(value));

export function registerCardRoutes({ app, db, now, admin, counter, photoStore, logoStore, secret }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });

  const load = id => {
    const member = getMember(db, id);
    if (!member) throw new HttpError(404, 'ไม่พบสมาชิก');
    return member;
  };

  /**
   * What the bottom of the card says: the package, or nothing.
   *
   * Nothing is `null`, not the words "ยังไม่มีแพ็กเกจ" -- the same shape the
   * member list returns, so a screen can test it rather than compare strings.
   * The card renderer is the one place that turns an absent package into words.
   */
  function membershipFor(memberId) {
    const entitlement = db.prepare(`SELECT e.*, p.name_th FROM entitlements e
      JOIN packages p ON p.id=e.package_id
      WHERE e.member_id=? AND e.status='active' AND e.expires_at>?
      ORDER BY e.expires_at DESC LIMIT 1`).get(memberId, now());
    if (!entitlement) return { package: null, expires: null, expires_at: null, sessions_remaining: null };
    return {
      package: entitlement.name_th,
      expires: dateTh(entitlement.expires_at),
      expires_at: entitlement.expires_at,
      sessions_remaining: entitlement.sessions_remaining,
    };
  }

  const readPhoto = member => {
    if (!member.photo_stored_name) return null;
    try { return photoStore?.read(member.photo_stored_name) ?? null; } catch { return null; }
  };

  /** The gym's logo, when it has one and the file is still where it said. */
  const readLogo = settings => {
    if (!settings?.logo_stored_name) return null;
    try { return logoStore?.read(settings.logo_stored_name) ?? null; } catch { return null; }
  };

  async function draw(member, { voided = false } = {}) {
    const gym = db.prepare('SELECT * FROM gym_profile WHERE id=1').get() ?? getGym(db).profile;
    // Read on every draw rather than cached at boot: the owner changes a colour
    // and the next card out of the door is the new one, including the one a
    // seven-day link hands over. The token in the QR does not depend on any of
    // this, so nothing that is already in somebody's phone stops working.
    const settings = settingsRow(db);
    return renderCard({
      member,
      gym,
      qr: cardQrFor(secret, member),
      photo: readPhoto(member),
      membership: membershipFor(member.id),
      theme: resolveTheme(settings),
      logo: readLogo(settings),
      logoAvg: settings?.logo_avg ?? null,
      brandShort: brandShort(settings, gym),
      lineId: settings?.line_id ?? '',
      voided,
    });
  }

  /**
   * Handed back to createApp so the member's welcome letter can attach the
   * same picture the counter sees, drawn by the same code with the same
   * colours. A second renderer would be a second card.
   */
  const handles = { drawCard: draw, membershipFor };

  function sendCard(res, member, png) {
    res.set('Content-Type', 'image/png');
    // The name the browser suggests when staff save it to send on: a folder of
    // card.png files helps nobody.
    res.set('Content-Disposition', `inline; filename="${member.member_code}.png"`);
    res.send(png);
  }

  // ------------------------------------------------------------- photograph

  app.put('/api/members/:id/photo', counter, upload.single('photo'), async (req, res) => {
    if (!photoStore) throw new HttpError(503, 'ระบบยังไม่ได้ตั้งค่าที่เก็บรูป กรุณาติดต่อผู้ดูแลระบบ');
    const member = load(req.params.id);
    let saved;
    // Opened once, here at the door, and down to 700px on the long edge before
    // anything is written: the card draws the face at 232 and the scan screen
    // at about 300, so the rest of a phone camera's pixels are disk and waiting
    // time nobody sees (Mika). A file that will not open is refused now, while
    // the member is still standing at the counter (QA PHOTO-03).
    let bytes = req.file?.buffer;
    // The cheap check on the leading bytes goes first and keeps its own
    // wording: a PDF named face.jpg, or an iPhone's HEIC, each need a
    // different sentence from a JPEG that arrived half-written.
    const looksLikeAnImage = bytes ? detectImageType(bytes) : null;
    if (looksLikeAnImage && !looksLikeAnImage.unsupported) {
      try { bytes = await preparePhoto(bytes); }
      catch (error) {
        if (error instanceof PhotoUnreadableError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    try { saved = photoStore.save(bytes); }
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
    const bytes = readPhoto(member);
    if (!bytes) throw new HttpError(404, 'ไม่พบไฟล์รูปถ่าย');
    res.set('Content-Type', member.photo_content_type);
    // no-store is set for every /api response: a face is not something a shared
    // counter tablet should keep in its disk cache.
    res.send(bytes);
  });

  // -------------------------------------------------------------- the card

  /**
   * A link the gym can paste into a chat when a member loses the picture.
   *
   * Signed rather than stored: the counter hands these out casually and a row
   * per handout is a table nobody prunes. The signature covers the card number,
   * so reissuing a card kills every link to the old one at the same moment it
   * kills the card itself.
   */
  const linkSignature = (memberId, version, expires) =>
    createHmac('sha256', secret).update(`cardlink:${memberId}:${version}:${expires}`).digest('hex').slice(0, 32);

  function checkLink(memberId, version, expires, signature) {
    if (!/^\d+$/.test(String(expires)) || !/^[0-9a-f]{32}$/.test(String(signature ?? ''))) return false;
    const expected = linkSignature(memberId, version, expires);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return false;
    return Number(expires) > now();
  }

  app.post('/api/members/:id/card/link', counter, (req, res) => {
    const member = load(req.params.id);
    const expires = now() + CARD_LINK_TTL_MS;
    const signature = linkSignature(member.id, member.card_version, expires);
    audit(db, req.user.id, 'member.card_link', member.id, null,
      { card_version: member.card_version, expires_at: expires }, now());
    res.json({
      url: `/card/${member.id}.png?v=${member.card_version}&e=${expires}&s=${signature}`,
      expires_at: expires,
      card_version: member.card_version,
    });
  });

  /**
   * The link itself. Outside /api on purpose: it is opened by whoever the gym
   * sent it to, in a browser with no session, and the path is what they see.
   */
  app.get('/card/:id.png', async (req, res, next) => {
    try {
      const member = getMember(db, req.params.id);
      const { v, e, s } = req.query;
      if (!member || Number(v) !== member.card_version || !checkLink(member.id, member.card_version, e, s)) {
        // One message for every way of failing: a wrong signature, an expired
        // link and a reissued card are the same answer to whoever is holding it.
        return res.status(404).type('text/plain; charset=utf-8')
          .send('ลิงก์นี้หมดอายุหรือถูกยกเลิกแล้ว กรุณาขอลิงก์ใหม่จากยิม');
      }
      res.set('Cache-Control', 'no-store');
      sendCard(res, member, await draw(member));
    } catch (error) {
      if (error instanceof CardRenderError) return next(new HttpError(503, error.message));
      next(error);
    }
  });

  app.get('/api/members/:id/card', counter, async (req, res) => {
    const member = load(req.params.id);
    // Whether the face on the card is really there. The card itself never
    // fails over a photograph -- it falls back to the silhouette -- so this is
    // the only thing that can tell the person at the counter that the picture
    // needs taking again, while the member is still in front of them.
    const bytes = readPhoto(member);
    // `null` means there is no photograph to judge; `false` covers both a file
    // that will not decode and one that is no longer on the disk at all.
    const readable = !member.photo_stored_name ? null : bytes ? await photoIsDrawable(bytes) : false;
    res.json({
      member: publicMember(member),
      qr: cardQrFor(secret, member),
      membership: membershipFor(member.id),
      card_version: member.card_version,
      card_issued_at: member.card_issued_at,
      photo_readable: readable,
      // Moves when the gym's colours or logo change, so the picture on this
      // screen is the picture that would be sent, not the browser's memory.
      theme_version: settingsRow(db)?.version ?? 1,
    });
  });

  app.get('/api/members/:id/card.png', counter, async (req, res, next) => {
    try {
      const member = load(req.params.id);
      // ?voided=1 draws the cancelled version for the history screen. It is
      // never sent to a member; it exists so an admin can see which picture is
      // the dead one (Designer).
      sendCard(res, member, await draw(member, { voided: req.query.voided === '1' }));
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

  return handles;
}
