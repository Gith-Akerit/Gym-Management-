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
 * Three groups, because there are exactly three different things the owner
 * has to go and do -- and telling them apart is the whole job of this
 * function. The two that both arrive as "535 authentication unsuccessful" are
 * the ones that matter: one means "Microsoft has this switched off for the
 * mailbox" and the other means "the password is wrong". Reading them as one
 * sends the owner off to retype a password that was never the problem
 * (Designer).
 *
 * `raw` is what the server actually said. It is not the answer -- a gym owner
 * who reads `SmtpClientAuthentication is disabled` closes the page and
 * telephones us -- but it is what gets forwarded to whoever runs Microsoft
 * 365, so the screen keeps it folded away rather than throwing it out.
 */
export function explainFailure(error) {
  const code = error?.responseCode ?? error?.code ?? '';
  const text = `${error?.response ?? ''} ${error?.message ?? ''}`;
  const raw = [
    error?.response,
    error?.message && error.message !== error?.response ? error.message : null,
    code ? `code: ${code}` : null,
  ].filter(Boolean).join('\n');

  // Microsoft's own switch, off by default on every mailbox they sell. Checked
  // before the general 535 because it IS a 535, and it is not a wrong password.
  if (/SmtpClientAuthentication|5\.7\.139|smtp_auth_disabled/i.test(text)) {
    return {
      reason: 'smtp_disabled', raw,
      message: 'กล่องนี้ยังไม่ได้เปิดให้โปรแกรมส่งเมลแทน — Microsoft ปิดไว้เป็นค่าเริ่มต้นทุกกล่อง '
        + 'นี่ไม่ใช่รหัสผ่านผิด ต้องให้ผู้ดูแล Microsoft 365 ติ๊กเปิด Authenticated SMTP ให้กล่องนี้หนึ่งครั้ง',
    };
  }
  if (code === 535 || /5\.7\.3|authentication unsuccessful|invalid credentials|auth.*fail/i.test(text)) {
    return {
      reason: 'password', raw,
      message: 'Microsoft ไม่รับรหัสผ่านนี้ — ถ้ากล่องเปิดยืนยันตัวตนสองขั้น ต้องใช้ App password 16 ตัว '
        + 'ไม่ใช่รหัสปกติ และอีเมลผู้ส่งต้องเป็นกล่องเดียวกับเจ้าของรหัสนั้น',
    };
  }
  // Kept as its own answer rather than folded into "password": the fix is a
  // different field on the same screen, and the message Microsoft returns is
  // otherwise indistinguishable from a wrong password to somebody reading it.
  if (code === 550 || code === 553 || /5\.7\.60|SendAsDenied/i.test(text)) {
    return {
      reason: 'sender', raw,
      message: 'กล่องนี้ส่งในนามอีเมลผู้ส่งที่กรอกไว้ไม่ได้ — ให้อีเมลผู้ส่งตรงกับชื่อผู้ใช้ที่ล็อกอิน',
    };
  }
  // QA-02: a server that does not offer STARTTLS. `requireTLS` refuses to
  // continue, which is the right answer -- failing to send beats sending the
  // gym's mailbox password in the clear -- but the owner who caused it by
  // typing port 25 or 465 was told "cause unknown", which they cannot act on.
  if (/STARTTLS|does not support|not supported|SSL routines|wrong version number/i.test(text)
    || code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    return {
      reason: 'no_tls', raw,
      message: 'เซิร์ฟเวอร์นี้ไม่รองรับการเข้ารหัส ระบบจึงไม่ยอมส่งรหัสผ่านออกไป — '
        + 'เกือบทุกครั้งคือพิมพ์ชื่อเซิร์ฟเวอร์หรือพอร์ตผิด Microsoft 365 ใช้ smtp.office365.com พอร์ต 587 เท่านั้น',
    };
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ESOCKET', 'EDNS', 'ECONNECTION', 'EAI_AGAIN']
    .includes(code) || /timed? ?out|getaddrinfo|socket/i.test(text)) {
    return {
      reason: 'network', raw,
      message: 'ต่อเซิร์ฟเวอร์อีเมลไม่ได้ — ตรวจว่าชื่อเซิร์ฟเวอร์และพอร์ตถูกต้อง '
        + '(Microsoft 365 ใช้ smtp.office365.com พอร์ต 587 เท่านั้น) หรือเครื่องถูกบล็อกพอร์ตขาออกไว้',
    };
  }
  // The fourth case exists so that an answer nobody anticipated still lands on
  // a screen that says what to do next, instead of a blank red box.
  return {
    reason: 'unknown', raw,
    message: 'ส่งไม่สำเร็จ และยังไม่ทราบสาเหตุ — กดแจ้งปัญหาพร้อมข้อความจากเซิร์ฟเวอร์ด้านล่าง ทีมดูแลตรวจให้ได้',
  };
}

/**
 * Office 365 accepts about 30 messages a minute from one mailbox and starts
 * refusing above that, so letters leave through a queue with a gap between
 * them rather than all at once.
 *
 * This gym will never come close on an ordinary day -- a few cards, the odd
 * password link. It matters on the day somebody imports a membership list, or
 * a script goes wrong: without the gap, the mailbox is throttled and the
 * letters that get refused are indistinguishable from a wrong password on the
 * settings screen. Two seconds between sends costs nothing and removes the
 * whole class of problem.
 */
export const SEND_GAP_MS = 2100;

/**
 * @param {object} options
 * @param {() => (object|null)} options.load  the current settings, read fresh
 *   on every send: the owner can fix a typo and the next letter uses it,
 *   without restarting the counter.
 * @param {Function} [options.transportFor]  swapped out in tests
 * @param {number} [options.gapMs]  0 in tests, so a suite does not wait out
 *   the real throttle for letters that go nowhere
 */
export function createMailer({ load = () => null, transportFor = nodemailer.createTransport,
  gapMs = SEND_GAP_MS, sleep = ms => new Promise(done => setTimeout(done, ms)),
  clock = Date.now } = {}) {
  // One queue for the whole process. Serial on purpose: two letters in flight
  // at once is two letters arriving inside the same second.
  let tail = Promise.resolve();
  let lastSentAt = 0;
  function queued(work) {
    const mine = tail.then(async () => {
      const wait = gapMs - (clock() - lastSentAt);
      if (wait > 0) await sleep(wait);
      try { return await work(); } finally { lastSentAt = clock(); }
    });
    // The chain must not break when one letter fails, or every letter after it
    // is stuck behind a rejected promise forever.
    tail = mine.then(() => undefined, () => undefined);
    return mine;
  }

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
      await queued(() => transport.sendMail({
        // The name is the gym's, never the word no-reply. nodemailer builds
        // the RFC 2047 encoding of a Thai name and the multipart/alternative
        // from these two bodies.
        from: { name: senderName || config.from_name || 'ระบบจัดการยิม', address: config.from_email },
        to,
        subject,
        text,
        ...(html ? { html } : {}),
        ...(attachments?.length ? { attachments } : {}),
      }));
      console.log(JSON.stringify({ event: 'mail_sent', to, subject }));
      return { sent: true };
    } catch (error) {
      const failure = explainFailure(error);
      // The server's own message is logged; it does not echo the body, so it
      // does not echo the link.
      console.error(JSON.stringify({ event: 'mail_failed', to, subject, reason: failure.reason,
        detail: String(error?.response ?? error?.message ?? '').slice(0, 200) }));
      return { sent: false, reason: failure.reason, message: failure.message, raw: failure.raw };
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
