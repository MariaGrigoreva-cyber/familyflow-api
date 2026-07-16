// Регистрация и вход. При регистрации сразу создаётся семья и пустой state.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const sign = uid => jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: '90d' });
const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

router.post('/register', async (req, res) => {
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
    res.json({ token: sign(u.rows[0].id), familyId: f.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    console.error(e);
    res.status(500).json({ error: 'server' });
  } finally {
    client.release();
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!emailOk(email) || !password) return res.status(400).json({ error: 'bad_credentials' });
  const r = await db.query('SELECT id, pass_hash FROM users WHERE email = lower($1)', [email]);
  if (!r.rows.length) return res.status(401).json({ error: 'bad_credentials' });
  const ok = await bcrypt.compare(password, r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  res.json({ token: sign(r.rows[0].id) });
});


// ── Смена пароля (для залогиненных) ────────────────────────────────────────
const authMw = require('../middleware/auth');
router.post('/change-password', authMw, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'short_password' });
  const r = await db.query('SELECT pass_hash FROM users WHERE id=$1', [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_user' });
  const ok = await bcrypt.compare(oldPassword || '', r.rows[0].pass_hash);
  if (!ok) return res.status(401).json({ error: 'bad_credentials' });
  const hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET pass_hash=$1 WHERE id=$2', [hash, req.user.uid]);
  res.json({ ok: true });
});

// ── Восстановление пароля по email ─────────────────────────────────────────
// Требует SMTP_URL в env (например smtp://user:pass@smtp.timeweb.ru:465).
// Без него endpoint честно отвечает 503 — UI покажет «временно недоступно».
// Конфиг SMTP: либо раздельные переменные (надёжно — панели хостингов
// декодируют %40 в URL и ломают логин с @), либо SMTP_URL как запасной вариант.
let mailer = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,                          // smtp.yandex.ru
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: (process.env.SMTP_PORT || '465') === '465',   // 465 = SSL, 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
  } else if (process.env.SMTP_URL) {
    mailer = nodemailer.createTransport(process.env.SMTP_URL);
  }
} catch { mailer = null; }

router.post('/reset-request', async (req, res) => {
  const { email } = req.body || {};
  if (!emailOk(email)) return res.status(400).json({ error: 'bad_email' });
  if (!mailer) return res.status(503).json({ error: 'mail_unavailable' });
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
    const send = mailer.sendMail({
      from: process.env.MAIL_FROM || 'FamilyFlow <no-reply@familyflow.app>',
      to: email,
      subject: 'Код восстановления пароля FamilyFlow',
      text: `Ваш код: ${code}\nДействует 15 минут. Если вы не запрашивали сброс — просто игнорируйте письмо.`,
    });
    Promise.race([
      send,
      new Promise((_, rej) => setTimeout(() => rej(new Error('smtp timeout 10s — проверьте smtps:// и порт 465')), 10000)),
    ]).then(
      () => console.log('mail: sent to', email),
      e => console.error('mail:', e.message)
    );
  }
  res.json({ ok: true });
});

router.post('/reset-confirm', async (req, res) => {
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
});

module.exports = router;
