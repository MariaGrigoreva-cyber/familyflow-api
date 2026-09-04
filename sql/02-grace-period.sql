-- ════════════════════════════════════════════════════════════════════════════
-- GRACE PERIOD при включении серверного шлюза
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠️  СОДЕРЖИТ ИЗМЕНЯЮЩИЕ ЗАПРОСЫ. Выполнять только осознанно, по шагам,
--     и только ПОСЛЕ того, как sql/01-expired-users-audit.sql показал масштаб.
--     Ничего из этого файла не запускается автоматически: schema.sql его не
--     подключает, server.js о нём не знает.
--
-- ── ЗАЧЕМ ──────────────────────────────────────────────────────────────────
-- До появления серверного шлюза окончание триала фактически ничего не
-- ограничивало. Часть людей всё это время активно пользовалась платными
-- возможностями — не обходя защиту, а потому что защиты не было. Включение
-- шлюза для них выглядит как внезапная поломка работавшего приложения.
--
-- Grace period — разовая компенсация ИМЕННО ЭТОГО нашего недочёта, а не новый
-- триал. Поэтому: короткий фиксированный срок, только активным, и никогда не
-- «ещё 30 дней».
--
-- ── КРИТЕРИИ (и почему такие) ──────────────────────────────────────────────
--   1. Триал истёк и активной подписки нет — то есть шлюз их действительно
--      затронет.
--   2. Была активность за последние 14 дней — компенсируем тем, кто реально
--      пользуется. Неактивные ничего не заметят, продлевать им нечего.
--      14 дней, а не 7: недельное окно отсекает тех, кто заходит в бюджет
--      пару раз в месяц (это нормальный режим для семейного планирования).
--   3. Срок только УДЛИНЯЕТСЯ, никогда не сокращается — GREATEST ниже.
--   4. Платных не касаемся вовсе.
--
-- ── ВАЖНО ПРО ДАТУ ─────────────────────────────────────────────────────────
-- Ниже везде подставьте ОДНО И ТО ЖЕ значение вместо :gate_launch_at —
-- фактический момент включения шлюза, в UTC с явной зоной. Пример:
--   \set gate_launch_at '2026-09-10T09:00:00Z'
-- В psql это делается один раз перед запуском файла.

\if :{?gate_launch_at}
\else
  \echo '!! Не задан gate_launch_at. Запустите так:'
  \echo '!!   psql "$DATABASE_URL" -v gate_launch_at="2026-09-10T09:00:00Z" -f sql/02-grace-period.sql'
  \quit
\endif

-- Целевая дата окончания grace period: момент включения шлюза + 7 дней.
-- 7 дней — чтобы человек успел увидеть предупреждение, дочитать письмо и
-- принять решение, но не успел воспринять это как «триал продлили».

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 1. PREVIEW — кого затронет. НИЧЕГО НЕ МЕНЯЕТ.
-- ────────────────────────────────────────────────────────────────────────────
WITH candidates AS (
  SELECT f.id, f.name, f.trial_ends_at, f.pro_until,
         GREATEST(
           COALESCE(fs.updated_at, 'epoch'::timestamptz),
           COALESCE(ev.last_event, 'epoch'::timestamptz)
         ) AS last_seen
    FROM families f
    LEFT JOIN family_states fs ON fs.family_id = f.id
    LEFT JOIN (
      SELECT family_id, max(created_at) AS last_event
        FROM user_activity_events GROUP BY family_id
    ) ev ON ev.family_id = f.id
   WHERE (f.pro_until IS NULL OR f.pro_until <= now())
     AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
     AND EXISTS (
       SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = f.id AND u.deleted_at IS NULL
     )
)
SELECT id, name, trial_ends_at AS current_end, last_seen,
       GREATEST(
         COALESCE(trial_ends_at, 'epoch'::timestamptz),
         (:'gate_launch_at')::timestamptz + interval '7 days'
       ) AS new_end
