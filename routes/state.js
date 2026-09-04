// Снапшот состояния семьи: GET отдаёт, PUT сохраняет.
//
// СИНХРОНИЗАЦИЯ — СЛИЯНИЕ, А НЕ ПЕРЕЗАПИСЬ. Клиент присылает baseUpdatedAt —
// версию, которую он видел последней. Если сервер с тех пор ушёл вперёд, запись
// НЕ отклоняется и НЕ затирает чужое: сервер достаёт из family_state_versions
// ту самую базу и трёхсторонним слиянием соединяет обе ветки (lib/stateMerge.js).
// Отказ (409) остаётся только там, где общего предка доказать нечем.
//
// Так было не всегда. Раньше PUT был last-write-wins по всему снапшоту, а без
// baseUpdatedAt перезаписывал что угодно безусловно. Отметки «платёж получен» —
// это операции: два устройства, отметившие разные платежи, не конфликтуют, и
// терять одну из правок нельзя. На практике это и выстрелило: отмеченная на
// телефоне зарплата исчезала при заходе с компьютера, а «остаток на руках»
// падал на всю её сумму (доход считается только по отметкам isDone).
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
const { mergeStates, eq } = require('../lib/stateMerge');

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
  const { data, baseUpdatedAt, acceptsMerge } = req.body || {};
  if (JSON.stringify(data).length > 2_000_000) return res.status(413).json({ error: 'too_large' });
  const fid = req.entitlement.familyId;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE обязателен. Раньше проверка версии и запись шли двумя
    // отдельными запросами вне транзакции: два одновременных PUT успевали
    // прочитать одну и ту же версию, оба проходили проверку, и второй затирал
    // первого. Блокировка строки семьи выстраивает их в очередь.
    const cur = await client.query(
      'SELECT data, data_enc, updated_at, reset_at FROM family_states WHERE family_id=$1 FOR UPDATE', [fid]);
    const row = cur.rows[0];

    let serverData;
    try { serverData = readData(row); }
    catch (e) { await client.query('ROLLBACK'); return res.status(e.status || 500).json({ error: e.message }); }

    const serverAt = row?.updated_at || null;
    const serverEmpty = !serverAt || !serverData || Object.keys(serverData).length === 0;
    // Обе стороны сравнения усечены до миллисекунд: клиент получает updatedAt
    // строкой из toISOString(), а timestamptz в Postgres хранит микросекунды.
    const clientIsBehind = !!(baseUpdatedAt && serverAt
      && serverAt.getTime() > new Date(baseUpdatedAt).getTime());

    // Состояние пустое, потому что его только что сбросили, а клиент всё ещё
    // держит снапшот, снятый ДО сброса. Пустая версия «моложе» его базы, и без
    // этой проверки автосейв со второго устройства просто воскресил бы стёртый
    // бюджет: пустое состояние проходит по ветке serverEmpty как обычная запись.
    // Отдаём 409 — клиент примет пустое состояние, как и остальные устройства.
    if (serverEmpty && row?.reset_at && clientIsBehind
      && new Date(baseUpdatedAt).getTime() < row.reset_at.getTime()) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'conflict', code: 'STATE_WAS_RESET', data: serverData, updatedAt: serverAt,
      });
    }

    let toWrite = data;
    let merged = false;

    if (!serverEmpty && clientIsBehind) {
      // Сервер ушёл вперёд. Пытаемся не отказать, а соединить обе ветки —
      // для этого нужна общая база, та самая версия, которую клиент видел.
      const baseRow = await client.query(
        `SELECT data, data_enc FROM family_state_versions
          WHERE family_id=$1
            AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz)`,
        [fid, baseUpdatedAt]);

      if (!baseRow.rows[0]) {
        // Общего предка нет (версия старше срока хранения, либо запись сделана
        // до появления истории). Соединить ветки нечем, а перезаписывать чужие
        // данные вслепую — ровно та потеря, от которой мы уходим. Отдаём 409:
        // клиент получает актуальные данные и решает сам.
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'conflict', code: 'BASE_NOT_FOUND', data: serverData, updatedAt: serverAt,
        });
      }

      let baseData;
      try { baseData = readData(baseRow.rows[0]); }
      catch (e) { await client.query('ROLLBACK'); return res.status(e.status || 500).json({ error: e.message }); }

      toWrite = mergeStates(baseData, data, serverData);
      merged = true;
    } else if (!serverEmpty && !baseUpdatedAt) {
      // Клиент не сказал, от какой версии он отталкивается. Раньше это было
      // разрешением перезаписать что угодно (и тестом «без baseUpdatedAt всегда
      // перезаписывает»). Доказать общего предка нечем — значит, 409.
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'conflict', code: 'BASE_REQUIRED', data: serverData, updatedAt: serverAt,
      });
    }

    // Слияние не изменило серверную версию (клиент прислал то, что уже учтено):
    // не двигаем updated_at впустую — иначе у остальных устройств без нужды
    // протухает их база.
    if (merged && eq(toWrite, serverData)) {
      await client.query('COMMIT');
      // Писать нечего, но клиент всё равно отстал от этой версии — результат
      // ему нужен ровно по той же причине, что и ниже.
      if (acceptsMerge) return res.json({ ok: true, updatedAt: serverAt, data: serverData, merged: true });
      return res.status(409).json({ error: 'conflict', code: 'MERGED', data: serverData, updatedAt: serverAt });
    }

    const useEnc = configured();
    const enc = v => (useEnc ? encryptJSON(v) : null);
    const plain = v => (useEnc ? {} : v); // при шифровании в data реальные данные не пишем

    // Предыдущее состояние тоже кладём в историю: сразу после выката её ещё
    // нет, а именно эту версию держат на руках все остальные устройства — без
    // неё их первое же слияние упрётся в BASE_NOT_FOUND.
    if (serverAt) {
      await client.query(
        `INSERT INTO family_state_versions(family_id, updated_at, data, data_enc)
         VALUES($1,$2,$3,$4) ON CONFLICT (family_id, updated_at) DO NOTHING`,
        [fid, serverAt, plain(serverData), enc(serverData)]);
    }

    // date_trunc до миллисекунд — чтобы значение, которое клиент получит и
    // вернёт как baseUpdatedAt, точно совпало с ключом версии в истории.
    const r = await client.query(
      `INSERT INTO family_states(family_id, data, data_enc, updated_at, updated_by)
       VALUES($1, $2, $3, date_trunc('milliseconds', now()), $4)
       ON CONFLICT (family_id) DO UPDATE
         SET data=$2, data_enc=$3, updated_at=date_trunc('milliseconds', now()), updated_by=$4
       RETURNING updated_at`,
      [fid, plain(toWrite), enc(toWrite), req.user.uid]);
    const newAt = r.rows[0].updated_at;

    await client.query(
      `INSERT INTO family_state_versions(family_id, updated_at, data, data_enc)
       VALUES($1,$2,$3,$4) ON CONFLICT (family_id, updated_at) DO NOTHING`,
      [fid, newAt, plain(toWrite), enc(toWrite)]);

    await client.query(
      `INSERT INTO user_activity_events(user_id, family_id, event_type) VALUES($1, $2, 'budget_saved')`,
      [req.user.uid, fid]);

    await client.query('COMMIT');

    if (!merged) return res.json({ ok: true, updatedAt: newAt });

    // Слияние состоялось и записано. Осталось донести результат до клиента —
    // и это не формальность: если клиент останется со своей версией, его
    // следующее сохранение придёт с базой «слитая версия» и данными без чужих
    // правок, а сервер честно прочитает это как их удаление. То есть
    // недоставленный результат слияния сам себя отменяет.
    //
    // Отсюда два формата ответа. Новый клиент говорит acceptsMerge и получает
    // 200 с данными. Старый (опубликованный RuStore, versionCode 3) поле data
    // при 200 игнорирует, а вот на 409 у него есть готовая ветка: принять
    // серверное состояние и запомнить его версию. Ею и пользуемся — 409 здесь
    // не выдумка, а правда: запись в присланном виде не применилась, и клиенту
    // отдаётся актуальное состояние. Расходится только код ответа, данные и
    // updatedAt в обоих случаях одни и те же.
    if (acceptsMerge) return res.json({ ok: true, updatedAt: newAt, data: toWrite, merged: true });
    return res.status(409).json({ error: 'conflict', code: 'MERGED', data: toWrite, updatedAt: newAt });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
