// Setting a password on an account that has none, without signing in first.
//
// The gym that is already running was installed before passwords existed. The
// owner's account is there and it is an admin, and it opens nothing. There is
// no mail provider to send a reset link through and no second admin to ask, so
// the way in is a link issued at the terminal by whoever has shell access.
//
// One use, twenty-four hours, and the token is only ever on disk as a hash.

import { createHash, randomBytes } from 'node:crypto';

export const SETUP_TTL_MS = 24 * 3600000;

export const setupTokenHash = token => createHash('sha256').update(token).digest('hex');

/**
 * Issues a link for an account, retiring any earlier unused one.
 *
 * Retiring matters: somebody who runs the command twice because the first
 * message did not send should not leave two working ways in.
 */
export function issueSetupToken(db, { userId, now, issuedBy = null }) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('UPDATE password_setup_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL')
    .run(now, userId);
  db.prepare(`INSERT INTO password_setup_tokens(token_hash,user_id,created_at,expires_at,issued_by)
    VALUES(?,?,?,?,?)`).run(setupTokenHash(token), userId, now, now + SETUP_TTL_MS, issuedBy);
  return { token, expiresAt: now + SETUP_TTL_MS };
}

/** The account a live token belongs to, or null for every way of being invalid. */
export function readSetupToken(db, token, now) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare(`SELECT t.*, u.email, u.role, u.status FROM password_setup_tokens t
    JOIN users u ON u.id=t.user_id WHERE t.token_hash=?`).get(setupTokenHash(token));
  if (!row || row.used_at !== null || row.expires_at <= now) return null;
  return row;
}

/** The path the owner is told to open. Relative, so it works on any hostname. */
export const setupPath = token => `/?setpw=${token}`;
