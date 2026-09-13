import express from 'express';
import helmet from 'helmet';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audit, createMember, getGym, getMember, getPackage, memberSelect, publicGym, publicMember, publicPackage, transaction } from './db.js';
import { email, gymSchema, hoursSchema, HttpError, memberSchema, packageSchema, packageUpdateSchema, parse, profileSchema, updateSchema } from './validation.js';

const digest = value => createHash('sha256').update(value).digest('hex');
export function createApp({ db, sendOtp, secret, origin = 'http://localhost:5173', production = false, now = Date.now }) {
  if (!secret || secret.length < 32) throw new Error('OTP_SECRET must have at least 32 characters');
  if (production && !origin.startsWith('https://')) throw new Error('Production APP_ORIGIN must use HTTPS');
  const app = express();
  app.disable('x-powered-by');
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

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/auth/request-otp', async (req, res) => {
    limit(`request-ip:${req.ip}`, 20, 900000);
    const input = parse(z.object({ email }).strict(), req.body);
    limit(`request-email:${input.email}`, 5, 900000);
    assertNotLockedOut(input.email);
    const last = db.prepare('SELECT created_at FROM otp_challenges WHERE email=? ORDER BY created_at DESC LIMIT 1').get(input.email);
    if (last && last.created_at > now() - 60000) throw new HttpError(429, 'กรุณารอ 60 วินาทีก่อนขอรหัสใหม่');
    const id = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
    transaction(db, () => {
      db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL').run(now(), input.email);
      db.prepare('INSERT INTO otp_challenges(id,email,code_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
        .run(id, input.email, hmac(`${id}:${code}`), now(), now() + 300000);
    });
    try { await sendOtp({ email: input.email, code }); }
    catch {
      db.prepare('UPDATE otp_challenges SET consumed_at=? WHERE id=?').run(now(), id);
      throw new HttpError(503, 'ส่งอีเมลไม่สำเร็จ กรุณาลองอีกครั้งใน 60 วินาที');
    }
    res.status(202).json({ challenge_id: id, expires_in: 300, retry_after: 60 });
  });
  function me(user) {
    return { email: user.email, role: user.role,
      member: publicMember(db.prepare(`${memberSelect} WHERE m.user_id=?`).get(user.id)) };
  }
  app.post('/api/auth/verify-otp', (req, res) => {
    limit(`verify-ip:${req.ip}`, 60, 900000);
    const input = parse(z.object({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/, 'กรอกรหัส 6 หลัก') }).strict(), req.body);
    const c = db.prepare('SELECT * FROM otp_challenges WHERE id=?').get(input.challenge_id);
    const invalid = () => new HttpError(400, 'รหัสไม่ถูกต้อง หมดอายุ หรือใช้ไปแล้ว กรุณาขอรหัสใหม่');
    if (!c || c.consumed_at !== null || c.expires_at <= now() || c.attempts >= 5) throw invalid();
    assertNotLockedOut(c.email);
    db.prepare('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?').run(c.id);
    if (!timingSafeEqual(Buffer.from(c.code_hash, 'hex'), Buffer.from(hmac(`${c.id}:${input.code}`), 'hex'))) {
      recordOtpFailure(c.email);
      throw invalid();
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
    res.json(publicMember(row));
  });
  function update(req, deactivate = false) {
    const input = deactivate ? parse(z.object({ version: z.number().int().positive() }).strict(), req.body) : parse(updateSchema, req.body);
    return transaction(db, () => {
      const before = getMember(db, req.params.id);
      if (!before) throw new HttpError(404, 'ไม่พบสมาชิก');
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข');
      const values = deactivate ? { ...before, status: 'suspended' } : input;
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
  app.get('/api/gym', (req, res) => res.json(req.user.role === 'admin' ? getGym(db) : publicGym(db)));

  app.put('/api/gym', admin, (req, res) => {
    const input = parse(gymSchema, req.body);
    const result = transaction(db, () => {
      const before = db.prepare('SELECT * FROM gym_profile WHERE id=1').get();
      if (!before) throw new HttpError(409, 'ยังไม่ได้ตั้งค่าข้อมูลยิม กรุณารัน npm run db:seed ก่อน');
      if (before.version !== input.version) throw new HttpError(409, 'ข้อมูลเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข');
      db.prepare(`UPDATE gym_profile SET name=?,brand_name_th=?,address=?,location_note=?,phone_primary=?,
        phone_secondary=?,phone_display=?,hours_confirmed=?,hours_note=?,version=version+1,updated_at=? WHERE id=1`)
        .run(input.name, input.brand_name_th, input.address, input.location_note, input.phone_primary,
          input.phone_secondary, input.phone_display, input.hours_confirmed ? 1 : 0, input.hours_note, now());
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
    if (err.message?.includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'อีเมลหรือเบอร์โทรนี้มีอยู่ในระบบแล้ว' });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'รูปแบบหรือขนาดข้อมูลไม่ถูกต้อง' });
    // Never log request bodies, credentials, SQL values, or raw database errors.
    console.error(JSON.stringify({ event: 'request_error', request_id: randomUUID() }));
    res.status(500).json({ error: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  });
  return app;
}
