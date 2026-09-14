// Storing payment slips.
//
// A slip shows the payer's name, part of an account number, an amount and a
// time. That is personal data, so the bytes never go anywhere a URL can reach
// them: they are written outside the web root under a server-chosen name and
// only handed out through an authenticated route.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_SLIP_BYTES = 5 * 1024 * 1024;

/**
 * What the file actually is, judged by its leading bytes. The declared
 * content-type and the file extension are both attacker-controlled, so neither
 * is consulted here.
 */
export function detectImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', ext: 'png' };
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { type: 'image/webp', ext: 'webp' };
  }
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return { type: 'image/heic', ext: 'heic', unsupported: true };
    }
  }
  return null;
}

/**
 * Drops the JPEG segments that carry EXIF, XMP and Photoshop metadata — which
 * is where the GPS coordinates of the customer's home would otherwise sit.
 * JFIF and the ICC colour profile are kept so the image still renders correctly.
 */
function stripJpegMetadata(buffer) {
  const out = [buffer.subarray(0, 2)];
  let index = 2;
  while (index + 4 <= buffer.length) {
    if (buffer[index] !== 0xff) break;
    const marker = buffer[index + 1];
    // Start of scan: everything from here on is entropy-coded image data.
    if (marker === 0xda) { out.push(buffer.subarray(index)); return Buffer.concat(out); }
    const length = buffer.readUInt16BE(index + 2);
    if (length < 2 || index + 2 + length > buffer.length) break;
    const metadata = marker === 0xe1 || marker === 0xed || marker === 0xef;
    if (!metadata) out.push(buffer.subarray(index, index + 2 + length));
    index += 2 + length;
  }
  // Anything we could not parse is left untouched rather than half-rewritten.
  return index === 2 ? buffer : Buffer.concat([...out, buffer.subarray(index)]);
}

/** Removes the EXIF and XMP chunks from a RIFF/WebP container. */
function stripWebpMetadata(buffer) {
  const chunks = [];
  let index = 12;
  let changed = false;
  while (index + 8 <= buffer.length) {
    const name = buffer.subarray(index, index + 4).toString('latin1');
    const size = buffer.readUInt32LE(index + 4);
    const padded = size + (size % 2);
    if (index + 8 + padded > buffer.length) break;
    if (name === 'EXIF' || name === 'XMP ') changed = true;
    else chunks.push(buffer.subarray(index, index + 8 + padded));
    index += 8 + padded;
  }
  if (!changed) return buffer;
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

export function stripMetadata(buffer, type) {
  if (type === 'image/jpeg') return stripJpegMetadata(buffer);
  if (type === 'image/webp') return stripWebpMetadata(buffer);
  return buffer;
}

/**
 * Also holds member photographs, which need exactly the same treatment: judged
 * by their leading bytes rather than their name, stripped of the GPS
 * coordinates the camera wrote into them, stored outside the web root under a
 * name the server chose, and only ever served through a route that checks who
 * is asking. A second class would have been the same class.
 */
export class SlipStore {
  /**
   * @param {string} root directory outside the web root, e.g. ./data/slips
   * @param {{maxBytes?: number}} [options]
   */
  constructor(root, { maxBytes = MAX_SLIP_BYTES } = {}) {
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    mkdirSync(this.root, { recursive: true });
  }

  /**
   * Validates, cleans and writes the upload. The name is generated here; the
   * name the browser sent is never used, so `../../etc/passwd.jpg` is not a
   * path this code can be talked into.
   */
  save(buffer) {
    if (!buffer?.length) throw new SlipError('ไฟล์ว่างเปล่า กรุณาเลือกรูปสลิปอีกครั้ง');
    if (buffer.length > this.maxBytes) {
      throw new SlipError(`ไฟล์ใหญ่เกิน ${Math.floor(this.maxBytes / 1024 / 1024)} MB กรุณาถ่ายใหม่หรือย่อรูปก่อนอัปโหลด`);
    }
    const detected = detectImageType(buffer);
    if (detected?.unsupported) {
      throw new SlipError('ไฟล์ HEIC ของ iPhone ยังเปิดดูไม่ได้ในหน้าตรวจสอบ กรุณาเลือกรูปอีกครั้งผ่านปุ่มอัปโหลด (iPhone จะแปลงเป็น JPG ให้อัตโนมัติ) หรือตั้งค่า กล้อง › รูปแบบ › รองรับมากที่สุด');
    }
    if (!detected) throw new SlipError('รองรับเฉพาะรูปภาพ JPG, PNG และ WEBP เท่านั้น');

    const cleaned = stripMetadata(buffer, detected.type);
    const storedName = `${randomUUID()}.${detected.ext}`;
    writeFileSync(join(this.root, storedName), cleaned);
    return {
      storedName,
      contentType: detected.type,
      byteSize: cleaned.length,
      // Hashing the cleaned bytes keeps the duplicate check stable: the same
      // photo uploaded twice is byte-identical after metadata is removed.
      fileHash: createHash('sha256').update(cleaned).digest('hex'),
    };
  }

  read(storedName) {
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storedName)) throw new SlipError('ชื่อไฟล์ไม่ถูกต้อง');
    return readFileSync(join(this.root, storedName));
  }

  remove(storedName) {
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storedName)) return;
    rmSync(join(this.root, storedName), { force: true });
  }
}

export class SlipError extends Error {}
