// Отправка почты — общий модуль (используется auth.js и billing.js).
// Приоритет: Unisender Go (HTTP API, порт 443 — не блокируется хостингами).
// Запасной путь: SMTP через nodemailer (если исходящие SMTP-порты открыты).
const UNI_KEY = process.env.UNISENDER_API_KEY || null;

let smtpTransport = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: (process.env.SMTP_PORT || '465') === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
  } else if (process.env.SMTP_URL) {
    smtpTransport = nodemailer.createTransport(process.env.SMTP_URL);
  }
} catch { smtpTransport = null; }

const mailConfigured = () => !!(UNI_KEY || smtpTransport);

async function sendMailUni(to, subject, text, html) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('https://go2.unisender.ru/ru/transactional/api/v1/email/send.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': UNI_KEY },
      signal: ctrl.signal,
      body: JSON.stringify({
        message: {
          recipients: [{ email: to }],
          subject,
          body: { plaintext: text, html: html || undefined },
          from_email: process.env.MAIL_FROM_EMAIL || 'no-reply@familyflow.app',
          from_name: process.env.MAIL_FROM_NAME || 'Семейный поток',
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'error') {
      throw new Error('unisender: ' + (data.message || data.code || res.status));
    }
  } finally { clearTimeout(timer); }
}

async function sendMail(to, subject, text, html) {
  if (UNI_KEY) return sendMailUni(to, subject, text, html);
  if (smtpTransport) {
    return Promise.race([
      smtpTransport.sendMail({
        from: process.env.MAIL_FROM || 'Семейный поток <no-reply@familyflow.app>',
        to, subject, text, html,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('smtp timeout 10s')), 10000)),
    ]);
  }
  throw new Error('mail transport not configured');
}

module.exports = { sendMail, mailConfigured };
