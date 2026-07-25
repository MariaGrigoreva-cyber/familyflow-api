// Общая логика применения успешного платежа — используется и вебхуком
// (routes/billing.js), и планировщиком автосписаний (lib/scheduler.js),
// чтобы продление считалось одинаково независимо от источника.
const db = require('../db');

async function applySucceededPayment(familyId, ykPayment, period) {
  const paymentMethodId = ykPayment.payment_method?.saved ? ykPayment.payment_method.id : null;
  // period уже провалидирован вызывающим кодом (monthly|yearly) — литерал, не вход пользователя.
  const intervalSql = period === 'yearly' ? `interval '1 year'` : `interval '1 month'`;
  await db.query(
    `UPDATE families SET
       plan='pro',
       pro_until = GREATEST(COALESCE(pro_until, now()), now()) + ${intervalSql},
       billing_period=$1,
       auto_renew=true,
       yk_payment_method_id = COALESCE($2, yk_payment_method_id),
       renewal_reminder_sent_for=NULL
     WHERE id=$3`,
    [period, paymentMethodId, familyId]
  );
}

module.exports = { applySucceededPayment };
