// AI-онбординг (свободный текст/расшифровка голоса → черновик дохода и статей
// расходов) и AI-поддержка (ответы на вопросы о работе приложения) — см. спеку
// в обсуждении. Оба эндпоинта только читают данные пользователя из запроса и
// зовут LLM (lib/llm.js) — ничего не пишут в family_states напрямую: черновик
// онбординга возвращается фронту на подтверждение/правку, и уже оттуда обычным
// PUT /state уходит в БД. Так ошибка модели не может испортить бюджет семьи.
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const ah = require('../middleware/asyncHandler');
const validate = require('../middleware/validate');
const { aiOnboardingSchema, aiSupportSchema } = require('../lib/schemas');
const { askLLM, aiConfigured } = require('../lib/llm');
const { ONBOARDING_SYSTEM_PROMPT, SUPPORT_SYSTEM_PROMPT } = require('../lib/aiPrompts');

// Модели почти никогда не возвращают чистый JSON, несмотря на промпт — обычно
// оборачивают в ```json или добавляют пояснение. Вырезаем первый {...} блок.
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function isValidDraft(d) {
  if (!d || typeof d !== 'object') return false;
  if (!Array.isArray(d.income) || !Array.isArray(d.expenses)) return false;
  const itemOk = it => it && typeof it.amount === 'number' &&
    typeof (it.source ?? it.category) === 'string';
  return d.income.every(itemOk) && d.expenses.every(itemOk);
}

// AI_OWNER_EMAIL — опциональный канареечный переключатель на время обкатки:
// не задан → эндпоинты доступны любому залогиненному пользователю (обычный
// режим). Задан → доступны только этому email, всем остальным — тот же
// ai_not_configured, что и при отсутствии AI_API_KEY, чтобы не палить самим
// ответом факт существования ограничения. Совпадает по смыслу с
// REACT_APP_OWNER_EMAIL на фронте (lib/metrika.js), который там же прячет
// кнопки — но фронтовая проверка сама по себе не мешает прямому вызову API,
// а платный вызов LLM — не тот случай, где стоит полагаться только на UI.
async function isAllowedCaller(req) {
  const ownerEmail = (process.env.AI_OWNER_EMAIL || '').trim().toLowerCase();
  if (!ownerEmail) return true;
  const r = await db.query('SELECT email FROM users WHERE id=$1', [req.user.uid]);
  return r.rows[0]?.email === ownerEmail;
}

router.post('/onboarding-draft', auth, validate(aiOnboardingSchema), ah(async (req, res) => {
  if (!aiConfigured() || !(await isAllowedCaller(req))) return res.status(503).json({ error: 'ai_not_configured' });

  // Сетевые/провайдерские ошибки при вызове askLLM намеренно не ловим здесь —
  // их забирает ah() и превращает в 500, как везде в приложении. Один повтор
  // делаем только на случай, если модель ответила, но не JSON-ом.
  let draft = extractJSON(await askLLM(ONBOARDING_SYSTEM_PROMPT, req.body.text));
  if (!isValidDraft(draft)) {
    draft = extractJSON(await askLLM(ONBOARDING_SYSTEM_PROMPT, req.body.text));
  }
  if (!isValidDraft(draft)) return res.status(422).json({ error: 'ai_parse_failed' });

  res.json({ draft });
}));

router.post('/support-ask', auth, validate(aiSupportSchema), ah(async (req, res) => {
  if (!aiConfigured() || !(await isAllowedCaller(req))) return res.status(503).json({ error: 'ai_not_configured' });
  const answer = await askLLM(SUPPORT_SYSTEM_PROMPT, req.body.question);
  res.json({ answer });
}));

module.exports = router;
