// Снапшот состояния семьи: GET отдаёт, PUT сохраняет.
// Оптимистичная блокировка: клиент присылает baseUpdatedAt (что он видел последним);
// если на сервере новее — 409 и актуальные данные, клиент решает что делать.
// Данные шифруются перед сохранением (см. lib/crypto.js) — в БД лежит только
// шифротекст в data_enc, колонка data держится пустой ('{}').
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');
const { encryptJSON, decryptJSON, configured } = require('../lib/crypto');
const validate = require('../middleware/validate');
const { stateSchema } = require('../lib/schemas');

const familyOf = async uid => {
  const r = await db.query('SELECT family_id FROM family_members WHERE user_id=$1', [uid]);
  return r.rows[0]?.family_id || null;
};

// data_enc, если есть, всегда авторитетнее — data остаётся только для строк,
// созданных до включения шифрования (или если DATA_ENC_KEY вообще не задан).
const readData = row => {
  if (!row) return {};
  if (row.data_enc) {
    try { return decryptJSON(row.data_enc); }
    catch (e) { console.error('state decrypt failed:', e.message); throw Object.assign(new Error('decrypt_failed'), { status: 500 }); }
  }
  return row.data || {};
};

router.get('/', auth, ah(async (req, res) => {
  const fid = await familyOf(req.user.uid);
  if (!fid) return res.status(404).json({ error: 'no_family' });
  const r = await db.query(
    'SELECT data, data_enc, updated_at FROM family_states WHERE family_id=$1', [fid]);
  const row = r.rows[0];
  let data;
  try { data = readData(row); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  res.json({ familyId: fid, data, updatedAt: row?.updated_at || null });
}));

router.put('/', auth, validate(stateSchema), ah(async (req, res) => {
  const { data, baseUpdatedAt } = req.body || {};
  if (JSON.stringify(data).length > 2_000_000) return res.status(413).json({ error: 'too_large' });
  const fid = await familyOf(req.user.uid);
  if (!fid) return res.status(404).json({ error: 'no_family' });

  const cur = await db.query('SELECT updated_at FROM family_states WHERE family_id=$1', [fid]);
  const serverAt = cur.rows[0]?.updated_at?.toISOString?.() || null;
  if (baseUpdatedAt && serverAt && new Date(serverAt) > new Date(baseUpdatedAt)) {
    const fresh = await db.query('SELECT data, data_enc, updated_at FROM family_states WHERE family_id=$1', [fid]);
    let freshData;
    try { freshData = readData(fresh.rows[0]); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    return res.status(409).json({ error: 'conflict', data: freshData, updatedAt: fresh.rows[0].updated_at });
  }

  const useEnc = configured();
  const encBuf = useEnc ? encryptJSON(data) : null;
  const plainVal = useEnc ? {} : data; // при включённом шифровании в data больше не пишем реальные данные

  const r = await db.query(
    `INSERT INTO family_states(family_id, data, data_enc, updated_at, updated_by)
     VALUES($1, $2, $3, now(), $4)
     ON CONFLICT (family_id) DO UPDATE SET data=$2, data_enc=$3, updated_at=now(), updated_by=$4
     RETURNING updated_at`,
    [fid, plainVal, encBuf, req.user.uid]);
  res.json({ ok: true, updatedAt: r.rows[0].updated_at });
}));

module.exports = router;
