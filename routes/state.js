// Снапшот состояния семьи: GET отдаёт, PUT сохраняет.
// Оптимистичная блокировка: клиент присылает baseUpdatedAt (что он видел последним);
// если на сервере новее — 409 и актуальные данные, клиент решает что делать.
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

const familyOf = async uid => {
  const r = await db.query('SELECT family_id FROM family_members WHERE user_id=$1', [uid]);
  return r.rows[0]?.family_id || null;
};

router.get('/', auth, async (req, res) => {
  const fid = await familyOf(req.user.uid);
  if (!fid) return res.status(404).json({ error: 'no_family' });
  const r = await db.query(
    'SELECT data, updated_at FROM family_states WHERE family_id=$1', [fid]);
  res.json({ familyId: fid, data: r.rows[0]?.data || {}, updatedAt: r.rows[0]?.updated_at || null });
});

router.put('/', auth, async (req, res) => {
  const { data, baseUpdatedAt } = req.body || {};
  if (typeof data !== 'object' || data === null) return res.status(400).json({ error: 'bad_data' });
  if (JSON.stringify(data).length > 2_000_000) return res.status(413).json({ error: 'too_large' });
  const fid = await familyOf(req.user.uid);
  if (!fid) return res.status(404).json({ error: 'no_family' });

  const cur = await db.query('SELECT updated_at FROM family_states WHERE family_id=$1', [fid]);
  const serverAt = cur.rows[0]?.updated_at?.toISOString?.() || null;
  if (baseUpdatedAt && serverAt && new Date(serverAt) > new Date(baseUpdatedAt)) {
    const fresh = await db.query('SELECT data, updated_at FROM family_states WHERE family_id=$1', [fid]);
    return res.status(409).json({ error: 'conflict', data: fresh.rows[0].data, updatedAt: fresh.rows[0].updated_at });
  }
  const r = await db.query(
    `INSERT INTO family_states(family_id, data, updated_at, updated_by)
     VALUES($1, $2, now(), $3)
     ON CONFLICT (family_id) DO UPDATE SET data=$2, updated_at=now(), updated_by=$3
     RETURNING updated_at`,
    [fid, data, req.user.uid]);
  res.json({ ok: true, updatedAt: r.rows[0].updated_at });
});

module.exports = router;
