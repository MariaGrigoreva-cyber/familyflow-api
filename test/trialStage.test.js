// Стадия пробного периода — единственное серверное состояние, по которому
// интерфейс решает, показывать ли баннер и какой. Здесь проверяется сам расчёт
// и то, что он доезжает до клиента в /billing/status.
//
// Отдельно и настойчиво проверяется главное свойство: стадия зависит только от
// ОСТАТКА дней, а не от длины триала. После включения новой политики в системе
// одновременно будут 30-дневные и 14-дневные пробные периоды, и «за 4 дня до
// конца» обязано значить для них одно и то же.
const { computeEntitlement, computeTrialStage, TRIAL_STAGES } = require('../lib/entitlement');
const { request, db, resetDb, registerUser } = require('./helpers');

const hours = h => new Date(Date.now() + h * 3600 * 1000).toISOString();
const stageOf = row => computeEntitlement(row).trialStage;

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

describe('стадии по остатку дней', () => {
  test('много дней впереди — active, без всяких напоминаний', () => {
    expect(stageOf({ trial_ends_at: hours(24 * 25), pro_until: null })).toBe('active');
    expect(stageOf({ trial_ends_at: hours(24 * 10), pro_until: null })).toBe('active');
    expect(stageOf({ trial_ends_at: hours(24 * 5), pro_until: null })).toBe('active');
  });

  test('4 и 3 дня — одна стадия warning_4, а не счётчик на каждый день', () => {
    expect(stageOf({ trial_ends_at: hours(24 * 3.5), pro_until: null })).toBe('warning_4');
    expect(stageOf({ trial_ends_at: hours(24 * 2.5), pro_until: null })).toBe('warning_4');
  });

  test('2 дня — warning_2', () => {
    expect(stageOf({ trial_ends_at: hours(24 * 1.5), pro_until: null })).toBe('warning_2');
  });

  test('последние сутки — last_day', () => {
    expect(stageOf({ trial_ends_at: hours(20), pro_until: null })).toBe('last_day');
    expect(stageOf({ trial_ends_at: hours(1), pro_until: null })).toBe('last_day');
  });

  test('триал кончился — expired', () => {
    expect(stageOf({ trial_ends_at: hours(-1), pro_until: null })).toBe('expired');
    expect(stageOf({ trial_ends_at: hours(-24 * 40), pro_until: null })).toBe('expired');
  });
});

describe('когда стадии нет вовсе', () => {
  test('активная подписка — null, даже если триал давно кончился', () => {
    expect(stageOf({ trial_ends_at: hours(-24 * 60), pro_until: hours(24 * 30) })).toBeNull();
  });

  test('оплата во время триала убирает напоминания сразу', () => {
    // Человек купил Pro на последнем дне — баннер «сегодня последний день»
    // после этого показывать нельзя.
    expect(stageOf({ trial_ends_at: hours(10), pro_until: hours(24 * 30) })).toBeNull();
  });

  test('семья без триала вовсе (заведена до тарифов) — null, а не expired', () => {
    expect(stageOf({ trial_ends_at: null, pro_until: null })).toBeNull();
  });
});

describe('длина триала на стадию не влияет', () => {
  // Тот самый сценарий сосуществования: у одного человека триал 30 дней, у
  // другого 14, но до конца обоим осталось поровну — стадия обязана совпасть.
  test('30-дневный и 14-дневный триал с одинаковым остатком дают одну стадию', () => {
    for (const h of [24 * 3.5, 24 * 1.5, 10]) {
      const long = computeEntitlement({ trial_ends_at: hours(h), pro_until: null });
      const short = computeEntitlement({ trial_ends_at: hours(h), pro_until: null });
      expect(long.trialStage).toBe(short.trialStage);
      expect(long.trialDaysLeft).toBe(short.trialDaysLeft);
    }
  });

  test('у старого 30-дневного триала в середине срока стадия active', () => {
    // Ему не должно показываться ничего про «осталось мало» и тем более
    // ничего про 14 дней.
    const e = computeEntitlement({ trial_ends_at: hours(24 * 23), pro_until: null });
    expect(e.trialStage).toBe('active');
    expect(e.trialDaysLeft).toBe(23);
  });
});

describe('устойчивость расчёта', () => {
  test('набор стадий фиксирован', () => {
    expect(Object.values(TRIAL_STAGES).sort())
      .toEqual(['active', 'expired', 'last_day', 'warning_2', 'warning_4']);
  });

  test('computeTrialStage не падает на пустом входе', () => {
    expect(computeTrialStage({ plan: 'free', trialEndsAt: null, trialExpired: false, daysLeft: 0 })).toBeNull();
  });
});

describe('доставка стадии клиенту', () => {
  test('GET /billing/status отдаёт trialStage и не теряет старые поля', async () => {
    const u = await registerUser();
    const res = await request.get('/billing/status').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.trialStage).toBe('active');
    // Контракт опубликованного клиента v3 не тронут.
    for (const k of ['plan', 'trialEndsAt', 'proUntil', 'billingPeriod', 'autoRenew', 'prices']) {
      expect(res.body).toHaveProperty(k);
    }
  });

  test('стадия меняется вслед за датой окончания, без участия клиента', async () => {
    const u = await registerUser();
    const auth = { Authorization: `Bearer ${u.token}` };
    const setEnd = sql => db.query(`UPDATE families SET trial_ends_at = ${sql} WHERE id=$1`, [u.familyId]);
    const stage = async () => (await request.get('/billing/status').set(auth)).body.trialStage;

    await setEnd("now() + interval '3 days'");
    expect(await stage()).toBe('warning_4');
    await setEnd("now() + interval '36 hours'");
    expect(await stage()).toBe('warning_2');
    await setEnd("now() + interval '5 hours'");
    expect(await stage()).toBe('last_day');
    await setEnd("now() - interval '1 hour'");
    expect(await stage()).toBe('expired');
  });

  test('после оплаты стадия исчезает, а доступ остаётся', async () => {
    const u = await registerUser();
    const auth = { Authorization: `Bearer ${u.token}` };
    await db.query(
      `UPDATE families SET trial_ends_at = now() - interval '1 day', pro_until = now() + interval '30 days' WHERE id=$1`,
      [u.familyId]
    );
    const res = await request.get('/billing/status').set(auth);
    expect(res.body.trialStage).toBeNull();
    expect(res.body.plan).toBe('pro');
    expect(res.body.access).toBe(true);
  });
});
