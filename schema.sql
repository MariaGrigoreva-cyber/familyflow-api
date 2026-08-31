-- FamilyFlow · Фаза 0 · схема данных
-- Прагматичный подход: состояние приложения хранится JSONB-снапшотом на семью.
-- Нормализация транзакций/категорий — фаза совместного реалтайм-бюджета.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE NOT NULL,
  pass_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL DEFAULT 'Моя семья',
  invite_code text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_members (
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member',   -- owner | member
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);
-- Один пользователь состоит ровно в одной семье (упрощение фазы 0)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_single_family ON family_members(user_id);

CREATE TABLE IF NOT EXISTS family_states (
  family_id   uuid PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires timestamptz;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires timestamptz;

-- Пользователей, заведённых до введения проверки email, считаем подтверждёнными
-- задним числом — им не нужно ничего подтверждать. Условие по created_at делает
-- строку безопасной для повторного запуска: новых регистраций после этой даты
-- она никогда не касается.
UPDATE users SET email_verified_at = created_at
  WHERE email_verified_at IS NULL AND created_at < '2026-07-22 00:00:00+00';

-- ── Тарифы и оплата ──────────────────────────────────────────────────────────
ALTER TABLE families ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'trial'; -- trial | free | pro
ALTER TABLE families ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE families ADD COLUMN IF NOT EXISTS pro_until timestamptz;
ALTER TABLE families ADD COLUMN IF NOT EXISTS billing_period text; -- monthly | yearly
ALTER TABLE families ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT true;
ALTER TABLE families ADD COLUMN IF NOT EXISTS yk_payment_method_id text; -- сохранённый способ оплаты в ЮKassa для автосписания
ALTER TABLE families ADD COLUMN IF NOT EXISTS cancel_token text; -- разовая ссылка «отключить автопродление» из письма-напоминания
ALTER TABLE families ADD COLUMN IF NOT EXISTS renewal_reminder_sent_for timestamptz; -- за какой pro_until уже отправили напоминание — не дублировать

-- Новым семьям — 30-дневный триал с полным доступом. Существующие семьи
-- (заведённые до введения тарифов) получают Pro бессрочно задним числом —
-- нечестно вводить платный барьер для тех, кто уже пользовался бесплатно.
UPDATE families SET plan='pro', pro_until='2099-01-01 00:00:00+00', auto_renew=false
  WHERE plan='trial' AND created_at < '2026-07-26 00:00:00+00';

CREATE TABLE IF NOT EXISTS payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  yk_payment_id text UNIQUE NOT NULL,
  amount      numeric NOT NULL,
  status      text NOT NULL, -- pending | succeeded | canceled | refunded
  period      text NOT NULL, -- monthly | yearly
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Возврат за цифровой продукт надлежащего качества (ст. 48 ЗоЗПП, действует с
-- 01.02.2026) — потребитель вправе отказаться в течение 7 дней с даты оплаты.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS yk_refund_id text;

-- ── Push-уведомления ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text UNIQUE NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_weekly_push_at date;

-- Дедуп напоминаний о платеже: одно уведомление на семью/плановый платёж/дату/вид.
CREATE TABLE IF NOT EXISTS push_payment_reminders_sent (
  family_id   uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  planned_id  text NOT NULL,
  due_date    date NOT NULL,
  kind        text NOT NULL, -- today | tomorrow
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, planned_id, due_date, kind)
);

-- ── Согласия ──────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS pdn_consent_at timestamptz; -- согласие на обработку персональных данных (152-ФЗ), фиксируется при регистрации
ALTER TABLE users ADD COLUMN IF NOT EXISTS pdn_consent_ip text;
ALTER TABLE families ADD COLUMN IF NOT EXISTS auto_charge_consent_at timestamptz; -- согласие на автосписание (рекуррентные платежи), фиксируется перед первой оплатой
ALTER TABLE families ADD COLUMN IF NOT EXISTS auto_charge_consent_ip text;
-- Пользователей и семьи, заведённых до введения явного согласия, задним числом
-- не помечаем — фактического согласия по новой форме от них не было.

-- ── Ревокация токенов ────────────────────────────────────────────────────────
-- JWT живёт 90 дней и сам по себе неотзываем (stateless) — token_version даёт
-- практический способ его инвалидировать: при смене/сбросе пароля версия
-- увеличивается, и все ранее выданные токены (в т.ч. украденные) перестают
-- проходить проверку в middleware/auth.js, даже до истечения их 90 дней.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 1;

