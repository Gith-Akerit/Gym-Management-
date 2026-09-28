// The gym's colours and logo, on the server side.
//
// The colour arithmetic itself is NOT here. It lives in `shared/brand.cjs` --
// the Designer's file, lifted whole -- because the settings screen previews a
// colour live in the browser while the card is drawn here, and two copies of a
// formula is two answers to "what colour is our green". That file runs in both
// places unchanged; this one is the part that needs a database row, a file on
// disk and an image decoder.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** One formula, both sides. See shared/brand.cjs for the rules themselves. */
export const Brand = require('../shared/brand.cjs');

/** The green the app shipped with, and what an empty gym gets. */
export const DEFAULT_PRIMARY = '#05603A';
/** Below this a colour cannot carry text, whichever ink is used. */
export const MIN_CONTRAST = 4.5;

export const { contrast: contrastRatio, mix, logoNeedsPlate } = Brand;
export const luminance = hex => Brand.relLum(Brand.hexToRgb(hex));
export const readableInk = Brand.onBrand;

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const short = /^#?([0-9a-fA-F]{3})$/.exec(text);
  if (short) return `#${[...short[1]].map(c => c + c).join('').toUpperCase()}`;
  const full = /^#?([0-9a-fA-F]{6})$/.exec(text);
  return full ? `#${full[1].toUpperCase()}` : null;
}

/**
 * The eight tokens a screen or a card needs, from one stored row.
 *
 * Names are the Designer's, and so is every number: this function chooses
 * nothing, it only reads the row and hands it to `Brand.deriveAll`.
 *
 * `--brand` is the colour the owner actually picked and is never painted on
 * anything -- it exists so the settings screen can show it back to them. What
 * gets painted is `brand_surface`, which is the same colour nudged only as far
 * as it has to be for the text on it to be readable.
 *
 * @param {object|null} settings row from `gym_settings`
 */
export function resolveTheme(settings) {
  const picked = normalizeHex(settings?.color_primary) ?? DEFAULT_PRIMARY;
  const secondary = normalizeHex(settings?.color_secondary);
  const derived = Brand.deriveAll(picked, secondary);
  const adjusted = derived.brandSurface !== derived.brand;
  return {
    brand: derived.brand,
    brand_surface: derived.brandSurface,
    on_brand: derived.onBrand,
    brand_ink: derived.brandInk,
    brand_soft: derived.brandSoft,
    brand_line: derived.brandLine,
    brand_2: derived.brand2,
    on_brand_2: derived.onBrand2,
    // The five numbers the settings screen shows as a table. Sent rather than
    // recomputed so the owner is looking at what the server actually used.
    ratios: derived.ratios,
    notes: derived.notes,
    // Kept for the screens that only want one sentence. Nothing is refused for
    // it: it is the gym's own sign, and being told is the point.
    warning: adjusted
      ? `สีนี้อ่านยากเมื่อใช้เป็นพื้น ระบบจึงใช้ ${derived.brandSurface} เฉพาะตอนเป็นพื้นปุ่มและหัวบัตร `
        + `สีที่คุณเลือก (${derived.brand}) ยังอยู่ครบในที่อื่น`
      : (derived.notes[0] ? `${derived.notes[0].title} — ${derived.notes[0].body}` : null),
    appbar: settings?.appbar_style === 'brand' ? 'brand' : 'light',
  };
}

// ------------------------------------------------------------------- the logo

/** A logo is a sign, not a photograph: small, and kept lossless for its edges. */
export const LOGO_MAX_EDGE = 512;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const drawing = () => { try { return require('@napi-rs/canvas'); } catch { return null; } };

export class LogoUnreadableError extends Error {}

/**
 * Checks the uploaded logo opens, and trims it to a sensible size.
 *
 * The same door check the member photograph gets (QA PHOTO-03): leading bytes
 * are not enough, because a file cut off halfway still starts like a PNG and
 * would then break the card for every member at once rather than for one.
 *
 * Re-encoded as PNG rather than JPEG -- a logo is usually flat colour with a
 * transparent background, and JPEG would give it a white box and fuzzy edges.
 */
export async function prepareLogo(buffer) {
  if (!buffer?.length) return buffer;
  const canvasLib = drawing();
  if (!canvasLib) return buffer;

  let image;
  try { image = await canvasLib.loadImage(buffer); } catch { image = null; }
  if (!image?.width || !image?.height) {
    throw new LogoUnreadableError(
      'ไฟล์โลโก้นี้เปิดไม่ได้ อาจอัปโหลดไม่ครบหรือไฟล์เสียหาย กรุณาเลือกไฟล์ PNG หรือ JPG อีกครั้ง');
  }
  const longest = Math.max(image.width, image.height);
  if (longest <= LOGO_MAX_EDGE) return buffer;
  try {
    const scale = LOGO_MAX_EDGE / longest;
    const canvas = canvasLib.createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvas.encode('png');
  } catch { return buffer; }
}

/**
 * The colours in a logo, and its average colour.

 * Same steps and the same constants as `Brand.extractPalette`, which cannot be
 * used here because it reaches for `document`: shrink to 120px, drop anything
 * transparent, near-white or near-black, bin four bits per channel, then merge
 * anything closer than 60 in Manhattan distance so orange and yellow survive as
 * two colours (Designer, ข้อ 7).
 *
 * The average is not for showing: it is what decides whether the logo needs a
 * white plate behind it on the card.
 *
 * @returns {Promise<{colors: string[], avg: string|null}>}
 */
export async function paletteFrom(buffer, want = 4) {
  const canvasLib = drawing();
  if (!canvasLib || !buffer?.length) return { colors: [], avg: null };
  try {
    const image = await canvasLib.loadImage(buffer);
    if (!image.width || !image.height) return { colors: [], avg: null };
    const side = 120;
    const scale = Math.min(side / image.width, side / image.height, 1);
    const canvas = canvasLib.createCanvas(
      Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const bins = new Map();
    const total = [0, 0, 0];
    let seen = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at + 3] < 200) continue;
      const [r, g, b] = [data[at], data[at + 1], data[at + 2]];
      total[0] += r; total[1] += g; total[2] += b; seen += 1;
      const lum = Brand.relLum([r, g, b]);
      if (lum > 0.90 || lum < 0.02) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const found = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      found.n += 1; found.r += r; found.g += g; found.b += b;
      bins.set(key, found);
    }
    const ranked = [...bins.values()]
      .sort((a, b) => b.n - a.n)
      .map(({ n, r, g, b }) => Brand.rgbToHex([r / n, g / n, b / n]));

    const colors = [];
    for (const hex of ranked) {
      if (colors.length >= want) break;
      const [r, g, b] = Brand.hexToRgb(hex);
      const tooClose = colors.some(other => {
        const [x, y, z] = Brand.hexToRgb(other);
        return Math.abs(r - x) + Math.abs(g - y) + Math.abs(b - z) < 60;
      });
      if (!tooClose) colors.push(hex);
    }
    return { colors, avg: seen ? Brand.rgbToHex(total.map(sum => sum / seen)) : null };
  } catch { return { colors: [], avg: null }; }
}
