// Юнит-тесты единого расчёта права доступа (lib/entitlement.js). Интеграционные
// проверки самого шлюза — в test/trialAccess.test.js.
const {
  computeEntitlement, trialDays, trialIntervalParam,
  DEFAULT_TRIAL_DAYS,
} = require('../lib/entitlement');

const hoursFromNow = h => new Date(Date.now() + h * 3600 * 1000).toISOString();

describe('computeEntitlement', () => {
  test('активный триал — доступ есть, это триал, не истёк', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(24 * 18), pro_until: null });
    expect(e.access).toBe(true);
    expect(e.plan).toBe('trial');
    expect(e.subscriptionStatus).toBe('trial');
    expect(e.isTrial).toBe(true);
    expect(e.isExpired).toBe(false);
    expect(e.trialExpired).toBe(false);
    expect(e.hasActiveSubscription).toBe(false);
    expect(e.trialDaysLeft).toBe(18);
  });

  test('истёкший триал без подписки — доступа нет', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(-1), pro_until: null });
    expect(e.access).toBe(false);
    expect(e.plan).toBe('free');
    expect(e.isTrial).toBe(false);
    expect(e.isExpired).toBe(true);
    expect(e.trialExpired).toBe(true);
    expect(e.trialDaysLeft).toBe(0);
  });

  test('активная подписка — доступ есть даже при истёкшем триале', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(-24 * 100), pro_until: hoursFromNow(24 * 30) });
    expect(e.access).toBe(true);
    expect(e.plan).toBe('pro');
    expect(e.hasActiveSubscription).toBe(true);
    // Триал действительно в прошлом, но «истёкшим» пользователь не считается —
    // isExpired означает «доступа нет», а не «триал закончился».
    expect(e.trialExpired).toBe(true);
    expect(e.isExpired).toBe(false);
  });

  test('оплата во время активного триала — сразу pro, триал не «истёк»', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(24 * 5), pro_until: hoursFromNow(24 * 35) });
    expect(e.plan).toBe('pro');
    expect(e.access).toBe(true);
    expect(e.trialExpired).toBe(false);
    expect(e.trialDaysLeft).toBe(0); // считаем остаток только для плана trial
  });

  test('семья без обеих дат (заведена до введения тарифов) — доступа нет, но триал и не начинался', () => {
    const e = computeEntitlement({ trial_ends_at: null, pro_until: null });
    expect(e.plan).toBe('free');
    expect(e.access).toBe(false);
    expect(e.trialExpired).toBe(false); // отличие от «триал был и кончился»
    expect(e.trialEndsAt).toBeNull();
  });

  test('пустой/отсутствующий аргумент не роняет расчёт', () => {
    expect(computeEntitlement(undefined).plan).toBe('free');
    expect(computeEntitlement(null).access).toBe(false);
    expect(computeEntitlement({}).isExpired).toBe(true);
  });

  test('trialDaysLeft округляется вверх и не уходит в минус', () => {
    expect(computeEntitlement({ trial_ends_at: hoursFromNow(1), pro_until: null }).trialDaysLeft).toBe(1);
    expect(computeEntitlement({ trial_ends_at: hoursFromNow(25), pro_until: null }).trialDaysLeft).toBe(2);
    expect(computeEntitlement({ trial_ends_at: hoursFromNow(-50), pro_until: null }).trialDaysLeft).toBe(0);
  });
});

describe('TRIAL_DAYS', () => {
  const original = process.env.TRIAL_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRIAL_DAYS;
    else process.env.TRIAL_DAYS = original;
  });

  test('без переменной — безопасный дефолт 30', () => {
    delete process.env.TRIAL_DAYS;
    expect(trialDays()).toBe(30);
    expect(DEFAULT_TRIAL_DAYS).toBe(30);
    expect(trialIntervalParam()).toBe('30 days');
  });

  test('пустая строка трактуется как «не задано»', () => {
    process.env.TRIAL_DAYS = '';
    expect(trialDays()).toBe(30);
  });

  test('корректное значение читается парсером', () => {
    process.env.TRIAL_DAYS = '14';
    expect(trialDays()).toBe(14);
  });

  test('но без момента перехода политика его не применяет', () => {
    // trialDays() — это разбор переменной, а не решение. Решает
    // effectiveTrialDays(), и без TRIAL_POLICY_CUTOFF_AT новый срок не
    // включается: см. test/trialFailSafe.test.js.
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.TRIAL_POLICY_CUTOFF_AT;
    process.env.TRIAL_DAYS = '14';
    expect(trialIntervalParam()).toBe('30 days');
    spy.mockRestore();
  });

  test('мусор и значения вне диапазона откатываются к 30, а не роняют API', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['abc', '0', '-5', '366', '14.5', 'NaN', '  ']) {
      process.env.TRIAL_DAYS = bad;
      expect(trialDays()).toBe(30);
    }
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('значение читается на каждый вызов, а не кешируется при загрузке модуля', () => {
    process.env.TRIAL_DAYS = '14';
    expect(trialDays()).toBe(14);
    process.env.TRIAL_DAYS = '21';
    expect(trialDays()).toBe(21);
  });
});
