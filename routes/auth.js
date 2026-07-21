// Регистрация и вход. При регистрации сразу создаётся семья и пустой state.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const ah = require('../middleware/asyncHandler');

const sign = uid => jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: '90d' });
const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Строже общего лимита на /auth — это конкретно подбор пароля и подбор
// 6-значного кода сброса, самые ценные цели для брутфорса.
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

// ── Отправка почты ─────────────────────────────────────────────────────────
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
          from_name: process.env.MAIL_FROM_NAME || 'FamilyFlow',
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
        from: process.env.MAIL_FROM || 'FamilyFlow <no-reply@familyflow.app>',
        to, subject, text, html,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('smtp timeout 10s')), 10000)),
    ]);
  }
  throw new Error('mail transport not configured');
}

router.post('/register', ah(async (req, res) => {
  const { email, password, familyName } = req.body || {};
  if (!emailOk(email)) return res.status(400).json({ error: 'bad_email' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'short_password' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const u = await client.query(
      'INSERT INTO users(email, pass_hash) VALUES(lower($1), $2) RETURNING id',
      [email, hash]
    );
    const f = await client.query(
      'INSERT INTO families(name) VALUES($1) RETURNING id',
      [familyName || 'Моя семья']
    );
    await client.query(
      "INSERT INTO family_members(family_id, user_id, role) VALUES($1, $2, 'owner')",
      [f.rows[0].id, u.rows[0].id]
    );
    await client.query(
      'INSERT INTO family_states(family_id, data, updated_by) VALUES($1, $2, $3)',
      [f.rows[0].id, '{}', u.rows[0].id]
    );
    await client.query('COMMIT');

    if (mailConfigured()) {
      sendMail(
        email,
        'Добро пожаловать в FamilyFlow!',
        'Спасибо за регистрацию в FamilyFlow. Теперь вы можете вести семейный бюджет, планировать расходы и контролировать накопления.',
        `<h2>Добро пожаловать!</h2>
         <p>Спасибо за регистрацию в FamilyFlow.</p>
         <p>Теперь вы можете:</p>
         <ul>
           <li>вести семейный бюджет;</li>
           <li>планировать расходы;</li>
           <li>контролировать накопления.</li>
         </ul>
         <p>Желаем успешного финансового планирования!</p>`
      ).then(
        () => console.log('welcome mail: sent to', email),
        e => console.error('welcome mail:', e.message)
      );
    }

    res.json({ token: sign(u.rows[0].id), familyId: f.rows[0].id });
  } catch (e) {
    // ROLLBACK сам может упасть, если соединение уже разорвано исходной ошибкой —
    // тогда это была бы вторая необработанная ошибка внутри catch.
    try { await client.query('ROLLBACK'); } catch {}
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    console.error(e);
    res.status(500).json({ error: 'server' });
  } finally {
    client.release();
  }
}));

router.post('/login', strictLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!emailOk(email) || !password) return res.status(400).json({ error: 'bad_credentials' });
  const r = await db.query('SELECT id, pass_hash FROM users WHERE email = lower($1)', [email]);
  if (!r.rows.length) return res.status(401).json({ error: 'bad_credentials' });
  const ok = await bcrypt.compare(password, r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  res.json({ token: sign(r.rows[0].id) });
}));


// ── Смена пароля (для залогиненных) ────────────────────────────────────────
const authMw = require('../middleware/auth');
router.post('/change-password', authMw, ah(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'short_password' });
  const r = await db.query('SELECT pass_hash FROM users WHERE id=$1', [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_user' });
  const ok = await bcrypt.compare(oldPassword || '', r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  const hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET pass_hash=$1 WHERE id=$2', [hash, req.user.uid]);
  res.json({ ok: true });
}));

router.post('/reset-request', ah(async (req, res) => {
  const { email } = req.body || {};
  if (!emailOk(email)) return res.status(400).json({ error: 'bad_email' });
  if (!mailConfigured()) return res.status(503).json({ error: 'mail_unavailable' });
  const u = await db.query('SELECT id FROM users WHERE email=lower($1)', [email]);
  // Не раскрываем, существует ли аккаунт — отвечаем одинаково
  if (u.rows.length) {
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 цифр
    const hash = await bcrypt.hash(code, 10);
    await db.query(
      `UPDATE users SET reset_hash=$1, reset_expires=now() + interval '15 minutes' WHERE id=$2`,
      [hash, u.rows[0].id]);
    // Письмо шлём асинхронно: HTTP-ответ не ждёт SMTP, зависший SMTP не вешает API.
    // 10-секундный таймаут, чтобы битые соединения не копились.
    sendMail(
      email,
      'Код восстановления пароля FamilyFlow',
      `Ваш код: ${code}\nДействует 15 минут. Если вы не запрашивали сброс — просто игнорируйте письмо.`
    ).then(
      () => console.log('mail: sent to', email),
      e => console.error('mail:', e.message)
    );
  }
  res.json({ ok: true });
}));

router.post('/reset-confirm', strictLimiter, ah(async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!emailOk(email) || !code) return res.status(400).json({ error: 'bad_request' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'short_password' });
  const u = await db.query(
    `SELECT id, reset_hash FROM users
      WHERE email=lower($1) AND reset_hash IS NOT NULL AND reset_expires > now()`, [email]);
  if (!u.rows.length) return res.status(400).json({ error: 'code_invalid' });
  const ok = await bcrypt.compare(String(code), u.rows[0].reset_hash);
  if (!ok) return res.status(400).json({ error: 'code_invalid' });
  const hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET pass_hash=$1, reset_hash=NULL, reset_expires=NULL WHERE id=$2', [hash, u.rows[0].id]);
  res.json({ token: sign(u.rows[0].id) });
}));

module.exports = router;
