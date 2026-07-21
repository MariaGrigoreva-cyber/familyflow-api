// Приглашения: owner генерирует код, второй супруг вводит его и присоединяется.
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');

const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих символов
const genCode = () => Array.from({ length: 6 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');

router.get('/me', auth, ah(async (req, res) => {
  const r = await db.query(
    `SELECT f.id, f.name, f.invite_code, m.role,
            (SELECT count(*) FROM family_members WHERE family_id=f.id)::int AS members
       FROM family_members m JOIN families f ON f.id=m.family_id
      WHERE m.user_id=$1`, [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_family' });
  res.json(r.rows[0]);
}));

router.post('/invite', auth, ah(async (req, res) => {
  const m = await db.query(
    "SELECT family_id FROM family_members WHERE user_id=$1 AND role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  const code = genCode();
  await db.query('UPDATE families SET invite_code=$1 WHERE id=$2', [code, m.rows[0].family_id]);
  res.json({ code });
}));

router.post('/join', auth, ah(async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (code.length !== 6) return res.status(400).json({ error: 'bad_code' });
  const f = await db.query('SELECT id FROM families WHERE invite_code=$1', [code]);
  if (!f.rows.length) return res.status(404).json({ error: 'code_not_found' });
  const fid = f.rows[0].id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Покидаем прежнюю семью (упрощение фазы 0: один пользователь — одна семья).
    // Если пользователь был единственным участником — его старая семья удаляется целиком.
    const old = await client.query('SELECT family_id FROM family_members WHERE user_id=$1', [req.user.uid]);
    if (old.rows.length) {
      const oldFid = old.rows[0].family_id;
      if (oldFid === fid) { await client.query('ROLLBACK'); return res.json({ ok: true, familyId: fid, already: true }); }
      await client.query('DELETE FROM family_members WHERE user_id=$1', [req.user.uid]);
      const left = await client.query('SELECT 1 FROM family_members WHERE family_id=$1 LIMIT 1', [oldFid]);
      if (!left.rows.length) await client.query('DELETE FROM families WHERE id=$1', [oldFid]);
    }
    await client.query(
      "INSERT INTO family_members(family_id, user_id, role) VALUES($1, $2, 'member')", [fid, req.user.uid]);
    await client.query('COMMIT');
    const st = await db.query('SELECT data, updated_at FROM family_states WHERE family_id=$1', [fid]);
    res.json({ ok: true, familyId: fid, data: st.rows[0]?.data || {}, updatedAt: st.rows[0]?.updated_at || null });
  } catch (e) {
    // ROLLBACK сам может упасть, если соединение уже разорвано исходной ошибкой —
    // тогда это была бы вторая необработанная ошибка внутри catch.
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'server' });
  } finally {
    client.release();
  }
}));

module.exports = router;
