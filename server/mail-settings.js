// The screen where the gym owner turns email on.
//
// Everything about this file follows from one fact: the only person who knows
// the mailbox password is the gym owner, and the only screen the gym owner can
// reach is this app. So the password arrives through a form over HTTPS, is
// sealed before it touches the disk, and never comes back out to a browser.
// What the screen gets instead is "มีรหัสผ่านอยู่แล้ว" and a button that
// proves it by sending an actual letter.

import { z } from 'zod';
import { audit, transaction } from './db.js';
import { explainFailure, mailSettingsRow } from './mail.js';
import { hasKey, open, seal } from './secret-box.js';
import { HttpError, parse } from './validation.js';

const mailSchema = z.object({
  host: z.string().trim().min(1, 'กรุณากรอกชื่อเซิร์ฟเวอร์อีเมล').max(190),
  port: z.coerce.number().int().min(1).max(65535),
  starttls: z.coerce.boolean().optional(),
  username: z.string().trim().max(254),
  // Absent means "leave the one that is already stored alone", which is what
  // a form that cannot show the current value has to mean. An explicit empty
  // string is how the owner clears it.
  password: z.string().max(400).optional(),
  from_email: z.string().trim().toLowerCase().max(254),
  from_name: z.string().trim().max(120).optional(),
  version: z.number().int().positive(),
}).strict();

/**
 * The settings a send needs, unsealed, or null.
 *
 * Read fresh on every letter rather than cached at boot: the owner fixing a
 * typo should fix the next letter, not the one after the next restart.
 */
export function loadMailConfig(db) {
  const row = mailSettingsRow(db);
  if (!row?.password_sealed || !row.host || !row.username || !row.from_email) return null;
  const password = open(row.password_sealed);
  if (!password) return null;
  return {
    host: row.host, port: row.port, starttls: !!row.starttls,
    username: row.username, password,
    from_email: row.from_email, from_name: row.from_name,
  };
}

