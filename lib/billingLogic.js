// Общая логика применения успешного платежа — используется и вебхуком
// (routes/billing.js), и планировщиком автосписаний (lib/scheduler.js),
// чтобы продление считалось одинаково независимо от источника.
const db = require('../db');

// trial | free | pro — единая логика для /billing/status и проверок доступа
// (например, лимита участников семьи на free-тарифе в routes/family.js).
function computePlan({ trial_ends_at, pro_until }) {
  const now = new Date();
  if (trial_ends_at && new Date(trial_ends_at) > now) return 'trial';
  if (pro_until && new Date(pro_until) > now) return 'pro';
  return 'free';
}

async function getFamilyPlan(familyId, client = db) {
  const r = await client.query('SELECT trial_ends_at, pro_until FROM families WHERE id=$1', [familyId]);
  if (!r.rows.length) return 'free';
  return computePlan(r.rows[0]);
}

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

module.exports = { computePlan, getFamilyPlan, applySucceededPayment };
