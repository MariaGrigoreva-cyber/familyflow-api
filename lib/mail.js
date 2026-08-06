// Отправка почты — общий модуль (используется auth.js, billing.js и планировщиками).
// Приоритет: Unisender Go (HTTP API, порт 443 — не блокируется хостингами).
// Запасной путь: SMTP через nodemailer (если исходящие SMTP-порты открыты).
const Sentry = require('@sentry/node');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const UNI_KEY = process.env.UNISENDER_API_KEY || null;

// Unisender при отправке (см. sendMailUni) синхронно ловит только сломанный
// формат (нет "@", нет домена) — а это уже отсеяно схемой на входе в /register.
// Опечатку в домене (gmial.com, yandex.ry) Unisender молча проглатывает
// (status: success) — проверено вручную через реальный API. Поэтому домен
// проверяем сами через MX: нет записи — почта туда физически не дойдёт.
// ENOTFOUND/ENODATA — домен подтверждённо не принимает почту (блокируем).
// Любая другая ошибка (таймаут, сбой резолвера) — не блокируем регистрацию
// вслепую, лучше пропустить сомнительный адрес, чем отказать настоящему.
function hasMxRecord(email, timeoutMs = 3000) {
  const domain = String(email).split('@')[1];
  if (!domain) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(true), timeoutMs);
    dns.resolveMx(domain, (err, addresses) => {
      clearTimeout(timer);
      if (!err) return resolve(addresses.length > 0);
      resolve(err.code !== 'ENOTFOUND' && err.code !== 'ENODATA');
    });
  });
}

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
    // Unisender может отдать status:"success" на весь запрос, но конкретный
    // адрес — в failed_emails (например, "invalid": опечатка в домене типа
    // gmial.com, письмо никогда не уйдёт). Это узнаётся сразу же, синхронно,
    // без вебхуков о бounce — этим и пользуется /auth/register.
    const rejected = data.failed_emails?.[to];
    if (rejected) {
      const err = new Error('mail_rejected');
      err.rejectedReason = rejected; // invalid | permanent_unavailable | temporary_unavailable | ...
      throw err;
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
    // rejectedReason — это Unisender сообщил про конкретный адрес (опечатка,
    // отписка и т.п.), ожидаемый пользовательский случай, а не сбой почты —
    // не засоряем Sentry.
    if (!e.rejectedReason) Sentry.captureException(e);
    throw e;
  }
}

// ── Шаблоны писем (lib/emails/*.html + .txt) ────────────────────────────────
// Табличная вёрстка под email-клиенты, готовая от дизайнера — здесь только
// подстановка {{VAR}} и чтение файла. text — обязательная альтернатива html
// (доставляемость/спам-фильтры), лежит рядом тем же именем с .txt.
const EMAIL_DIR = path.join(__dirname, 'emails');

function renderTemplate(name, vars) {
  const fill = raw => Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{{${k}}}`).join(v), raw
  );
  return {
    html: fill(fs.readFileSync(path.join(EMAIL_DIR, `${name}.html`), 'utf8')),
    text: fill(fs.readFileSync(path.join(EMAIL_DIR, `${name}.txt`), 'utf8')),
  };
}

// ── Отписка от рассылки ──────────────────────────────────────────────────
// Токен — HMAC(uid) на JWT_SECRET, без отдельной колонки/таблицы: не одноразовый
// и не истекает, как и положено ссылке «Отписаться». Секрет тот же, что и для
// сессионных JWT (routes/auth.js), но назначение другое — на предъявителя токена
// это не влияет, коллизии с auth-токенами исключены разным форматом.
function unsubscribeToken(uid) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(uid)).digest('hex');
}
function verifyUnsubscribeToken(uid, token) {
  const expected = Buffer.from(unsubscribeToken(uid));
  const given = Buffer.from(String(token || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
function unsubscribeUrl(uid) {
  const base = (process.env.API_PUBLIC_URL || 'https://mariagrigoreva-cyber-familyflow-api-bccc.twc1.net').replace(/\/$/, '');
  return `${base}/auth/unsubscribe?uid=${uid}&token=${unsubscribeToken(uid)}`;
}

module.exports = {
  sendMail, mailConfigured, renderTemplate, hasMxRecord,
  unsubscribeUrl, unsubscribeToken, verifyUnsubscribeToken,
};
