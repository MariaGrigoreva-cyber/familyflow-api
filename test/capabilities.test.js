// Реестр состава тарифов (lib/capabilities.js) — юнит-тесты.
// Интеграционные проверки самих шлюзов — в test/trialAccess.test.js.
const {
  CAPABILITIES, CAPABILITY_NAMES, FREE_CAPABILITIES, PRO_CAPABILITIES,
  hasCapability, capabilitiesFor, isPaidPlan,
} = require('../lib/capabilities');
const { computeEntitlement } = require('../lib/entitlement');

const hoursFromNow = h => new Date(Date.now() + h * 3600 * 1000).toISOString();

describe('состав тарифов', () => {
  test('бесплатный тариф оставляет базовое ведение бюджета', () => {
    // Главный продуктовый инвариант: Free не должен быть сломанным. Человек
    // без подписки ведёт свой бюджет и получает поддержку по приложению.
    expect(FREE_CAPABILITIES).toEqual(expect.arrayContaining(['basicBudget', 'aiSupport']));
  });

  test('ценность Pro — прогноз, предупреждения, решения о покупках и AI по своему плану', () => {
    expect(PRO_CAPABILITIES).toEqual(expect.arrayContaining([
      'safeSpendable', 'forecast', 'cashflowWarnings', 'spendingCheck',
      'aiAssistant', 'scenarios', 'recommendations',
    ]));
  });

  // «Сколько можно потратить сейчас» и «что будет в следующие недели» — разные
  // вопросы пользователя, поэтому и разные возможности, хотя считаются из
  // одного прогноза. Слить их обратно в одну — молча лишить возможности менять
  // состав тарифа по одному из вопросов.
  test('safeSpendable и forecast — отдельные возможности', () => {
    expect(CAPABILITY_NAMES).toEqual(expect.arrayContaining(['safeSpendable', 'forecast']));
    expect(CAPABILITIES.safeSpendable).toBe('pro');
    expect(CAPABILITIES.forecast).toBe('pro');
  });

  test('каждая возможность отнесена ровно к одному тарифу', () => {
    for (const name of CAPABILITY_NAMES) {
      expect(['free', 'pro']).toContain(CAPABILITIES[name]);
    }
    expect(FREE_CAPABILITIES.length + PRO_CAPABILITIES.length).toBe(CAPABILITY_NAMES.length);
  });
});

describe('hasCapability', () => {
  test('free: базовое доступно, платное — нет', () => {
    expect(hasCapability('free', 'basicBudget')).toBe(true);
    expect(hasCapability('free', 'aiSupport')).toBe(true);
    for (const name of PRO_CAPABILITIES) expect(hasCapability('free', name)).toBe(false);
  });

  test('trial даёт ровно то же, что pro — иначе человеку не за что платить потом', () => {
    for (const name of CAPABILITY_NAMES) {
      expect(hasCapability('trial', name)).toBe(hasCapability('pro', name));
    }
  });

  test('pro даёт всё', () => {
    for (const name of CAPABILITY_NAMES) expect(hasCapability('pro', name)).toBe(true);
  });

  test('неизвестное имя закрыто, а не открыто — опечатка не должна давать доступ', () => {
    expect(hasCapability('pro', 'forcast')).toBe(false);        // опечатка
    expect(hasCapability('pro', '')).toBe(false);
    expect(hasCapability('pro', undefined)).toBe(false);
    expect(hasCapability('pro', 'toString')).toBe(false);        // свойство прототипа
    expect(hasCapability('pro', 'constructor')).toBe(false);
  });

  test('неизвестный план трактуется как бесплатный', () => {
    expect(isPaidPlan('unknown')).toBe(false);
    expect(hasCapability('unknown', 'forecast')).toBe(false);
    expect(hasCapability(null, 'basicBudget')).toBe(true); // базовое всё равно открыто
  });
});

describe('capabilitiesFor — карта для клиента', () => {
  test('содержит все известные возможности и только булевы значения', () => {
    const map = capabilitiesFor('free');
    expect(Object.keys(map).sort()).toEqual([...CAPABILITY_NAMES].sort());
    for (const v of Object.values(map)) expect(typeof v).toBe('boolean');
  });

  test('free и pro различаются ровно на платные возможности', () => {
    const free = capabilitiesFor('free');
    const pro = capabilitiesFor('pro');
    const differing = CAPABILITY_NAMES.filter(n => free[n] !== pro[n]);
    expect(differing.sort()).toEqual([...PRO_CAPABILITIES].sort());
  });
});

describe('computeEntitlement отдаёт состав тарифа', () => {
  test('активный триал — все возможности открыты', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(24 * 10), pro_until: null });
    expect(e.plan).toBe('trial');
    for (const name of CAPABILITY_NAMES) {
      expect(e.capabilities[name]).toBe(true);
      expect(e.can(name)).toBe(true);
    }
  });

  test('истёкший триал — базовое остаётся, платное закрывается', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(-1), pro_until: null });
    expect(e.plan).toBe('free');
    expect(e.can('basicBudget')).toBe(true);
    expect(e.can('forecast')).toBe(false);
    expect(e.can('safeSpendable')).toBe(false);
    expect(e.can('aiAssistant')).toBe(false);
    expect(e.capabilities.spendingCheck).toBe(false);
  });

  test('активная подписка поверх истёкшего триала — доступ полный', () => {
    const e = computeEntitlement({ trial_ends_at: hoursFromNow(-24 * 100), pro_until: hoursFromNow(24 * 30) });
    expect(e.plan).toBe('pro');
    expect(e.can('forecast')).toBe(true);
    expect(e.can('aiAssistant')).toBe(true);
  });

  test('capabilities и access согласованы между собой', () => {
    for (const row of [
      { trial_ends_at: hoursFromNow(24), pro_until: null },
      { trial_ends_at: hoursFromNow(-24), pro_until: null },
      { trial_ends_at: null, pro_until: hoursFromNow(24) },
      { trial_ends_at: null, pro_until: null },
    ]) {
      const e = computeEntitlement(row);
      // access — это и есть «доступны ли платные возможности».
      expect(e.capabilities.forecast).toBe(e.access);
      // Базовое ведение бюджета не зависит от access вообще.
      expect(e.capabilities.basicBudget).toBe(true);
    }
  });
});
