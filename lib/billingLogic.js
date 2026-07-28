// Общая логика применения успешного платежа — используется и вебхуком
// (routes/billing.js), и планировщиком автосписаний (lib/scheduler.js),
// чтобы продление считалось одинаково независимо от источника.
const db = require('../db');

// trial | free | pro — единая логика для /billing/status и проверок доступа
// (например, лимита участников семьи на free-тарифе в routes/family.js).
// pro_until проверяем ПЕРВЫМ: если пользователь оплатил подписку во время
// активного триала, статус должен сразу стать 'pro' — иначе (порядок был
// обратным) экран после успешной оплаты продолжал показывать «Пробный период»
// и кнопки «Купить», как будто платежа не было, хотя pro_until уже продлён.
function computePlan({ trial_ends_at, pro_until }) {
  const now = new Date();
  if (pro_until && new Date(pro_until) > now) return 'pro';
  if (trial_ends_at && new Date(trial_ends_at) > now) return 'trial';
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
       -- Новый оплаченный период должен добавляться поверх САМОЙ ПОЗДНЕЙ из уже
       -- имеющихся дат доступа — включая ещё активный бесплатный триал. Раньше
       -- здесь брали только pro_until/now(), без trial_ends_at — из-за этого
       -- оплата во время активного триала могла не добавить ни одного лишнего
       -- дня доступа (оплаченный период просто накладывался на дни триала).
       pro_until = GREATEST(COALESCE(pro_until, now()), COALESCE(trial_ends_at, now()), now()) + ${intervalSql},
       billing_period=$1,
       auto_renew=true,
       yk_payment_method_id = COALESCE($2, yk_payment_method_id),
       renewal_reminder_sent_for=NULL
     WHERE id=$3`,
    [period, paymentMethodId, familyId]
  );
}

module.exports = { computePlan, getFamilyPlan, applySucceededPayment };
