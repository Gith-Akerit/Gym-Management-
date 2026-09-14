// The membership card.
//
// The card is the whole of what a member holds: one picture in a chat app.
// It has to do three jobs at once -- scan from a phone screen held at arm's
// length, say whose it is at a glance, and look like something worth keeping --
// so it is drawn here, on the server, from the member's own row. Nothing about
// the drawing is trusted: the only thing the scanner reads is the token, and
// the token is signed.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);

// ------------------------------------------------------------------ the token

const PREFIX = 'GYMCARD1';
const compact = uuid => uuid.replaceAll('-', '').toLowerCase();

/**
 * `GYMCARD1.<member>.<card version>.<signature>`
 *
 * Deliberately not a database row. A card lives in somebody's photo album for
 * years; a row that had to survive that long to keep the card working is a row
 * that gets pruned by accident one day. The signature covers the version, so
 * reissuing is a counter going up rather than a search for what to delete.
 */
export const encodeCardQr = (memberId, version, signature) =>
  `${PREFIX}.${compact(memberId)}.${version}.${signature}`;

export const cardSignature = (secret, memberId, version) =>
  createHmac('sha256', secret).update(`card:${compact(memberId)}:${version}`).digest('hex').slice(0, 32);

export function decodeCardQr(raw) {
  const parts = String(raw ?? '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, member, version, signature] = parts;
  if (!/^[0-9a-f]{32}$/.test(member)) return null;
  if (!/^[1-9]\d{0,8}$/.test(version)) return null;
  if (!/^[0-9a-f]{32}$/.test(signature)) return null;
  return { member, version: Number(version), signature };
}

/** Constant time, so a wrong signature cannot be found by timing the reply. */
export function cardSignatureMatches(secret, memberId, version, signature) {
  const expected = cardSignature(secret, memberId, version);
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export const cardQrFor = (secret, member) =>
  encodeCardQr(member.id, member.card_version, cardSignature(secret, member.id, member.card_version));

// ----------------------------------------------------------------- the design

/**
 * Every number the drawing uses, in one place, at the size the file is written.
 * 1080 × 1350 is 4:5 -- the tallest a picture can be before a chat app crops
 * it in the timeline -- so the QR arrives already filling the screen and
 * nobody has to open it before holding it up (Designer, แบบ 2).
 */
export const CARD = {
  width: 1080,
  height: 1350,
  background: '#0F4038',
  panel: '#FFFFFF',
  ink: '#172B36',
  muted: '#52616B',
  onDark: '#FFFFFF',
  onDarkMuted: '#BCD3CC',
  footer: '#0B2A24',
  accent: '#C9A227',
  photo: { x: 96, y: 108, size: 232 },
  name: { x: 372, y: 196, size: 62, max: 612 },
  code: { x: 372, y: 262, size: 34 },
  qr: { x: 220, y: 400, size: 640, quiet: 28 },
  footerTop: 1150,
};

let fonts = null;
/**
 * Noto Sans Thai, bundled through npm rather than taken from whatever the
 * machine happens to have installed: the card must come out the same from a
 * developer's laptop, the test suite and the gym's server, and a Thai name
 * rendered in a font without Thai glyphs is a row of empty boxes.
 */
function registerFonts(GlobalFonts) {
  if (fonts) return fonts;
  const file = (subset, weight) => require.resolve(
    `@fontsource/noto-sans-thai/files/noto-sans-thai-${subset}-${weight}-normal.woff`);
  GlobalFonts.registerFromPath(file('thai', 700), 'GymCardThai');
  GlobalFonts.registerFromPath(file('latin', 700), 'GymCardLatin');
  GlobalFonts.registerFromPath(file('thai', 400), 'GymCardThaiBook');
  GlobalFonts.registerFromPath(file('latin', 400), 'GymCardLatinBook');
  fonts = {
    bold: size => `${size}px GymCardThai, GymCardLatin`,
    book: size => `${size}px GymCardThaiBook, GymCardLatinBook`,
  };
  return fonts;
}

/** Trims to the width available and marks the cut, rather than running off. */
function fitted(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** 0863307368 reads as a number; 086-330-7368 reads as a phone. */
const prettyPhone = value => value.replace(/^(0\d{1,2})(\d{3})(\d{3,4})$/, '$1-$2-$3');

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws the card.
 *
 * @param {object} member  row from `members`
 * @param {object} gym     gym profile row
 * @param {string} qr      the signed token the QR encodes
 * @param {Buffer|null} photo  the member's photograph, already read from disk
 * @param {string} subtitle    package and expiry, or why there is none
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderCard({ member, gym, qr, photo, subtitle }) {
  // Loaded here rather than at the top of the file: a machine without a build
  // of the drawing library should still be able to run the counter, scan
  // members in and take money. Only the card is unavailable, and it says so.
  let canvasLib;
  try { canvasLib = require('@napi-rs/canvas'); }
  catch { throw new CardRenderError('เครื่องนี้ยังสร้างรูปบัตรไม่ได้ กรุณาติดตั้ง dependency ให้ครบแล้วลองใหม่'); }
  const { createCanvas, loadImage, GlobalFonts } = canvasLib;
  const font = registerFonts(GlobalFonts);

  const canvas = createCanvas(CARD.width, CARD.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = CARD.background;
  ctx.fillRect(0, 0, CARD.width, CARD.height);
  // A thin gold rule along the top: enough to read as a card rather than a
  // screenshot, and it costs no room the QR wanted.
  ctx.fillStyle = CARD.accent;
  ctx.fillRect(0, 0, CARD.width, 10);

  // --- the face ------------------------------------------------------------
  const { x: px, y: py, size: ps } = CARD.photo;
  ctx.save();
  ctx.beginPath();
  ctx.arc(px + ps / 2, py + ps / 2, ps / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = '#12352D';
  ctx.fillRect(px, py, ps, ps);
  if (photo) {
    const image = await loadImage(photo);
    // Cover, not stretch: a face squashed to a square is not a face anybody
    // can check against the person in front of them.
    const scale = Math.max(ps / image.width, ps / image.height);
    const w = image.width * scale, h = image.height * scale;
    ctx.drawImage(image, px + (ps - w) / 2, py + (ps - h) / 2, w, h);
  } else {
    ctx.fillStyle = CARD.onDarkMuted;
    ctx.font = font.bold(64);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ไม่มีรูป', px + ps / 2, py + ps / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  ctx.strokeStyle = CARD.accent;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(px + ps / 2, py + ps / 2, ps / 2, 0, Math.PI * 2);
  ctx.stroke();

  // --- name and code -------------------------------------------------------
  ctx.fillStyle = CARD.onDark;
  ctx.font = font.bold(CARD.name.size);
  ctx.fillText(fitted(ctx, member.name, CARD.name.max), CARD.name.x, CARD.name.y);
  ctx.fillStyle = CARD.onDarkMuted;
  ctx.font = font.book(CARD.code.size);
  ctx.fillText(member.member_code, CARD.code.x, CARD.code.y);

  // --- the QR --------------------------------------------------------------
  // Drawn from the module matrix rather than scaled from a rendered image, so
  // every module lands on a whole pixel and the camera sees hard edges.
  const { x: qx, y: qy, size: qs, quiet } = CARD.qr;
  ctx.fillStyle = CARD.panel;
  roundedRect(ctx, qx - quiet, qy - quiet, qs + quiet * 2, qs + quiet * 2, 28);
  ctx.fill();
  const matrix = QRCode.create(qr, { errorCorrectionLevel: 'M' }).modules;
  const cell = Math.floor(qs / matrix.size);
  const offset = Math.round((qs - cell * matrix.size) / 2);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.data[row * matrix.size + col]) {
        ctx.fillRect(qx + offset + col * cell, qy + offset + row * cell, cell, cell);
      }
    }
  }

  // --- what the member reads ----------------------------------------------
  ctx.fillStyle = CARD.onDark;
  ctx.font = font.book(32);
  ctx.textAlign = 'center';
  ctx.fillText(fitted(ctx, 'ยื่นบัตรนี้ให้พนักงานสแกน', 900), CARD.width / 2, qy + qs + 78);

  // --- the gym -------------------------------------------------------------
  ctx.fillStyle = CARD.footer;
  ctx.fillRect(0, CARD.footerTop, CARD.width, CARD.height - CARD.footerTop);
  ctx.fillStyle = CARD.onDark;
  ctx.font = font.bold(42);
  ctx.fillText(fitted(ctx, gym?.brand_name_th || gym?.name || 'ยิม', 960), CARD.width / 2, CARD.footerTop + 66);
  ctx.fillStyle = CARD.onDarkMuted;
  ctx.font = font.book(30);
  ctx.fillText(fitted(ctx, subtitle, 960), CARD.width / 2, CARD.footerTop + 114);
  const phone = gym?.phone_display === 'hidden' ? ''
    : (gym?.phone_display === 'secondary' ? gym?.phone_secondary : gym?.phone_primary) || '';
  if (phone) {
    ctx.font = font.book(28);
    ctx.fillText(`โทร ${prettyPhone(phone)}`, CARD.width / 2, CARD.footerTop + 158);
  }
  ctx.textAlign = 'left';

  return canvas.encode('png');
}

export class CardRenderError extends Error {}
