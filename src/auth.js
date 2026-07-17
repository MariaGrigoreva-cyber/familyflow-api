// Регистрация, вход, middleware проверки токена
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q } = require('./db');
const { sendWelcomeEmail } = require('../services/mail');

const router = express.Router();
const SECRET = process.env.JWT_SECRET;
const TOKEN_DAYS = 30;

const sign = (user) => jwt.sign({ uid: user.id }, SECRET, { expiresIn: `${TOKEN_DAYS}d` });

// Middleware: кладёт req.user = {id, familyId}
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    const { uid } = jwt.verify(token, SECRET);
    const { rows } = await q(
      `SELECT u.id, u.email, u.name, fm.family_id
       FROM users u LEFT JOIN family_members fm ON fm.user_id = u.id
       WHERE u.id = $1 LIMIT 1`, [uid]);
    if (!rows[0]) return res.status(401).json({ error: 'user_not_found' });
    req.user = { id: rows[0].id, email: rows[0].email, name: rows[0].name, familyId: rows[0].family_id };
    next();
  } catch {
    return res.status(401).json({ error: 'bad_token' });
  }
}

// POST /auth/register {email, password, name, familyName?}
// Создаёт пользователя + его семью, возвращает токен
router.post('/register', async (req, res) => {
  const { email, password, name = '', familyName = 'Моя семья' } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password_min_8' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const u = await q(
      `INSERT INTO users (email, password_hash, name) VALUES (lower($1), $2, $3) RETURNING id, email, name`,
      [email, hash, name.trim()]);
    const user = u.rows[0];
    const f = await q(`INSERT INTO families (name, owner_id) VALUES ($1, $2) RETURNING id`, [familyName, user.id]);
    await q(`INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'owner')`, [f.rows[0].id, user.id]);

    sendWelcomeEmail(user.email).catch(() => {});

    return res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.name }, familyId: f.rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
    throw e;
  }
});

// POST /auth/login {email, password}
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await q(`SELECT * FROM users WHERE email = lower($1)`, [email || '']);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash)))
    return res.status(401).json({ error: 'wrong_credentials' });
  const fm = await q(`SELECT family_id FROM family_members WHERE user_id = $1 LIMIT 1`, [user.id]);
  return res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.name }, familyId: fm.rows[0]?.family_id || null });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

module.exports = { router, requireAuth };
