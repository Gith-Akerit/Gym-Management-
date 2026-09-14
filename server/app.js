import express from 'express';
import helmet from 'helmet';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { registerCheckInRoutes } from './checkin.js';
import { otpCodeHash } from './otp.js';
import { registerPaymentRoutes } from './payments.js';
import { audit, createMember, expireStaleOrders, getGym, getMember, getPackage, memberSelect, publicGym, publicMember, publicPackage, transaction } from './db.js';
import { email, gymSchema, hoursSchema, HttpError, memberSchema, packageSchema, packageUpdateSchema, parse, profileSchema, roleSchema, updateSchema, userSchema } from './validation.js';

const digest = value => createHash('sha256').update(value).digest('hex');
/** Dead check-in tokens are kept a week, then deleted. */
export const CHECK_IN_TOKEN_RETENTION_MS = 7 * 86400000;
export function createApp({ db, sendOtp, secret, origin = 'http://localhost:5173', production = false,
  now = Date.now, trustProxy = 1, slipStore, promptPayId, pilotMode = false }) {
  if (!secret || secret.length < 32) throw new Error('OTP_SECRET must have at least 32 characters');
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
    if (count.hits > max) throw new HttpError(429, 'ขอรหัสหรือลองยืนยันบ่อยเกินไป กรุณารอ 15 นาที');
  }
  // A per-challenge attempt cap alone is not enough: an attacker can request a
  // fresh challenge after every 5 guesses. This bounds guesses per address.
  const OTP_MAX_FAILURES = 5, OTP_LOCK_MS = 900000;
  function assertNotLockedOut(address) {
    const row = db.prepare('SELECT locked_until FROM otp_lockouts WHERE email=?').get(address);
    if (row?.locked_until && row.locked_until > now()) {
      throw new HttpError(429, 'ยืนยันรหัสผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วขอรหัสใหม่');
    }
  }
  function recordOtpFailure(address) {
    db.prepare(`INSERT INTO otp_lockouts(email,failures,updated_at) VALUES(?,1,?)
      ON CONFLICT(email) DO UPDATE SET
        failures=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN 1 ELSE failures+1 END,
        locked_until=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN NULL ELSE locked_until END,
        updated_at=?`).run(address, now(), now(), now(), now());
    db.prepare('UPDATE otp_lockouts SET locked_until=? WHERE email=? AND failures>=? AND locked_until IS NULL')
      .run(now() + OTP_LOCK_MS, address, OTP_MAX_FAILURES);
  }
  const clearOtpFailures = address => db.prepare('DELETE FROM otp_lockouts WHERE email=?').run(address);

  // Expired challenges, sessions and rate-limit buckets are swept here rather
  // than in start.js, so every entry point that builds an app gets the cleanup.
  const sweep = () => {
    db.prepare('DELETE FROM otp_challenges WHERE expires_at<?').run(now() - 900000);
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
    db.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(now());
    db.prepare('DELETE FROM otp_lockouts WHERE locked_until IS NOT NULL AND locked_until<?').run(now() - 900000);
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
   * Pilot mode: the gym is trying the system before it has a mail provider or
   * a PromptPay account, so the OTP is read out at the counter instead of
   * emailed. The codes live here and nowhere else -- never in the database,
   * never past a restart, and never in anything a member can fetch. Reading one
   * is the same as being able to sign in as that person, which is why only an
   * admin can.
   */
  const pilotCodes = [];
  const rememberPilotCode = entry => {
    pilotCodes.unshift(entry);
    pilotCodes.length = Math.min(pilotCodes.length, 50);
  };
  const livePilotCodes = () => pilotCodes.filter(entry => entry.expires_at > now());
  /** Consumed codes are dropped: showing a used one only invites retyping it. */
  const pilotCodeFor = email => livePilotCodes().find(entry => entry.email === email
    && !db.prepare('SELECT consumed_at FROM otp_challenges WHERE id=?').get(entry.id)?.consumed_at);

  // Exposed the same way app.locals.sweep is: something outside the request
  // path -- an operator, a test harness -- occasionally needs the live list.
  app.locals.pilotCodes = livePilotCodes;

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // The login screen has to say "ask the staff for your code" instead of "check
  // your email" before anyone has signed in, so this one fact is public.
  app.get('/api/public/config', (req, res) => res.json({ pilot_mode: pilotMode }));

  // Anyone may read what the gym advertises: opening hours, address, the phone
  // number staff chose to publish, and the packages actually on sale. Somebody
  // deciding whether to join should not have to create an account first.
  app.get('/api/public/gym', (req, res) => res.json(publicGym(db)));
  app.get('/api/public/packages', (req, res) => res.json({
    items: db.prepare("SELECT * FROM packages WHERE status='active' ORDER BY sort_order, created_at")
      .all().map(publicPackage),
  }));
  app.post('/api/auth/request-otp', async (req, res) => {
    limit(`request-ip:${req.ip}`, 40, 900000);
    const input = parse(z.object({ email }).strict(), req.body);
    limit(`request-email:${input.email}`, 5, 900000);
    assertNotLockedOut(input.email);
    const last = db.prepare('SELECT created_at FROM otp_challenges WHERE email=? ORDER BY created_at DESC LIMIT 1').get(input.email);
    if (last && last.created_at > now() - 60000) throw new HttpError(429, 'กรุณารอ 60 วินาทีก่อนขอรหัสใหม่');
    const id = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
    transaction(db, () => {
      db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL').run(now(), input.email);
      db.prepare('INSERT INTO otp_challenges(id,email,code_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
        .run(id, input.email, otpCodeHash(secret, id, code), now(), now() + 300000);
    });
    if (pilotMode) {
      rememberPilotCode({ id, email: input.email, code, created_at: now(), expires_at: now() + 300000 });
    } else {
      try { await sendOtp({ email: input.email, code }); }
      catch {
        db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE id=?').run(now(), id);
        throw new HttpError(503, 'ส่งอีเมลไม่สำเร็จ กรุณาลองอีกครั้งใน 60 วินาที');
      }
    }
    // pilot_mode tells the screen which sentence to show. The code itself is
    // never in this response: the member is the one person who must not be able
    // to read it without asking a human.
    res.status(202).json({ challenge_id: id, expires_in: 300, retry_after: 60, ...(pilotMode && { pilot_mode: true }) });
  });
  function me(user) {
    return { email: user.email, role: user.role,
      member: publicMember(db.prepare(`${memberSelect} WHERE m.user_id=?`).get(user.id)) };
  }
  app.post('/api/auth/verify-otp', (req, res) => {
    limit(`verify-ip:${req.ip}`, 120, 900000);
    const input = parse(z.object({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/, 'กรอกรหัส 6 หลัก') }).strict(), req.body);
    const c = db.prepare('SELECT * FROM otp_challenges WHERE id=?').get(input.challenge_id);
    const invalid = () => new HttpError(400, 'รหัสไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว กรุณาขอรหัสใหม่');
    if (!c || c.consumed_at !== null || c.expires_at <= now() || c.attempts >= 5) throw invalid();
    assertNotLockedOut(c.email);
    db.prepare('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?').run(c.id);
    if (!timingSafeEqual(Buffer.from(c.code_hash, 'hex'), Buffer.from(otpCodeHash(secret, c.id, input.code), 'hex'))) {
      recordOtpFailure(c.email);
      throw invalid();
    }
    // Only now, with the right code in hand. Checking the suspension first told
    // anybody typing digits at an address which accounts are suspended, because
    // a wrong guess came back 403 there and 400 everywhere else (QA USR-10).
    // The person holding the mailbox gets the real reason; a stranger does not.
    if (db.prepare("SELECT 1 FROM users WHERE email=? AND status='suspended'").get(c.email)) {
      throw new HttpError(403, 'บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ');
    }
    const token = randomBytes(32).toString('base64url');
    const result = transaction(db, () => {
      const consumed = db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now(), c.id);
      if (consumed.changes !== 1) throw invalid();
      db.prepare(`INSERT INTO users(id,email,email_verified_at,created_at) VALUES(?,?,?,?)
        ON CONFLICT(email) DO UPDATE SET email_verified_at=excluded.email_verified_at`).run(randomUUID(), c.email, now(), now());
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(c.email);
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, now() + 43200000);
      clearOtpFailures(c.email);
      return me(user);
    });
    if (req.get('X-Gym-Client') === 'mobile') return res.json({ ...result, token, expires_in: 43200 });
    res.cookie('gym_session', token, { httpOnly: true, secure: production, sameSite: 'strict', maxAge: 43200000, path: '/api' });
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
  app.put('/api/me/profile', (req, res) => {
    if (req.user.role !== 'member') throw new HttpError(403, 'สำหรับบัญชีสมาชิกเท่านั้น');
    const input = parse(profileSchema, req.body);
    if (db.prepare('SELECT 1 FROM members WHERE user_id=?').get(req.user.id)) throw new HttpError(409, 'มีโปรไฟล์แล้ว กรุณาติดต่อพนักงานเพื่อแก้ไข');
    const member = transaction(db, () => createMember(db, req.user.id, input, req.user.id, now()));
    res.status(201).json(member);
  });
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : next(new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น'));

  // Phase 2: buying a package with PromptPay, uploading a slip, admin review.
  // In pilot mode there is no PromptPay account yet, but the admin still needs
  // to hand out packages and read the orders that result.
  if (slipStore && (promptPayId || pilotMode)) {
    registerPaymentRoutes({ app, db, now, admin, slipStore, promptPayId, pilotMode });
  }

  // Phase 3: QR check-in at the counter.
  registerCheckInRoutes({ app, db, now, admin, secret, limit });
  app.get('/api/members', admin, (req, res) => {
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
    const total = db.prepare(`SELECT count(*) AS total FROM members m JOIN users u ON u.id=m.user_id ${where}`).get(...params).total;
    const items = db.prepare(`${memberSelect} ${where} ORDER BY m.joined_at DESC,m.id LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size).map(publicMember);
    res.json({ items, total, page, limit: size });
  });
  app.post('/api/members', admin, (req, res) => {
    const input = parse(memberSchema, req.body);
    const result = transaction(db, () => {
      let user = db.prepare('SELECT * FROM users WHERE email=?').get(input.email);
      if (user && (user.role !== 'member' || db.prepare('SELECT 1 FROM members WHERE user_id=?').get(user.id))) {
        throw new HttpError(409, 'อีเมลหรือเบอร์โทรนี้มีอยู่ในระบบแล้ว');
      }
      if (!user) {
        user = { id: randomUUID() };
        db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(user.id, input.email, now());
      }
      return createMember(db, user.id, input, req.user.id, now());
    });
    res.status(201).json(result);
  });
  app.get('/api/members/:id', admin, (req, res) => {
    const row = getMember(db, req.params.id);
    if (!row) throw new HttpError(404, 'ไม่พบสมาชิก');
    // In pilot mode the member is standing at the counter asking for their
    // code, so it belongs on the screen the staff member already has open.
    const pilot = pilotMode ? pilotCodeFor(row.email) : undefined;
    res.json({
      ...publicMember(row),
      ...(pilotMode && { pilot_otp: pilot ? { code: pilot.code, expires_at: pilot.expires_at } : null }),
    });
  });

  /**
   * Every code requested recently, newest first. The list is what makes pilot
   * mode workable: a member messages "I am trying to log in" and the staff
   * member reads their code off this screen.
   */
  app.get('/api/admin/pilot/otp-codes', admin, (req, res) => {
    if (!pilotMode) throw new HttpError(404, 'ไม่พบรายการที่ต้องการ');
    const consumed = new Set(db.prepare(`SELECT id FROM otp_challenges WHERE consumed_at IS NOT NULL
      AND expires_at > ?`).all(now() - 300000).map(row => row.id));
    res.json({
      items: livePilotCodes().map(entry => ({
        email: entry.email, code: entry.code, created_at: entry.created_at,
        expires_at: entry.expires_at, used: consumed.has(entry.id),
      })),
    });
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
      if (values.email !== before.email) {
        db.prepare('UPDATE users SET email=?,email_verified_at=NULL WHERE id=?').run(values.email, before.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(before.user_id);
        db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE email IN (?,?)').run(now(), before.email, values.email);
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

  const publicUser = row => ({
    id: row.id, email: row.email, role: row.role, status: row.status,
    created_at: row.created_at, email_verified_at: row.email_verified_at,
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

  app.post('/api/users', admin, (req, res) => {
    const input = parse(userSchema, req.body);
    const created = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(input.email)) {
        throw new HttpError(409, 'อีเมลนี้มีบัญชีอยู่แล้ว เปลี่ยนสิทธิ์ของบัญชีเดิมแทนได้');
      }
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, input.email, input.role, now());
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
