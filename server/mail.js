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
  async function send({ to, subject, text }) {
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
        body: JSON.stringify({
          sender: { email: from, name: fromName },
          to: [{ email: to }],
          subject,
          textContent: text,
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

/** The wording, in one place, so the screens and the mail cannot drift apart. */
export const letters = {
  signupReceived: ({ gym }) => ({
    subject: `ได้รับคำขอเข้าใช้งาน ${gym} แล้ว`,
    text: `เราได้รับคำขอเข้าใช้งานระบบของ ${gym} แล้ว\n\n`
      + 'เจ้าของยิมจะเป็นผู้อนุมัติและกำหนดสิทธิ์ให้ เมื่ออนุมัติแล้วคุณจะได้รับอีเมลอีกฉบับ '
      + 'และเข้าสู่ระบบด้วยอีเมลกับรหัสผ่านที่ตั้งไว้ได้ทันที\n\n'
      + 'ระหว่างนี้ยังเข้าใช้งานไม่ได้ ถ้ารอนานผิดปกติ ติดต่อเจ้าของยิมได้โดยตรง',
  }),
  signupWaiting: ({ gym, name, email, phone }) => ({
    subject: `มีคำขอเข้าใช้งาน ${gym} รออนุมัติ`,
    text: `มีคนขอเข้าใช้งานระบบ\n\nชื่อ: ${name || '—'}\nอีเมล: ${email}\nเบอร์โทร: ${phone || '—'}\n\n`
      + 'เปิดเมนู "ผู้ใช้และสิทธิ์" เพื่ออนุมัติและกำหนดสิทธิ์ หรือปฏิเสธคำขอนี้',
  }),
  approved: ({ gym, role }) => ({
    subject: `อนุมัติให้เข้าใช้งาน ${gym} แล้ว`,
    text: `เจ้าของยิมอนุมัติคำขอของคุณแล้ว สิทธิ์ที่ได้รับคือ${role === 'admin' ? 'เจ้าของยิม' : 'พนักงาน'}\n\n`
      + 'เข้าสู่ระบบด้วยอีเมลและรหัสผ่านที่ตั้งไว้ตอนสมัครได้เลย',
  }),
  rejected: ({ gym, reason }) => ({
    subject: `คำขอเข้าใช้งาน ${gym} ไม่ได้รับอนุมัติ`,
    text: `คำขอเข้าใช้งานของคุณไม่ได้รับอนุมัติ\n\nเหตุผล: ${reason}\n\n`
      + 'ถ้าคิดว่าเป็นความเข้าใจผิด ติดต่อเจ้าของยิมได้โดยตรง',
  }),
};
