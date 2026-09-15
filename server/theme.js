// The gym's colours, worked out once and used everywhere.
//
// The owner picks one colour off their own sign. Everything else -- the second
// colour, the colour of the text on top, whether the whole thing is legible at
// all -- is arithmetic, and it is done here rather than in the browser so the
// card drawn on the server and the screen drawn in the browser cannot drift
// apart. A card is a picture somebody keeps for a year; it has to match the app
// it came from.
//
// Contrast is WCAG 2.x: the same rule the browser suite measures against, so a
// colour that fails here is a colour the tests would have caught anyway.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The green the app shipped with, and what an empty gym gets. */
export const DEFAULT_PRIMARY = '#05603A';
/** Ink used when white would be the worse of the two on a pale colour. */
export const DARK_INK = '#0E1418';
export const LIGHT_INK = '#FFFFFF';
/** Below this a colour is not usable as a background for either ink. */
export const MIN_CONTRAST = 4.5;

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const short = /^#?([0-9a-fA-F]{3})$/.exec(text);
  if (short) return `#${[...short[1]].map(c => c + c).join('').toUpperCase()}`;
  const full = /^#?([0-9a-fA-F]{6})$/.exec(text);
  return full ? `#${full[1].toUpperCase()}` : null;
}

export const toRgb = hex => {
  const clean = normalizeHex(hex) ?? DEFAULT_PRIMARY;
  return [1, 3, 5].map(at => parseInt(clean.slice(at, at + 2), 16));
};

const toHex = ([r, g, b]) => `#${[r, g, b]
  .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
  .join('').toUpperCase()}`;

/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [first, second] = [luminance(a), luminance(b)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Black or white on this colour, whichever a person can actually read.
 *
 * Not a lightness threshold: two colours with the same lightness can need
 * different ink, and the only question that matters is which of the two wins
 * the contrast ratio.
 */
export const readableInk = background =>
  (contrastRatio(background, LIGHT_INK) >= contrastRatio(background, DARK_INK) ? LIGHT_INK : DARK_INK);

/** Moves a colour towards black (negative) or white (positive). */
export function shade(hex, amount) {
  const target = amount < 0 ? 0 : 255;
  const mix = Math.min(1, Math.abs(amount));
  return toHex(toRgb(hex).map(value => value + (target - value) * mix));
}

/**
 * A companion colour, when the owner did not name one.
 *
 * Darker for a light primary and lighter for a dark one, so the pair always
 * reads as the same colour twice rather than two unrelated colours, and the
 * darker of the two is always the one that can carry white text.
 */
export const deriveSecondary = primary =>
  (luminance(primary) > 0.3 ? shade(primary, -0.45) : shade(primary, 0.28));

/**
 * The same colour, darkened a step at a time until it can be read on `over`.
 *
 * Stops at near-black rather than giving up: something has to be legible, and
 * a very dark version of the gym's own colour is closer to what they meant
 * than falling back to the app's default green would be.
 */
export function darkenUntilReadable(hex, over, target = MIN_CONTRAST) {
  let colour = normalizeHex(hex) ?? DEFAULT_PRIMARY;
  for (let step = 0; step < 12 && contrastRatio(colour, over) < target; step += 1) {
    colour = shade(colour, -0.12);
  }
  return contrastRatio(colour, over) >= target ? colour : DARK_INK;
}

/**
 * Everything the app and the card need, from one stored row.
 *
 * `warning` is filled in when the chosen colour is one that neither white nor
 * black sits comfortably on. Nothing is refused for it -- it is the owner's
 * sign and they know what it looks like -- but the screen says so, and the
 * ink is still the better of the two.
 *
 * @param {object|null} settings row from `gym_settings`
 * @returns {{primary: string, secondary: string, on_primary: string,
 *   on_secondary: string, contrast: number, warning: string|null}}
 */
export function resolveTheme(settings) {
  const primary = normalizeHex(settings?.color_primary) ?? DEFAULT_PRIMARY;
  const secondary = normalizeHex(settings?.color_secondary) ?? deriveSecondary(primary);
  const contrast = Math.round(contrastRatio(primary, readableInk(primary)) * 100) / 100;
  const soft = shade(primary, 0.88);
  return {
    primary,
    secondary,
    on_primary: readableInk(primary),
    on_secondary: readableInk(secondary),
    // The pale version, for the background of a chip or a chosen row, and a
    // version of the colour dark enough to be read on top of it. A gym whose
    // colour is a light yellow gets a dark yellow to write with rather than
    // yellow-on-cream, which is how brand colours usually go wrong.
    soft,
    ink: darkenUntilReadable(primary, soft),
    hover: shade(primary, luminance(primary) > 0.5 ? 0.18 : -0.22),
    contrast,
    warning: contrast < MIN_CONTRAST
      ? `สีนี้อ่านยาก ตัวอักษรบนสีนี้ได้ค่าความต่างเพียง ${contrast}:1 (ควรอย่างน้อย ${MIN_CONTRAST}:1) `
        + 'ลองเลือกสีที่เข้มขึ้นหรืออ่อนลงจากโลโก้'
      : null,
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
 * The colours actually used in a logo, most-used first.
 *
 * Picking a colour by eye off a screen is the step where owners give up, so
 * the upload answers the question for them. Pixels are bucketed coarsely --
 * a logo is flat colour, and exact shades are noise from anti-aliased edges --
 * and three kinds of pixel are thrown away first: transparent ones, the
 * near-white and near-black that every logo is mostly made of, and greys,
 * which are never what somebody means by "our colour".
 *
 * @param {Buffer} buffer the logo as stored
 * @param {number} count how many to hand back
 * @returns {Promise<string[]>} hex colours, most used first
 */
export async function paletteFrom(buffer, count = 4) {
  const canvasLib = drawing();
  if (!canvasLib || !buffer?.length) return [];
  try {
    const image = await canvasLib.loadImage(buffer);
    if (!image.width || !image.height) return [];
    const side = 72;
    const canvas = canvasLib.createCanvas(side, side);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, side, side);
    const { data } = ctx.getImageData(0, 0, side, side);

    const buckets = new Map();
    for (let at = 0; at < data.length; at += 4) {
      const [r, g, b, alpha] = [data[at], data[at + 1], data[at + 2], data[at + 3]];
      if (alpha < 200) continue;
      const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
      if (max > 240 && min > 240) continue;                  // the paper it sits on
      if (max < 24) continue;                                // the outline
      if (max - min < 18 && max > 60 && max < 200) continue; // grey is not a brand colour
      // 32-level buckets: two shades of the same green count as one colour.
      const key = [r, g, b].map(value => Math.round(value / 32) * 32).join(',');
      const found = buckets.get(key) ?? { total: [0, 0, 0], n: 0 };
      found.total = [found.total[0] + r, found.total[1] + g, found.total[2] + b];
      found.n += 1;
      buckets.set(key, found);
    }
    return [...buckets.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, count)
      // The average of the bucket, not its centre: closer to the colour the
      // owner would name if they had the file open in front of them.
      .map(({ total, n }) => toHex(total.map(sum => sum / n)));
  } catch { return []; }
}
