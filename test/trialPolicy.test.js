// Политика перехода 30 → 14 дней (TRIAL_DAYS + TRIAL_POLICY_CUTOFF_AT).
//
// Тесты написаны ЗАРАНЕЕ, пока в production действует 30 дней: они и есть та
// страховка, которая позволит переключить срок одной переменной окружения и не
// проверять руками, что никому ничего не урезали.
//
// Разделение по уровням сознательное: точные границы (за секунду до порога,
// ровно в порог) проверяются юнит-тестом effectiveTrialDays с подставленным
// временем, а реальные регистрации — интеграционно, с заведомым запасом в
// минуту, чтобы тест не зависел от того, сколько заняли bcrypt и DNS-проверка.
const fs = require('fs');
const path = require('path');
const { request, db, resetDb, registerUser } = require('./helpers');
const {
  effectiveTrialDays, trialDays, trialPolicyCutoffMs, LEGACY_TRIAL_DAYS,
} = require('../lib/entitlement');

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

// Аккуратно возвращаем окружение: иначе одна забытая переменная меняет
// поведение всех последующих файлов тестов.
const ENV_KEYS = ['TRIAL_DAYS', 'TRIAL_POLICY_CUTOFF_AT'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const iso = ms => new Date(ms).toISOString();
const trialEndsAt = async familyId => {
  const r = await db.query('SELECT trial_ends_at FROM families WHERE id=$1', [familyId]);
  return r.rows[0].trial_ends_at;
};
const expectDaysFromNow = (date, days) => {
  const diff = (date.getTime() - Date.now()) / 86400000;
  expect(diff).toBeGreaterThan(days - 0.02);
  expect(diff).toBeLessThanOrEqual(days + 0.02);
};

// ════════════════════════════════════════════════════════════════════════════
// Границы порога — точно, без гонок с реальным временем
// ════════════════════════════════════════════════════════════════════════════
describe('порог смены политики: границы', () => {
  const CUTOFF = Date.parse('2026-09-15T10:00:00Z');
  beforeEach(() => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = '2026-09-15T10:00:00Z';
  });

  test('за секунду до порога — старая политика, 30 дней', () => {
    expect(effectiveTrialDays(CUTOFF - 1000)).toBe(30);
  });

  test('ровно в порог — новая политика, 14 дней', () => {
    expect(effectiveTrialDays(CUTOFF)).toBe(14);
  });

  test('через секунду после порога — 14 дней', () => {
    expect(effectiveTrialDays(CUTOFF + 1000)).toBe(14);
  });

  test('за месяц до порога — 30, через месяц после — 14', () => {
    expect(effectiveTrialDays(CUTOFF - 30 * 86400000)).toBe(30);
    expect(effectiveTrialDays(CUTOFF + 30 * 86400000)).toBe(14);
  });
});

describe('порог: часовые пояса и некорректные значения', () => {
  test('одинаковый момент в разных записях зоны даёт одинаковый порог', () => {
    process.env.TRIAL_DAYS = '14';
    // 10:00Z и 13:00+03:00 — это ОДИН момент времени.
    process.env.TRIAL_POLICY_CUTOFF_AT = '2026-09-15T10:00:00Z';
    const asZulu = trialPolicyCutoffMs();
    process.env.TRIAL_POLICY_CUTOFF_AT = '2026-09-15T13:00:00+03:00';
    expect(trialPolicyCutoffMs()).toBe(asZulu);
  });

  test('дата без зоны отвергается — иначе порог сдвинулся бы на часы вместе с TZ процесса', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = '2026-09-15T10:00:00'; // зоны нет
    expect(Number.isNaN(trialPolicyCutoffMs())).toBe(true);
    // Не угадываем: отдаём старый, больший срок.
    expect(effectiveTrialDays(Date.parse('2026-12-01T00:00:00Z'))).toBe(LEGACY_TRIAL_DAYS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('мусор в пороге тоже даёт старую политику, а не 14 дней', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.TRIAL_DAYS = '14';
    for (const bad of ['завтра', '15.09.2026', '2026-13-45T99:99:99Z', 'null']) {
      process.env.TRIAL_POLICY_CUTOFF_AT = bad;
      expect(effectiveTrialDays(Date.parse('2026-12-01T00:00:00Z'))).toBe(LEGACY_TRIAL_DAYS);
    }
    spy.mockRestore();
  });

  test('порог не задан — TRIAL_DAYS действует сразу, с предупреждением в лог', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '14';
    expect(effectiveTrialDays()).toBe(14);
    // Предупреждение важно: без порога не зафиксирован момент перехода,
    // а без него невозможен откатный SQL по когорте.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('порог не задан и TRIAL_DAYS=30 — ничего не меняется и никто не предупреждается', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '30';
    expect(effectiveTrialDays()).toBe(30);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Реальные регистрации
// ════════════════════════════════════════════════════════════════════════════
describe('реальная регистрация подчиняется порогу', () => {
  test('до порога — 30 дней, даже если TRIAL_DAYS=14', async () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() + 60_000); // порог в будущем
    const u = await registerUser();
    expectDaysFromNow(await trialEndsAt(u.familyId), 30);
  });

  test('после порога — 14 дней', async () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() - 60_000); // порог уже прошёл
    const u = await registerUser();
    expectDaysFromNow(await trialEndsAt(u.familyId), 14);
  });

  test('оба потока регистрации подчиняются одному порогу', async () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() - 60_000);
    process.env.YANDEX_CLIENT_ID = 'test-client-id';
    process.env.YANDEX_CLIENT_SECRET = 'test-client-secret';
    const originalFetch = global.fetch;
    try {
      const viaEmail = await registerUser();
      expectDaysFromNow(await trialEndsAt(viaEmail.familyId), 14);

      const yandexEmail = `yandex-policy-${Date.now()}@example.com`;
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

      const y = await db.query(
        `SELECT f.trial_ends_at FROM families f
           JOIN family_members m ON m.family_id = f.id
           JOIN users u ON u.id = m.user_id
          WHERE u.email = $1`, [yandexEmail]);
      expectDaysFromNow(y.rows[0].trial_ends_at, 14);
    } finally {
      global.fetch = originalFetch;
      delete process.env.YANDEX_CLIENT_ID;
      delete process.env.YANDEX_CLIENT_SECRET;
    }
  });

  test('ни версия клиента, ни его часы, ни тело запроса на срок не влияют', async () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() - 60_000);
    // Клиент «сообщает» о себе всё, чем мог бы попытаться повлиять на срок.
    const email = `client-claims-${Date.now()}@example.com`;
    const res = await request.post('/auth/register')
      .set('X-App-Version', '3')
      .set('User-Agent', 'FamilyFlow/1.0 (Android; versionCode 3)')
      .set('Date', new Date(Date.now() - 400 * 86400000).toUTCString())
      .send({
        email, password: 'password123', pdnConsent: true,
        trialDays: 365, trial_ends_at: iso(Date.now() + 365 * 86400000),
        clientNow: iso(Date.now() - 400 * 86400000), timezoneOffset: -720,
      });
    expect(res.status).toBe(200);
    expectDaysFromNow(await trialEndsAt(res.body.familyId), 14);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Неприкосновенность выданных сроков
