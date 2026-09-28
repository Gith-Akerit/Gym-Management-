// Keeping one secret in the database that the database is not allowed to give
// away.
//
// The gym's mailbox password has to be stored -- the system sends letters at
// three in the morning when nobody is there to type it -- and it has to be
// typed in by the owner on a screen rather than handed to a developer to put
// in a file. So it sits in a row, sealed, and the key that opens it sits in
// `.env` where the database backup does not reach. A stolen `.sqlite` file is
// then a stolen file, not a stolen mailbox.
//
// AES-256-GCM, because the tag is what makes a swapped ciphertext fail loudly
// instead of decrypting into rubbish that gets sent to an SMTP server.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** What a sealed value looks like in the column: v1.<iv>.<tag>.<ciphertext>. */
const PREFIX = 'v1';

/**
 * Reads SETTINGS_ENC_KEY into 32 bytes, or says why it cannot.
 *
 * Deliberately not thrown at boot. An installed gym that upgrades to this
 * version has no such key yet, and refusing to start would take the counter
 * down over a mailbox password nobody has typed in yet. Everything else keeps
 * working; only the mail settings screen says what is missing.
 */
export function readKey(raw = process.env.SETTINGS_ENC_KEY) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  // Hex is what the documented one-liner produces; base64 is what somebody
  // pasting from a password manager tends to produce. Both are accepted, and
  // anything that is not 32 bytes is refused rather than padded.
  const bytes = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  return bytes.length === 32 ? bytes : null;
}

export const hasKey = () => readKey() !== null;

/** A key to print into the setup instructions. Never logged, only shown once. */
export const newKey = () => randomBytes(32).toString('hex');

export function seal(plain, key = readKey()) {
  if (!key) throw new Error('SETTINGS_ENC_KEY is missing or not 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    body.toString('base64url')].join('.');
}

/**
 * Opens a sealed value, or returns null.
 *
 * Null covers every way this can go wrong -- no key, the wrong key, a row
 * written by a different install, a truncated column -- because the caller's
 * answer is the same in all of them: behave as though mail is not configured
 * and say so on the screen. A thrown error here would turn a wrong key into a
 * 500 on a settings page.
 */
export function open(sealed, key = readKey()) {
  if (!key || typeof sealed !== 'string') return null;
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== PREFIX || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
