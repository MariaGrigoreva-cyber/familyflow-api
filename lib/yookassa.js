// Обёртка над API ЮKassa. Требует переменные окружения YK_SHOP_ID / YK_SECRET_KEY
// (тестовые или боевые — ЮKassa использует один и тот же URL для обоих режимов,
// режим определяется самими ключами).
const crypto = require('crypto');
const { withRetry } = require('./retry');

const API_URL = 'https://api.yookassa.ru/v3';
const TIMEOUT_MS = 15000;
const authHeader = () => 'Basic ' + Buffer.from(`${process.env.YK_SHOP_ID}:${process.env.YK_SECRET_KEY}`).toString('base64');

class YooKassaError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'YooKassaError';
    this.status = status;
    this.retryable = retryable;
  }
}

// Один запрос к API. Idempotence-Key передаётся снаружи (не генерируется тут),
// чтобы при повторе через withRetry все попытки одной логической операции шли
// с одним и тем же ключом — иначе ЮKassa считает retry за новый платёж и есть
// риск списать деньги дважды, если первая попытка на самом деле прошла, а мы
// просто не увидели ответ (таймаут/обрыв сети).
async function ykRequest(path, body, idempotenceKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader(),
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    // Не дошли до ЮKassa вовсе (таймаут/обрыв сети) — это ретраебельно.
    throw new YooKassaError('yookassa: network error: ' + e.message, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 429 (перегрузка) и 5xx (сбой на стороне ЮKassa) стоит повторить; остальные
    // 4xx — содержательная ошибка запроса/авторизации, повтор ничего не изменит.
    const retryable = res.status === 429 || res.status >= 500;
    throw new YooKassaError('yookassa: ' + (data.description || data.code || res.status), { status: res.status, retryable });
  }
  return data;
}

const RETRY_OPTS = { attempts: 3, baseDelayMs: 500, isRetryable: e => e instanceof YooKassaError && e.retryable };

// Первый платёж — с сохранением способа оплаты для будущих автосписаний.
async function createPayment({ amountRub, description, returnUrl, metadata }) {
  const idempotenceKey = crypto.randomUUID();
  return withRetry(() => ykRequest('/payments', {
    amount: { value: amountRub.toFixed(2), currency: 'RUB' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    capture: true,
    save_payment_method: true,
    description,
    metadata,
  }, idempotenceKey), RETRY_OPTS);
}

// Автосписание сохранённым способом оплаты — без участия пользователя, без confirmation.
async function chargeSaved({ amountRub, description, paymentMethodId, metadata }) {
  const idempotenceKey = crypto.randomUUID();
  return withRetry(() => ykRequest('/payments', {
    amount: { value: amountRub.toFixed(2), currency: 'RUB' },
    capture: true,
    payment_method_id: paymentMethodId,
    description,
    metadata,
  }, idempotenceKey), RETRY_OPTS);
}

// Переспрашиваем реальный статус у ЮKassa напрямую — не доверяем телу вебхука
// (так и рекомендует сама ЮKassa вместо проверки IP/подписи). GET и так идемпотентен,
// отдельный Idempotence-Key не нужен.
async function getPayment(paymentId) {
  return withRetry(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API_URL}/payments/${paymentId}`, {
        headers: { 'Authorization': authHeader() },
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new YooKassaError('yookassa: network error: ' + e.message, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new YooKassaError('yookassa: ' + (data.description || data.code || res.status), { status: res.status, retryable });
    }
    return data;
  }, RETRY_OPTS);
}

// Возврат — полный или частичный, по исходному платежу.
async function refundPayment({ paymentId, amountRub }) {
  const idempotenceKey = crypto.randomUUID();
  return withRetry(() => ykRequest('/refunds', {
    payment_id: paymentId,
    amount: { value: amountRub.toFixed(2), currency: 'RUB' },
  }, idempotenceKey), RETRY_OPTS);
}

module.exports = { createPayment, chargeSaved, getPayment, refundPayment, YooKassaError };
