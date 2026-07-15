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

module.exports = router;
