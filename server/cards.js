// The membership card.
//
// The card is the whole of what a member holds: one picture in a chat app.
// It has to do three jobs at once -- scan from a phone screen held at arm's
// length, say whose it is at a glance, and look like something worth keeping --
// so it is drawn here, on the server, from the member's own row. Nothing about
// the drawing is trusted: the only thing the scanner reads is the token, and
// the token is signed.
//
// Every coordinate below comes from the Designer's spec, which was measured off
// the rendered prototype rather than estimated. They are gathered in CARD so a
// change to the design is a change to one object.

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
 *
 * Nothing readable goes in. The picture gets forwarded around chat groups, and
 * a name or a phone number in the payload is a name or a phone number any
 * scanner app can read off it (Designer).
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
 * Every number the drawing uses, at the size the file is written.
 *
 * 1080 × 1350 is 4:5 -- the tallest a picture can be before a chat app crops it
 * in the timeline -- so the QR arrives already filling the screen and nobody has
 * to open it before holding it up. Changing this ratio throws away the whole
 * point of the design (Designer, สเปคบัตร).
 */
export const CARD = {
  width: 1080,
  height: 1350,
  margin: 56,
  background: '#FFFFFF',
  green: '#05603A',
  ink: '#0E1418',
  ink2: '#3D4852',
  panel: '#E4E9ED',
  panelFg: '#98A5AF',
  white: '#FFFFFF',
  qrDark: '#0A0F0C',
  header: { height: 150 },
  logo: { x: 56, y: 38, size: 74, radius: 20, font: 27 },
  gymTh: { x: 152, y: 38, size: 42, max: 872 },
  gymEn: { x: 152, y: 89, size: 19, tracking: 0.2, max: 872 },
  photo: { x: 56, y: 188, size: 232, ring: 7 },
  eyebrow: { x: 324, y: 216, size: 24 },
  name: { x: 324, y: 259, size: 64, min: 44, step: 4, max: 700, lineHeight: 1.15 },
  code: { x: 324, y: 341, size: 30, tracking: 0.09 },
  qr: { x: 220, y: 468, size: 640, border: 6, radius: 26, padding: 22 },
  caption: { y: 1124, size: 32 },
  footer: { y: 1198, height: 152, top: 1216, size: 26, labelSize: 22, telY: 1291, telSize: 21 },
  /** The face is scaled to this before it is drawn, so the file stays sendable. */
  photoMaxEdge: 700,
  void: { text: 'ยกเลิกแล้ว', size: 150, angle: -24, fill: 'rgba(155,28,19,0.26)', qrOpacity: 0.35 },
};

let fonts = null;
/**
 * Noto Sans Thai and IBM Plex Sans, bundled through npm rather than taken from
 * whatever the machine happens to have installed: the card must come out the
 * same from a developer's laptop, the test suite and the gym's server, and a
 * Thai name rendered in a font without Thai glyphs is a row of empty boxes.
 */
