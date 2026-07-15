// Семья: список участников, инвайт-коды, присоединение
const express = require('express');
const crypto = require('crypto');
const { q } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();
const CODE_TTL_H = 72;
const genCode = () => crypto.randomBytes(4).toString('base64url').replace(/[-_]/g, 'A').slice(0, 6).toUpperCase();

// GET /family → { family, members[] }
router.get('/', requireAuth, async (req, res) => {
  if (!req.user.familyId) return res.status(400).json({ error: 'no_family' });
  const fam = await q(`SELECT id, name, owner_id FROM families WHERE id = $1`, [req.user.familyId]);
  const members = await q(
    `SELECT u.id, u.name, u.email, fm.role, fm.joined_at
     FROM family_members fm JOIN users u ON u.id = fm.user_id
     WHERE fm.family_id = $1 ORDER BY fm.joined_at`, [req.user.familyId]);
  res.json({ family: fam.rows[0], members: members.rows });
});

// POST /family/invite → { code, expiresAt }
router.post('/invite', requireAuth, async (req, res) => {
  if (!req.user.familyId) return res.status(400).json({ error: 'no_family' });
  const code = genCode();
  const { rows } = await q(
    `INSERT INTO invites (code, family_id, created_by, expires_at)
     VALUES ($1, $2, $3, now() + interval '${CODE_TTL_H} hours')
     RETURNING code, expires_at`,
    [code, req.user.familyId, req.user.id]);
  res.json({ code: rows[0].code, expiresAt: rows[0].expires_at });
});

// POST /family/join { code } — переводит пользователя в семью по коду
router.post('/join', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const inv = await q(
    `SELECT * FROM invites WHERE code = $1 AND used_by IS NULL AND expires_at > now()`,
    [(code || '').toUpperCase().trim()]);
  if (!inv.rows[0]) return res.status(404).json({ error: 'invalid_or_expired' });
  const familyId = inv.rows[0].family_id;

  // Покидаем прежнюю семью (одиночную), вступаем в новую
  await q(`DELETE FROM family_members WHERE user_id = $1`, [req.user.id]);
  await q(`INSERT INTO family_members (family_id, user_id, role) VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`, [familyId, req.user.id]);
  await q(`UPDATE invites SET used_by = $1 WHERE code = $2`, [req.user.id, inv.rows[0].code]);
  res.json({ familyId });
});

module.exports = { router };
