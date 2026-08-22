// Раз в час проверяет: (1) кому за 2 дня до списания нужно отправить письмо-
// напоминание со ссылкой отмены, (2) у кого пора списывать автопродление.
// Отдельного cron-процесса на Timeweb App Platform нет, поэтому планировщик
// живёт прямо в основном процессе — это нормально для нагрузки такого масштаба.
const crypto = require('crypto');
const db = require('../db');
const { sendMail, mailConfigured } = require('./mail');
const yk = require('./yookassa');
const { applySucceededPayment } = require('./billingLogic');
const { withSchedulerLock } = require('./schedulerLock');

const PRICE = {
  monthly: Number(process.env.PRICE_MONTHLY_RUB || 199),
  yearly: Number(process.env.PRICE_YEARLY_RUB || 999),
};

async function sendRenewalReminders() {
  const { rows } = await db.query(`
    SELECT f.id, f.pro_until, f.billing_period, u.email
      FROM families f
      JOIN family_members m ON m.family_id=f.id AND m.role='owner'
      JOIN users u ON u.id=m.user_id
     WHERE f.auto_renew=true AND f.pro_until IS NOT NULL
       AND f.pro_until <= now() + interval '2 days' AND f.pro_until > now()
       AND (f.renewal_reminder_sent_for IS NULL OR f.renewal_reminder_sent_for <> f.pro_until)
  `);
  if (!rows.length || !mailConfigured()) return;

  for (const row of rows) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      'UPDATE families SET cancel_token=$1, renewal_reminder_sent_for=$2 WHERE id=$3',
      [token, row.pro_until, row.id]
    );
    const apiUrl = process.env.API_PUBLIC_URL || 'https://mariagrigoreva-cyber-familyflow-api-bccc.twc1.net';
    const cancelUrl = `${apiUrl}/billing/cancel?token=${token}`;
    const period = row.billing_period === 'yearly' ? 'yearly' : 'monthly';
    const amount = PRICE[period];
    const dateStr = new Date(row.pro_until).toLocaleDateString('ru-RU');
    sendMail(
      row.email,
      `Через 2 дня спишется ${amount} ₽ за продление подписки`,
      `${dateStr} автоматически спишется ${amount} ₽ за продление подписки Pro в «Семейном потоке».\n\nЕсли не хотите продлевать — отмените автопродление по ссылке: ${cancelUrl}`,
      `<p>${dateStr} автоматически спишется <b>${amount} ₽</b> за продление подписки Pro в «Семейном потоке».</p>
       <p><a href="${cancelUrl}">Отменить автопродление</a></p>
       <p style="color:#888;font-size:13px">Если вы не против продления — ничего делать не нужно.</p>`
    ).catch(e => console.error('renewal reminder mail:', e.message));
  }
}

async function chargeRenewals() {
  const { rows } = await db.query(`
    SELECT f.id, f.billing_period, f.yk_payment_method_id, u.email
      FROM families f
      JOIN family_members m ON m.family_id=f.id AND m.role='owner'
      JOIN users u ON u.id=m.user_id
     WHERE f.auto_renew=true AND f.pro_until IS NOT NULL
       AND f.pro_until <= now() AND f.yk_payment_method_id IS NOT NULL
  `);
  for (const row of rows) {
    const period = row.billing_period === 'yearly' ? 'yearly' : 'monthly';
    const amount = PRICE[period];
    try {
      // yk.chargeSaved уже сам повторяет запрос с backoff при временных сбоях
      // (таймаут, 5xx, 429) — если долетело сюда в catch, значит либо ретраи
      // исчерпаны, либо ошибка содержательная (невалидные данные, авторизация)
      // и повторять её бессмысленно. Поэтому auto_renew ниже выключаем сразу.
      const payment = await yk.chargeSaved({
        amountRub: amount,
        description: `Продление подписки «Семейный поток» (${period === 'yearly' ? 'год' : 'месяц'})`,
        paymentMethodId: row.yk_payment_method_id,
        metadata: { familyId: row.id, period },
      });
      await db.query(
        'INSERT INTO payments(family_id, yk_payment_id, amount, status, period) VALUES($1,$2,$3,$4,$5)',
        [row.id, payment.id, amount, payment.status, period]
      );
      if (payment.status === 'succeeded') {
        await applySucceededPayment(row.id, payment, period);
      }
      // Если статус ещё pending — дождёмся webhook, ничего доп. делать не нужно.
    } catch (e) {
      console.error('renewal charge failed for family', row.id, e.message);
      await db.query('UPDATE families SET auto_renew=false WHERE id=$1', [row.id]);
      if (mailConfigured()) {
        sendMail(
          row.email,
          'Не удалось продлить подписку Pro',
          'Не получилось списать оплату за продление подписки. Доступ Pro приостановлен — вы можете оформить подписку заново в любой момент в настройках приложения.'
        ).catch(() => {});
      }
    }
  }
}

function start() {
  if (!process.env.YK_SHOP_ID || !process.env.YK_SECRET_KEY) {
    console.log('billing scheduler: YK_SHOP_ID/YK_SECRET_KEY не заданы, автосписания отключены');
    return;
  }
  const run = () => {
    withSchedulerLock('billing-scheduler', async () => {
      await Promise.all([
        sendRenewalReminders().catch(e => console.error('reminders:', e.message)),
        chargeRenewals().catch(e => console.error('renewals:', e.message)),
      ]);
    }).catch(e => console.error('billing scheduler lock:', e.message));
  };
  run();
  setInterval(run, 60 * 60 * 1000);
}

module.exports = { start };