function registerFonts(GlobalFonts) {
  if (fonts) return fonts;
  const thai = weight => require.resolve(`@fontsource/noto-sans-thai/files/noto-sans-thai-thai-${weight}-normal.woff`);
  const latin = weight => require.resolve(`@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff`);
  for (const weight of [400, 600, 700, 800]) GlobalFonts.registerFromPath(thai(weight), `CardThai${weight}`);
  for (const weight of [400, 500, 600, 700]) GlobalFonts.registerFromPath(latin(weight), `CardPlex${weight}`);
  // Thai first in every stack: Latin letters exist in both, Thai only in one,
  // and a fallback that never reaches the Thai face loses the tone marks.
  fonts = {
    th: (size, weight = 400) => `${size}px CardThai${weight}, CardPlex${weight === 800 ? 700 : weight}`,
    num: (size, weight = 500) => `${size}px CardPlex${weight}, CardThai400`,
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

/**
 * Shrinks the font a step at a time until the name fits, and only then cuts it.
 * A long Thai name at 44px is still legible across a counter; the same name cut
 * to "ประกายแก้ว เจริญ…" is a different person's card as far as the staff member
 * holding it is concerned.
 */
function fitName(ctx, font, text, { size, min, step, max }) {
  for (let current = size; current >= min; current -= step) {
    ctx.font = font.th(current, 800);
    if (ctx.measureText(text).width <= max) return { text, size: current };
  }
  ctx.font = font.th(min, 800);
  return { text: fitted(ctx, text, max), size: min };
}

/** 0863307368 reads as a number; 086-330-7368 reads as a phone. */
const prettyPhone = value => String(value ?? '').replace(/^(0\d{1,2})(\d{3})(\d{3,4})$/, '$1-$2-$3');

/** The two Thai initials the gym's own name starts with, for the logo box. */
export function logoInitials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'ยม';
  if (words.length === 1) return words[0].slice(0, 2);
  return words[0][0] + words[1][0];
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws text letter by letter so a tracking value can be honoured. */
function trackedText(ctx, text, x, y, tracking) {
  const extra = tracking * parseFloat(ctx.font);
  let cursor = x;
  for (const character of [...text]) {
    ctx.fillText(character, cursor, y);
    cursor += ctx.measureText(character).width + extra;
  }
  return cursor - x - extra;
}

/**
 * Draws the card.
 *
 * @param {object} member  row from `members`
 * @param {object} gym     gym profile row
 * @param {string} qr      the signed token the QR encodes
 * @param {Buffer|null} photo  the member's photograph, already read from disk
 * @param {{package?: string, expires?: string}} membership  what the footer says
 * @param {boolean} voided draw the cancelled version, for the history screen
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderCard({ member, gym, qr, photo, membership = {}, voided = false }) {
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
  ctx.textBaseline = 'top';
  ctx.fillStyle = CARD.background;
  ctx.fillRect(0, 0, CARD.width, CARD.height);

  // --- header --------------------------------------------------------------
  ctx.fillStyle = CARD.green;
  ctx.fillRect(0, 0, CARD.width, CARD.header.height);
  const { x: lx, y: ly, size: ls, radius: lr } = CARD.logo;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundedRect(ctx, lx, ly, ls, ls, lr);
  ctx.fill();
  ctx.fillStyle = CARD.white;
  ctx.font = font.th(CARD.logo.font, 800);
  const initials = logoInitials(gym?.brand_name_th || gym?.name);
  ctx.fillText(initials, lx + (ls - ctx.measureText(initials).width) / 2, ly + (ls - CARD.logo.font * 1.35) / 2 + 4);

  ctx.font = font.th(CARD.gymTh.size, 800);
  ctx.fillText(fitted(ctx, gym?.brand_name_th || gym?.name || 'ยิม', CARD.gymTh.max), CARD.gymTh.x, CARD.gymTh.y);
  if (gym?.name) {
    ctx.font = font.num(CARD.gymEn.size, 500);
    ctx.globalAlpha = 0.8;
    trackedText(ctx, fitted(ctx, gym.name.toUpperCase(), CARD.gymEn.max), CARD.gymEn.x, CARD.gymEn.y, CARD.gymEn.tracking);
    ctx.globalAlpha = 1;
  }

  // --- the face ------------------------------------------------------------
  const { x: px, y: py, size: ps, ring } = CARD.photo;
  const radius = ps / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(px + radius, py + radius, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = CARD.panel;
  ctx.fillRect(px, py, ps, ps);
  if (photo) {
    const image = await loadImage(photo);
    // Cover, not stretch: a face squashed to a square is not a face anybody
    // can check against the person in front of them.
    const scale = Math.max(ps / image.width, ps / image.height);
    const w = image.width * scale, h = image.height * scale;
    ctx.drawImage(image, px + (ps - w) / 2, py + (ps - h) / 2, w, h);
  } else {
    // The grey silhouette from the prototype, not the words "no photo": the
    // card goes to a member, and a member should not be told off by it.
    ctx.fillStyle = CARD.panelFg;
    ctx.beginPath();
    ctx.arc(px + radius, py + ps * 0.36, ps * 0.168, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(px + radius, py + ps * 1.02, ps * 0.34, ps * 0.30, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = CARD.green;
  ctx.lineWidth = ring;
  ctx.beginPath();
  ctx.arc(px + radius, py + radius, radius - ring / 2, 0, Math.PI * 2);
  ctx.stroke();

  // --- name and code -------------------------------------------------------
  ctx.fillStyle = CARD.ink2;
  ctx.font = font.th(CARD.eyebrow.size, 600);
  ctx.fillText('บัตรสมาชิก', CARD.eyebrow.x, CARD.eyebrow.y);
  const name = fitName(ctx, font, member.name, CARD.name);
  ctx.fillStyle = CARD.ink;
  ctx.font = font.th(name.size, 800);
  ctx.fillText(name.text, CARD.name.x, CARD.name.y);
  ctx.fillStyle = CARD.ink2;
  ctx.font = font.num(CARD.code.size, 600);
  trackedText(ctx, member.member_code, CARD.code.x, CARD.code.y, CARD.code.tracking);

  // --- the QR --------------------------------------------------------------
  // Drawn from the module matrix rather than scaled from a rendered image, so
  // every module lands on a whole pixel and the camera sees hard edges. No
  // logo over the middle: it costs reads when the member's screen is dim,
  // which is the case that actually happens (Designer).
  const { x: qx, y: qy, size: qs, border, radius: qr2, padding } = CARD.qr;
  ctx.fillStyle = CARD.white;
  roundedRect(ctx, qx, qy, qs, qs, qr2);
  ctx.fill();
  ctx.strokeStyle = CARD.ink;
  ctx.lineWidth = border;
  roundedRect(ctx, qx + border / 2, qy + border / 2, qs - border, qs - border, qr2);
  ctx.stroke();

  const inner = qs - padding * 2;
  const matrix = QRCode.create(qr, { errorCorrectionLevel: 'M' }).modules;
  const cell = Math.floor(inner / matrix.size);
  const offset = Math.round((inner - cell * matrix.size) / 2);
  ctx.save();
  if (voided) ctx.globalAlpha = CARD.void.qrOpacity;
  ctx.fillStyle = CARD.qrDark;
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.data[row * matrix.size + col]) {
        ctx.fillRect(qx + padding + offset + col * cell, qy + padding + offset + row * cell, cell, cell);
      }
    }
  }
  ctx.restore();

  ctx.fillStyle = CARD.ink;
  ctx.font = font.th(CARD.caption.size, 700);
  const caption = voided ? 'บัตรใบนี้ถูกยกเลิกแล้ว' : 'ยื่นบัตรนี้ให้พนักงานสแกน';
  ctx.fillText(caption, (CARD.width - ctx.measureText(caption).width) / 2, CARD.caption.y);

  // --- the footer ----------------------------------------------------------
  const f = CARD.footer;
  ctx.fillStyle = CARD.ink;
  ctx.fillRect(0, f.y, CARD.width, f.height);
  const right = CARD.width - CARD.margin;
  const half = (CARD.width - CARD.margin * 2) / 2 - 20;
  ctx.fillStyle = CARD.white;
  ctx.globalAlpha = 0.78;
  ctx.font = font.th(f.labelSize, 400);
  ctx.fillText('แพ็กเกจ', CARD.margin, f.top);
  const validLabel = 'ใช้ได้ถึง';
  ctx.fillText(validLabel, right - ctx.measureText(validLabel).width, f.top);
  ctx.globalAlpha = 1;
  ctx.font = font.th(f.size, 700);
  ctx.fillText(fitted(ctx, membership.package ?? 'ยังไม่มีแพ็กเกจ', half), CARD.margin, f.top + 30);
  const expires = membership.expires ?? '—';
  ctx.font = font.num(f.size, 600);
  ctx.fillText(expires, right - ctx.measureText(expires).width, f.top + 30);

  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CARD.margin, f.telY - 10);
  ctx.lineTo(right, f.telY - 10);
  ctx.stroke();

  ctx.font = font.th(f.telSize, 400);
  ctx.globalAlpha = 0.78;
  const place = [gym?.brand_name_th || gym?.name, gym?.location_note].filter(Boolean).join(' · ');
  ctx.fillText(fitted(ctx, place, half + 60), CARD.margin, f.telY);
  const phone = gym?.phone_display === 'hidden' ? ''
    : (gym?.phone_display === 'secondary' ? gym?.phone_secondary : gym?.phone_primary) || '';
  if (phone) {
    const label = `โทร ${prettyPhone(phone)}`;
    ctx.fillText(label, right - ctx.measureText(label).width, f.telY);
  }
  ctx.globalAlpha = 1;

  // --- cancelled -----------------------------------------------------------
  if (voided) {
    ctx.save();
    ctx.translate(CARD.width / 2, CARD.height / 2);
    ctx.rotate((CARD.void.angle * Math.PI) / 180);
    ctx.font = font.th(CARD.void.size, 800);
    ctx.fillStyle = CARD.void.fill;
    ctx.textBaseline = 'middle';
    ctx.fillText(CARD.void.text, -ctx.measureText(CARD.void.text).width / 2, 0);
    ctx.restore();
  }

  return canvas.encode('png');
}

export class CardRenderError extends Error {}

/**
 * Shrinks a member's photograph to `CARD.photoMaxEdge` on its long side.
 *
 * A phone camera hands over four thousand pixels of a face that is drawn at
 * 232 on the card and about 300 on the scan screen. Keeping the original costs
 * megabytes on the gym's disk and a visible wait every time the counter scans
 * somebody in, and buys nothing anybody can see.
 *
 * Anything that goes wrong -- no drawing library on the machine, a format the
 * decoder will not read -- returns the bytes untouched. A member whose picture
 * is merely large is better than a signup that cannot be finished.
 *
 * @param {Buffer} buffer the uploaded image
 * @returns {Promise<Buffer>} the same image, no larger than the long edge allows
 */
export async function shrinkPhoto(buffer, maxEdge = CARD.photoMaxEdge) {
  if (!buffer?.length) return buffer;
  let canvasLib;
  try { canvasLib = require('@napi-rs/canvas'); } catch { return buffer; }
  try {
    const image = await canvasLib.loadImage(buffer);
    const longest = Math.max(image.width, image.height);
    if (!longest || longest <= maxEdge) return buffer;
    const scale = maxEdge / longest;
    const canvas = canvasLib.createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    // JPEG whatever arrived: a photograph of a face is exactly what JPEG is
    // for, and a 700px PNG of one is several times the size for no gain.
    const out = await canvas.encode('jpeg', 88);
    return out.length < buffer.length ? out : buffer;
  } catch { return buffer; }
}
