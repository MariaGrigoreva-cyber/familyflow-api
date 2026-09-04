// Защита главного риска перехода на другой срок триала: НИЧТО не должно
// пересчитывать trial_ends_at у уже существующих семей.
//
// Риск неочевидный и оттого опасный: server.js выполняет ВЕСЬ schema.sql при
// КАЖДОМ старте процесса (не один раз при первой установке). Одна строка вида
// `UPDATE families SET trial_ends_at = created_at + interval 'N days'`,
// добавленная туда «чтобы привести базу в порядок», молча обрежет срок всем
// существующим пользователям — и будет делать это заново при каждом рестарте.
const fs = require('fs');
const path = require('path');
const { request, db, resetDb, registerUser } = require('./helpers');

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const trialEndsAt = async familyId => {
  const r = await db.query('SELECT trial_ends_at FROM families WHERE id=$1', [familyId]);
  return r.rows[0].trial_ends_at;
};

describe('schema.sql идемпотентен относительно trial_ends_at', () => {
  test('повторный прогон не меняет срок у существующей семьи', async () => {
    const u = await registerUser();
    const before = await trialEndsAt(u.familyId);
    expect(before).toBeInstanceOf(Date);

    // Ровно то, что делает server.js при старте — дважды, как два рестарта.
    await db.query(schemaSql);
    await db.query(schemaSql);

    expect((await trialEndsAt(u.familyId)).getTime()).toBe(before.getTime());
  });

  test('срок не меняется даже у семьи, попадающей под разовый UPDATE для старожилов', async () => {
    const u = await registerUser();
    // Двигаем created_at до порога из schema.sql ('2026-07-26'), чтобы строка
    // UPDATE ... WHERE plan='trial' AND created_at < ... точно сработала.
    await db.query("UPDATE families SET created_at = '2026-01-01 00:00:00+00' WHERE id=$1", [u.familyId]);
    const before = await trialEndsAt(u.familyId);

    await db.query(schemaSql);

    // Тот UPDATE выдаёт бессрочный Pro, но trial_ends_at не трогает.
    const after = await db.query('SELECT trial_ends_at, plan, pro_until FROM families WHERE id=$1', [u.familyId]);
    expect(after.rows[0].trial_ends_at.getTime()).toBe(before.getTime());
    expect(after.rows[0].plan).toBe('pro');
  });

  test('в schema.sql нет ни одного пересчёта trial_ends_at', () => {
    // Статическая проверка: ловит опасную строку в ревью, а не на проде.
    // Комментарии вырезаем — в самом файле этот запрет описан словами и как раз
    // содержит запрещённый образец в качестве примера того, чего делать нельзя.
    const executable = schemaSql.replace(/--[^\n]*/g, '');
    const updatesTrialEnd = /UPDATE\s+families[\s\S]{0,400}?SET[\s\S]{0,400}?trial_ends_at\s*=/i.test(executable);
    expect(updatesTrialEnd).toBe(false);
    // И заодно убеждаемся, что предупреждение из файла никто не удалил.
    expect(schemaSql).toContain('trial_ends_at неприкосновенен');
  });
});

describe('срок триала при регистрации', () => {
  const original = process.env.TRIAL_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRIAL_DAYS;
    else process.env.TRIAL_DAYS = original;
  });

  // Сравниваем с ожидаемым сроком, допуская несколько минут на выполнение теста.
  const expectDaysFromNow = (date, days) => {
    const diffDays = (date.getTime() - Date.now()) / 86400000;
    expect(diffDays).toBeGreaterThan(days - 0.01);
    expect(diffDays).toBeLessThanOrEqual(days + 0.01);
  };

  test('без TRIAL_DAYS новая регистрация получает 30 дней', async () => {
    delete process.env.TRIAL_DAYS;
    const u = await registerUser();
    expectDaysFromNow(await trialEndsAt(u.familyId), 30);
  });

  test('TRIAL_DAYS применяется к новой регистрации', async () => {
    process.env.TRIAL_DAYS = '14';
    const u = await registerUser();
    expectDaysFromNow(await trialEndsAt(u.familyId), 14);
  });

  test('мусор в TRIAL_DAYS не даёт нулевой триал — откат к 30', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TRIAL_DAYS = 'сколько-нибудь';
    const u = await registerUser();
    expectDaysFromNow(await trialEndsAt(u.familyId), 30);
    spy.mockRestore();
  });

  test('смена TRIAL_DAYS не трогает уже выданные сроки', async () => {
    delete process.env.TRIAL_DAYS;
    const old = await registerUser();
    const oldEnd = await trialEndsAt(old.familyId);

    process.env.TRIAL_DAYS = '14';
    const fresh = await registerUser();

    expect((await trialEndsAt(old.familyId)).getTime()).toBe(oldEnd.getTime());
    expectDaysFromNow(await trialEndsAt(fresh.familyId), 14);
  });
});

describe('оба потока регистрации дают одинаковый срок', () => {
  const original = process.env.TRIAL_DAYS;
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    if (original === undefined) delete process.env.TRIAL_DAYS;
    else process.env.TRIAL_DAYS = original;
    delete process.env.YANDEX_CLIENT_ID;
    delete process.env.YANDEX_CLIENT_SECRET;
  });

  test('обычная регистрация и первый вход через Яндекс ID — один и тот же триал', async () => {
    process.env.TRIAL_DAYS = '17'; // нарочно не 30 и не 14: подхватят оба потока или ни один
    process.env.YANDEX_CLIENT_ID = 'test-client-id';
    process.env.YANDEX_CLIENT_SECRET = 'test-client-secret';

    const viaEmail = await registerUser();
    const emailEnd = await trialEndsAt(viaEmail.familyId);

    // Подменяем оба внешних вызова Яндекса — сам OAuth здесь не проверяем.
    const yandexEmail = `yandex-${Date.now()}@example.com`;
    global.fetch = jest.fn(async url => {
      if (String(url).includes('oauth.yandex.ru/token')) {
        return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
      }
      if (String(url).includes('login.yandex.ru/info')) {
        return { ok: true, json: async () => ({ default_email: yandexEmail }) };
      }
      throw new Error('неожиданный внешний вызов: ' + url);
    });

    const res = await request.get('/auth/yandex/callback').query({ code: 'test-code' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('#yandex_token=');

    const y = await db.query(
      `SELECT f.id, f.trial_ends_at FROM families f
         JOIN family_members m ON m.family_id = f.id
         JOIN users u ON u.id = m.user_id
        WHERE u.email = $1`, [yandexEmail]);
    expect(y.rows.length).toBe(1);

    // Оба потока созданы почти одновременно — разница должна быть в секундах,
    // а не в днях. Так ловится расхождение вида «30 дней тут и 14 там».
    const deltaDays = Math.abs(y.rows[0].trial_ends_at.getTime() - emailEnd.getTime()) / 86400000;
    expect(deltaDays).toBeLessThan(0.01);
  });

  test('оба INSERT берут срок из общего хелпера, а не из своего литерала', () => {
    // Статическая страховка: даже если интеграционный тест выше когда-нибудь
    // отключат, здесь сразу видно возврат к зашитому `interval '30 days'`.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    const inserts = src.match(/INSERT INTO families\([^)]*\)[^`]*/g) || [];
    expect(inserts.length).toBe(2);
    for (const stmt of inserts) {
      expect(stmt).toContain("($2 || ' days')::interval");
      expect(stmt).not.toMatch(/interval\s+'\d+\s+days'/);
    }
    expect((src.match(/trialIntervalParam\(\)/g) || []).length).toBe(2);
  });
});
