-- ════════════════════════════════════════════════════════════════════════════
-- ДИАГНОСТИКА: сколько людей уже с истёкшим триалом и продолжают пользоваться
-- ════════════════════════════════════════════════════════════════════════════
-- ТОЛЬКО ЧТЕНИЕ. Ни один запрос в этом файле ничего не меняет — его можно
-- безопасно запускать в production в любой момент.
--
-- Зачем: до включения серверного шлюза (SUBSCRIPTION_GATE_ENABLED=true) эти
-- люди пользовались платными возможностями бесплатно, потому что серверной
-- проверки не существовало. Прежде чем включать шлюз, нужно знать масштаб.
--
-- ── ЧТО СЧИТАЕТСЯ АКТИВНОСТЬЮ (важное ограничение) ─────────────────────────
-- Колонки last_login в схеме НЕТ — её никогда не было. Реальные следы
-- активности только эти:
--   family_states.updated_at   — последнее сохранение бюджета (PUT /state,
--                                /state/reset, /state/restore-backup);
--   user_activity_events       — append-only лог сохранений ('budget_saved'),
--                                годится для «сколько активных дней»;
--   ai_requests.created_at     — обращения к AI-помощнику.
-- users.last_weekly_push_at НЕ подходит: это отметка, что мы ОТПРАВИЛИ push,
-- а не что человек что-либо сделал.
--
-- ПОЭТОМУ: чтение бюджета (GET /state) следов не оставляет. Человек, который
-- каждый день открывает приложение и просто смотрит на план, ничего не
-- редактируя, во всех запросах ниже выглядит неактивным. Все числа — это
-- НИЖНЯЯ ГРАНИЦА реальной активности.
--
-- ── ЧТО СЧИТАЕТСЯ ИСТЁКШИМ И НЕОПЛАЧЕННЫМ ──────────────────────────────────
-- Ровно та же логика, что в computePlan (lib/billingLogic.js):
--   pro_until > now()      → 'pro'   (доступ есть)
--   trial_ends_at > now()  → 'trial' (доступ есть)
--   иначе                  → 'free'  (доступа нет)
-- families.plan НЕ используется: у неоплативших она навсегда остаётся 'trial'.
-- Семьи, заведённые до введения тарифов, имеют pro_until='2099-01-01' и в
-- выборки не попадают — это правильно, им Pro выдан бессрочно.

-- Общее определение когорты. Повторяется в каждом запросе, чтобы любой из них
-- можно было скопировать и выполнить отдельно.
--   expired_unpaid: триал кончился (или его не было) И активной подписки нет,
--                   И в семье есть хотя бы один живой (не удалённый) аккаунт.

-- ────────────────────────────────────────────────────────────────────────────
-- A. ВСЕГО: истёкший триал + нет активной подписки
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                        AS families_total,
  count(*) FILTER (WHERE f.trial_ends_at IS NOT NULL)             AS with_trial_date,
  count(*) FILTER (WHERE f.trial_ends_at IS NULL)                 AS never_had_trial,
  count(*) FILTER (WHERE f.pro_until IS NOT NULL)                 AS had_subscription_before
FROM families f
WHERE (f.pro_until IS NULL OR f.pro_until <= now())
  AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
  AND EXISTS (
    SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
     WHERE m.family_id = f.id AND u.deleted_at IS NULL
  );

-- ────────────────────────────────────────────────────────────────────────────
-- B. АКТИВНОСТЬ этой когорты за 7 / 14 / 30 дней
-- ────────────────────────────────────────────────────────────────────────────
-- «Активна» = было хотя бы одно сохранение бюджета или обращение к AI.
WITH expired_unpaid AS (
  SELECT f.id
    FROM families f
   WHERE (f.pro_until IS NULL OR f.pro_until <= now())
     AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
     AND EXISTS (
       SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = f.id AND u.deleted_at IS NULL
     )
),
last_activity AS (
  SELECT e.id AS family_id,
         GREATEST(
           COALESCE(fs.updated_at,  'epoch'::timestamptz),
           COALESCE(ev.last_event,  'epoch'::timestamptz),
           COALESCE(ai.last_ai,     'epoch'::timestamptz)
         ) AS last_seen
    FROM expired_unpaid e
    LEFT JOIN family_states fs ON fs.family_id = e.id
    LEFT JOIN (
      SELECT family_id, max(created_at) AS last_event
        FROM user_activity_events GROUP BY family_id
    ) ev ON ev.family_id = e.id
    LEFT JOIN (
      SELECT m.family_id, max(a.created_at) AS last_ai
        FROM ai_requests a JOIN family_members m ON m.user_id = a.user_id
       GROUP BY m.family_id
    ) ai ON ai.family_id = e.id
)
SELECT
  count(*)                                                              AS expired_unpaid_total,
  count(*) FILTER (WHERE last_seen > now() - interval '7 days')          AS active_7d,
  count(*) FILTER (WHERE last_seen > now() - interval '14 days')         AS active_14d,
  count(*) FILTER (WHERE last_seen > now() - interval '30 days')         AS active_30d,
  count(*) FILTER (WHERE last_seen <= now() - interval '30 days')        AS inactive_30d_plus,
  count(*) FILTER (WHERE last_seen = 'epoch'::timestamptz)               AS never_any_activity
