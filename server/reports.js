// Turning a screenshot from a browser into something safe to keep.
//
// What arrives is whatever the tab could draw of itself: a PNG that can be two
// or three hundred kilobytes of a screen nobody will ever zoom into. What is
// kept is a JPEG no wider than 1280, which is enough to read a Thai sentence
// in a form field and about a tenth of the size. On a one-gigabyte volume
// shared with the database, the member photographs and the payment slips, that
// difference is the difference between keeping six months of reports and
// keeping none.

import { detectImageType } from './slips.js';

/** The widest a kept screenshot gets. A 4K desktop is scaled down to this. */
export const REPORT_MAX_EDGE = 1280;
/** What the browser may send before the door shuts. */
export const MAX_REPORT_BYTES = 6 * 1024 * 1024;
/** Kept for half a year, then deleted along with the row that points at it. */
export const REPORT_RETENTION_DAYS = 180;

/** Loaded the same way the card renderer loads it: absent is not fatal. */
async function drawing() {
  try { return await import('@napi-rs/canvas'); } catch { return null; }
}

export class UnreadableScreenshot extends Error {}

/**
 * Opens the screenshot, scales it down and re-encodes it as JPEG.
 *
 * Opened for real rather than sniffed, for the same reason the member
 * photograph is (QA PHOTO-03): a file that was cut off in transit still starts
 * with the right bytes, and a report whose picture cannot be drawn is a report
 * the owner opens to a broken image on the day they most need to read it.
 */
export async function prepareScreenshot(buffer) {
  if (!buffer?.length) throw new UnreadableScreenshot('ไฟล์ภาพว่างเปล่า');
  if (buffer.length > MAX_REPORT_BYTES) {
    throw new UnreadableScreenshot(
      `ภาพหน้าจอใหญ่เกิน ${Math.round(MAX_REPORT_BYTES / 1024 / 1024)} MB กรุณาส่งเรื่องโดยไม่แนบภาพ`);
  }
  if (!detectImageType(buffer)) throw new UnreadableScreenshot('ไฟล์นี้ไม่ใช่รูปภาพ');

  const canvasLib = await drawing();
  // No canvas means no way to check or shrink it. Keeping the original is
  // better than losing the report: the door already checked the size.
  if (!canvasLib) return { bytes: buffer, contentType: 'image/png' };

  let image;
  try { image = await canvasLib.loadImage(buffer); } catch { image = null; }
  if (!image?.width || !image?.height) {
    throw new UnreadableScreenshot('ภาพหน้าจอนี้เปิดไม่ได้ อาจส่งไม่ครบ กรุณาส่งเรื่องโดยไม่แนบภาพ');
  }
  const longest = Math.max(image.width, image.height);
  const scale = Math.min(1, REPORT_MAX_EDGE / longest);
  const canvas = canvasLib.createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  // Quality 0.82: a screen is flat colour and text, which JPEG keeps legible
  // well below the point where the file stops shrinking.
  return { bytes: await canvas.encode('jpeg', 82), contentType: 'image/jpeg' };
}

/** A user agent, cut to the part that says which browser on which machine. */
export const shortAgent = (value = '') => String(value).replace(/\s+/g, ' ').trim().slice(0, 200);