-- family_states.updated_by ссылался на users(id) без ON DELETE — при удалении
-- владельца, чья семья остаётся жить для других участников (POST
-- /auth/delete-account), это падало нарушением внешнего ключа: семья и её
-- бюджет должны пережить удаление автора последнего сохранения.
ALTER TABLE family_states DROP CONSTRAINT IF EXISTS family_states_updated_by_fkey;
ALTER TABLE family_states ADD CONSTRAINT family_states_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

-- ── Шифрование данных семьи ──────────────────────────────────────────────────
-- Само шифрование/расшифровку и перенос существующих строк делает lib/crypto.js +
-- lib/migrateEncryption.js (нужен Node, чистым SQL AES не сделать) — здесь только
-- добавляем колонку под шифротекст.
ALTER TABLE family_states ADD COLUMN IF NOT EXISTS data_enc bytea;

-- ── Онбординг-письма 2-4 (перенос воронки из n8n) ────────────────────────────
-- Письмо 1 (Welcome) шлётся сразу при регистрации в routes/auth.js. Дальше
-- lib/onboardingScheduler.js считает дни от users.created_at и шлёт письма 2-4;
-- эти колонки — дедуп-отметки, чтобы часовой прогон не отправил письмо дважды.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_email2_sent_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_email3_sent_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_email4_sent_at timestamptz;

-- ── Мягкое удаление аккаунта ─────────────────────────────────────────────────
-- /auth/delete-account раньше удалял строку users сразу и безвозвратно — ошибочное
-- или вынужденное (украденная сессия) удаление не оставляло шанса на восстановление.
-- Теперь аккаунт помечается deleted_at и сразу перестаёт быть доступен (login и
-- middleware/auth.js его не находят), а по-настоящему стирает строку
-- lib/accountPurgeScheduler.js спустя грейс-период — этого достаточно для права
-- на удаление по 152-ФЗ и не требует мгновенной необратимости.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Табличный UNIQUE на email держал бы адрес мягко удалённого аккаунта занятым
-- весь грейс-период — заменяем на частичный уникальный индекс: уникальность
-- только среди живых аккаунтов, поэтому новый пользователь может сразу
-- зарегистрироваться на тот же email, не дожидаясь окончательной очистки.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_idx ON users(email) WHERE deleted_at IS NULL;

-- ── Отложенное удаление бюджета (кнопка «Сбросить все данные») ──────────────
-- POST /state/reset раньше (через обычный PUT /state с data:{}) стирал бюджет
-- необратимо — один случайный клик терял всё без права на восстановление.
-- Теперь /state/reset сначала копирует текущее data/data_enc в reset_backup(_enc)
-- с отметкой reset_at, и только потом обнуляет — окно на восстановление даёт
-- POST /state/restore-backup, а lib/stateResetPurgeScheduler.js стирает забытую
-- копию по-настоящему спустя грейс-период (тот же принцип, что и у мягкого
-- удаления аккаунта выше).
ALTER TABLE family_states ADD COLUMN IF NOT EXISTS reset_backup jsonb;
ALTER TABLE family_states ADD COLUMN IF NOT EXISTS reset_backup_enc bytea;
ALTER TABLE family_states ADD COLUMN IF NOT EXISTS reset_at timestamptz;

-- ── Атрибуция регистрации (реклама) ─────────────────────────────────────────
-- yclid/utm_* клика по объявлению, с которого пришёл пользователь — лендинг
-- кладёт их в cookie ff_attr на .myfamilyflow.ru (familyflow-web/src/lib/metrika.js
-- читает её и шлёт сюда при POST /auth/register). Без этого нельзя сопоставить
-- регистрацию с конкретной кампанией/фразой в Яндекс.Директе — ни выгрузить
-- офлайн-конверсии по yclid, ни посчитать конверсию по utm_campaign вручную.
ALTER TABLE users ADD COLUMN IF NOT EXISTS attribution jsonb;

-- ── Отписка от онбординг-рассылки ────────────────────────────────────────
-- Ссылка «Отписаться» в письмах 2-4 (см. lib/emails/) — GET /auth/unsubscribe
-- помечает этой отметкой, lib/onboardingScheduler.js больше не шлёт таким
-- пользователям. Welcome-письмо (оно же подтверждение email) отправляется
-- независимо от этой отметки — это не рассылка, а часть регистрации.
ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

