// Письмо за 2 дня до окончания пробного периода (lib/trialScheduler.js).
//
// Главное, что здесь проверяется, — точка отсчёта. Письмо привязано к
// ФАКТИЧЕСКОМУ trial_ends_at, а не к «дата регистрации + N дней». Разница
// станет видна сразу после включения новой политики: у 30-дневных и 14-дневных
// триалов D−2 приходится на совершенно разные дни жизни аккаунта, и привязка к
// регистрации сломала бы письмо для одной из когорт.
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
const { sendTrialEndingReminders, SUBJECT, SELECT_RECIPIENTS } = require('../lib/trialScheduler');
const { db, resetDb, registerUser } = require('./helpers');

beforeEach(async () => { await resetDb(); jest.clearAllMocks(); });
afterAll(async () => { await db.end(); });

const setTrialEnd = (familyId, sql) =>
  db.query(`UPDATE families SET trial_ends_at = ${sql} WHERE id=$1`, [familyId]);
// registerUser() тоже шлёт письмо (приветственное) через тот же мок, поэтому
// смотрим не на все вызовы, а только на письма с нашей темой.
const trialMails = () => mail.sendMail.mock.calls.filter(c => c[1] === SUBJECT);
const recipients = () => trialMails().map(c => c[0]);

describe('кому уходит письмо', () => {
  test('уходит, когда до конца триала меньше двух суток', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    expect(await sendTrialEndingReminders()).toBe(1);
    expect(recipients()).toEqual([u.email]);
  });

  test('не уходит, пока до конца далеко', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '10 days'");
    expect(await sendTrialEndingReminders()).toBe(0);
    expect(trialMails()).toHaveLength(0);
  });

  test('не уходит, если триал уже кончился — поезд ушёл', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() - interval '1 hour'");
    expect(await sendTrialEndingReminders()).toBe(0);
  });

  test('не уходит тому, кто уже оплатил Pro', async () => {
    const u = await registerUser();
    await db.query(
      `UPDATE families SET trial_ends_at = now() + interval '36 hours',
                           pro_until = now() + interval '30 days' WHERE id=$1`,
      [u.familyId]
    );
    expect(await sendTrialEndingReminders()).toBe(0);
    expect(trialMails()).toHaveLength(0);
  });

  test('не уходит отписавшемуся от писем', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    await db.query('UPDATE users SET unsubscribed_at = now() WHERE email = lower($1)', [u.email]);
    expect(await sendTrialEndingReminders()).toBe(0);
  });
});

describe('точка отсчёта — дата окончания, а не регистрации', () => {
  test('старый 30-дневный триал получает письмо на 28-й день, а не на 12-й', async () => {
    const u = await registerUser();
    // Зарегистрирован давно, триал длинный и заканчивается послезавтра.
    await db.query("UPDATE users SET created_at = now() - interval '28 days' WHERE email = lower($1)", [u.email]);
    await setTrialEnd(u.familyId, "now() + interval '40 hours'");
    expect(await sendTrialEndingReminders()).toBe(1);
  });

  test('давно зарегистрированный, но с далёкой датой окончания письма не получает', async () => {
    // Если бы отсчёт шёл от регистрации, этот человек письмо бы уже получил.
    const u = await registerUser();
    await db.query("UPDATE users SET created_at = now() - interval '28 days' WHERE email = lower($1)", [u.email]);
    await setTrialEnd(u.familyId, "now() + interval '9 days'");
    expect(await sendTrialEndingReminders()).toBe(0);
  });

  test('короткий триал: письмо приходит на 12-й день 14-дневного срока', async () => {
    const u = await registerUser();
    await db.query("UPDATE users SET created_at = now() - interval '12 days' WHERE email = lower($1)", [u.email]);
    await setTrialEnd(u.familyId, "now() + interval '40 hours'");
    expect(await sendTrialEndingReminders()).toBe(1);
  });
});

describe('дедупликация', () => {
  test('повторный прогон планировщика письмо не дублирует', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    expect(await sendTrialEndingReminders()).toBe(1);
    expect(await sendTrialEndingReminders()).toBe(0);
    expect(await sendTrialEndingReminders()).toBe(0);
    expect(trialMails()).toHaveLength(1);
  });

  // Регрессия на потерю точности. Прежний код записывал дату, прочитанную
  // через драйвер pg: тот отдаёт timestamptz как JS Date с точностью до
  // миллисекунд, а Postgres хранит микросекунды. Записанное обратно значение
  // переставало равняться trial_ends_at (…057616 → …057), и отбор выбирал
  // строку снова на КАЖДОМ часовом прогоне. Письмо при этом не дублировалось —
  // спасала вторая проверка внутри UPDATE, — поэтому обычный тест «не пришло
  // дважды» этого не ловил. Ловит только проверка самого отбора.
  test('после отправки строка выпадает из отбора, а не только из UPDATE', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    await sendTrialEndingReminders();

    const again = await db.query(SELECT_RECIPIENTS);
    expect(again.rows.map(r => r.id)).not.toContain(u.familyId);
    expect(again.rows).toHaveLength(0);
  });

  test('записанная отметка совпадает с датой окончания ДО микросекунды', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    await sendTrialEndingReminders();
    // Сравниваем внутри базы: через JS обе даты усеклись бы до миллисекунд и
    // разница, из-за которой всё и ломалось, стала бы невидимой.
    const r = await db.query(
      'SELECT (trial_end_email_sent_for = trial_ends_at) AS same FROM families WHERE id=$1',
      [u.familyId]);
    expect(r.rows[0].same).toBe(true);
  });

  test('отметка ставится по конкретной дате окончания', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    await sendTrialEndingReminders();
    const r = await db.query(
      'SELECT trial_ends_at, trial_end_email_sent_for FROM families WHERE id=$1', [u.familyId]);
    expect(r.rows[0].trial_end_email_sent_for.getTime())
      .toBe(r.rows[0].trial_ends_at.getTime());
  });

  test('если дата окончания изменится, письмо за новую дату уйдёт снова', async () => {
    // Флаг «отправлено» здесь сломался бы; отметка датой — нет.
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    expect(await sendTrialEndingReminders()).toBe(1);
    await setTrialEnd(u.familyId, "now() + interval '44 hours'");
    expect(await sendTrialEndingReminders()).toBe(1);
    expect(trialMails()).toHaveLength(2);
  });
});

describe('содержание письма', () => {
  test('обещает сохранить бюджет бесплатно и не давит срочностью', async () => {
    const u = await registerUser();
    await setTrialEnd(u.familyId, "now() + interval '36 hours'");
    await sendTrialEndingReminders();
    const [, subject, text, html] = trialMails()[0];

    expect(subject).toBe('Ещё 2 дня полного Pro');
    expect(text).toContain('Бюджет останется с вами');
    expect(html).toContain('Бюджет останется с вами');
    for (const bad of ['Срочно', 'последний шанс', 'вы потеряете', 'успейте', 'в опасности']) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });

  test('цена берётся из общего источника, а не зашита в письме', async () => {
    const original = process.env.PRICE_MONTHLY_RUB;
    process.env.PRICE_MONTHLY_RUB = '249';
    try {
      const u = await registerUser();
      await setTrialEnd(u.familyId, "now() + interval '36 hours'");
      await sendTrialEndingReminders();
      expect(trialMails()[0][2]).toContain('249 ₽');
    } finally {
      if (original === undefined) delete process.env.PRICE_MONTHLY_RUB;
      else process.env.PRICE_MONTHLY_RUB = original;
    }
  });
});