export function registerMailSettingsRoutes({ app, db, now, admin, counter, limit, mailer, gymName }) {
  /**
   * What the screen shows. The password is represented by a boolean and
   * nothing else -- there is no route in this system that returns it, so
   * there is no route to get it wrong.
   */
  function view(isOwner = true) {
    const row = mailSettingsRow(db) ?? {};
    // Staff open the settings screen to read the gym's LINE ID out to a
    // member, and the tab is there for them too -- but all they get is the one
    // sentence that answers "is email working?". No fields, and above all no
    // hint about the mailbox the gym signs in with (Designer, screen 8).
    if (!isOwner) return { staff: true, ready: loadMailConfig(db) !== null };
    return {
      // Without the key in .env there is nowhere safe to put the password, so
      // the form is shown disabled with the one command that fixes it rather
      // than accepting a password it would have to store in the clear.
      key_ready: hasKey(),
      host: row.host ?? 'smtp.office365.com',
      port: row.port ?? 587,
      starttls: !!(row.starttls ?? 1),
      username: row.username ?? '',
      from_email: row.from_email ?? '',
      from_name: row.from_name ?? '',
      has_password: !!row.password_sealed,
      // Whether a letter sent right now would actually go out. Separate from
      // has_password: a password sealed with a key that has since been
      // replaced unseals to nothing, and the screen must say so.
      ready: loadMailConfig(db) !== null,
      tested_at: row.tested_at ?? null,
      test_ok: !!row.test_ok,
      test_detail: row.test_detail ?? '',
      // Which of the three groups the last failure fell into, so a reload
      // draws the right set of steps rather than only the moment it happened.
      test_reason: row.test_reason ?? '',
      // Folded away on screen, never the first thing shown.
      test_raw: row.test_raw ?? '',
      version: row.version ?? 1,
    };
  }

  app.get('/api/gym/mail-settings', counter, (req, res) => res.json(view(req.user.role === 'admin')));

  app.put('/api/gym/mail-settings', admin, (req, res) => {
    const input = parse(mailSchema, req.body);
    if (!hasKey()) {
      throw new HttpError(409, 'เครื่องนี้ยังไม่มีคีย์สำหรับเก็บรหัสผ่านอย่างปลอดภัย '
        + 'ผู้ดูแลเครื่องต้องตั้ง SETTINGS_ENC_KEY ใน .env แล้วรีสตาร์ตก่อน');
    }
    if (input.username && !input.from_email) {
      throw new HttpError(400, 'กรุณากรอกอีเมลผู้ส่ง');
    }
    const result = transaction(db, () => {
      const before = mailSettingsRow(db);
      if ((before?.version ?? 1) !== input.version) {
        throw new HttpError(409, 'การตั้งค่าเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่ก่อนบันทึก');
      }
      // Three states, and they are not the same: absent keeps what is stored,
      // a value replaces it, an empty string clears it.
      const sealed = input.password === undefined ? (before?.password_sealed ?? '')
        : (input.password === '' ? '' : seal(input.password));
      db.prepare(`UPDATE mail_settings SET host=?,port=?,starttls=?,username=?,password_sealed=?,
        from_email=?,from_name=?,version=version+1,updated_at=? WHERE id=1`)
        .run(input.host, input.port, input.starttls === false ? 0 : 1, input.username, sealed,
          input.from_email, input.from_name ?? '', now());
      // The password is not in the audit row, and neither is its sealed form:
      // what is worth knowing later is who changed the mailbox and when.
      audit(db, req.user.id, 'gym.mail_settings_changed', 'mail_settings', null,
        { host: input.host, username: input.username, from_email: input.from_email,
          password_changed: input.password !== undefined }, now());
      return view();
    });
    res.json(result);
  });

  /**
   * "Send a test letter to myself."
   *
   * To the address of whoever pressed it, never to an address typed into the
   * form: a button that posts to an arbitrary address is a button that sends
   * mail on behalf of this gym to anybody.
   *
   * The answer is the real one. A green tick that only means "we saved your
   * settings" is worse than no button, because the owner then walks away
   * believing mail works.
   */
  app.post('/api/gym/mail-settings/test', admin, async (req, res) => {
    // Five in ten minutes. Generous for somebody fixing a password and
    // retrying, and not enough to be worth pointing at a mailbox -- this is
    // the one button in the system that makes the gym's own domain send mail.
    limit(`mailtest:${req.user.id}`, 5, 600000);
    const config = loadMailConfig(db);
    if (!config) {
      throw new HttpError(409, 'ยังกรอกไม่ครบ ต้องมีชื่อเซิร์ฟเวอร์ ชื่อผู้ใช้ รหัสผ่าน และอีเมลผู้ส่ง ก่อนส่งทดสอบ');
    }
    // Caught here as well as on the screen, because the screen can only check
    // what it can see: Microsoft refuses this with a message that reads like a
    // wrong password, and an owner who retypes the password ten times is an
    // owner nobody helped.
    if (config.from_email !== config.username) {
      throw new HttpError(409, 'อีเมลผู้ส่งไม่ตรงกับชื่อผู้ใช้ที่ล็อกอิน — Microsoft จะปฏิเสธ '
        + 'และขึ้นข้อความที่อ่านเหมือนรหัสผ่านผิด ให้ใช้กล่องเดียวกันทั้งสองช่อง');
    }
    const gym = gymName();
    const when = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' })
      .format(new Date(now()));
    const outcome = await mailer.send({
      to: req.user.email,
      senderName: gym,
      subject: `ทดสอบการส่งอีเมลของ ${gym}`,
      text: [
        `ถ้าคุณอ่านข้อความนี้อยู่ แปลว่าระบบของ ${gym} ส่งอีเมลออกได้แล้ว`,
        '',
        `ส่งจาก: ${config.from_email}`,
        `เวลาที่ส่ง: ${when}`,
        '',
        'ตั้งแต่นี้ไป ลิงก์ลืมรหัสผ่านและอีเมลต้อนรับสมาชิกจะถูกส่งออกอัตโนมัติ',
        'ไม่ต้องคัดลอกลิงก์ส่งเองอีก',
      ].join('\n'),
    });
    transaction(db, () => {
      db.prepare('UPDATE mail_settings SET tested_at=?,test_ok=?,test_detail=?,test_reason=?,test_raw=? WHERE id=1')
        .run(now(), outcome.sent ? 1 : 0, outcome.sent ? '' : (outcome.message ?? ''),
          outcome.sent ? '' : (outcome.reason ?? 'unknown'),
          outcome.sent ? '' : String(outcome.raw ?? '').slice(0, 4000));
    });
    if (!outcome.sent) {
      return res.status(502).json({
        sent: false,
        error: outcome.message ?? explainFailure({}).message,
        reason: outcome.reason ?? 'unknown',
        raw: String(outcome.raw ?? '').slice(0, 4000),
      });
    }
    res.json({ sent: true, to: req.user.email, message: `ส่งแล้ว เปิดกล่องจดหมายของ ${req.user.email} เพื่อดู` });
  });
}
