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

// Держим в синхроне с lib/stateResetPurgeScheduler.js — там та же переменная
// окружения определяет, когда бэкап сброса стирается по-настоящему.
const RESET_GRACE_DAYS = Number(process.env.STATE_RESET_GRACE_DAYS || 90);

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
    'SELECT data, data_enc, updated_at, reset_at FROM family_states WHERE family_id=$1', [fid]);
  const row = r.rows[0];
  let data;
  try { data = readData(row); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const resetBackup = row?.reset_at
    ? { resetAt: row.reset_at, expiresAt: new Date(row.reset_at.getTime() + RESET_GRACE_DAYS * 86400000) }
    : null;
  res.json({ familyId: fid, data, updatedAt: row?.updated_at || null, resetBackup });
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

  await db.query(
    `INSERT INTO user_activity_events(user_id, family_id, event_type) VALUES($1, $2, 'budget_saved')`,
    [req.user.uid, fid]);

  res.json({ ok: true, updatedAt: r.rows[0].updated_at });
}));

// «Сбросить все данные и начать заново» в Настройках — вместо необратимого PUT
// пустым data сначала переносим текущее состояние в reset_backup(_enc) с отметкой
// времени, и только потом обнуляем рабочие data/data_enc. Все SET-выражения в
// одном UPDATE читают значения ДО изменения, так что бэкап атомарно захватывает
// именно то, что стирается этим же запросом.
router.post('/reset', auth, ah(async (req, res) => {
  const fid = await familyOf(req.user.uid);
  if (!fid) return res.status(404).json({ error: 'no_family' });

  const r = await db.query(
    `UPDATE family_states
     SET reset_backup = data, reset_backup_enc = data_enc, reset_at = now(),
         data = '{}'::jsonb, data_enc = NULL, updated_at = now(), updated_by = $2
     WHERE family_id = $1
     RETURNING updated_at`,
    [fid, req.user.uid]);

  if (!r.rows[0]) {
    // Строки для этой семьи ещё не было — бэкапить нечего, просто заводим пустую.
    await db.query(
      `INSERT INTO family_states(family_id, data, updated_at, updated_by)
       VALUES($1, '{}'::jsonb, now(), $2) ON CONFLICT (family_id) DO NOTHING`,
      [fid, req.user.uid]);
    return res.json({ ok: true, updatedAt: new Date().toISOString() });
  }
  res.json({ ok: true, updatedAt: r.rows[0].updated_at });
}));

// Возврат данных из окна отложенного удаления (см. п. выше и
// lib/stateResetPurgeScheduler.js). COALESCE на data обязателен: колонка NOT NULL,
// а reset_backup останется NULL, если семья использовала шифрование (данные лежали
// только в reset_backup_enc).
router.post('/restore-backup', auth, ah(async (req, res) => {
  const fid = await familyOf(req.user.uid);
  if (!fid) return res.status(404).json({ error: 'no_family' });

  const r = await db.query(
    `UPDATE family_states
     SET data = COALESCE(reset_backup, '{}'::jsonb), data_enc = reset_backup_enc,
         reset_backup = NULL, reset_backup_enc = NULL, reset_at = NULL,
         updated_at = now(), updated_by = $2
     WHERE family_id = $1 AND reset_at IS NOT NULL
     RETURNING updated_at`,
    [fid, req.user.uid]);

  if (!r.rows[0]) return res.status(404).json({ error: 'no_backup' });
  res.json({ ok: true, updatedAt: r.rows[0].updated_at });
}));

module.exports = router;
