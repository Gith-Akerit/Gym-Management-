// The gym's own look: what the owner sets, and who may read it.
//
// Three audiences, three levels of access. The login screen has no session at
// all and still has to show the right logo and the right colour, so the theme
// is public -- it is a shop sign, and there is nothing in it that a passer-by
// could not read off the door. Staff may look at the settings screen but not
// change it. Changing it is the owner's, and every change is written down,
// because a member's card changes shape the moment it is saved.

import { z } from 'zod';
import multer from 'multer';
import { audit, getGym, transaction } from './db.js';
import { LogoUnreadableError, MAX_LOGO_BYTES, normalizeHex, paletteFrom, prepareLogo, resolveTheme } from './theme.js';
import { detectImageType, SlipError } from './slips.js';
import { HttpError, parse } from './validation.js';

export const settingsRow = db => db.prepare('SELECT * FROM gym_settings WHERE id=1').get() ?? null;

/**
 * The short word in the square, when there is no logo file.
 *
 * What the owner typed if they typed one; otherwise the first letters of the
 * gym's own name, which is what the card has always drawn.
 */
export function brandShort(settings, gym) {
  const chosen = (settings?.brand_short ?? '').trim();
  if (chosen) return chosen;
  const words = String(gym?.brand_name_th || gym?.name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'ยม';
  return words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
}

/**
 * Everything a screen needs to paint itself, with nothing private in it.
 *
 * `logo_url` carries the timestamp of the file so a browser that cached the
 * old logo does not keep showing it after the owner changes one.
 */
export function publicTheme(db) {
  const settings = settingsRow(db);
  const gym = getGym(db).profile;
  return {
    brand: gym?.brand_name_th || gym?.name || 'ยิมของเรา',
    brand_short: brandShort(settings, gym),
    has_logo: !!settings?.logo_stored_name,
    logo_url: settings?.logo_stored_name ? `/api/gym/logo?v=${settings.logo_updated_at ?? 0}` : null,
    line_id: settings?.line_id || '',
    theme: resolveTheme(settings),
    // The screen redraws the card image when this moves, so a colour change is
    // visible without anybody pressing reload.
    version: settings?.version ?? 1,
  };
}

const settingsSchema = z.object({
  brand_short: z.string().trim().max(12, 'ชื่อย่อยาวได้ไม่เกิน 12 ตัวอักษร').optional(),
  color_primary: z.string().trim().optional(),
  // Empty string means "go back to working it out from the primary colour".
  color_secondary: z.string().trim().nullish(),
  line_id: z.string().trim().max(60, 'LINE ID ยาวได้ไม่เกิน 60 ตัวอักษร').optional(),
  version: z.coerce.number().int().min(1).optional(),
}).strict();

export function registerPublicThemeRoutes({ app, db, logoStore }) {
  app.get('/api/public/theme', (req, res) => res.json(publicTheme(db)));

  /**
   * The logo bytes, to anybody who asks.
   *
   * Deliberately not behind the session check: the first screen anyone sees is
   * the login page, and a login page with a missing logo looks like the wrong
   * address. A logo is the one image in this system that is not personal data.
   */
  app.get('/api/gym/logo', (req, res) => {
    const settings = settingsRow(db);
    if (!settings?.logo_stored_name) throw new HttpError(404, 'ยังไม่ได้อัปโหลดโลโก้');
    let bytes;
    try { bytes = logoStore?.read(settings.logo_stored_name) ?? null; } catch { bytes = null; }
    if (!bytes) throw new HttpError(404, 'ไม่พบไฟล์โลโก้');
    res.set('Content-Type', settings.logo_content_type);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  });
}

export function registerSettingsRoutes({ app, db, now, admin, counter, logoStore }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1 } });

  const readLogo = settings => {
    if (!settings?.logo_stored_name) return null;
    try { return logoStore?.read(settings.logo_stored_name) ?? null; } catch { return null; }
  };

  /** The settings screen's whole state, including what the logo is made of. */
  async function view() {
    const settings = settingsRow(db);
    const bytes = readLogo(settings);
    return {
      ...publicTheme(db),
      brand_short_source: (settings?.brand_short ?? '').trim() ? 'gym' : 'auto',
      color_secondary_source: normalizeHex(settings?.color_secondary) ? 'gym' : 'auto',
      logo_updated_at: settings?.logo_updated_at ?? null,
      // Offered, not applied: the owner picks one of these or a colour of
      // their own. An empty list means the logo had no colour worth naming.
      palette: bytes ? await paletteFrom(bytes) : [],
    };
  }

  // Staff see it because the screen they use is painted with it and "why is it
  // green" is a question they get asked; they cannot change it.
  app.get('/api/gym/settings', counter, async (req, res) => res.json(await view()));

  app.put('/api/gym/settings', admin, async (req, res) => {
    const input = parse(settingsSchema, req.body);
    const fields = {};
    if (input.color_primary !== undefined) {
      const primary = normalizeHex(input.color_primary);
      if (!primary) throw new HttpError(400, 'สีหลักไม่ถูกต้อง กรุณาเลือกสีจากโลโก้หรือใส่รหัสสีแบบ #RRGGBB', { color_primary: 'ใส่รหัสสีแบบ #RRGGBB' });
      fields.color_primary = primary;
    }
    if (input.color_secondary !== undefined) {
      const raw = (input.color_secondary ?? '').trim();
      // Clearing it is a choice, not a mistake: it hands the second colour
      // back to the system, which is where most gyms leave it.
      if (!raw) fields.color_secondary = null;
      else {
        const secondary = normalizeHex(raw);
        if (!secondary) throw new HttpError(400, 'สีรองไม่ถูกต้อง เว้นว่างไว้ได้ ระบบจะคำนวณให้เอง', { color_secondary: 'ใส่รหัสสีแบบ #RRGGBB หรือเว้นว่าง' });
        fields.color_secondary = secondary;
      }
    }
    if (input.brand_short !== undefined) fields.brand_short = input.brand_short;
    if (input.line_id !== undefined) fields.line_id = input.line_id;
    if (!Object.keys(fields).length) throw new HttpError(400, 'ไม่มีอะไรให้บันทึก');

    transaction(db, () => {
      const before = settingsRow(db);
      // Two people on two tablets, and the second one would otherwise put back
      // a colour the first had just changed without either of them knowing.
      if (input.version !== undefined && input.version !== before.version) {
        throw new HttpError(409, 'มีคนแก้ตั้งค่ายิมไปแล้วระหว่างที่คุณเปิดหน้านี้ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง');
      }
      const columns = Object.keys(fields).map(name => `${name}=?`).join(',');
      db.prepare(`UPDATE gym_settings SET ${columns},version=version+1,updated_at=? WHERE id=1`)
        .run(...Object.values(fields), now());
      audit(db, req.user.id, 'gym.settings', '1', before, settingsRow(db), now(), 'gym');
    });
    res.json(await view());
  });

  app.put('/api/gym/settings/logo', admin, upload.single('logo'), async (req, res) => {
    if (!logoStore) throw new HttpError(503, 'ระบบยังไม่ได้ตั้งค่าที่เก็บโลโก้ กรุณาติดต่อผู้ดูแลระบบ');
    let bytes = req.file?.buffer;
    if (!bytes?.length) throw new HttpError(400, 'กรุณาเลือกไฟล์โลโก้');
    // Type by leading bytes first, so a PDF named logo.png keeps its own
    // message, then opened for real so a half-sent file is refused here rather
    // than on every member's card afterwards.
    const looksLikeAnImage = detectImageType(bytes);
    if (looksLikeAnImage && !looksLikeAnImage.unsupported) {
      try { bytes = await prepareLogo(bytes); }
      catch (error) {
        if (error instanceof LogoUnreadableError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    let saved;
    try { saved = logoStore.save(bytes); }
    catch (error) {
      if (error instanceof SlipError) throw new HttpError(400, error.message);
      throw error;
    }
    const previous = settingsRow(db)?.logo_stored_name ?? null;
    transaction(db, () => {
      const before = settingsRow(db);
      db.prepare(`UPDATE gym_settings SET logo_stored_name=?,logo_content_type=?,logo_updated_at=?,
        version=version+1,updated_at=? WHERE id=1`)
        .run(saved.storedName, saved.contentType, now(), now());
      audit(db, req.user.id, 'gym.logo', '1', before, settingsRow(db), now(), 'gym');
    });
    // Only once the row points at the new file.
    if (previous) logoStore.remove(previous);
    res.json(await view());
  });

  app.delete('/api/gym/settings/logo', admin, async (req, res) => {
    const previous = settingsRow(db)?.logo_stored_name ?? null;
    if (!previous) throw new HttpError(404, 'ยังไม่ได้อัปโหลดโลโก้');
    transaction(db, () => {
      const before = settingsRow(db);
      db.prepare(`UPDATE gym_settings SET logo_stored_name=NULL,logo_content_type=NULL,logo_updated_at=NULL,
        version=version+1,updated_at=? WHERE id=1`).run(now());
      audit(db, req.user.id, 'gym.logo_remove', '1', before, settingsRow(db), now(), 'gym');
    });
    logoStore?.remove(previous);
    res.json(await view());
  });
}
