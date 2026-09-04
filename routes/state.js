// Снапшот состояния семьи: GET отдаёт, PUT сохраняет.
// Оптимистичная блокировка: клиент присылает baseUpdatedAt (что он видел последним);
// если на сервере новее — 409 и актуальные данные, клиент решает что делать.
// Данные шифруются перед сохранением (см. lib/crypto.js) — в БД лежит только
// шифротекст в data_enc, колонка data держится пустой ('{}').
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const requireCapability = require('../middleware/requireCapability');
const ah = require('../middleware/asyncHandler');
const { encryptJSON, decryptJSON, configured } = require('../lib/crypto');
const validate = require('../middleware/validate');
const { stateSchema } = require('../lib/schemas');

// ── Временное профилирование GET /state ──────────────────────────────────────
// Включается переменной окружения STATE_TIMING=1 (по умолчанию выключено, в лог
// ничего лишнего не течёт). Разбивка нужна, чтобы отличить медленную БД от
// медленной расшифровки/сериализации большого снапшота бюджета.
//   GET /state: auth: X ms | db: X ms | serialization: X ms | total: X ms
// auth  — JWT + проверка token_version в middleware/auth.js (одна выборка из users);
// db    — выборка состояния семьи ВМЕСТЕ с расшифровкой data_enc (AES-GCM);
// serialization — JSON.stringify итогового ответа.
const STATE_TIMING = process.env.STATE_TIMING === '1';
const now = () => process.hrtime.bigint();
const msSince = from => Number(now() - from) / 1e6;
// Ставим метку ДО auth — иначе время самого auth измерить нечем.
const timing = (req, _res, next) => { if (STATE_TIMING) req._tStart = now(); next(); };

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

// Раньше здесь было два последовательных запроса к БД: сначала familyOf() за
// family_id, потом выборка family_states по нему. Второй ждал первого впустую —
// это один и тот же путь по индексам, склеенный JOIN'ом в один round-trip.
// LEFT JOIN обязателен: семья без строки в family_states — нормальная ситуация
// (пустой бюджет), и она по-прежнему должна отдавать data:{}, а не 404.
//
// ЧТЕНИЕ НЕ ЗАКРЫВАЕТСЯ ничем: снапшот бюджета входит в бесплатный тариф
// (capability basicBudget), и человек обязан видеть свой бюджет и иметь
// возможность выгрузить его в Excel (familyflow-web/src/lib/excelBackup.js
// читает состояние именно отсюда).
router.get('/', timing, auth, ah(async (req, res) => {
  const tAuth = STATE_TIMING ? msSince(req._tStart) : 0;
  const tDb0 = STATE_TIMING ? now() : null;

  const r = await db.query(
    `SELECT fm.family_id, fs.data, fs.data_enc, fs.updated_at, fs.reset_at
       FROM family_members fm
       LEFT JOIN family_states fs ON fs.family_id = fm.family_id
      WHERE fm.user_id = $1`, [req.user.uid]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'no_family' });

  let data;
  try { data = readData(row); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const dbMs = STATE_TIMING ? msSince(tDb0) : 0;

  const resetBackup = row.reset_at
    ? { resetAt: row.reset_at, expiresAt: new Date(row.reset_at.getTime() + RESET_GRACE_DAYS * 86400000) }
    : null;
  const body = { familyId: row.family_id, data, updatedAt: row.updated_at || null, resetBackup };

  if (!STATE_TIMING) return res.json(body);

  const tSer0 = now();
  const json = JSON.stringify(body);
  const serMs = msSince(tSer0);
  res.type('json').send(json);
  console.log(
    `GET /state: auth: ${tAuth.toFixed(1)} ms | db: ${dbMs.toFixed(1)} ms | ` +
    `serialization: ${serMs.toFixed(1)} ms | total: ${msSince(req._tStart).toFixed(1)} ms | bytes: ${json.length}`);
}));

// Запись бюджета — БЕСПЛАТНАЯ возможность (capability basicBudget).
//
// Так было не всегда: до пересборки тарифов этот роут закрывался шлюзом и
// после окончания триала отдавал 402. Free при этом превращался в режим
// «только чтение» — человек не мог даже отметить оплаченный счёт, то есть
// бесплатный тариф был не урезанным, а сломанным. Ценность Pro теперь несут
// прогноз, предупреждения о кассовых разрывах, проверка покупок и AI
// (см. lib/capabilities.js), а не запрет вести собственный бюджет.
//
// Шлюз всё равно стоит: он загружает entitlement (в req.entitlement приходит
// familyId, поэтому отдельный запрос familyOf() здесь не нужен) и остаётся
// единственным местом, где решается доступ — если состав тарифов однажды
// изменится, менять придётся только реестр возможностей.
router.put('/', auth, requireCapability('basicBudget'), validate(stateSchema), ah(async (req, res) => {
  const { data, baseUpdatedAt } = req.body || {};
  if (JSON.stringify(data).length > 2_000_000) return res.status(413).json({ error: 'too_large' });
  const fid = req.entitlement.familyId;

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
// Сброс — часть базового ведения бюджета (basicBudget), а не платная функция:
// человек вправе стереть собственные данные на любом тарифе. Шлюз здесь ради
// единой точки загрузки entitlement (familyId в req.entitlement).
router.post('/reset', auth, requireCapability('basicBudget'), ah(async (req, res) => {
  const fid = req.entitlement.familyId;

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

// Возврат данных из окна отложенного удаления — восстановление собственных
// данных пользователя, а не платная возможность: доступно на любом тарифе,
// как и сама запись бюджета (basicBudget в lib/capabilities.js).
//
// Шлюз здесь стоит осознанно, хотя ничего не запрещает. Это ЗАПИСЬ в
// family_states, и такая запись обязана проходить через тот же реестр
// возможностей, что и PUT /state: если состав тарифов однажды изменится и
// basicBudget станет платным, эндпоинт не должен остаться лазейкой, через
// которую состояние меняется в обход шлюза. Плюс это единая точка загрузки
// entitlement — familyId приходит в req.entitlement, отдельный familyOf() не нужен.
//
// Подменить содержимое восстановления нельзя: тело запроса здесь не читается
// вовсе, источник данных — reset_backup ТОЙ ЖЕ строки family_states, а строка
// выбирается по family_id текущего пользователя. Чужую семью восстановить
// невозможно, произвольный backup подсунуть — тоже.
//
// (см. п. выше и lib/stateResetPurgeScheduler.js). COALESCE на data обязателен: колонка NOT NULL,
// а reset_backup останется NULL, если семья использовала шифрование (данные лежали
// только в reset_backup_enc).
router.post('/restore-backup', auth, requireCapability('basicBudget'), ah(async (req, res) => {
  const fid = req.entitlement.familyId;

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
