// Уведомление в Telegram при новом отзыве (см. routes/feedback.js) — свой бот
// через Bot API, без сторонних сервисов. Без переменных модуль просто ничего
// не делает (как и почта в lib/mail.js без UNISENDER_API_KEY/SMTP_*).
// В отличие от lib/mail.js переменные читаются не при require, а на каждый
// вызов — здесь не из чего строить транспорт заранее (нет SDK-клиента), а
// динамическое чтение упрощает тесты (не нужно выставлять env до require).
const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

async function sendTelegramMessage(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('telegram not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error('telegram: ' + (data.description || res.status));
  } finally { clearTimeout(timer); }
}

module.exports = { sendTelegramMessage, telegramConfigured };