FROM candidates
WHERE last_seen > now() - interval '14 days'
ORDER BY last_seen DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 2. КОЛИЧЕСТВО — одна цифра для решения. НИЧЕГО НЕ МЕНЯЕТ.
-- ────────────────────────────────────────────────────────────────────────────
WITH candidates AS (
  SELECT f.id,
         GREATEST(
           COALESCE(fs.updated_at, 'epoch'::timestamptz),
           COALESCE(ev.last_event, 'epoch'::timestamptz)
         ) AS last_seen
    FROM families f
    LEFT JOIN family_states fs ON fs.family_id = f.id
    LEFT JOIN (
      SELECT family_id, max(created_at) AS last_event
        FROM user_activity_events GROUP BY family_id
    ) ev ON ev.family_id = f.id
   WHERE (f.pro_until IS NULL OR f.pro_until <= now())
     AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
     AND EXISTS (
       SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = f.id AND u.deleted_at IS NULL
     )
)
SELECT count(*) AS families_to_extend
FROM candidates WHERE last_seen > now() - interval '14 days';

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 3. СНИМОК ДО ИЗМЕНЕНИЯ — обязателен, это и есть основа отката.
-- ────────────────────────────────────────────────────────────────────────────
-- Без этой таблицы откат придётся угадывать: исходные trial_ends_at у разных
-- семей разные, и «вернуть как было» одним выражением невозможно.
CREATE TABLE IF NOT EXISTS trial_grace_backup (
  family_id           uuid PRIMARY KEY,
  trial_ends_at_before timestamptz,
  applied_at          timestamptz NOT NULL DEFAULT now(),
  gate_launch_at      timestamptz NOT NULL
);

INSERT INTO trial_grace_backup(family_id, trial_ends_at_before, gate_launch_at)
SELECT f.id, f.trial_ends_at, (:'gate_launch_at')::timestamptz
  FROM families f
  LEFT JOIN family_states fs ON fs.family_id = f.id
  LEFT JOIN (
    SELECT family_id, max(created_at) AS last_event
      FROM user_activity_events GROUP BY family_id
  ) ev ON ev.family_id = f.id
 WHERE (f.pro_until IS NULL OR f.pro_until <= now())
   AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
   AND EXISTS (
     SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
      WHERE m.family_id = f.id AND u.deleted_at IS NULL
   )
   AND GREATEST(
         COALESCE(fs.updated_at, 'epoch'::timestamptz),
         COALESCE(ev.last_event, 'epoch'::timestamptz)
       ) > now() - interval '14 days'
ON CONFLICT (family_id) DO NOTHING;  -- повторный запуск не портит первый снимок

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 4. САМО ПРОДЛЕНИЕ
-- ────────────────────────────────────────────────────────────────────────────
-- Работает строго по снимку из шага 3 — то есть ровно по тем, кого показал
-- preview, и не «доберёт» никого, кто станет активным между запусками.
--
-- GREATEST гарантирует главное: срок может только вырасти. Если у кого-то
-- trial_ends_at почему-то окажется позже целевой даты, он останется своим.
UPDATE families f
   SET trial_ends_at = GREATEST(
         COALESCE(f.trial_ends_at, 'epoch'::timestamptz),
         b.gate_launch_at + interval '7 days'
       )
  FROM trial_grace_backup b
 WHERE b.family_id = f.id
   -- Ещё раз, уже на момент самого UPDATE: платных не касаемся. За время
   -- между шагами 3 и 4 кто-то мог оплатить подписку.
   AND (f.pro_until IS NULL OR f.pro_until <= now());

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 5. ПРОВЕРКА РЕЗУЛЬТАТА
-- ────────────────────────────────────────────────────────────────────────────
SELECT count(*)                                                   AS extended,
       min(f.trial_ends_at)                                       AS min_new_end,
       max(f.trial_ends_at)                                       AS max_new_end,
       count(*) FILTER (WHERE f.trial_ends_at <= now())           AS still_expired_should_be_0
  FROM families f JOIN trial_grace_backup b ON b.family_id = f.id;

-- ════════════════════════════════════════════════════════════════════════════
-- ОТКАТ GRACE PERIOD
-- ════════════════════════════════════════════════════════════════════════════
-- Возвращает ровно то, что было, по снимку из шага 3. Выполнять только если
-- решено отказаться от grace period целиком.
--
-- Условие про pro_until здесь тоже обязательно: если человек за это время
-- оплатил подписку, его trial_ends_at всё равно уже не влияет на доступ, но
-- трогать оплаченный аккаунт откатом чужого решения не нужно.
--
-- UPDATE families f
--    SET trial_ends_at = b.trial_ends_at_before
--   FROM trial_grace_backup b
--  WHERE b.family_id = f.id
--    AND (f.pro_until IS NULL OR f.pro_until <= now());
--
-- DROP TABLE trial_grace_backup;   -- только когда откат больше не понадобится
