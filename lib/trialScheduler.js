// Письмо за 2 дня до окончания пробного периода.
//
// Почему отдельный файл, а не lib/scheduler.js: тот выходит из start() сразу,
// если не заданы ключи ЮKassa (он про списания). Письмо об окончании триала к
// оплате отношения не имеет и должно уходить даже там, где биллинг не настроен.
// И не lib/onboardingScheduler.js: тот считает всё от даты регистрации, а здесь
// принципиально другая точка отсчёта.
//
// СЧИТАЕТСЯ ОТ ФАКТИЧЕСКОГО trial_ends_at, а не от «регистрация + N дней».
// Это главное требование: после включения новой политики в базе одновременно
// будут люди с 30-дневным и 14-дневным триалом, и «за два дня до конца» для них
// приходится на разные дни жизни аккаунта. Привязка к дате регистрации сломала
// бы письмо для одной из когорт.
const db = require('../db');
const { sendMail, mailConfigured } = require('./mail');
const { unsubscribeUrl } = require('./mail');
const { withSchedulerLock } = require('./schedulerLock');
const { priceRub } = require('./pricing');

const APP_URL = (process.env.CORS_ORIGIN || '').split(',')[0].trim() || 'https://app.myfamilyflow.ru';

const SUBJECT = 'Ещё 2 дня полного Pro';

/**
 * Кому шлём. Условия отбора — они же защита от дублей и от писем не по адресу:
 *   • триал ещё идёт и закончится в ближайшие двое суток;
 *   • подписки нет (иначе человеку нечего терять — письмо было бы враньём);
 *   • письмо за ИМЕННО ЭТУ дату окончания ещё не отправляли;
 *   • человек не отписался от писем.
 *
 * Дедупликация устроена как у письма о продлении в lib/scheduler.js: храним не
 * флаг «отправлено», а ДАТУ, за которую отправили. Флаг сломался бы, если дата
 * окончания когда-нибудь изменится; сравнение с самой датой — нет.
 */
const SELECT_RECIPIENTS = `
  SELECT f.id, f.trial_ends_at, u.id AS user_id, u.email
    FROM families f
    JOIN family_members m ON m.family_id = f.id AND m.role = 'owner'
    JOIN users u ON u.id = m.user_id
   WHERE f.trial_ends_at IS NOT NULL
     AND f.trial_ends_at <= now() + interval '2 days'
     AND f.trial_ends_at > now()
     AND (f.pro_until IS NULL OR f.pro_until <= now())
     AND (f.trial_end_email_sent_for IS NULL OR f.trial_end_email_sent_for <> f.trial_ends_at)
     AND u.unsubscribed_at IS NULL
     AND u.deleted_at IS NULL
`;

function renderBody({ endsAt, unsubUrl }) {
  const dateStr = new Date(endsAt).toLocaleDateString('ru-RU');
  const price = priceRub('monthly');
  // Тон спокойный и честный: главное сообщение — «бюджет останется бесплатным»,
  // а не «вы всё потеряете». Никакой искусственной срочности.
  const text =
    `${dateStr} заканчивается пробный период Pro в «Семейном потоке».\n\n` +
    'Бюджет останется с вами и после него: доходы, расходы, недельный план и ' +
    'текущий остаток работают на бесплатном тарифе.\n\n' +
    'В Pro останутся ответы на вопросы о будущем:\n' +
    '— сколько можно потратить прямо сейчас;\n' +
    '— что будет с деньгами в следующие недели;\n' +
    '— предупреждения о возможной нехватке;\n' +
    '— проверка крупных покупок;\n' +
    '— финансовые сценарии;\n' +
    `— AI, который знает ваш финансовый план.\n\n` +
    `Оставить Pro — ${price} ₽ в месяц: ${APP_URL}\n`;

  const html =
    `<p>${dateStr} заканчивается пробный период Pro в «Семейном потоке».</p>` +
    '<p><b>Бюджет останется с вами и после него</b> — доходы, расходы, недельный ' +
    'план и текущий остаток работают на бесплатном тарифе.</p>' +
    '<p>В Pro останутся ответы на вопросы о будущем:</p>' +
    '<ul>' +
    '<li>сколько можно потратить прямо сейчас;</li>' +
    '<li>что будет с деньгами в следующие недели;</li>' +
    '<li>предупреждения о возможной нехватке;</li>' +
    '<li>проверка крупных покупок;</li>' +
    '<li>финансовые сценарии;</li>' +
    '<li>AI, который знает ваш финансовый план.</li>' +
    '</ul>' +
    `<p><a href="${APP_URL}">Оставить Pro — ${price} ₽ в месяц</a></p>`;

  return { text, html, unsubUrl };
}

async function sendTrialEndingReminders() {
  if (!mailConfigured()) return 0;
  const { rows } = await db.query(SELECT_RECIPIENTS);
  let sent = 0;
  for (const row of rows) {
    // Отметку ставим ДО отправки и по конкретной дате окончания. Если письмо не
    // уйдёт (почта недоступна), повтора не будет — это осознанный размен:
    // отправить дважды хуже, чем не отправить вовсе, а следующее касание у
    // человека всё равно есть внутри приложения (баннеры и окно перехода).
    const upd = await db.query(
      `UPDATE families SET trial_end_email_sent_for = $1
        WHERE id = $2 AND (trial_end_email_sent_for IS NULL OR trial_end_email_sent_for <> $1)`,
      [row.trial_ends_at, row.id]
    );
    // Другой процесс успел раньше (два инстанса, гонка) — не дублируем.
    if (upd.rowCount === 0) continue;

    const unsubUrl = unsubscribeUrl(row.user_id);
    const { text, html } = renderBody({ endsAt: row.trial_ends_at, unsubUrl });
    sent += 1;
    sendMail(row.email, SUBJECT, text, html, unsubUrl)
      .catch(e => console.error('trial ending mail:', row.email, e.message));
  }
  return sent;
}

function start() {
  if (!mailConfigured()) {
    console.log('trial scheduler: почта не настроена, письмо об окончании триала отключено');
    return;
  }
  const run = () => {
    withSchedulerLock('trial-scheduler', async () => {
      await sendTrialEndingReminders();
    }).catch(e => console.error('trial scheduler lock:', e.message));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start, sendTrialEndingReminders, SUBJECT, SELECT_RECIPIENTS };
