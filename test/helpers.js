// Общие хелперы для интеграционных тестов: HTTP-агент поверх приложения без
// поднятия реального сервера (server.js экспортирует app только при require,
// см. `require.main === module` в нём) и сброс данных между тестами.
const supertest = require('supertest');
const app = require('../server');
const db = require('../db');

const request = supertest(app);

async function resetDb() {
  await db.query(`TRUNCATE TABLE
    push_payment_reminders_sent, push_subscriptions, payments,
    family_state_versions, family_states, family_members, families, users
    RESTART IDENTITY CASCADE`);
}

let counter = 0;
const uniqueEmail = () => `test-${Date.now()}-${counter++}@example.com`;

// Регистрирует нового пользователя (со своей семьёй) и возвращает токен/id.
async function registerUser(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const password = overrides.password || 'password123';
  const res = await request.post('/auth/register').send({
    email, password, pdnConsent: true, familyName: overrides.familyName,
  });
  if (res.status !== 200) throw new Error('registerUser failed: ' + JSON.stringify(res.body));
  return { email, password, token: res.body.token, familyId: res.body.familyId };
}

module.exports = { app, request, db, resetDb, registerUser, uniqueEmail };
