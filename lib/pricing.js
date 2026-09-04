// Цена подписки — ЕДИНСТВЕННОЕ место в проекте, где она задана.
//
// До этого объект PRICE был объявлен дважды и независимо: в routes/billing.js
// (сумма платежа и то, что видит клиент в GET /billing/status) и в
// lib/scheduler.js (сумма в письме-напоминании «через 2 дня спишется N ₽» и в
// автосписании). Две копии одного значения по определению могут разойтись —
// достаточно поправить дефолт в одной из них, и человек получит письмо с одной
// суммой, а спишется другая.
//
// Клиент собственных цен не хранит вовсе: и приложение, и экран тарифов читают
// status.prices[period] из ответа сервера.
const DEFAULT_MONTHLY_RUB = 199;
const DEFAULT_YEARLY_RUB = 999;

// Читается на каждый вызов, а не фиксируется при загрузке модуля — та же
// логика, что у остальных настроек проекта (см. комментарий про process.env в
// lib/aiAccess.js): менять цену можно переменной окружения, но новое значение
// увидит только перезапущенный процесс.
const priceRub = period => (period === 'yearly'
  ? Number(process.env.PRICE_YEARLY_RUB || DEFAULT_YEARLY_RUB)
  : Number(process.env.PRICE_MONTHLY_RUB || DEFAULT_MONTHLY_RUB));

// Форма { monthly, yearly } — ровно та, что уходит клиенту в поле prices и
// которую опубликованный RuStore-клиент v3 читает как status.prices[period].
const prices = () => ({ monthly: priceRub('monthly'), yearly: priceRub('yearly') });

module.exports = { DEFAULT_MONTHLY_RUB, DEFAULT_YEARLY_RUB, priceRub, prices };
