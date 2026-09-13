import nodemailer from 'nodemailer';
export function createMailer(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (!env.SMTP_HOST || !env.MAIL_FROM) throw new Error('Configure SMTP_HOST and MAIL_FROM');
  if (production && (!env.SMTP_USER || !env.SMTP_PASSWORD)) throw new Error('Production requires authenticated SMTP');
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
    requireTLS: production, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  return async ({ email, code }) => {
    await transport.sendMail({ from: env.MAIL_FROM, to: email, subject: 'รหัสเข้าใช้งานยิมของเรา',
      text: `รหัสยืนยันของคุณคือ ${code}\nใช้ได้ภายใน 5 นาที และใช้ได้ครั้งเดียว\nหากไม่ได้ขอรหัสนี้ สามารถละเว้นอีเมลฉบับนี้ได้` });
  };
}
