import express from 'express';
import helmet from 'helmet';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerCardRoutes } from './cards-routes.js';
import { registerCheckInRoutes } from './checkin.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issueSetupToken, readSetupToken, setupPath, setupTokenHash, verifyPath } from './password-setup.js';
import { registerPaymentRoutes } from './payments.js';
import { registerPublicThemeRoutes, registerSettingsRoutes } from './settings-routes.js';
import { registerReportRoutes } from './reports-routes.js';
import { createMailer, ownerNotice } from './mail.js';
import { letter } from './letters.js';
import { resolveTheme } from './theme.js';
import { settingsRow } from './settings-routes.js';
import { audit, createMember, expireStaleOrders, getGym, getMember, getPackage, memberSelect, publicGym, publicMember, publicPackage, transaction } from './db.js';
import { approveRequestSchema, forgotSchema, gymSchema, hoursSchema, HttpError, loginSchema, memberSchema, packageSchema, packageUpdateSchema, parse, passwordSchema, rejectRequestSchema, roleSchema, setPasswordSchema, signupSchema, updateSchema, userSchema } from './validation.js';

const digest = value => createHash('sha256').update(value).digest('hex');
/** Dead check-in tokens are kept a week, then deleted. */
export const CHECK_IN_TOKEN_RETENTION_MS = 7 * 86400000;
export function createApp({ db, secret, origin = 'http://localhost:5173', production = false,
  now = Date.now, trustProxy = 1, slipStore, photoStore, logoStore, reportStore, promptPayId, pilotMode = false,
  mailer = createMailer() }) {
  if (!secret || secret.length < 32) throw new Error('CARD_SIGNING_SECRET must have at least 32 characters');
  if (production && !origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS');
  const app = express();
  app.disable('x-powered-by');
  // Production forces HTTPS, so there is always a proxy in front and every
  // request arrives from its address. Without this, req.ip is the proxy and the
  // whole gym shares one per-IP budget — 20 members and the rest are locked out
  // of login (BUG-01). Set TRUST_PROXY to the real number of hops.
  app.set('trust proxy', trustProxy);
  app.use(helmet({ strictTransportSecurity: production ? undefined : false }));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin && req.headers.origin !== origin) return next(new HttpError(403, 'ไม่อนุญาตให้เรียกจากเว็บไซต์นี้'));
    if (req.headers.origin === origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gym-Client');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      return res.sendStatus(204);
    }
    if (!['GET', 'HEAD'].includes(req.method) && !['web', 'mobile'].includes(req.get('X-Gym-Client'))) {
      return next(new HttpError(403, 'คำขอไม่ถูกต้อง กรุณาเปิดแอปใหม่'));
    }
    next();
  });
  const hmac = value => createHmac('sha256', secret).update(value).digest('hex');
  function limit(key, max, windowMs) {
    const bucket = hmac(key);
    const count = db.prepare(`INSERT INTO rate_limits(bucket,hits,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN expires_at<=? THEN 1 ELSE hits+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING hits,expires_at`)
      .get(bucket, now() + windowMs, now(), now());
    if (count.hits > max) throw new HttpError(429, 'ลองบ่อยเกินไป กรุณารอ 15 นาทีแล้วลองใหม่');
  }
  // The per-IP ceiling alone would let one address be guessed at from a
  // botnet. This bounds guesses per account, whoever is making them.
  const SIGN_IN_MAX_FAILURES = 5, SIGN_IN_LOCK_MS = 900000;
  function assertNotLockedOut(address) {
    const row = db.prepare('SELECT locked_until FROM otp_lockouts WHERE email=?').get(address);
    if (row?.locked_until && row.locked_until > now()) {
      throw new HttpError(429, 'กรอกรหัสผ่านผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่');
    }
  }
  function recordSignInFailure(address) {
    db.prepare(`INSERT INTO otp_lockouts(email,failures,updated_at) VALUES(?,1,?)
      ON CONFLICT(email) DO UPDATE SET
        failures=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN 1 ELSE failures+1 END,
        locked_until=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN NULL ELSE locked_until END,
        updated_at=?`).run(address, now(), now(), now(), now());
    db.prepare('UPDATE otp_lockouts SET locked_until=? WHERE email=? AND failures>=? AND locked_until IS NULL')
      .run(now() + SIGN_IN_LOCK_MS, address, SIGN_IN_MAX_FAILURES);
    // How many tries are left, so somebody mistyping their own password is
    // warned before the door shuts rather than after (Designer).
    const row = db.prepare('SELECT failures FROM otp_lockouts WHERE email=?').get(address);
    return Math.max(0, SIGN_IN_MAX_FAILURES - (row?.failures ?? 0));
  }
  const clearSignInFailures = address => db.prepare('DELETE FROM otp_lockouts WHERE email=?').run(address);

  // Expired challenges, sessions and rate-limit buckets are swept here rather
  // than in start.js, so every entry point that builds an app gets the cleanup.
  const sweep = () => {
    db.prepare('DELETE FROM otp_challenges WHERE expires_at<?').run(now() - 900000);
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
    db.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(now());
    db.prepare('DELETE FROM otp_lockouts WHERE locked_until IS NOT NULL AND locked_until<?').run(now() - 900000);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='password_setup_tokens'").get()) {
      db.prepare('DELETE FROM password_setup_tokens WHERE expires_at<?').run(now() - 86400000);
    }
    // Reading an order used to perform this UPDATE on every GET. Reads now
    // project the expired state instead, and the durable change happens here.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get()) {
      expireStaleOrders(db, now());
    }
    // A member watching the QR screen mints a fresh token every minute, and
    // nothing used to delete them. A week is long enough to answer "who came in
    // on Tuesday?" from the check_ins rows that point at them.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='check_in_tokens'").get()) {
      db.prepare('DELETE FROM check_in_tokens WHERE expires_at < ?').run(now() - CHECK_IN_TOKEN_RETENTION_MS);
    }
  };
  const sweepTimer = setInterval(sweep, 60000).unref();
  app.locals.stopSweeper = () => clearInterval(sweepTimer);
  // Exposed so a deployment script or a test can run the sweep on demand
  // rather than waiting out the interval.
  app.locals.sweep = sweep;

  app.locals.pilotMode = pilotMode;

  /**
   * Everything the four letters need about this gym, read fresh each time.
   *
   * The colours come from the same engine that paints the membership card, so
   * a gym that changes its colour on Tuesday sends Tuesday's colour in
   * Wednesday's email without anybody touching a template.
   */
  function gymLetterContext() {
    const profile = publicGym(db);
    const theme = resolveTheme(settingsRow(db));
    return {
      gym_name: profile.brand_name_th || profile.name || 'ยิม',
      gym_phone: profile.phone || '',
      brand_surface: theme.brand_surface,
      on_brand: theme.on_brand,
      login_url: origin || '',
    };
  }

  /** Builds one of the Designer's letters and hands it to the mailer. */
  function post(key, to, values = {}) {
    const context = gymLetterContext();
    const built = letter(key, { ...context, email: to, ...values });
    return mailer.send({ to, senderName: context.gym_name, ...built });
  }

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  /**
   * The staff guide, served out of the repository.
   *
   * It ships with the code on purpose: a manual that lives in somebody's chat
   * history is a manual that a new member of staff cannot find at 19:00, and
   * one that lives on a file-sharing link is a manual that stops working the
   * day the link expires. This way the version on the machine is the version
   * of the app on the machine.
   *
   * No session: it is instructions for using a counter, not gym data, and the
   * person who most needs it may be the one who cannot get signed in.
   */
  app.get('/manual.pdf', (req, res, next) => {
    const file = fileURLToPath(new URL('../docs/manual/staff-guide-th.pdf', import.meta.url));
    if (!existsSync(file)) return next(new HttpError(404, 'ยังไม่มีคู่มือในระบบ'));
    res.type('application/pdf');
    res.set('Content-Disposition', 'inline; filename="suklutai-staff-guide.pdf"');
    return res.sendFile(file);
  });

  // The trial banner has to be on the login screen, before anybody has signed
  // in, so this one fact is public.
  app.get('/api/public/config', (req, res) => res.json({ pilot_mode: pilotMode }));

  // Anyone may read what the gym advertises: opening hours, address, the phone
  // number staff chose to publish, and the packages actually on sale. Somebody
  // deciding whether to join should not have to create an account first.
  app.get('/api/public/gym', (req, res) => res.json(publicGym(db)));
  // The gym's own colours and logo, for the screens drawn before anybody has
  // signed in. Nothing in it is private: it is what is painted on the door.
  registerPublicThemeRoutes({ app, db, logoStore });
  app.get('/api/public/packages', (req, res) => res.json({
    items: db.prepare("SELECT * FROM packages WHERE status='active' ORDER BY sort_order, created_at")
      .all().map(publicPackage),
  }));
  function me(user) {
    return { email: user.email, role: user.role,
      member: publicMember(db.prepare(`${memberSelect} WHERE m.user_id=?`).get(user.id)) };
  }
  /**
   * Signing in.
   *
   * Only staff and the owner have accounts at all now, and the thing they type
   * is a password their own admin set. The address no longer has to be reachable
   * by mail at the moment somebody needs to open the till -- which is what an
   * emailed code quietly required, on a Sunday, from a rented mailbox.
   *
   * Every failure answers the same sentence. "No such account", "no password
   * set" and "wrong password" are three different facts, and telling them apart
   * is how somebody finds out which addresses exist here (QA USR-10).
   */
  app.post('/api/auth/login', (req, res) => {
    limit(`login-ip:${req.ip}`, 60, 900000);
    const input = parse(loginSchema, req.body);
    assertNotLockedOut(input.email);

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
    // Always spends the hashing time, even with nothing to compare against, so
    // the reply for an unknown address takes as long as one for a real account.
    const correct = verifyPassword(input.password, user?.password_hash);
    if (!correct || !['admin', 'staff'].includes(user.role)) {
      // The count is the same for an address with no account, so the warning
      // says nothing about whether this one exists.
      const left = recordSignInFailure(input.email);
      throw new HttpError(401, left > 0
        ? `อีเมลหรือรหัสผ่านไม่ถูกต้อง เหลืออีก ${left} ครั้งก่อนถูกล็อก 15 นาที`
        : 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    // Only now, with the right password in hand, does the real reason come out.
    if (user.status === 'suspended') throw new HttpError(403, 'บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ');
    // Same rule for the two answers a self-signup can be waiting on: they are
    // told after the password checks out, so somebody guessing addresses at the
    // login screen still learns nothing about which ones exist.
    if (user.approval === 'pending') {
      throw new HttpError(403, 'บัญชีนี้รอเจ้าของยิมอนุมัติอยู่ เมื่ออนุมัติแล้วจะมีอีเมลแจ้ง แล้วเข้าสู่ระบบได้ทันที');
    }
    if (user.approval === 'rejected') {
      throw new HttpError(403, `คำขอเข้าใช้งานนี้ไม่ได้รับอนุมัติ${user.reject_reason ? ` (${user.reject_reason})` : ''} กรุณาติดต่อเจ้าของยิม`);
    }

    const token = randomBytes(32).toString('base64url');
    const result = transaction(db, () => {
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, now() + 43200000);
      clearSignInFailures(input.email);
      return me(user);
    });
    if (req.get('X-Gym-Client') === 'mobile') return res.json({ ...result, token, expires_in: 43200 });
    res.cookie('gym_session', token, { httpOnly: true, secure: production, sameSite: 'strict', maxAge: 43200000, path: '/api' });
    res.json(result);
  });

  /**
   * Asking for an account.
   *
   * The reply is the same sentence whether or not that address already has an
   * account here, and the work done before replying is the same too -- the
   * password is hashed either way, which is the expensive part. Otherwise this
   * form becomes the tool that tells somebody which addresses belong to the
   * gym: the thing the login screen was carefully built not to say.
   *
   * Nothing is decided here. The account exists, opens nothing, and waits.
   */
  app.post('/api/auth/signup', async (req, res) => {
    // Ten an hour from one address. A person filling in a form for themselves
    // does it once; anything doing it sixty times is not that person.
    limit(`signup-ip:${req.ip}`, 10, 3600000);
    const input = parse(signupSchema, req.body);
    // Before the lookup, so the timing of the reply says nothing either.
    const hash = hashPassword(input.password);
    const taken = db.prepare('SELECT 1 FROM users WHERE email=?').get(input.email);
    // The gym's own lock on a form that lives on a public URL. Empty means
    // off, which is how every gym starts; set, and the queue stops being open
    // to the whole internet (Designer). A wrong code is answered exactly like
    // a duplicate address -- silence, and the same sentence.
    const expected = (settingsRow(db)?.invite_code ?? '').trim();
    const codeOk = !expected || expected === (input.invite_code ?? '').trim();

    if (!taken && codeOk) {
      const id = randomUUID();
      transaction(db, () => {
        // The role is written now but means nothing until approval: the owner
        // chooses the real one when they let the person in.
        db.prepare(`INSERT INTO users(id,email,role,password_hash,password_set_at,created_at,
          approval,name,phone,requested_at) VALUES(?,?, 'staff',?,?,?, 'pending',?,?,?)`)
          .run(id, input.email, hash, now(), now(), input.name, input.phone, now());
        audit(db, id, 'user.signup_requested', id, null, { email: input.email }, now(), 'user');
      });
      // Not awaited before replying: the person is looking at a spinner, and
      // whether a mail provider is slow is not their problem. The request is
      // already written down and visible to the owner on the screen.
      const { token } = issueSetupToken(db, { userId: id, now: now(), purpose: 'verify' });
      post('1-verify-email', input.email, { name: input.name, verify_url: `${origin}${verifyPath(token)}` });

      const gym = gymLetterContext().gym_name;
      const note = ownerNotice({ gym, name: input.name, email: input.email, phone: input.phone });
      for (const owner of db.prepare("SELECT email FROM users WHERE role='admin' AND status='active' AND approval='approved'").all()) {
        mailer.send({ to: owner.email, senderName: gym, subject: note.subject, text: note.text });
      }
    }

    res.status(202).json({
      pending: true,
      message: 'ส่งคำขอแล้ว เจ้าของยิมจะอนุมัติและกำหนดสิทธิ์ให้ เมื่ออนุมัติแล้วจะมีอีเมลแจ้งและเข้าสู่ระบบได้ทันที',
    });
  });

  /**
   * Proving the address in a sign-up is reachable by whoever typed it.
   *
   * No session is created and nothing is granted: the account still waits for
   * the owner. All this does is let the owner see that the letter arrived
   * somewhere, which is what makes approving safe to do.
   */
  app.get('/api/auth/verify/:token', (req, res) => {
    limit(`verify-ip:${req.ip}`, 60, 900000);
    const result = transaction(db, () => {
      const row = readSetupToken(db, req.params.token, now(), ['verify']);
      if (!row) throw new HttpError(404, 'ลิงก์ยืนยันอีเมลหมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่จากเจ้าของยิม');
      const claimed = db.prepare('UPDATE password_setup_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL')
        .run(now(), setupTokenHash(req.params.token));
      if (claimed.changes !== 1) throw new HttpError(404, 'ลิงก์ยืนยันอีเมลถูกใช้ไปแล้ว');
      db.prepare('UPDATE users SET email_verified_at=?,email_verified_by_link_at=? WHERE id=?')
        .run(now(), now(), row.user_id);
      audit(db, row.user_id, 'user.email_verified', row.user_id, null, { via: 'link' }, now(), 'user');
      return { email: row.email, approval: row.approval };
    });
    res.json(result);
  });

  /**
   * "I forgot my password."
   *
   * The reply is one sentence, always the same one, and the work done before
   * it is the same too -- a token is minted and hashed whatever happens, so an
   * address with no account costs the same milliseconds as one with. An email
   * goes out ONLY when the account is real: a letter saying "there is no
   * account here" would undo the whole thing from the other side (Designer).
   */
  app.post('/api/auth/forgot', (req, res) => {
    limit(`forgot-ip:${req.ip}`, 20, 900000);
    const input = parse(forgotSchema, req.body);
    // Per address as well as per address-that-asked: an IP limit alone leaves
    // one person's mailbox open to being buried from a hundred machines.
    limit(`forgot-email:${input.email}`, 5, 900000);

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
    const eligible = user && ['admin', 'staff'].includes(user.role)
      && user.status === 'active' && user.approval === 'approved';
    if (eligible) {
      const { token } = issueSetupToken(db, { userId: user.id, now: now(), purpose: 'reset' });
      post('4-reset-password', user.email, {
        name: user.name, reset_url: `${origin}${setupPath(token)}`,
      });
    } else {
      // The same work, thrown away: a token is minted and hashed so the reply
      // for an address with no account takes as long as one for a real one.
      setupTokenHash(randomBytes(32).toString('base64url'));
    }
    res.json({
      sent: true,
      message: 'ถ้ามีบัญชีของอีเมลนี้อยู่ เราส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว ลิงก์ใช้ได้ 30 นาที',
    });
  });

  /**
   * The set-password link, issued at the terminal by `npm run
   * admin:set-password-link`. Both halves sit above the session check because
   * the whole point is that the person opening them cannot sign in yet.
   *
   * The reply says only whether the link still works and whose it is. A caller
   * guessing tokens learns nothing from a live one that they did not already
   * need the token to learn.
   */
  app.get('/api/auth/set-password/:token', (req, res) => {
    limit(`setpw-ip:${req.ip}`, 60, 900000);
    const row = readSetupToken(db, req.params.token, now());
    if (!row) throw new HttpError(404, 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่');
    res.json({ email: row.email, expires_at: row.expires_at });
  });

  app.post('/api/auth/set-password', (req, res) => {
    limit(`setpw-ip:${req.ip}`, 60, 900000);
    const input = parse(setPasswordSchema, req.body);
    const result = transaction(db, () => {
      const row = readSetupToken(db, input.token, now());
      if (!row) throw new HttpError(404, 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่');
      // Claim the token first: two submissions of the same form must not both
      // count as the one use it is allowed.
      const claimed = db.prepare('UPDATE password_setup_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL')
        .run(now(), setupTokenHash(input.token));
      if (claimed.changes !== 1) throw new HttpError(404, 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่');
      db.prepare('UPDATE users SET password_hash=?,password_set_at=? WHERE id=?')
        .run(hashPassword(input.password), now(), row.user_id);
      // Anything that account had open elsewhere ends here, and the lockout
      // from whoever was guessing at it is cleared.
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      db.prepare('DELETE FROM otp_lockouts WHERE email=?').run(row.email);
      audit(db, row.user_id, 'user.password_set_by_link', row.user_id, null,
        { via: 'setup_link' }, now(), 'user');
      return { email: row.email };
    });
    res.json(result);
  });

  app.use('/api', (req, res, next) => {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('gym_session='))?.slice(12);
    const bearer = req.get('Authorization');
    const token = bearer ? (bearer.startsWith('Bearer ') ? bearer.slice(7) : '') : cookie;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบอีกครั้ง'));
    const user = db.prepare(`SELECT u.*,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), now());
    if (!user) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบอีกครั้ง'));
    // Suspending deletes the sessions it can see, but a token issued a second
    // earlier would otherwise keep working until it expired.
    if (user.status === 'suspended') return next(new HttpError(403, 'บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ'));
    req.user = user;
    next();
  });
  app.post('/api/auth/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.user.token_hash);
    res.clearCookie('gym_session', { path: '/api', httpOnly: true, sameSite: 'strict', secure: production });
    res.sendStatus(204);
  });
  app.get('/api/me', (req, res) => res.json(me(req.user)));
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : next(new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น'));
  /** Signing people up and scanning them in is counter work, not owner work. */
  const counter = (req, res, next) => (['staff', 'admin'].includes(req.user.role)
    ? next() : next(new HttpError(403, 'เฉพาะพนักงานและผู้ดูแลระบบเท่านั้น')));

  // Money. Members no longer buy anything themselves; what is left is the
  // counter recording what was paid and handing over the package, plus the
  // orders and slips the old member app already created.
  if (slipStore) {
    registerPaymentRoutes({ app, db, now, admin, counter, slipStore, promptPayId, pilotMode });
  }

  // The photograph and the card it goes on.
  registerCardRoutes({ app, db, now, admin, counter, photoStore, logoStore, secret });
  registerSettingsRoutes({ app, db, now, admin, counter, logoStore });
  registerReportRoutes({ app, db, now, admin, counter, reportStore });

  // Check-in at the counter.
  registerCheckInRoutes({ app, db, now, admin, counter, secret, limit });
  /**
   * What a member's membership currently is, in the shape every screen needs:
   * the list row, the summary panel before a sale, and the card footer all ask
   * the same question, and they must not answer it three different ways.
   */
  const membershipDate = value => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' })
    .format(new Date(value));
  function withMembership(member) {
    const entitlement = db.prepare(`SELECT e.*, p.name_th FROM entitlements e
      JOIN packages p ON p.id=e.package_id
      WHERE e.member_id=? AND e.status='active' AND e.expires_at>?
      ORDER BY e.expires_at DESC LIMIT 1`).get(member.id, now());
    return {
      ...member,
      membership: entitlement
        ? { package: entitlement.name_th, expires_at: entitlement.expires_at,
          expires: membershipDate(entitlement.expires_at), sessions_remaining: entitlement.sessions_remaining }
        : { package: null, expires_at: null, expires: null, sessions_remaining: null },
    };
  }

  app.get('/api/members', counter, (req, res) => {
    const { q = '', page = 1, limit: size = 20 } = parse(z.object({
      q: z.string().max(120).optional(), page: z.coerce.number().int().min(1).max(100000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).strict(), req.query);
    const escaped = q.trim().replace(/[\\%_]/g, '\\$&');
    const term = `%${escaped}%`;
    const phoneTerm = q.replace(/[\s()-]/g, '').replace(/^\+66/, '0');
    const where = `WHERE (m.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
      OR m.member_code LIKE ? ESCAPE '\\' OR m.id=? OR m.phone=?)`;
    const params = [term, term, term, q, phoneTerm];
    const total = db.prepare(`SELECT count(*) AS total FROM members m LEFT JOIN users u ON u.id=m.user_id ${where}`).get(...params).total;
    const items = db.prepare(`${memberSelect} ${where} ORDER BY m.joined_at DESC,m.id LIMIT ? OFFSET ?`)
      .all(...params, size, (page - 1) * size).map(row => withMembership(publicMember(row)));
    res.json({ items, total, page, limit: size });
  });

  /**
   * Signing somebody up at the counter. Staff do this, not only the owner: the
   * person standing at the desk with a new member in front of them is whoever
   * happens to be working.
   *
   * An email address is optional and creates no account. A member has nothing
   * to sign in to -- what they walk away with is a picture of a card.
   */
  app.post('/api/members', counter, (req, res) => {
    const input = parse(memberSchema, req.body);
    const result = transaction(db, () => {
      let userId = null;
      if (input.email) {
        const existing = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
        if (existing && (existing.role !== 'member' || db.prepare('SELECT 1 FROM members WHERE user_id=?').get(existing.id))) {
          throw new HttpError(409, 'อีเมลหรือเบอร์โทรนี้มีอยู่ในระบบแล้ว');
        }
        userId = existing?.id ?? randomUUID();
        if (!existing) db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(userId, input.email, now());
      }
      return createMember(db, userId, input, req.user.id, now());
    });
    res.status(201).json(withMembership(result));
  });
  app.get('/api/members/:id', counter, (req, res) => {
    const row = getMember(db, req.params.id);
    if (!row) throw new HttpError(404, 'ไม่พบสมาชิก');
    res.json(withMembership(publicMember(row)));
  });
  function update(req, deactivate = false) {
    const input = deactivate ? parse(z.object({ version: z.number().int().positive() }).strict(), req.body) : parse(updateSchema, req.body);
    return transaction(db, () => {
      const before = getMember(db, req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบสมาชิก');
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข');
      // An omitted optional field keeps whatever is already stored. Overwriting
      // it with a default is how an emergency contact used to vanish (BUG-03).
      const values = deactivate ? { ...before, status: 'suspended' } : {
        ...input,
        date_of_birth: input.date_of_birth === undefined ? before.date_of_birth : input.date_of_birth,
        emergency_contact: input.emergency_contact === undefined ? before.emergency_contact : input.emergency_contact,
      };
      db.prepare(`UPDATE members SET name=?,phone=?,date_of_birth=?,emergency_contact=?,status=?,version=version+1,updated_at=? WHERE id=?`)
        .run(values.name, values.phone, values.date_of_birth, values.emergency_contact, values.status, now(), before.id);
      // A member's address is now only a way to reach them, so changing it
      // writes one column. The account it used to belong to, if there ever was
      // one, is left alone: nobody signs in as a member.
      if (values.email !== before.email) {
        if (before.user_id && values.email) {
          db.prepare('UPDATE users SET email=?,email_verified_at=NULL WHERE id=?').run(values.email, before.user_id);
        } else if (before.user_id) {
          // Clearing the address detaches the old account rather than blanking
          // it: the row is what the audit history points at.
          db.prepare('UPDATE members SET user_id=NULL WHERE id=?').run(before.id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(before.user_id);
        } else if (values.email) {
          const userId = randomUUID();
          db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(userId, values.email, now());
          db.prepare('UPDATE members SET user_id=? WHERE id=?').run(userId, before.id);
        }
      }
      const after = getMember(db, before.id);
      audit(db, req.user.id, deactivate ? 'member.deactivate' : 'member.update', before.id, before, after, now());
      return publicMember(after);
    });
  }
  app.put('/api/members/:id', admin, (req, res) => res.json(update(req)));
  app.delete('/api/members/:id', admin, (req, res) => res.json(update(req, true)));
  app.get('/api/members/:id/audit', admin, (req, res) => {
    const rows = db.prepare('SELECT * FROM audit_logs WHERE entity_id=? ORDER BY created_at DESC,id LIMIT 100').all(req.params.id);
    res.json({ items: rows.map(({ before_json, after_json, ...row }) => ({ ...row, before: JSON.parse(before_json), after: JSON.parse(after_json) })) });
  });

  // --------------------------------------------------------------- gym profile

  // Every signed-in user may read the gym's public facts; only admins edit them.
  // --------------------------------------------------------- users and roles
  //
  // Separate from the members screen on purpose: that one is about people who
  // train here, this one is about who may sign in and what they may do. Until
  // this existed there was no way at all to create a staff account -- a gym
  // could be installed with nobody able to work the scanner (QA smoke test).

  // has_password, never the hash. An account with no password is one the owner
  // created and has not handed over yet, and the screen has to say so or the
  // person will stand at the login wondering what they typed wrong.
  const publicUser = row => ({
    id: row.id, email: row.email, role: row.role, status: row.status,
    approval: row.approval, name: row.name ?? '', phone: row.phone ?? '',
    requested_at: row.requested_at ?? null, reject_reason: row.reject_reason ?? '',
    created_at: row.created_at, email_verified_at: row.email_verified_at,
    has_password: !!row.password_hash, password_set_at: row.password_set_at ?? null,
    member_id: row.member_id ?? null, member_name: row.member_name ?? null,
  });
  const userWithMember = () => `SELECT u.*, m.id AS member_id, m.name AS member_name
    FROM users u LEFT JOIN members m ON m.user_id=u.id`;
  const activeAdmins = (exceptId = '') =>
    db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND status='active' AND id<>?").get(exceptId).n;
  /**
   * The one rule that cannot be broken: somebody must still be able to
   * administer the gym afterwards. Locking every admin out of a live system
   * needs a terminal and a person who knows where the database is.
   */
  const keepAnAdmin = (before, becomes) => {
    const wasAdmin = before.role === 'admin' && before.status === 'active';
    const stays = becomes.role === 'admin' && becomes.status === 'active';
    if (wasAdmin && !stays && activeAdmins(before.id) === 0) {
      throw new HttpError(409, 'นี่คือผู้ดูแลระบบคนสุดท้ายที่ใช้งานได้ กรุณาตั้งผู้ดูแลระบบคนอื่นก่อน');
    }
  };

  app.get('/api/users', admin, (req, res) => {
    const { q = '', page = 1 } = parse(z.object({
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).optional(),
    }).strict(), req.query);
    const where = q ? `WHERE (u.email LIKE ? ESCAPE '\\' OR m.name LIKE ? ESCAPE '\\')` : '';
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const args = q ? [like, like] : [];
    const total = db.prepare(`SELECT count(*) AS n FROM users u LEFT JOIN members m ON m.user_id=u.id ${where}`).get(...args).n;
    const rows = db.prepare(`${userWithMember()} ${where}
      ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, u.email
      LIMIT 20 OFFSET ?`).all(...args, (page - 1) * 20);
    res.json({ items: rows.map(publicUser), total, page, admins: activeAdmins() });
  });

  /**
   * The requests waiting for a decision.
   *
   * Separate from the list of accounts rather than mixed into it: these are
   * not people who work here yet, and the owner opens this screen to work
   * through them, not to browse. Oldest first -- somebody who asked on Monday
   * should not be behind somebody who asked this morning.
   */
  app.get('/api/users/requests', admin, (req, res) => {
    const rows = db.prepare(`${userWithMember()} WHERE u.approval='pending'
      ORDER BY u.requested_at ASC, u.created_at ASC LIMIT 100`).all();
    res.json({ items: rows.map(publicUser), total: rows.length });
  });

  app.post('/api/users/:id/approve', admin, (req, res) => {
    const input = parse(approveRequestSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare(`${userWithMember()} WHERE u.id=?`).get(req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบบัญชีนี้');
      if (before.approval !== 'pending') throw new HttpError(409, 'คำขอนี้ถูกตัดสินไปแล้ว กรุณาโหลดหน้าใหม่');
      // Approving somebody whose address has never answered means the "you are
      // in" letter goes nowhere and nobody finds out until they telephone. The
      // screen offers to send the verification again rather than greying the
      // button out with no explanation (Designer).
      if (!before.email_verified_at) {
        throw new HttpError(409, 'อีเมลนี้ยังไม่ได้ยืนยัน กรุณากด "ส่งอีเมลยืนยันอีกครั้ง" แล้วรอให้เขากดลิงก์ก่อน');
      }
      db.prepare("UPDATE users SET approval='approved',role=?,decided_at=?,decided_by=?,reject_reason='' WHERE id=?")
        .run(input.role, now(), req.user.id, before.id);
      const after = db.prepare(`${userWithMember()} WHERE u.id=?`).get(before.id);
      // "Who let this person in" is a question with an answer a year later.
      audit(db, req.user.id, 'user.approve', before.id, publicUser(before), publicUser(after), now(), 'user');
      return after;
    });
    post('2-approved', result.email, {
      name: result.name,
      role: result.role,
      signin_method: result.google_sub ? 'บัญชี Google ของคุณ' : 'อีเมลและรหัสผ่านที่คุณตั้งไว้ตอนสมัคร',
    });
    res.json(publicUser(result));
  });

  /**
   * Sending the verification letter again.
   *
   * The owner's way out of the only state that blocks them: a request they
   * want to approve whose address has never answered. Rate limited per account
   * so pressing it repeatedly does not turn into a way to post mail at
   * somebody.
   */
  app.post('/api/users/:id/resend-verify', admin, (req, res) => {
    const row = db.prepare(`${userWithMember()} WHERE u.id=?`).get(req.params.id);
    if (!row) throw new HttpError(404, 'ไม่พบบัญชีนี้');
    if (row.email_verified_at) throw new HttpError(409, 'อีเมลนี้ยืนยันแล้ว');
    limit(`verify-resend:${row.id}`, 5, 3600000);
    const { token } = issueSetupToken(db, { userId: row.id, now: now(), issuedBy: req.user.id, purpose: 'verify' });
    post('1-verify-email', row.email, { name: row.name, verify_url: `${origin}${verifyPath(token)}` });
    audit(db, req.user.id, 'user.verify_resent', row.id, null, null, now(), 'user');
    res.json({ sent: true });
  });

  app.post('/api/users/:id/reject', admin, (req, res) => {
    const input = parse(rejectRequestSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare(`${userWithMember()} WHERE u.id=?`).get(req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบบัญชีนี้');
      if (before.approval !== 'pending') throw new HttpError(409, 'คำขอนี้ถูกตัดสินไปแล้ว กรุณาโหลดหน้าใหม่');
      // The row stays. Deleting it would let the same address ask again the
      // next minute, and would lose the record that somebody said no.
      db.prepare("UPDATE users SET approval='rejected',decided_at=?,decided_by=?,reject_reason=? WHERE id=?")
        .run(now(), req.user.id, input.reason, before.id);
      const after = db.prepare(`${userWithMember()} WHERE u.id=?`).get(before.id);
      audit(db, req.user.id, 'user.reject', before.id, publicUser(before), publicUser(after), now(), 'user');
      return after;
    });
    post('3-rejected', result.email, { name: result.name });
    res.json(publicUser(result));
  });

  app.post('/api/users', admin, (req, res) => {
    const input = parse(userSchema, req.body);
    const created = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(input.email)) {
        throw new HttpError(409, 'อีเมลนี้มีบัญชีอยู่แล้ว เปลี่ยนสิทธิ์ของบัญชีเดิมแทนได้');
      }
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,email,role,password_hash,password_set_at,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, input.email, input.role, input.password ? hashPassword(input.password) : null,
          input.password ? now() : null, now());
      const after = db.prepare(`${userWithMember()} WHERE u.id=?`).get(id);
      audit(db, req.user.id, 'user.create', id, null, publicUser(after), now(), 'user');
      return after;
    });
    res.status(201).json(publicUser(created));
  });

  function changeUser(req, changes) {
    return transaction(db, () => {
      const before = db.prepare(`${userWithMember()} WHERE u.id=?`).get(req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบบัญชีนี้');
      const becomes = { ...before, ...changes };
      keepAnAdmin(before, becomes);
      db.prepare('UPDATE users SET role=?,status=? WHERE id=?').run(becomes.role, becomes.status, before.id);
      // Anything that reduces what an account may do takes effect now, not
      // whenever the browser tab it is open in happens to be closed.
      if (becomes.status !== 'active' || becomes.role !== before.role) {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(before.id);
      }
      const after = db.prepare(`${userWithMember()} WHERE u.id=?`).get(before.id);
      audit(db, req.user.id, changes.role !== undefined ? 'user.role' : `user.${changes.status === 'active' ? 'restore' : 'suspend'}`,
        before.id, publicUser(before), publicUser(after), now(), 'user');
      return publicUser(after);
    });
  }

  /**
   * Setting somebody's password, including your own.
   *
   * The owner does this at the counter with the person standing there, which is
   * why there is no "send a reset link": there is no mail provider to send it
   * with, and the two people are already in the same room. Every other session
   * that account had ends, because the usual reason for changing a password is
   * that somebody else knows the old one.
   */
  app.put('/api/users/:id/password', admin, (req, res) => {
    const input = parse(passwordSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare(`${userWithMember()} WHERE u.id=?`).get(req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบบัญชีนี้');
      if (!['admin', 'staff'].includes(before.role)) {
        throw new HttpError(409, 'บัญชีสมาชิกไม่ได้ใช้รหัสผ่านเข้าสู่ระบบ');
      }
      db.prepare('UPDATE users SET password_hash=?,password_set_at=? WHERE id=?')
        .run(hashPassword(input.password), now(), before.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(before.id, req.user.token_hash);
      db.prepare('DELETE FROM otp_lockouts WHERE email=?').run(before.email);
      const after = db.prepare(`${userWithMember()} WHERE u.id=?`).get(before.id);
      // The hash is not in publicUser, so nothing about the password reaches
      // the audit trail beyond the fact that it changed and who changed it.
      audit(db, req.user.id, 'user.password', before.id, publicUser(before), publicUser(after), now(), 'user');
      return after;
    });
    res.json(publicUser(result));
  });

  app.put('/api/users/:id/role', admin, (req, res) => res.json(changeUser(req, parse(roleSchema, req.body))));
  app.post('/api/users/:id/suspend', admin, (req, res) => res.json(changeUser(req, { status: 'suspended' })));
  app.post('/api/users/:id/restore', admin, (req, res) => res.json(changeUser(req, { status: 'active' })));
  app.get('/api/users/:id/audit', admin, (req, res) => {
    const rows = db.prepare('SELECT * FROM audit_logs WHERE entity_id=? AND entity_type=\'user\' ORDER BY created_at DESC,id LIMIT 50').all(req.params.id);
    res.json({ items: rows });
  });

  app.get('/api/gym', (req, res) => res.json(req.user.role === 'admin' ? getGym(db) : publicGym(db)));

  app.put('/api/gym', admin, (req, res) => {
    const input = parse(gymSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare('SELECT * FROM gym_profile WHERE id=1').get();
      if (!before) throw new HttpError(409, 'ยังไม่ได้ตั้งค่าข้อมูลยิม กรุณารัน npm run db:seed ก่อน');
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข');
      db.prepare(`UPDATE gym_profile SET name=?,brand_name_th=?,address=?,location_note=?,phone_primary=?,
        phone_secondary=?,phone_display=?,hours_confirmed=?,hours_note=?,payment_sla_text=?,order_ttl_minutes=?,
        check_in_window_minutes=?,check_in_token_seconds=?,version=version+1,updated_at=? WHERE id=1`)
        .run(input.name, input.brand_name_th, input.address, input.location_note, input.phone_primary,
          input.phone_secondary, input.phone_display, input.hours_confirmed ? 1 : 0, input.hours_note,
          input.payment_sla_text, input.order_ttl_minutes, input.check_in_window_minutes,
          input.check_in_token_seconds, now());
      const after = db.prepare('SELECT * FROM gym_profile WHERE id=1').get();
      audit(db, req.user.id, 'gym.update', 'gym_profile:1', before, after, now(), 'gym_profile');
      return getGym(db);
    });
    res.json(result);
  });

  app.put('/api/gym/hours', admin, (req, res) => {
    const { hours } = parse(hoursSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare('SELECT * FROM gym_hours ORDER BY weekday').all();
      for (const day of hours) {
        db.prepare(`INSERT INTO gym_hours(weekday,closed,open_time,close_time,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(weekday) DO UPDATE SET closed=excluded.closed,open_time=excluded.open_time,
          close_time=excluded.close_time,updated_at=excluded.updated_at`)
          .run(day.weekday, day.closed ? 1 : 0, day.closed ? null : day.open_time, day.closed ? null : day.close_time, now());
      }
      const after = db.prepare('SELECT * FROM gym_hours ORDER BY weekday').all();
      audit(db, req.user.id, 'gym.update_hours', 'gym_hours', { hours: before }, { hours: after }, now(), 'gym_hours');
      return getGym(db);
    });
    res.json(result);
  });

  // ----------------------------------------------------------------- packages

  // Members only ever see what is on sale; drafts and archived stay internal.
  app.get('/api/packages', (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM packages ORDER BY sort_order, created_at').all()
      : db.prepare("SELECT * FROM packages WHERE status='active' ORDER BY sort_order, created_at").all();
    res.json({ items: rows.map(publicPackage) });
  });

  app.post('/api/packages', admin, (req, res) => {
    const input = parse(packageSchema, req.body);
    const id = randomUUID();
    const result = transaction(db, () => {
      db.prepare(`INSERT INTO packages(id,code,name_th,type,duration_days,session_limit,price_satang,
        description,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, input.code, input.name_th, input.type, input.duration_days, input.session_limit,
          input.price_satang, input.description, input.status, input.sort_order, now(), now());
      const after = getPackage(db, id);
      audit(db, req.user.id, 'package.create', id, null, after, now(), 'package');
      return publicPackage(after);
    });
    res.status(201).json(result);
  });

  app.get('/api/packages/:id', admin, (req, res) => {
    const row = getPackage(db, req.params.id);
    if (!row) throw new HttpError(404, 'ไม่พบแพ็กเกจ');
    res.json(publicPackage(row));
  });

  app.put('/api/packages/:id', admin, (req, res) => {
    const input = parse(packageUpdateSchema, req.body);
    const result = transaction(db, () => {
      const before = getPackage(db, req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบแพ็กเกจ');
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข');
      db.prepare(`UPDATE packages SET code=?,name_th=?,type=?,duration_days=?,session_limit=?,price_satang=?,
        description=?,status=?,sort_order=?,version=version+1,updated_at=? WHERE id=?`)
        .run(input.code, input.name_th, input.type, input.duration_days, input.session_limit,
          input.price_satang, input.description, input.status, input.sort_order, now(), before.id);
      const after = getPackage(db, before.id);
      audit(db, req.user.id, 'package.update', before.id, before, after, now(), 'package');
      return publicPackage(after);
    });
    res.json(result);
  });

  // Archive rather than delete: orders bought in Phase 2 must keep pointing here.
  app.delete('/api/packages/:id', admin, (req, res) => {
    const input = parse(z.object({ version: z.number().int().positive() }).strict(), req.body);
    const result = transaction(db, () => {
      const before = getPackage(db, req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบแพ็กเกจ');
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข');
      db.prepare("UPDATE packages SET status='archived',version=version+1,updated_at=? WHERE id=?").run(now(), before.id);
      const after = getPackage(db, before.id);
      audit(db, req.user.id, 'package.archive', before.id, before, after, now(), 'package');
      return publicPackage(after);
    });
    res.json(result);
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'ไม่พบรายการที่ต้องการ')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.fields && { fields: err.fields }) });
    // Say which collision happened. Reporting every UNIQUE violation as a
    // duplicate email sent an admin hunting an email problem while the real one
    // was an entitlement row left over from a reversal (QA P2-BUG-02).
    if (err.message?.includes('UNIQUE constraint failed')) {
      const where = err.message.match(/UNIQUE constraint failed: ([a-z_]+).([a-z_]+)/);
      const messages = {
        'users.email': 'อีเมลนี้มีอยู่ในระบบแล้ว',
        'members.phone': 'เบอร์โทรนี้มีอยู่ในระบบแล้ว',
        'members.member_code': 'รหัสสมาชิกซ้ำ กรุณาลองใหม่อีกครั้ง',
        'packages.code': 'รหัสแพ็กเกจนี้มีอยู่แล้ว กรุณาใช้รหัสอื่น',
        'entitlements.order_id': 'คำสั่งซื้อนี้มีสิทธิ์ที่ออกไว้แล้ว กรุณาโหลดหน้าใหม่แล้วตรวจสอบอีกครั้ง',
        'payment_slips.stored_name': 'บันทึกไฟล์สลิปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      };
      const key = where ? `${where[1]}.${where[2]}` : '';
      return res.status(409).json({ error: messages[key] ?? 'ข้อมูลนี้มีอยู่ในระบบแล้ว' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ไฟล์สลิปใหญ่เกิน 5 MB กรุณาถ่ายใหม่หรือย่อรูปก่อนอัปโหลด' });
    if (err.code?.startsWith?.('LIMIT_')) return res.status(400).json({ error: 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาแนบรูปสลิปเพียงไฟล์เดียว' });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'รูปแบบหรือขนาดข้อมูลไม่ถูกต้อง' });
    // Never log request bodies, credentials, SQL values, or raw database errors.
    // The id is returned as well as logged, so a support call can be matched to
    // the log line without asking the caller to describe what they did.
    const requestId = randomUUID();
    console.error(JSON.stringify({ event: 'request_error', request_id: requestId }));
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง', request_id: requestId });
  });
  return app;
}
