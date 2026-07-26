// Готовит тестовую БД один раз перед всем прогоном: создаёт базу (если её ещё
// нет) и применяет актуальную schema.sql. Переменные окружения, выставленные
// здесь, наследуются тестовыми воркерами (см. документацию Jest по globalSetup).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

module.exports = async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-not-for-production';
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
  process.env.PGSSL = process.env.PGSSL || 'disable';
  // В CI (.github/workflows/ci.yml) это указывает на сервис-контейнер Postgres.
  // Для локального прогона задайте TEST_DATABASE_URL под свою установку Postgres.
  const rawUrl = process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:postgres@localhost:5432/familyflow_test';
  process.env.DATABASE_URL = rawUrl;

  const url = new URL(rawUrl);
  const dbName = url.pathname.replace(/^\//, '');
  const adminUrl = new URL(rawUrl);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    if (e.code !== '42P04') throw e; // 42P04 = database "..." already exists — ок при повторных прогонах
  } finally {
    await admin.end();
  }

  const target = new Client({ connectionString: rawUrl, ssl: false });
  await target.connect();
  await target.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  await target.end();
};
