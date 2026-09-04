// Два предохранителя, каждый закрывает свою дорогую ошибку при переходе на
// короткий пробный период.
//
// 1. Новая политика не включается без явно заданного момента перехода. Одной
//    переменной TRIAL_DAYS, забытой в панели хостинга, недостаточно: иначе срок
//    молча урезался бы всем новым регистрациям, и заметить это можно было бы
//    только через недели, когда у людей начнёт заканчиваться Pro раньше
//    обещанного.
//
// 2. Сдвиг дня письма 4 не вызывает массовую рассылку. День зависит от длины
//    триала конкретного человека, поэтому те, кто уже живёт с 30-дневным
//    сроком, не получают письмо разом на первом же прогоне после выкатки.
jest.mock('../lib/mail', () => {
  const actual = jest.requireActual('../lib/mail');
  return {
    ...actual,
    mailConfigured: () => true,
    sendMail: jest.fn().mockResolvedValue({ ok: true }),
    unsubscribeUrl: () => 'https://example.test/unsub',
  };
});

const mail = require('../lib/mail');
const {
  effectiveTrialDays, trialDays, trialIntervalParam, LEGACY_TRIAL_DAYS,
} = require('../lib/entitlement');
const { SUBJECT4 } = require('../lib/onboardingScheduler');
const { db, resetDb, registerUser } = require('./helpers');

const ENV = ['TRIAL_DAYS', 'TRIAL_POLICY_CUTOFF_AT'];
const saved = {};
beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  for (const k of ENV) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => { await db.end(); });

const quiet = fn => {
  const warn = console.warn, error = console.error;
  console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.warn = warn; console.error = error; }
};

// ════════════════════════════════════════════════════════════════════════════
describe('без момента перехода новая политика не включается', () => {
  test('TRIAL_DAYS=14 сам по себе НЕ укорачивает триал', () => {
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '14';
    // Сам парсер значение видит...
    expect(trialDays()).toBe(14);
    // ...но политика без порога его не применяет.
    expect(quiet(() => effectiveTrialDays())).toBe(30);
    expect(quiet(() => trialIntervalParam())).toBe('30 days');
  });

  test('и предупреждает в лог, чтобы расхождение не осталось незамеченным', () => {
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '14';
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    effectiveTrialDays();
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toMatch(/НЕ применяется/);
    spy.mockRestore();
  });

  test('битый порог тоже оставляет старый срок', () => {
    process.env.TRIAL_DAYS = '14';
    for (const bad of ['мусор', '2026-09-15', '2026-09-15T10:00:00', '']) {
      process.env.TRIAL_POLICY_CUTOFF_AT = bad;
      expect(quiet(() => effectiveTrialDays())).toBe(30);
    }
  });

  test('порог в будущем — до него всё ещё 30 дней', () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = '2099-01-01T00:00:00Z';
    expect(effectiveTrialDays()).toBe(30);
  });

  test('включается ровно тогда, когда порог задан и наступил', () => {
    process.env.TRIAL_DAYS = '14';
    process.env.TRIAL_POLICY_CUTOFF_AT = '2026-09-15T10:00:00Z';
    const cutoff = Date.parse('2026-09-15T10:00:00Z');
    expect(effectiveTrialDays(cutoff - 1)).toBe(30);   // за миллисекунду до
    expect(effectiveTrialDays(cutoff)).toBe(14);       // ровно в момент
    expect(effectiveTrialDays(cutoff + 86400000)).toBe(14);
  });

  test('LEGACY_TRIAL_DAYS — именно 30, это обещание старой когорте', () => {
    expect(LEGACY_TRIAL_DAYS).toBe(30);
  });

  test('регистрация прямо сейчас получает 30 дней даже при TRIAL_DAYS=14', async () => {
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '14';
    const u = await registerUser();
    const r = await db.query(
      'SELECT trial_ends_at, created_at FROM families WHERE id=$1', [u.familyId]);
    const days = (r.rows[0].trial_ends_at - r.rows[0].created_at) / 86400000;
    expect(days).toBeGreaterThan(29.5);
    expect(days).toBeLessThan(30.5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('сдвиг письма 4 не вызывает массовую рассылку', () => {
  const { sendEmail4 } = require('../lib/onboardingScheduler');
  // Вызываем РАБОЧУЮ функцию планировщика, а не копию её запроса: копия
  // проверяла бы саму себя и разошлась бы с боевым кодом при первой же правке.
  // Смотрим на письма именно с темой письма 4 — registerUser() по дороге шлёт
  // приветственное через тот же мок.
  const runEmail4 = async () => {
    await sendEmail4();
    return mail.sendMail.mock.calls.filter(c => c[1] === SUBJECT4).map(c => c[0]);
  };

  const age = (email, days) =>
    db.query("UPDATE users SET created_at = now() - ($1 || ' days')::interval WHERE email=lower($2)",
      [String(days), email]);
  // Длину триала отмеряем от created_at ПОЛЬЗОВАТЕЛЯ, а не семьи: именно эту
  // разницу смотрит планировщик, и в бою обе даты ставятся одной транзакцией,
  // так что это точная симуляция. Через families.created_at (которая в тесте
  // остаётся «сейчас») получался бы триал другой длины.
  const setTrialLength = (familyId, days) =>
    db.query(
      `UPDATE families f SET trial_ends_at = u.created_at + ($1 || ' days')::interval
         FROM family_members m JOIN users u ON u.id = m.user_id
        WHERE m.family_id = f.id AND f.id = $2`,
      [String(days), familyId]);

  test('30-дневный триал: на 11-й день письма ещё нет', async () => {
    const u = await registerUser();
    await age(u.email, 11);
    await setTrialLength(u.familyId, 30);
    expect(await runEmail4()).not.toContain(u.email);
  });

  test('30-дневный триал: письмо приходит на прежний 14-й день', async () => {
    const u = await registerUser();
    await age(u.email, 15);
    await setTrialLength(u.familyId, 30);
    expect(await runEmail4()).toContain(u.email);
  });

  test('14-дневный триал: письмо приходит на 9-й день', async () => {
    const u = await registerUser();
    await age(u.email, 10);
    await setTrialLength(u.familyId, 14);
    expect(await runEmail4()).toContain(u.email);
  });

  test('14-дневный триал: на 8-й день ещё рано', async () => {
    const u = await registerUser();
    await age(u.email, 8);
    await setTrialLength(u.familyId, 14);
    expect(await runEmail4()).not.toContain(u.email);
  });

  // Главная проверка: именно она ловит массовую рассылку при выкатке.
  test('существующая когорта 9–14 дней с длинным триалом НЕ получает письмо разом', async () => {
    const cohort = [];
    for (const days of [9, 10, 11, 12, 13]) {
      const u = await registerUser();
      await age(u.email, days);
      await setTrialLength(u.familyId, 30);
      cohort.push(u.email);
    }
    const due = await runEmail4();
    for (const email of cohort) expect(due).not.toContain(email);
    expect(due).toHaveLength(0);
  });

  test('длину триала определить нельзя — считаем длинным, отправляем позже', async () => {
    const u = await registerUser();
    await age(u.email, 11);
    await db.query('UPDATE families SET trial_ends_at = NULL WHERE id=$1', [u.familyId]);
    expect(await runEmail4()).not.toContain(u.email);
  });
});
