// Чистая логика без БД — computePlan решает, какой тариф видит пользователь
// (trial | pro | free), от этого зависят и лимит участников (routes/family.js),
// и доступность инвайтов/чекаута. Единственный тестовый файл, который не
// требует тестовой БД — полезно проверять его и локально без Postgres.
const { computePlan } = require('../lib/billingLogic');

describe('computePlan', () => {
  const hoursFromNow = h => new Date(Date.now() + h * 3600 * 1000).toISOString();

  test('активный триал — trial, даже если pro_until в прошлом', () => {
    expect(computePlan({ trial_ends_at: hoursFromNow(24), pro_until: hoursFromNow(-1) })).toBe('trial');
  });

  test('триал истёк, pro активен — pro', () => {
    expect(computePlan({ trial_ends_at: hoursFromNow(-1), pro_until: hoursFromNow(24) })).toBe('pro');
  });

  test('и триал, и pro истекли — free', () => {
    expect(computePlan({ trial_ends_at: hoursFromNow(-48), pro_until: hoursFromNow(-1) })).toBe('free');
  });

  test('ничего не задано (новая семья без миграции тарифов) — free', () => {
    expect(computePlan({ trial_ends_at: null, pro_until: null })).toBe('free');
  });

  test('pro_until ровно сейчас — уже не активен (строгое сравнение >)', () => {
    const now = new Date();
    expect(computePlan({ trial_ends_at: null, pro_until: now.toISOString() })).toBe('free');
  });

  // Оплата подписки во время ещё активного триала — раньше computePlan всё
  // равно возвращал 'trial' (проверка триала шла первой), и экран после успешной
  // оплаты выглядел так, будто платёж не подействовал вообще.
  test('триал ещё активен, но уже есть оплаченный pro_until — pro (платёж не должен "теряться")', () => {
    expect(computePlan({ trial_ends_at: hoursFromNow(24 * 20), pro_until: hoursFromNow(24 * 50) })).toBe('pro');
  });
});
