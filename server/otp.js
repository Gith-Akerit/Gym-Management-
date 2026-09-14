import { createHmac } from 'node:crypto';

/**
 * The stored form of a one-time code.
 *
 * The challenge id is mixed in so the same six digits issued twice do not
 * produce the same row, and so a hash lifted from one challenge is useless
 * against another. Both the server and the pilot CLI hash through here: two
 * copies of this line would eventually stop agreeing, and the symptom would be
 * a code that is printed correctly and rejected at the login screen.
 */
export const otpCodeHash = (secret, challengeId, code) =>
  createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
