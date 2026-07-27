// Отправка почты — общий модуль (используется auth.js, billing.js и планировщиками).
// Приоритет: Unisender Go (HTTP API, порт 443 — не блокируется хостингами).
// Запасной путь: SMTP через nodemailer (если исходящие SMTP-порты открыты).
const Sentry = require('@sentry/node');
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
          from_email: process.env.MAIL_FROM_EMAIL || 'no-reply@myfamilyflow.ru',
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

// Каждый вызывающий код (auth.js, billing.js, scheduler.js, onboardingScheduler.js)
// сам логирует ошибку в консоль через .catch, но консоль в проде никто не читает —
// поэтому репортим в Sentry/GlitchTip централизованно здесь, один раз для всех
// вызовов, а не в каждом месте по отдельности.
async function sendMail(to, subject, text, html) {
  try {
    if (UNI_KEY) return await sendMailUni(to, subject, text, html);
    if (smtpTransport) {
      return await Promise.race([
        smtpTransport.sendMail({
          from: process.env.MAIL_FROM || 'Семейный поток <no-reply@myfamilyflow.ru>',
          to, subject, text, html,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('smtp timeout 10s')), 10000)),
      ]);
    }
    throw new Error('mail transport not configured');
  } catch (e) {
    Sentry.captureException(e);
    throw e;
  }
}

// ── Форматирование писем из простого текста ─────────────────────────────────
// Общий хелпер для писем, которые пишутся как обычный текст (welcome, онбординг):
// параграфы — по пустой строке, переносы внутри параграфа — <br>, а строку-
// заголовок (нумерованный пункт, «Шаг N.» или пункт с 💡) выделяем жирным.
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HEADING_RE = /^(\d+\.\s|💡\s|Шаг\s\d+\.\s)/;

function textToHtml(text) {
  return text.trim().split(/\n{2,}/).map(para => {
    const lines = para.split('\n').map(escapeHtml);
    if (HEADING_RE.test(para)) lines[0] = `<strong>${lines[0]}</strong>`;
    return `<p>${lines.join('<br>')}</p>`;
  }).join('\n');
}

function ctaButtonHtml(label, url) {
  return `<p><a href="${url}" style="display:inline-block;padding:10px 22px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`;
}

module.exports = { sendMail, mailConfigured, escapeHtml, textToHtml, ctaButtonHtml };
