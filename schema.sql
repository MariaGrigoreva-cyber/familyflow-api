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
