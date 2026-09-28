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
/**
 * Half an hour for a reset, because the person who asked for it is standing
 * at the login screen waiting. A link that outlives that moment is a link
 * sitting in a mailbox for somebody else to find.
 */
export const RESET_TTL_MS = 30 * 60000;
/** A day to prove an address, which somebody may only read that evening. */
export const VERIFY_TTL_MS = 24 * 3600000;
/**
 * A week for a member's first password.
 *
 * It arrives with their membership card while they are walking out of the gym,
 * and a member who misses it has to come back to the counter to be sent
 * another -- which is a trip they should not have to make because a link
 * expired over a weekend.
 */
export const MEMBER_TTL_MS = 7 * 86400000;
const TTL = { setup: SETUP_TTL_MS, reset: RESET_TTL_MS, verify: VERIFY_TTL_MS, member: MEMBER_TTL_MS };

export const setupTokenHash = token => createHash('sha256').update(token).digest('hex');

/**
 * Issues a link for an account, retiring any earlier unused one.
 *
 * Retiring matters: somebody who runs the command twice because the first
 * message did not send should not leave two working ways in.
 */
export function issueSetupToken(db, { userId, now, issuedBy = null, purpose = 'setup', life: override }) {
  const token = randomBytes(32).toString('base64url');
  // The purpose decides the life, unless the caller has a reason to shorten
  // it. One does: the link the counter hands over face to face is used within
  // minutes, while the one posted with a card has to survive a weekend.
  const life = override ?? TTL[purpose] ?? SETUP_TTL_MS;
  // Only links of the same kind are retired: asking for a password reset must
  // not quietly kill the verification link in the same person's inbox.
  db.prepare('UPDATE password_setup_tokens SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL')
    .run(now, userId, purpose);
  db.prepare(`INSERT INTO password_setup_tokens(token_hash,user_id,created_at,expires_at,issued_by,purpose)
    VALUES(?,?,?,?,?,?)`).run(setupTokenHash(token), userId, now, now + life, issuedBy, purpose);
  return { token, expiresAt: now + life, purpose };
}

/** The account a live token belongs to, or null for every way of being invalid. */
export function readSetupToken(db, token, now, purposes = ['setup', 'reset', 'member']) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare(`SELECT t.*, u.email, u.role, u.status, u.approval, u.name
    FROM password_setup_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?`)
    .get(setupTokenHash(token));
  if (!row || row.used_at !== null || row.expires_at <= now) return null;
  // A link that proves an address must not also set a password, and the other
  // way round: one token, one thing.
  if (!purposes.includes(row.purpose ?? 'setup')) return null;
  return row;
}

/** The path the owner is told to open. Relative, so it works on any hostname. */
export const setupPath = token => `/?setpw=${token}`;
/** The link in the letter that proves an address belongs to whoever typed it. */
export const verifyPath = token => `/?verify=${token}`;
