// Тарифы и оплата через ЮKassa. /checkout и /status требуют входа, /webhook и
// /cancel — публичные (первый дёргает сама ЮKassa, второй — по ссылке из письма).
const router = require('express').Router();
const db = require('../db');
const authMw = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');
const yk = require('../lib/yookassa');
const { applySucceededPayment } = require('../lib/billingLogic');

const PRICE = {
  monthly: Number(process.env.PRICE_MONTHLY_RUB || 199),
  yearly: Number(process.env.PRICE_YEARLY_RUB || 999),
};

router.get('/status', authMw, ah(async (req, res) => {
  const r = await db.query(
    `SELECT f.plan, f.trial_ends_at, f.pro_until, f.billing_period, f.auto_renew
       FROM families f JOIN family_members m ON m.family_id=f.id
      WHERE m.user_id=$1`, [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_family' });
  const row = r.rows[0];
  const now = new Date();
  let plan = 'free';
  if (row.trial_ends_at && new Date(row.trial_ends_at) > now) plan = 'trial';
  else if (row.pro_until && new Date(row.pro_until) > now) plan = 'pro';
  res.json({
    plan,
    trialEndsAt: row.trial_ends_at,
    proUntil: row.pro_until,
    billingPeriod: row.billing_period,
    autoRenew: row.auto_renew,
    prices: PRICE,
  });
}));

router.post('/checkout', authMw, ah(async (req, res) => {
  const { period } = req.body || {};
  if (period !== 'monthly' && period !== 'yearly') return res.status(400).json({ error: 'bad_period' });
  const m = await db.query("SELECT family_id FROM family_members WHERE user_id=$1 AND role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  const familyId = m.rows[0].family_id;
  const amount = PRICE[period];
  const frontendUrl = (process.env.CORS_ORIGIN || '').split(',')[0].trim() || 'https://app.myfamilyflow.ru';

  const payment = await yk.createPayment({
    amountRub: amount,
    description: `Подписка Pro «Семейный поток» (${period === 'yearly' ? 'год' : 'месяц'})`,
    returnUrl: `${frontendUrl}/?billing=done`,
    metadata: { familyId, period },
  });
  await db.query(
    'INSERT INTO payments(family_id, yk_payment_id, amount, status, period) VALUES($1,$2,$3,$4,$5)',
    [familyId, payment.id, amount, payment.status, period]
  );
  res.json({ confirmationUrl: payment.confirmation?.confirmation_url || null });
}));

// ЮKassa шлёт уведомление о смене статуса платежа. Телу запроса не доверяем —
// сразу переспрашиваем реальный статус по API своими ключами (проще и надёжнее,
// чем проверять IP-адрес отправителя или подпись).
router.post('/webhook', ah(async (req, res) => {
  const paymentId = req.body?.object?.id;
  if (!paymentId) return res.status(200).json({ ok: true });

  let payment;
  try { payment = await yk.getPayment(paymentId); }
  catch (e) { console.error('billing webhook getPayment:', e.message); return res.status(200).json({ ok: true }); }

  const existing = await db.query('SELECT family_id, period, status FROM payments WHERE yk_payment_id=$1', [paymentId]);
  if (!existing.rows.length) return res.status(200).json({ ok: true });
  const row = existing.rows[0];
  if (row.status === 'succeeded') return res.status(200).json({ ok: true }); // уже обработано — идемпотентность

  if (payment.status === 'succeeded') {
    await db.query('UPDATE payments SET status=$1 WHERE yk_payment_id=$2', ['succeeded', paymentId]);
    await applySucceededPayment(row.family_id, payment, row.period);
  } else if (payment.status === 'canceled') {
    await db.query('UPDATE payments SET status=$1 WHERE yk_payment_id=$2', ['canceled', paymentId]);
  }
  res.status(200).json({ ok: true });
}));

// Отключить автопродление прямо из приложения (в дополнение к ссылке из письма).
router.post('/cancel-auto-renew', authMw, ah(async (req, res) => {
  const m = await db.query("SELECT family_id FROM family_members WHERE user_id=$1 AND role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  await db.query('UPDATE families SET auto_renew=false WHERE id=$1', [m.rows[0].family_id]);
  res.json({ ok: true });
}));

// Ссылка «отключить автопродление» из письма-напоминания — без входа в аккаунт.
router.get('/cancel', ah(async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).send('Ссылка недействительна.');
  const r = await db.query(
    'UPDATE families SET auto_renew=false, cancel_token=NULL WHERE cancel_token=$1 RETURNING pro_until',
    [token]
  );
  if (!r.rows.length) return res.status(400).send('Ссылка недействительна или уже использована.');
  const until = r.rows[0].pro_until;
  const dateStr = until ? new Date(until).toLocaleDateString('ru-RU') : '';
  res.send(`Автопродление отключено. Подписка Pro останется активной до ${dateStr}, дальше списаний не будет.`);
}));

module.exports = router;
