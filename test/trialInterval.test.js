// Срок триала уходит в Postgres параметром. Здесь проверяется, что он уходит
// В ПРАВИЛЬНОЙ ФОРМЕ — и проверяется так, чтобы результат не зависел от того,
// насколько снисходительна конкретная сборка Postgres.
//
// История, ради которой файл существует. trialIntervalParam() возвращает
// готовое «30 days», а SQL в routes/auth.js дописывал к нему ещё одну единицу:
//     now() + ($2 || ' days')::interval   →   «30 days days»
// PostgreSQL 16.14 (Homebrew, локально) такую строку принимал и давал ровно
// 30 дней, поэтому весь набор тестов и ручной smoke были зелёными. Postgres на
// проде оказался строже и отвечал
//     invalid input syntax for type interval: "30 days days"  (SQLSTATE 22007)
// — регистрация падала с 500, ни один аккаунт не создавался.
//
// Отсюда главный вывод для этих тестов: проверка «дата получилась правильная»
// НЕ ловит такую ошибку, потому что на снисходительной базе дата действительно
// правильная. Ловит только проверка самой строки и самого SQL — они одинаковы
// на любой версии. Поэтому основной страж здесь статический.
const fs = require('fs');
const path = require('path');
const { trialIntervalParam, effectiveTrialDays } = require('../lib/entitlement');
const { request, db, resetDb } = require('./helpers');

// Комментарии вырезаем: в них тоже упоминаются и вызов хелпера, и обе формы
// SQL (в том числе сломанная, как пример того, чего делать нельзя). Без этого
// тест считал бы упоминания в тексте наравне с настоящими вызовами и падал бы
// от любой правки комментария.
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const authSrc = stripComments(
  fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8'));

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

describe('форма параметра', () => {
  test('trialIntervalParam возвращает число и РОВНО одну единицу измерения', () => {
    expect(trialIntervalParam()).toMatch(/^\d+ days$/);
  });

  test('единица не задваивается ни при каком сроке', () => {
    const saved = [process.env.TRIAL_DAYS, process.env.TRIAL_POLICY_CUTOFF_AT];
    // Порог в прошлом — иначе сработает предохранитель и срок всегда будет 30
    // (см. test/trialFailSafe.test.js). Здесь проверяется ФОРМА строки, поэтому
    // политика должна быть включена.
    process.env.TRIAL_POLICY_CUTOFF_AT = '2020-01-01T00:00:00Z';
    try {
      for (const days of ['1', '14', '30', '365']) {
        process.env.TRIAL_DAYS = days;
        expect(trialIntervalParam()).toBe(`${days} days`);
        expect(trialIntervalParam()).not.toMatch(/days\s+days/);
      }
    } finally {
      for (const [k, v] of [['TRIAL_DAYS', saved[0]], ['TRIAL_POLICY_CUTOFF_AT', saved[1]]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe('SQL, в который он подставляется', () => {
  // Статическая проверка: не зависит ни от версии Postgres, ни от того,
  // согласится ли она разобрать кривую строку.
  test('интервал приводится как есть, единица в SQL не дописывается', () => {
    const inserts = authSrc.match(/INSERT INTO families\([^)]*\)[^`]*/g) || [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const sql of inserts) {
      expect(sql).toContain('$2::interval');
      // Ровно тот текст, который сломал прод.
      expect(sql).not.toMatch(/\|\|\s*'\s*days/);
    }
  });

  test('оба потока регистрации задают срок одинаково', () => {
    const uses = authSrc.match(/now\(\) \+ \$2::interval/g) || [];
    // Обычная регистрация и первый вход через Яндекс ID.
    expect(uses).toHaveLength(2);
    expect(authSrc.match(/trialIntervalParam\(\)/g)).toHaveLength(2);
  });
});

describe('регистрация реально создаёт семью', () => {
  // Тот самый сценарий, который падал на проде с 500. Проверка не заменяет
  // статическую (на снисходительной базе она проходила и с ошибкой), но
  // страхует от поломки самого пути создания аккаунта.
  test('POST /auth/register отвечает 200 и ставит срок триала', async () => {
    const res = await request.post('/auth/register')
      .send({ email: `interval-${Date.now()}@example.com`, password: 'password123', pdnConsent: true });
    expect(res.status).toBe(200);
    expect(res.body.familyId).toBeTruthy();

    const r = await db.query('SELECT trial_ends_at FROM families WHERE id=$1', [res.body.familyId]);
    const daysOut = (new Date(r.rows[0].trial_ends_at) - Date.now()) / 86400000;
    expect(daysOut).toBeGreaterThan(effectiveTrialDays() - 1);
    expect(daysOut).toBeLessThanOrEqual(effectiveTrialDays());
  });
});