// ════════════════════════════════════════════════════════════════════════════
describe('существующие trial_ends_at не пересчитываются', () => {
  test('смена TRIAL_DAYS и появление порога не трогают выданный срок', async () => {
    // Регистрация по старой политике.
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '30';
    const old = await registerUser();
    const before = await trialEndsAt(old.familyId);
    expectDaysFromNow(before, 30);

    // Включаем новую политику.
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() - 1000);

    // Существующий не изменился; новый получил 14.
    expect((await trialEndsAt(old.familyId)).getTime()).toBe(before.getTime());
    const fresh = await registerUser();
    expectDaysFromNow(await trialEndsAt(fresh.familyId), 14);
    expect((await trialEndsAt(old.familyId)).getTime()).toBe(before.getTime());
  });

  test('перезапуск бэкенда (повторный прогон schema.sql) ничего не пересчитывает', async () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() - 1000);
    const u = await registerUser();
    const before = await trialEndsAt(u.familyId);

    // Ровно то, что делает server.js при каждом старте.
    await db.query(schemaSql);
    await db.query(schemaSql);

    expect((await trialEndsAt(u.familyId)).getTime()).toBe(before.getTime());
  });

  test('откат политики 14 → 30 не уменьшает и не меняет срок существующим', async () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = iso(Date.now() - 1000);
    const during14 = await registerUser();
    const end14 = await trialEndsAt(during14.familyId);
    expectDaysFromNow(end14, 14);

    // Откат: новые снова получают 30.
    process.env.TRIAL_DAYS = '30';
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    const afterRollback = await registerUser();
    expectDaysFromNow(await trialEndsAt(afterRollback.familyId), 30);

    // Но выданные 14 дней сами по себе НЕ превращаются в 30 — это и есть
    // причина, по которой для отката нужен точечный UPDATE по когорте
    // (см. отчёт: rollback strategy). Тест фиксирует именно это ожидание.
    expect((await trialEndsAt(during14.familyId)).getTime()).toBe(end14.getTime());
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Единый источник срока
// ════════════════════════════════════════════════════════════════════════════
describe('срок задаётся в одном месте', () => {
  test('оба INSERT в routes/auth.js берут срок из общего хелпера', () => {
    // Комментарии вырезаем — они упоминают и хелпер, и обе формы SQL.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const inserts = src.match(/INSERT INTO families\([^)]*\)[^`]*/g) || [];
    expect(inserts.length).toBe(2);
    for (const stmt of inserts) {
      // Единица измерения уже внутри trialIntervalParam() («30 days»), поэтому
      // в SQL параметр приводится КАК ЕСТЬ. Раньше здесь ожидалось
      // ($2 || ' days')::interval — эта форма давала «30 days days» и роняла
      // регистрацию на проде (22007). См. test/trialInterval.test.js.
      expect(stmt).toContain('$2::interval');
      expect(stmt).not.toMatch(/\|\|\s*'\s*days/);
      expect(stmt).not.toMatch(/interval\s+'\d+\s+days'/);
    }
    expect((src.match(/trialIntervalParam\(\)/g) || []).length).toBe(2);
  });

  test('дату окончания считает БД, а не JS: в запросе стоит now()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    const inserts = src.match(/INSERT INTO families\([^)]*\)[^`]*/g) || [];
    for (const stmt of inserts) expect(stmt).toContain('now() +');
  });

  test('в production сейчас 30 дней', () => {
    // Страховка от случайного коммита TRIAL_DAYS=14 раньше времени.
    delete process.env.TRIAL_DAYS;
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    expect(trialDays()).toBe(30);
    expect(effectiveTrialDays()).toBe(30);
    expect(LEGACY_TRIAL_DAYS).toBe(30);
  });
});
