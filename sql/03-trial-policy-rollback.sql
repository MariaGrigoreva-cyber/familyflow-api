-- ════════════════════════════════════════════════════════════════════════════
-- ОТКАТ ПОЛИТИКИ ТРИАЛА 14 → 30 ДНЕЙ
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠️  СОДЕРЖИТ ИЗМЕНЯЮЩИЕ ЗАПРОСЫ. На момент написания НЕ НУЖЕН и запускать
--     его НЕ НАДО: production сейчас работает на 30 днях (TRIAL_DAYS=30),
--     14-дневная политика ещё не включалась. Файл готов заранее, чтобы в
--     момент отката не пришлось придумывать SQL на ходу.
--
-- ── ПОЧЕМУ ПРОСТОЙ ОТКАТ КОНФИГА НЕДОСТАТОЧЕН ──────────────────────────────
-- trial_ends_at — АБСОЛЮТНАЯ дата, зафиксированная один раз при регистрации.
-- Возврат TRIAL_DAYS=14 → 30 меняет поведение только для НОВЫХ регистраций.
-- Те, кто зарегистрировался, пока действовали 14 дней, свои 14 дней и
-- сохранят: их дата уже записана, и никакая правка окружения её не тронет.
--
-- Поэтому у отката две части:
--   1. конфиг      — TRIAL_DAYS=30, TRIAL_POLICY_CUTOFF_AT убрать (новые
--                    регистрации снова получают 30 дней). Это и есть основной
--                    откат, дальше можно не идти;
--   2. этот SQL    — точечно доплатить 16 дней тем, кто попал в «окно 14
--                    дней», ЕСЛИ решено, что им тоже положены 30.
--
-- ── ЧТО ОБЯЗАТЕЛЬНО ЗНАТЬ ЗАРАНЕЕ ──────────────────────────────────────────
-- Момент включения 14-дневной политики. Именно поэтому TRIAL_POLICY_CUTOFF_AT
-- задаётся явной датой, а не «просто включим TRIAL_DAYS=14»: без записанного
-- порога когорту потом не выделить, и придётся угадывать по created_at.
--
-- Запуск:
--   psql "$DATABASE_URL" \
--     -v cutoff_at="2026-09-15T10:00:00Z" \
--     -v rollback_at="2026-09-22T14:30:00Z" \
--     -f sql/03-trial-policy-rollback.sql
--
--   cutoff_at   — значение TRIAL_POLICY_CUTOFF_AT, с которым жил production
--   rollback_at — момент, когда TRIAL_DAYS вернули к 30

\if :{?cutoff_at}
\else
  \echo '!! Не задан cutoff_at (значение TRIAL_POLICY_CUTOFF_AT периода 14 дней).'
  \quit
\endif
\if :{?rollback_at}
\else
  \echo '!! Не задан rollback_at (момент возврата TRIAL_DAYS=30).'
  \quit
\endif

-- Разница между политиками. 30 - 14 = 16 дней.
-- Прибавляем РАЗНИЦУ к существующей дате, а не пересчитываем от created_at:
--   • не зависит от того, как именно дата была получена изначально;
--   • не затирает grace period, если он кому-то из этих людей уже применялся;
--   • арифметически не может укоротить срок.

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 1. PREVIEW — кто попал в окно 14-дневной политики. НИЧЕГО НЕ МЕНЯЕТ.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  f.id,
  f.name,
  f.created_at,
  f.trial_ends_at                                        AS current_end,
  f.trial_ends_at + interval '16 days'                   AS end_after_rollback,
  (f.trial_ends_at - f.created_at)                       AS granted_span,
  CASE WHEN f.pro_until > now() THEN 'оплачено — не трогаем' ELSE 'будет продлён' END AS verdict
FROM families f
WHERE f.created_at >= (:'cutoff_at')::timestamptz
  AND f.created_at <  (:'rollback_at')::timestamptz
  AND f.trial_ends_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
     WHERE m.family_id = f.id AND u.deleted_at IS NULL
  )
ORDER BY f.created_at;

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 2. КОЛИЧЕСТВО. НИЧЕГО НЕ МЕНЯЕТ.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                  AS in_window_total,
  count(*) FILTER (WHERE f.pro_until > now())               AS paid_skipped,
  count(*) FILTER (WHERE f.pro_until IS NULL OR f.pro_until <= now()) AS to_extend
FROM families f
WHERE f.created_at >= (:'cutoff_at')::timestamptz
  AND f.created_at <  (:'rollback_at')::timestamptz
  AND f.trial_ends_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
     WHERE m.family_id = f.id AND u.deleted_at IS NULL
  );

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 3. СНИМОК ДО ИЗМЕНЕНИЯ
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trial_policy_rollback_backup (
  family_id            uuid PRIMARY KEY,
  trial_ends_at_before timestamptz NOT NULL,
  created_at_snapshot  timestamptz NOT NULL,
  applied_at           timestamptz NOT NULL DEFAULT now(),
  cutoff_at            timestamptz NOT NULL,
  rollback_at          timestamptz NOT NULL
);

INSERT INTO trial_policy_rollback_backup(
  family_id, trial_ends_at_before, created_at_snapshot, cutoff_at, rollback_at)
SELECT f.id, f.trial_ends_at, f.created_at,
       (:'cutoff_at')::timestamptz, (:'rollback_at')::timestamptz
  FROM families f
 WHERE f.created_at >= (:'cutoff_at')::timestamptz
   AND f.created_at <  (:'rollback_at')::timestamptz
   AND f.trial_ends_at IS NOT NULL
   AND (f.pro_until IS NULL OR f.pro_until <= now())
   AND EXISTS (
     SELECT 1 FROM family_members m JOIN users u ON u.id = m.user_id
      WHERE m.family_id = f.id AND u.deleted_at IS NULL
   )
ON CONFLICT (family_id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 4. ПРОДЛЕНИЕ до 30-дневной политики
-- ────────────────────────────────────────────────────────────────────────────
-- Работает строго по снимку — повторный запуск не добавит вторые 16 дней,
-- потому что ON CONFLICT DO NOTHING выше не расширит снимок, а GREATEST
-- сравнивает с УЖЕ СОХРАНЁННЫМ исходным значением, а не с текущим.
UPDATE families f
   SET trial_ends_at = GREATEST(
         f.trial_ends_at,
         b.trial_ends_at_before + interval '16 days'
       )
  FROM trial_policy_rollback_backup b
 WHERE b.family_id = f.id
   -- Ещё раз на момент самого UPDATE: за время между шагами кто-то мог оплатить.
   AND (f.pro_until IS NULL OR f.pro_until <= now());

-- ────────────────────────────────────────────────────────────────────────────
-- ШАГ 5. ПРОВЕРКА
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  count(*)                                                          AS touched,
  count(*) FILTER (WHERE f.trial_ends_at < b.trial_ends_at_before)  AS shortened_MUST_BE_0,
  min(f.trial_ends_at - b.trial_ends_at_before)                     AS min_delta,
  max(f.trial_ends_at - b.trial_ends_at_before)                     AS max_delta
FROM families f JOIN trial_policy_rollback_backup b ON b.family_id = f.id;

-- ════════════════════════════════════════════════════════════════════════════
-- ОТКАТ ЭТОГО ОТКАТА
-- ════════════════════════════════════════════════════════════════════════════
-- UPDATE families f
--    SET trial_ends_at = b.trial_ends_at_before
--   FROM trial_policy_rollback_backup b
--  WHERE b.family_id = f.id;
--
-- DROP TABLE trial_policy_rollback_backup;
