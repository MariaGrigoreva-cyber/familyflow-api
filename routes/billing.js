// Тарифы и оплата через ЮKassa. /checkout и /status требуют входа, /webhook и
// /cancel — публичные (первый дёргает сама ЮKassa, второй — по ссылке из письма).
const router = require('express').Router();
const db = require('../db');
const authMw = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');
const yk = require('../lib/yookassa');
const { applySucceededPayment } = require('../lib/billingLogic');
const { computeEntitlement } = require('../lib/entitlement');
const validate = require('../middleware/validate');
const { billingCheckoutSchema } = require('../lib/schemas');
const { prices, priceRub } = require('../lib/pricing');

// Цена живёт в lib/pricing.js и только там (раньше этот объект был объявлен
// здесь и ещё раз в lib/scheduler.js — две копии могли разойтись, и человек
// получил бы письмо с одной суммой, а списалась бы другая). Пересборка состава
// Free/Pro цену НЕ меняет.

router.get('/status', authMw, ah(async (req, res) => {
  // f.plan из выборки убран намеренно: колонка устарела и не отражает
  // действительность (у неоплативших семей она навсегда остаётся 'trial', даже
  // когда триал давно кончился). План считается из дат — trial_ends_at/pro_until.
  // После этой правки families.plan нигде не читается, кроме schema.sql.
  const r = await db.query(
    `SELECT f.trial_ends_at, f.pro_until, f.billing_period, f.auto_renew, f.auto_charge_consent_at,
            (SELECT created_at FROM payments p
              WHERE p.family_id=f.id AND p.status='succeeded' AND p.refunded_at IS NULL
              ORDER BY created_at DESC LIMIT 1) AS last_payment_at
       FROM families f JOIN family_members m ON m.family_id=f.id
      WHERE m.user_id=$1`, [req.user.uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'no_family' });
  const row = r.rows[0];
  const ent = computeEntitlement(row);
  res.json({
    // ── Существующий контракт. НЕ МЕНЯТЬ и НЕ УДАЛЯТЬ: на этих полях целиком
    // держится опубликованный RuStore-клиент v3 (plan → isPro, prices читается
    // напрямую как status.prices[period]). Любая правка семантики здесь ломает
    // приложение у тех, кто ещё не обновился.
    plan: ent.plan,
    trialEndsAt: row.trial_ends_at,
    proUntil: row.pro_until,
    billingPeriod: row.billing_period,
    autoRenew: row.auto_renew,
    autoChargeConsentAt: row.auto_charge_consent_at,
    lastPaymentAt: row.last_payment_at,
    prices: prices(),
    // ── Добавлено на этапе 1. Только новые ключи — старый клиент читает ответ
    // через res.json() без валидации схемы и незнакомые поля игнорирует.
    // Фронт больше не считает срок сам: trialDaysLeft приходит с сервера и не
    // зависит от часов на устройстве.
    access: ent.access,
    subscriptionStatus: ent.subscriptionStatus,
    isTrial: ent.isTrial,
    isExpired: ent.isExpired,
    trialDaysLeft: ent.trialDaysLeft,
    hasActiveSubscription: ent.hasActiveSubscription,
    // ── Добавлено при пересборке тарифов ─────────────────────────────────
    // Состав тарифа в явном виде: { forecast: true, aiAssistant: false, ... }.
    // Фронт рисует интерфейс ПО НЕЙ и своей таблицы Free/Pro не держит —
    // иначе при следующем изменении состава тарифов пришлось бы править две
    // независимые копии и они бы разошлись. Ответ на этот запрос уже
    // загружается один раз при старте приложения, дополнительных запросов
    // карта возможностей не добавляет.
    capabilities: ent.capabilities,
  });
}));

