// Обёртка над API ЮKassa. Требует переменные окружения YK_SHOP_ID / YK_SECRET_KEY
// (тестовые или боевые — ЮKassa использует один и тот же URL для обоих режимов,
// режим определяется самими ключами).
const crypto = require('crypto');

const API_URL = 'https://api.yookassa.ru/v3';
const authHeader = () => 'Basic ' + Buffer.from(`${process.env.YK_SHOP_ID}:${process.env.YK_SECRET_KEY}`).toString('base64');

async function ykRequest(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader(),
      'Idempotence-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('yookassa: ' + (data.description || data.code || res.status));
  return data;
}

// Первый платёж — с сохранением способа оплаты для будущих автосписаний.
async function createPayment({ amountRub, description, returnUrl, metadata }) {
  return ykRequest('/payments', {
    amount: { value: amountRub.toFixed(2), currency: 'RUB' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    capture: true,
    save_payment_method: true,
    description,
    metadata,
  });
}

// Автосписание сохранённым способом оплаты — без участия пользователя, без confirmation.
async function chargeSaved({ amountRub, description, paymentMethodId, metadata }) {
  return ykRequest('/payments', {
    amount: { value: amountRub.toFixed(2), currency: 'RUB' },
    capture: true,
    payment_method_id: paymentMethodId,
    description,
    metadata,
  });
}

// Переспрашиваем реальный статус у ЮKassa напрямую — не доверяем телу вебхука
// (так и рекомендует сама ЮKassa вместо проверки IP/подписи).
async function getPayment(paymentId) {
  const res = await fetch(`${API_URL}/payments/${paymentId}`, {
    headers: { 'Authorization': authHeader() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('yookassa: ' + (data.description || data.code || res.status));
  return data;
}

// Возврат — полный или частичный, по исходному платежу.
async function refundPayment({ paymentId, amountRub }) {
  return ykRequest('/refunds', {
    payment_id: paymentId,
    amount: { value: amountRub.toFixed(2), currency: 'RUB' },
  });
}

module.exports = { createPayment, chargeSaved, getPayment, refundPayment };
