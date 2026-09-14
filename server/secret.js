// The one key that can never be rotated.
//
// It signs the QR on every membership card, and a card lives in somebody's
// photo album for years. Changing it does not invalidate a session somebody
// can create again by signing in -- it invalidates every card the gym has
// already sent out, with nothing on the server to tell anybody that is why the
// scanner started refusing people.
//
// It was called OTP_SECRET when the only thing it signed was a six digit code
// that expired in ten minutes, which is a name that invites exactly the wrong
// instinct: rotate it when in doubt. The old name is still read so a gym that
// is already installed keeps working across the upgrade, and says so loudly.

export const OLD_NAME = 'OTP_SECRET';
export const NAME = 'CARD_SIGNING_SECRET';

export const RENAME_WARNING = `${OLD_NAME} is now ${NAME}. The value still works; rename the key in .env. `
  + 'Do NOT generate a new value: it signs the QR on every membership card already sent out.';

/**
 * @param {Record<string, string|undefined>} [env]
 * @param {(line: string) => void} [warn]
 * @returns {string} the secret, or '' when neither name is set
 */
export function cardSecret(env = process.env, warn = console.warn) {
  if (env[NAME]) return env[NAME];
  if (env[OLD_NAME]) {
    warn(JSON.stringify({ event: 'secret_renamed', message: RENAME_WARNING }));
    return env[OLD_NAME];
  }
  return '';
}
