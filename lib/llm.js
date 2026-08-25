// Тонкая обёртка над LLM-провайдером для AI-онбординга и AI-поддержки (см.
// routes/ai.js). Без AI_API_KEY оба эндпоинта отвечают 503 — как отсутствие
// UNISENDER_API_KEY отключает почту (lib/mail.js), а не роняет сервер.
// Как и lib/telegram.js, переменные читаются на каждый вызов, а не при
// require — тестам не нужно выставлять env до require модуля.
//
// Два формата запроса:
// - YandexGPT (Yandex Cloud Foundation Models) — свой формат, не OpenAI-
//   совместимый. Включается наличием AI_FOLDER_ID (без него Foundation
//   Models API не примет запрос — folder_id обязателен в modelUri).
// - Иначе — OpenAI-совместимый chat/completions (OpenAI, большинство прокси).
const aiConfigured = () => !!process.env.AI_API_KEY;

async function askYandexGPT(systemPrompt, userText, ctrl) {
  const { AI_API_KEY, AI_API_URL, AI_MODEL, AI_FOLDER_ID } = process.env;
  const res = await fetch(AI_API_URL || 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Api-Key — авторизация сервисного аккаунта по статическому API-ключу,
      // отдельная схема от IAM-токенов (те короткоживущие и здесь не подходят).
      'Authorization': `Api-Key ${AI_API_KEY}`,
      'x-folder-id': AI_FOLDER_ID,
    },
    signal: ctrl.signal,
    body: JSON.stringify({
      modelUri: `gpt://${AI_FOLDER_ID}/${AI_MODEL || 'yandexgpt/latest'}`,
      completionOptions: { stream: false, temperature: 0.2, maxTokens: '2000' },
      messages: [
        { role: 'system', text: systemPrompt },
        { role: 'user', text: userText },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('llm: ' + (data.error?.message || res.status));
  const text = data.result?.alternatives?.[0]?.message?.text;
  if (typeof text !== 'string') throw new Error('llm: empty response');
  return text;
}

async function askOpenAICompatible(systemPrompt, userText, ctrl) {
  const { AI_API_KEY, AI_API_URL, AI_MODEL } = process.env;
  const res = await fetch(AI_API_URL || 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_API_KEY}` },
    signal: ctrl.signal,
    body: JSON.stringify({
      model: AI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('llm: ' + (data.error?.message || res.status));
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('llm: empty response');
  return content;
}

async function askLLM(systemPrompt, userText) {
  if (!process.env.AI_API_KEY) throw new Error('ai not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    return process.env.AI_FOLDER_ID
      ? await askYandexGPT(systemPrompt, userText, ctrl)
      : await askOpenAICompatible(systemPrompt, userText, ctrl);
  } finally { clearTimeout(timer); }
}

module.exports = { askLLM, aiConfigured };
