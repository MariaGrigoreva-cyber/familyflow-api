// Облачное состояние: GET/PUT снапшота appState с версионированием
const express = require('express');
const { q } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();
const MAX_BYTES = 1_000_000; // 1 МБ на снапшот — с запасом

// GET /state → { version, data, updatedAt } | { version: 0, data: null } если пусто
router.get('/', requireAuth, async (req, res) => {
  if (!req.user.familyId) return res.status(400).json({ error: 'no_family' });
  const { rows } = await q(`SELECT version, data, updated_at FROM states WHERE family_id = $1`, [req.user.familyId]);
  if (!rows[0]) return res.json({ version: 0, data: null, updatedAt: null });
  res.json({ version: Number(rows[0].version), data: rows[0].data, updatedAt: rows[0].updated_at });
});

// PUT /state { baseVersion, data }
// Оптимистичная блокировка: если baseVersion не совпал — 409 с актуальным состоянием
router.put('/', requireAuth, async (req, res) => {
  if (!req.user.familyId) return res.status(400).json({ error: 'no_family' });
  const { baseVersion, data } = req.body || {};
  if (data == null || typeof data !== 'object') return res.status(400).json({ error: 'bad_data' });
  if (JSON.stringify(data).length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

  // Первая запись (миграция из localStorage)
  if (!baseVersion) {
    const ins = await q(
      `INSERT INTO states (family_id, version, data, updated_by)
       VALUES ($1, 1, $2, $3)
       ON CONFLICT (family_id) DO NOTHING
       RETURNING version`,
      [req.user.familyId, data, req.user.id]);
    if (ins.rows[0]) return res.json({ version: 1 });
    // уже существует — конфликт первой записи
  }

  const upd = await q(
    `UPDATE states SET version = version + 1, data = $2, updated_by = $3, updated_at = now()
     WHERE family_id = $1 AND version = $4
     RETURNING version`,
    [req.user.familyId, data, req.user.id, baseVersion || 0]);

  if (upd.rows[0]) return res.json({ version: Number(upd.rows[0].version) });

  // Версия ушла вперёд — отдаём актуальное, клиент решает
  const cur = await q(`SELECT version, data, updated_at FROM states WHERE family_id = $1`, [req.user.familyId]);
  return res.status(409).json({
    error: 'version_conflict',
    version: Number(cur.rows[0]?.version || 0),
    data: cur.rows[0]?.data || null,
    updatedAt: cur.rows[0]?.updated_at || null,
  });
});

module.exports = { router };
