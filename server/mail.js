// Sending an email, or writing down that we would have.
//
// The gym already has a mailbox -- `info@` on the gym's own Office 365 -- and
// staff already read it. Sending through that costs nothing, needs no new
// account, and the recipient sees an address they would recognise. So this
// talks SMTP to smtp.office365.com on 587: the connection opens in the clear,
// STARTTLS upgrades it before anything is typed, and AUTH LOGIN signs in.
//
// Where the settings come from is the part worth reading. NOT `.env`: the
// person who knows the mailbox password is the gym owner, and the only screen
// the gym owner can reach is this app. They type it into "ตั้งค่าอีเมล" and it
// is sealed into the database (server/secret-box.js). Nobody has to paste a
// mailbox password into a chat for a developer to put it in a file.
//
// Until it is filled in the mailer still "works": it writes a line to the log
// with the address and the subject and reports that it did not send. Every
// flow above it is therefore finished and testable now, and the owner turning
// mail on is a form rather than a deploy.

import nodemailer from 'nodemailer';

/** Reads the one row, or null when the table is not there (older fixture). */
export function mailSettingsRow(db) {
  try { return db.prepare('SELECT * FROM mail_settings WHERE id=1').get() ?? null; }
  catch { return null; }
}

/**
 * Turns whatever went wrong into something a gym owner can act on.
 *
 * Three answers, because there are only three things they can do about it:
 * fix the password (or get Authenticated SMTP turned on), fix the address, or
 * tell whoever runs the network. The provider's own English wording is kept in
 * `detail` for the log and for us, never shown as the whole answer.
 */
export function explainFailure(error) {
  const code = error?.responseCode ?? error?.code ?? '';
  const text = `${error?.response ?? ''} ${error?.message ?? ''}`;
  if (code === 535 || /5\.7\.139|535|authenticate/i.test(text)) {
    return {
      reason: 'auth',
      message: 'รหัสผ่านไม่ถูกต้อง หรือกล่องนี้ยังไม่ได้เปิด Authenticated SMTP '
        + '— ถ้ากล่องเปิดยืนยันตัวตนสองขั้น ต้องใช้ App password ไม่ใช่รหัสปกติ',
    };
  }
  if (code === 550 || code === 553 || /5\.7\.60|SendAsDenied/i.test(text)) {
    return {
      reason: 'sender',
      message: 'กล่องนี้ส่งในนามอีเมลผู้ส่งที่กรอกไว้ไม่ได้ — ให้อีเมลผู้ส่งตรงกับชื่อผู้ใช้ที่ล็อกอิน',
    };
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ESOCKET', 'EDNS', 'ECONNECTION'].includes(code)) {
    return { reason: 'network', message: 'เชื่อมต่อเซิร์ฟเวอร์อีเมลไม่ได้ — ตรวจชื่อเซิร์ฟเวอร์ พอร์ต และการเชื่อมต่อขาออกของเครื่อง' };
  }
  return { reason: 'unknown', message: 'ส่งไม่สำเร็จ ยังไม่ทราบสาเหตุ — ดูรายละเอียดใน log ของเซิร์ฟเวอร์' };
}

/**
 * @param {object} options
 * @param {() => (object|null)} options.load  the current settings, read fresh
 *   on every send: the owner can fix a typo and the next letter uses it,
 *   without restarting the counter.
 * @param {Function} [options.transportFor]  swapped out in tests
 */
export function createMailer({ load = () => null, transportFor = nodemailer.createTransport } = {}) {
  const build = () => {
    const config = load();
    if (!config?.host || !config?.username || !config?.password || !config?.from_email) return null;
    return {
      config,
      transport: transportFor({
        host: config.host,
        port: config.port,
        // 587 is STARTTLS, which nodemailer spells `secure: false` plus a
        // refusal to continue unencrypted. Without requireTLS a server that
        // fails to offer STARTTLS would get the password in the clear.
        secure: !config.starttls,
        requireTLS: !!config.starttls,
        auth: { user: config.username, pass: config.password },
        // Long enough for a slow evening, short enough that a member standing
        // at the counter is not watching a spinner because of a mail server.
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      }),
    };
  };

  /**
   * Never throws. A gym must not fail to record a decision because a mail
   * server was slow, and the caller has no better answer than we have: the
   * outcome is written down either way and the person can be told in the room.
   */
  async function send({ to, subject, text, html, senderName, attachments }) {
    if (!to || !subject) return { sent: false, reason: 'incomplete' };
    const built = build();
    if (!built) {
      // The address is logged, the body is not: these messages carry one-time
      // links, and a link in a log file is a link somebody can use.
      console.log(JSON.stringify({ event: 'mail_skipped', to, subject, reason: 'not_configured' }));
      return { sent: false, reason: 'not_configured' };
    }
    const { config, transport } = built;
    try {
      await transport.sendMail({
        // The name is the gym's, never the word no-reply. nodemailer builds
        // the RFC 2047 encoding of a Thai name and the multipart/alternative
        // from these two bodies.
        from: { name: senderName || config.from_name || 'ระบบจัดการยิม', address: config.from_email },
        to,
        subject,
        text,
        ...(html ? { html } : {}),
        ...(attachments?.length ? { attachments } : {}),
      });
      console.log(JSON.stringify({ event: 'mail_sent', to, subject }));
      return { sent: true };
    } catch (error) {
      const failure = explainFailure(error);
      // The server's own message is logged; it does not echo the body, so it
      // does not echo the link.
      console.error(JSON.stringify({ event: 'mail_failed', to, subject, reason: failure.reason,
        detail: String(error?.response ?? error?.message ?? '').slice(0, 200) }));
      return { sent: false, reason: failure.reason, message: failure.message };
    }
  }

  /** Whether a letter sent right now would go anywhere. */
  const ready = () => build() !== null;

  return { get ready() { return ready(); }, send };
}

/**
 * The one message the Designer did not write, because it never leaves the
 * gym: the note telling the owner that somebody is waiting. The letters that
 * reach an applicant or a member live in server/emails/ and are filled in by
 * server/letters.js.
 */
export function ownerNotice({ gym, name, email, phone }) {
  const lines = [
    `มีคนขอบัญชีพนักงานในระบบของ ${gym}`,
    '',
    `ชื่อ: ${name || '—'}`,
    `อีเมล: ${email}`,
    `เบอร์โทร: ${phone || '—'}`,
    '',
    'เปิดเมนู “ผู้ใช้และสิทธิ์” เพื่ออนุมัติและกำหนดสิทธิ์ หรือปฏิเสธคำขอนี้',
    'อนุมัติเฉพาะคนที่คุณรู้จักตัวจริงเท่านั้น ถ้าไม่แน่ใจ โทรตามเบอร์ข้างบนก่อน',
  ];
  return { subject: `มีคำขอใช้งานระบบรออนุมัติ — ${gym}`, text: lines.join('\n') };
}
