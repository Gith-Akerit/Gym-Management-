// The member's own way in, and the wall around it.
//
// A member is not a member of staff with fewer menus. They sign in somewhere
// else, they get a session that opens a different set of routes, and the
// counter's API is closed to them completely -- not hidden, closed. That
// separation is the whole design: if the only thing standing between a member
// and the till were a hidden menu item, the till would be one guessed URL away.
//
// Two rules run through everything here.
//
// The sign-in screen answers one sentence whatever is true. A member portal
// login that says "no such account" is a public page that tells anybody which
// of their friends trains here, which is a worse leak than it first sounds in a
// town where everybody knows everybody.
//
// And every request re-checks that the membership is still live. Not at login:
// on every request. A membership expires on a Tuesday afternoon while somebody
// is holding a phone with a session from Monday, and the programme they are
// halfway through is the thing they are paying for.

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { publicMember, transaction } from './db.js';
import { verifyPassword } from './passwords.js';
import { HttpError, email as emailRule, parse } from './validation.js';

const memberLoginSchema = z.object({
  email: emailRule,
  password: z.string().min(1, 'กรุณากรอกรหัสผ่าน').max(200),
}).strict();

/** Twelve hours, the same as the counter: a phone left on a bench is a risk too. */
export const MEMBER_SESSION_MS = 43200000;

/**
 * The member's sign-in, registered BEFORE the session middleware.
 *
 * It has to be: the whole point of a sign-in is that the person asking has no
 * session yet. Registering it with the rest of the portal put it behind the
 * guard and every attempt came back "please sign in again", which is both
 * wrong and the single most confusing thing a login page can say.
 */
export function registerMemberAuthRoutes({ app, db, now, digest, limit, production,
  assertNotLockedOut, recordSignInFailure, clearSignInFailures }) {
  app.post('/api/auth/member/login', (req, res) => {
    limit(`mlogin-ip:${req.ip}`, 60, 900000);
    const input = parse(memberLoginSchema, req.body);
    assertNotLockedOut(input.email);

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
    // The hashing time is spent whether or not there is anything to compare
    // against, so an address with no account costs the same milliseconds.
    const correct = verifyPassword(input.password, user?.password_hash);
    // One sentence for all of it: no account, no password set yet, wrong
    // password, and an address that belongs to a member of staff rather than a
    // member. The last one matters -- otherwise this page tells anybody which
    // addresses work at the gym.
    if (!correct || user.role !== 'member' || user.status !== 'active') {
      const left = recordSignInFailure(input.email);
      throw new HttpError(401, left > 0
        ? `อีเมลหรือรหัสผ่านไม่ถูกต้อง เหลืออีก ${left} ครั้งก่อนถูกล็อก 15 นาที`
        : 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    const member = db.prepare('SELECT * FROM members WHERE user_id=?').get(user.id);
    // An account with no member row is not a member: same sentence again.
    if (!member) {
      const left = recordSignInFailure(input.email);
      throw new HttpError(401, left > 0
        ? `อีเมลหรือรหัสผ่านไม่ถูกต้อง เหลืออีก ${left} ครั้งก่อนถูกล็อก 15 นาที`
        : 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }

    // An expired membership still signs in. It has to: the screen that says
    // "your membership ended on the 3rd, here is the gym's number" is only
    // reachable by somebody who got through the door.
    const token = randomBytes(32).toString('base64url');
    transaction(db, () => {
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, now() + MEMBER_SESSION_MS);
      clearSignInFailures(input.email);
    });
    if (req.get('X-Gym-Client') === 'mobile') {
      return res.json({ member: publicMember(member), token, expires_in: MEMBER_SESSION_MS / 1000 });
    }
    res.cookie('gym_session', token, { httpOnly: true, secure: production, sameSite: 'strict',
      maxAge: MEMBER_SESSION_MS, path: '/api' });
    res.json({ member: publicMember(member) });
  });
}

export function registerMemberPortalRoutes({ app, db, now }) {
  /**
   * The live membership behind a member account, or null.
   *
   * The same query the counter uses for the card footer, asked from the other
   * side. One place, so "is this person still a member?" cannot be answered
   * two different ways by two screens.
   */
  function liveMembership(memberId) {
    return db.prepare(`SELECT e.*, p.name_th FROM entitlements e
      JOIN packages p ON p.id=e.package_id
      WHERE e.member_id=? AND e.status='active' AND e.expires_at>?
      ORDER BY e.expires_at DESC LIMIT 1`).get(memberId, now()) ?? null;
  }

  /** The most recent membership whether or not it is still live, for screen H. */
  const lastMembership = memberId => db.prepare(`SELECT e.*, p.name_th FROM entitlements e
    JOIN packages p ON p.id=e.package_id WHERE e.member_id=?
    ORDER BY e.expires_at DESC LIMIT 1`).get(memberId) ?? null;

  const asDate = value => (value
    ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' }).format(new Date(value))
    : null);

  /**
   * Everything under /api/m/ is the member's, and only the member's.
   *
   * Staff and the owner are turned away as firmly as a stranger. Not because
   * they must not see a programme -- they can open the counter's own screens
   * for that -- but because a route that quietly accepts three kinds of
   * session is a route whose rules nobody can state.
   */
  const member = (req, res, next) => {
    if (req.user.role !== 'member') {
      return next(new HttpError(403, 'หน้านี้สำหรับสมาชิกเท่านั้น'));
    }
    const row = db.prepare('SELECT * FROM members WHERE user_id=?').get(req.user.id);
    if (!row) return next(new HttpError(403, 'บัญชีนี้ไม่ได้ผูกกับสมาชิกคนไหน'));
    req.member = row;
    next();
  };

  /**
   * The gate the paid content sits behind, checked per request.
   *
   * 402 rather than 403, and a body the screen can act on: the answer to an
   * expired membership is not "you are not allowed", it is "this ran out on
   * the 3rd and here is how to renew" (Designer, screen H).
   */
  const paidUp = (req, res, next) => {
    const live = liveMembership(req.member.id);
    if (!live) {
      const last = lastMembership(req.member.id);
      return next(new HttpError(402, 'สมาชิกหมดอายุแล้ว', undefined, {
        expired: true,
        expired_at: last?.expires_at ?? null,
        expired_on: asDate(last?.expires_at),
        package: last?.name_th ?? null,
      }));
    }
    req.entitlement = live;
    next();
  };

  /** Who is signed in, and whether their membership is still live. */
  app.get('/api/m/me', member, (req, res) => {
    const live = liveMembership(req.member.id);
    const last = live ?? lastMembership(req.member.id);
    res.json({
      name: req.member.name,
      member_code: req.member.member_code,
      email: req.user.email,
      active: !!live,
      // Both spellings: the screen prints one and compares the other.
      expires_at: last?.expires_at ?? null,
      expires_on: asDate(last?.expires_at),
      package: last?.name_th ?? null,
    });
  });

  // Handed back so the content routes in the next commit sit behind the same
  // two guards rather than inventing their own.
  return { member, paidUp, liveMembership };
}