-- ── Попап сбора обратной связи ───────────────────────────────────────────
-- Фронт показывает попап пользователям, зарегистрированным 14+ дней назад
-- (флаг showFeedbackPrompt в GET /family/me, см. routes/family.js), пока
-- статус остаётся 'pending'. «Оставить позже» ничего не пишет в БД — попап
-- просто вернётся при следующем заходе. «Оставить сейчас»/«не хочу» переводят
-- статус в 'submitted'/'declined' насовсем — эти пользователи больше не
-- видят попап.
ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_status text NOT NULL DEFAULT 'pending'; -- pending | submitted | declined
ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_responded_at timestamptz;

CREATE TABLE IF NOT EXISTS user_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Лог активности ───────────────────────────────────────────────────────
-- family_states хранит только текущее состояние бюджета (UPDATE перезаписывает
-- строку), поэтому по нему нельзя посчитать регулярность использования —
-- видно только момент последнего сохранения. Эта таблица — append-only лог:
-- каждое сохранение добавляет новую строку, не трогая предыдущие, что и даёт
-- метрику "активных дней" (см. routes/state.js).
CREATE TABLE IF NOT EXISTS user_activity_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid REFERENCES families(id) ON DELETE CASCADE,
  event_type  text NOT NULL, -- budget_saved | ...
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_activity_events_family_created
  ON user_activity_events(family_id, created_at);

-- ── Способ регистрации ───────────────────────────────────────────────────
-- И обычная регистрация, и вход через Яндекс ID (routes/auth.js) пишут в
-- users.pass_hash (при Яндексе — неиспользуемый случайный хеш, см. коммент
-- там), поэтому по одному pass_hash отличить способ входа нельзя. DEFAULT
-- 'email' — то, что было верно для всех строк ДО этой колонки; настоящих
-- пользователей Яндекса среди них задним числом уже не различить.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'email';

-- ── AI-помощник: техническая статистика и оценки (этап 6) ────────────────
-- ЭТО НЕ АРХИВ ПЕРЕПИСКИ. Сама история диалога живёт только на устройстве
-- (localStorage ff_ai_chat_history) — здесь НЕТ ни вопроса, ни ответа, ни
-- финансовых сумм. Таблица нужна для трёх вещей: связать оценку с конкретным
-- ответом (id), понять качество по экранам/типам запросов и удержать дневной
-- лимит запросов на пользователя.
CREATE TABLE IF NOT EXISTS ai_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Код экрана из закрытого списка (today|plan|budget|health|settings|...)
  screen          text,
  -- Был ли передан обезличенный финансовый снимок и какой детерминированный
  -- вывод применился: spending_check | period_check | none.
  had_context     boolean NOT NULL DEFAULT false,
  decision_type   text NOT NULL DEFAULT 'none',
  -- success | validation_error | not_configured | provider_error | timeout
  -- | disabled | rate_limited
  status          text NOT NULL,
  latency_ms      integer,
  -- Версия связки промпт+база знаний, чтобы понимать, на чём получен отзыв.
  prompt_version  text
);
CREATE INDEX IF NOT EXISTS idx_ai_requests_user_created
  ON ai_requests(user_id, created_at);

-- Оценка конкретного ответа. UNIQUE по request_id: повторные клики обновляют
-- существующую оценку, а не плодят строки.
CREATE TABLE IF NOT EXISTS ai_feedback (
  request_id  uuid PRIMARY KEY REFERENCES ai_requests(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      text NOT NULL CHECK (rating IN ('up', 'down')),
  -- Необязательный комментарий пользователя. Пишет его сам пользователь.
  comment     text,
  -- Текст ответа, который пользователь пометил 👎. Сохраняется ТОЛЬКО для
  -- отрицательной оценки и ТОЛЬКО для этого одного сообщения — это не архив
  -- переписки: вопрос пользователя и остальные реплики сюда не попадают.
  -- ВНИМАНИЕ: ответ помощника может содержать суммы пользователя (например,
  -- «свободный остаток 10 720 ₽»), поэтому это единственное место, где
  -- финансовые цифры оказываются в открытом виде вне family_states. Пошли на
  -- это осознанно: без текста ответа 👎 без комментария нечем разбирать.
  -- Пользователю об этом сказано прямо в интерфейсе при нажатии 👎.
  -- При смене оценки на 👍 текст стирается.
  answer_excerpt text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Таблица уже создана на проде без этой колонки — CREATE TABLE IF NOT EXISTS
-- выше её туда не добавит, поэтому отдельный ALTER (как и для остальных
-- поздних колонок в этом файле).
ALTER TABLE ai_feedback ADD COLUMN IF NOT EXISTS answer_excerpt text;
