// Staff and owner passwords.
//
// bcrypt, through `bcryptjs` rather than the native binding: this system is
// installed by running a shell script on a rented Linux box, and a password
// hash that needs a C++ toolchain on the machine is a password hash that will
// one day fail to install at the worst moment. The pure-JavaScript
// implementation is the same algorithm at the same cost factor, only slower to
// compute -- which for a gym signing in a handful of people a day is free, and
// for somebody guessing at the login is the point.

import bcrypt from 'bcryptjs';

/**
 * 2^12 rounds. Roughly a quarter of a second per attempt on the hardware this
 * runs on, which nobody at the counter notices and a guessing script does.
 */
export const BCRYPT_ROUNDS = 12;

export const hashPassword = password => bcrypt.hashSync(password, BCRYPT_ROUNDS);

/**
 * Always does the work, even when there is no hash to check against. Returning
 * early for an unknown address answers "is there an account here?" in the time
 * the reply takes to arrive.
 */
const ABSENT = '$2b$12$' + 'x'.repeat(53);
export const verifyPassword = (password, hash) => {
  const matches = bcrypt.compareSync(password, hash || ABSENT);
  return !!hash && matches;
};
