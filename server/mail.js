// Sending an email, or writing down that we would have.
//
// One file on purpose. The gym has no domain yet, which rules out every
// provider that requires SPF and DKIM on a domain we do not control, so the
// first one is Brevo -- it verifies a single sender address instead. That is a
// decision about today, not forever: when the gym buys a domain the sensible
// move is Resend, and the only thing that should have to change is the body of
// `send` below.
//
// Until an API key exists the mailer still "works": it writes a line to the
// log with the address and the subject and reports that it did not send. Every
// flow above it is therefore finished and testable now, and turning mail on is
// one environment variable rather than a second pass over the code.

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/**
 * @param {object} options
 * @param {string} [options.apiKey]  BREVO_API_KEY; absent means log-only
 * @param {string} [options.from]    the verified sender address
 * @param {string} [options.fromName] what the recipient sees as the sender
 */
export function createMailer({ apiKey = '', from = '', fromName = 'ระบบจัดการยิม', fetchImpl = fetch } = {}) {
  const ready = !!(apiKey && from);

  /**
   * Never throws. A gym must not fail to record a decision because a mail
   * provider was slow, and the caller has no better answer than we have: the
   * outcome is written down either way and the person can be told in the room.
   */
  async function send({ to, subject, text, html, senderName }) {
    if (!to || !subject) return { sent: false, reason: 'incomplete' };
    if (!ready) {
      // The address is logged, the body is not: these messages carry one-time
      // links, and a link in a log file is a link somebody can use.
      console.log(JSON.stringify({ event: 'mail_skipped', to, subject, reason: 'no_api_key' }));
      return { sent: false, reason: 'not_configured' };
    }
    try {
      const response = await fetchImpl(BREVO_ENDPOINT, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        // Both halves, plain text first in spirit: the provider builds the
        // multipart/alternative and the UTF-8 and RFC 2047 encoding from these
        // two fields. The sender name is the gym's, never the word no-reply.
        body: JSON.stringify({
          sender: { email: from, name: senderName || fromName },
          to: [{ email: to }],
          subject,
          textContent: text,
          ...(html ? { htmlContent: html } : {}),
        }),
      });
      if (!response.ok) {
        // The provider's own message is not logged: it echoes the request,
        // which contains the link.
        console.error(JSON.stringify({ event: 'mail_failed', to, subject, status: response.status }));
        return { sent: false, reason: `http_${response.status}` };
      }
      console.log(JSON.stringify({ event: 'mail_sent', to, subject }));
      return { sent: true };
    } catch {
      console.error(JSON.stringify({ event: 'mail_failed', to, subject, reason: 'network' }));
      return { sent: false, reason: 'network' };
    }
  }

  return { ready, send };
}

/**
 * The one message the Designer did not write, because it never leaves the
 * gym: the note telling the owner that somebody is waiting. The four letters
 * that reach an applicant live in server/emails/ and are filled in by
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