FROM last_activity;

-- ────────────────────────────────────────────────────────────────────────────
-- C. КАК ДАВНО закончился триал
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  CASE
    WHEN f.trial_ends_at IS NULL                                    THEN '0. триала не было'
    WHEN f.trial_ends_at > now() - interval '7 days'                THEN '1. 1-7 дней назад'
    WHEN f.trial_ends_at > now() - interval '14 days'               THEN '2. 8-14 дней назад'
    WHEN f.trial_ends_at > now() - interval '30 days'               THEN '3. 15-30 дней назад'
    ELSE                                                                 '4. больше 30 дней назад'
  END                        AS expired_bucket,
  count(*)                   AS families,
  min(f.trial_ends_at)       AS earliest_end,
  max(f.trial_ends_at)       AS latest_end
FROM families f
WHERE (f.pro_until IS NULL OR f.pro_until <= now())
  AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
  AND EXISTS (
    SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
     WHERE m.family_id = f.id AND u.deleted_at IS NULL
  )
GROUP BY 1
ORDER BY 1;

-- ────────────────────────────────────────────────────────────────────────────
-- D. СОВМЕЩЕНИЕ: давность окончания × активность
-- ────────────────────────────────────────────────────────────────────────────
-- Это главная таблица для решения о grace period. Строка
-- «больше 30 дней назад × активны последние 7 дней» — те, кто дольше всех
-- пользуется бесплатно и заметит включение шлюза сильнее всего.
WITH expired_unpaid AS (
  SELECT f.id, f.trial_ends_at
    FROM families f
   WHERE (f.pro_until IS NULL OR f.pro_until <= now())
     AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
     AND EXISTS (
       SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = f.id AND u.deleted_at IS NULL
     )
),
last_activity AS (
  SELECT e.id AS family_id, e.trial_ends_at,
         GREATEST(
           COALESCE(fs.updated_at, 'epoch'::timestamptz),
           COALESCE(ev.last_event, 'epoch'::timestamptz),
           COALESCE(ai.last_ai,    'epoch'::timestamptz)
         ) AS last_seen
    FROM expired_unpaid e
    LEFT JOIN family_states fs ON fs.family_id = e.id
    LEFT JOIN (
      SELECT family_id, max(created_at) AS last_event
        FROM user_activity_events GROUP BY family_id
    ) ev ON ev.family_id = e.id
    LEFT JOIN (
      SELECT m.family_id, max(a.created_at) AS last_ai
        FROM ai_requests a JOIN family_members m ON m.user_id = a.user_id
       GROUP BY m.family_id
    ) ai ON ai.family_id = e.id
)
SELECT
  CASE
    WHEN trial_ends_at IS NULL                          THEN '0. триала не было'
    WHEN trial_ends_at > now() - interval '7 days'      THEN '1. истёк 1-7 дн. назад'
    WHEN trial_ends_at > now() - interval '14 days'     THEN '2. истёк 8-14 дн. назад'
    WHEN trial_ends_at > now() - interval '30 days'     THEN '3. истёк 15-30 дн. назад'
    ELSE                                                     '4. истёк >30 дн. назад'
  END AS expired_bucket,
  CASE
    WHEN last_seen > now() - interval '7 days'          THEN 'a. активны <=7 дн.'
    WHEN last_seen > now() - interval '30 days'         THEN 'b. активны 8-30 дн.'
    WHEN last_seen = 'epoch'::timestamptz               THEN 'd. активности не было вовсе'
    ELSE                                                     'c. неактивны >30 дн.'
  END AS activity_bucket,
  count(*) AS families
FROM last_activity
GROUP BY 1, 2
ORDER BY 1, 2;

-- ────────────────────────────────────────────────────────────────────────────
-- E. ОДНА ЦИФРА для решения: сколько человек реально заденет включение шлюза
-- ────────────────────────────────────────────────────────────────────────────
-- Истёкший триал + нет подписки + правил бюджет за последние 14 дней.
-- Именно эти люди в момент включения шлюза потеряют платные возможности,
-- которыми фактически пользуются. Их же предлагается накрыть grace period
-- (см. sql/02-grace-period.sql).
WITH expired_unpaid AS (
  SELECT f.id
    FROM families f
   WHERE (f.pro_until IS NULL OR f.pro_until <= now())
     AND (f.trial_ends_at IS NULL OR f.trial_ends_at <= now())
     AND EXISTS (
       SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = f.id AND u.deleted_at IS NULL
     )
)
SELECT count(DISTINCT e.id) AS affected_active_families
FROM expired_unpaid e
LEFT JOIN family_states fs ON fs.family_id = e.id
WHERE fs.updated_at > now() - interval '14 days'
   OR EXISTS (
     SELECT 1 FROM user_activity_events ev
      WHERE ev.family_id = e.id AND ev.created_at > now() - interval '14 days'
   );