router.post('/checkout', authMw, validate(billingCheckoutSchema), ah(async (req, res) => {
  const { period, autoChargeConsent } = req.body || {};
  const m = await db.query("SELECT family_id FROM family_members WHERE user_id=$1 AND role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  const familyId = m.rows[0].family_id;
  const amount = priceRub(period);
  const frontendUrl = (process.env.CORS_ORIGIN || '').split(',')[0].trim() || 'https://app.myfamilyflow.ru';

  // Защита от двойного клика «Оплатить»: если недавно уже создан платёж этой же
  // семьи и того же периода, который всё ещё ждёт подтверждения — отдаём его
  // ссылку вместо того чтобы плодить в ЮKassa дублирующие платежи.
  const pending = await db.query(
    `SELECT yk_payment_id FROM payments
      WHERE family_id=$1 AND period=$2 AND status='pending' AND created_at > now() - interval '10 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [familyId, period]
  );
  if (pending.rows.length) {
    try {
      const existing = await yk.getPayment(pending.rows[0].yk_payment_id);
      if (existing.status === 'pending' && existing.confirmation?.confirmation_url) {
        return res.json({ confirmationUrl: existing.confirmation.confirmation_url });
      }
    } catch (e) { console.error('billing checkout recheck pending:', e.message); }
  }

  // Фиксируем согласие сразу, независимо от исхода оплаты — карта сохраняется
  // ЮKassa (save_payment_method) уже в этом платеже, значит согласие на будущие
  // автосписания нужно до его создания.
  await db.query(
    'UPDATE families SET auto_charge_consent_at=now(), auto_charge_consent_ip=$1 WHERE id=$2',
    [req.ip, familyId]
  );

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

// Возврат последнего успешного платежа — право потребителя отказаться от
// цифрового продукта надлежащего качества в течение 7 дней с даты оплаты
// (ст. 48 ЗоЗПП, действует с 01.02.2026). Дальше возврат не производится.
router.post('/refund', authMw, ah(async (req, res) => {
  const m = await db.query("SELECT family_id FROM family_members WHERE user_id=$1 AND role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  const familyId = m.rows[0].family_id;

  const p = await db.query(
    `SELECT id, yk_payment_id, amount, period, created_at FROM payments
      WHERE family_id=$1 AND status='succeeded' AND refunded_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [familyId]
  );
  if (!p.rows.length) return res.status(404).json({ error: 'no_refundable_payment' });
  const row = p.rows[0];
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > 7 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'refund_window_expired' });

  const refund = await yk.refundPayment({ paymentId: row.yk_payment_id, amountRub: Number(row.amount) });

  await db.query(
    "UPDATE payments SET status='refunded', refunded_at=now(), yk_refund_id=$1 WHERE id=$2",
    [refund.id, row.id]
  );
  // period провалидирован при создании платежа (monthly|yearly) — литерал, не вход пользователя.
  const intervalSql = row.period === 'yearly' ? `interval '1 year'` : `interval '1 month'`;
  await db.query(
    `UPDATE families SET pro_until = pro_until - ${intervalSql}, auto_renew=false WHERE id=$1`,
    [familyId]
  );

  res.json({ ok: true, refundId: refund.id, amount: row.amount });
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
// Обязательно стираем и yk_payment_method_id — это требование ЮKassa для
// подключения рекуррентных платежей: у покупателя должна быть возможность
// самостоятельно отвязать способ оплаты от сервиса, без обращения в поддержку.
router.post('/cancel-auto-renew', authMw, ah(async (req, res) => {
  const m = await db.query("SELECT family_id FROM family_members WHERE user_id=$1 AND role='owner'", [req.user.uid]);
  if (!m.rows.length) return res.status(403).json({ error: 'owner_only' });
  await db.query('UPDATE families SET auto_renew=false, yk_payment_method_id=NULL WHERE id=$1', [m.rows[0].family_id]);
  res.json({ ok: true });
}));

// Ссылка «отключить автопродление» из письма-напоминания — без входа в аккаунт.
router.get('/cancel', ah(async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).send('Ссылка недействительна.');
  const r = await db.query(
    'UPDATE families SET auto_renew=false, yk_payment_method_id=NULL, cancel_token=NULL WHERE cancel_token=$1 RETURNING pro_until',
    [token]
  );
  if (!r.rows.length) return res.status(400).send('Ссылка недействительна или уже использована.');
  const until = r.rows[0].pro_until;
  const dateStr = until ? new Date(until).toLocaleDateString('ru-RU') : '';
  res.send(`Автопродление отключено. Подписка Pro останется активной до ${dateStr}, дальше списаний не будет.`);
}));

module.exports = router;
