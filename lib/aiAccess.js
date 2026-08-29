// Доступ к AI-помощнику и его технические лимиты (этап 6: закрытая бета).
//
// Решение о доступе принимает ТОЛЬКО сервер. Фронт спрашивает его через
// GET /ai/status и рисует кнопки по ответу — своей проверки email у него
// больше нет, поэтому подменой клиентского состояния доступ не получить.
const db = require('../db');
const { SCREEN_CODES } = require('./aiKnowledgeBase');

// Версия связки «правила + база знаний». Нужна, чтобы понимать, на какой
// конфигурации получен плохой отзыв. Модели не передаётся.
const AI_ASSISTANT_VERSION = 'v1-beta-2026-08';

// Дневной лимит запросов на пользователя — техническая защита беты от
// зацикливания и случайного перерасхода, а не тариф. Считается по той же
// таблице ai_requests, что и телеметрия: отдельного хранилища не нужно.
//
// ВАЖНО ПРО process.env (проверено экспериментально): все настройки AI ниже
// читаются на КАЖДЫЙ вызов, а не кешируются при загрузке модуля. Это значит,
// что менять их можно без правок кода и деплоя — но НЕ значит, что процесс
// увидит новое значение сам. process.env наполняется один раз при старте
// процесса; изменение переменной в панели хостинга существующий процесс не
// замечает. Чтобы новое значение вступило в силу, процесс должен быть
// перезапущен (сам ли это сделает платформа — надо проверять в конкретной
// панели, см. отчёт по этапу 6.1).
const dailyLimit = () => Number(process.env.AI_DAILY_LIMIT || 30);

const norm = e => String(e || '').trim().toLowerCase();

const ownerEmail = () => norm(process.env.AI_OWNER_EMAIL);
const betaEmails = () => new Set(
  String(process.env.AI_BETA_EMAILS || '').split(',').map(norm).filter(Boolean),
);

// Глобальный рубильник. Выключает AI для всех, включая владельца, — и делает
// это ДО обращения к YandexGPT. Фронт пересобирать не нужно: он узнаёт о
// выключении из GET /ai/status. Но само значение переменной подхватывается
// только новым процессом — см. комментарий про process.env выше.
const aiEnabled = () => process.env.AI_ENABLED !== 'false';

/**
 * Полная проверка доступа. Возвращает { allowed, reason, isOwner }.
 * reason: 'disabled' | 'not_in_beta' | null
 */
async function checkAiAccess(uid) {
  if (!aiEnabled()) return { allowed: false, reason: 'disabled', isOwner: false };

  const owner = ownerEmail();
  const beta = betaEmails();
  // Ни владельца, ни списка беты не задано — доступ открыт всем
  // залогиненным (поведение до этапа 6, полезно для локальной разработки).
  if (!owner && beta.size === 0) return { allowed: true, reason: null, isOwner: false };

  const r = await db.query('SELECT email FROM users WHERE id=$1', [uid]);
  const email = norm(r.rows[0]?.email);
  if (!email) return { allowed: false, reason: 'not_in_beta', isOwner: false };

  const isOwner = !!owner && email === owner;
  // Список читается на каждый запрос — то есть внутри процесса он нигде не
  // кеширован, и правка allowlist применяется к следующему же запросу ПОСЛЕ
  // того, как процесс подхватил новое значение переменной (см. выше).
  const allowed = isOwner || beta.has(email);
  return { allowed, reason: allowed ? null : 'not_in_beta', isOwner };
}

// Лимит расходуют ТОЛЬКО запросы, которые реально дошли до провайдера и
// стоили денег/квоты. Отказы на нашей стороне (кривое тело запроса,
// выключенный рубильник, уже сработавший лимит) в счёт не идут — иначе
// пользователь мог бы исчерпать сутки, ни разу не поговорив с помощником.
// В ai_requests при этом пишутся все статусы: это нужно для телеметрии.
const QUOTA_STATUSES = ['success', 'provider_error', 'timeout'];

/**
 * Сколько «платных» запросов пользователь уже сделал за текущие календарные
 * сутки. Владелец от лимита освобождён — иначе им же нельзя нормально
 * тестировать.
 */
async function isOverDailyLimit(uid, isOwner) {
  if (isOwner) return false;
  const r = await db.query(
    `SELECT count(*)::int AS n FROM ai_requests
      WHERE user_id = $1 AND created_at >= date_trunc('day', now())
        AND status = ANY($2)`,
    [uid, QUOTA_STATUSES],
  );
  return (r.rows[0]?.n || 0) >= dailyLimit();
}

/**
 * Запись технической статистики. Здесь НЕТ ни вопроса, ни ответа, ни сумм —
 * только служебные поля (см. комментарий к таблице в schema.sql).
 * Возвращает id записи: он же становится request_id ответа.
 */
async function logAiRequest({ uid, screen, hadContext, decisionType, status, latencyMs }) {
  // screen приходит от клиента и может быть чем угодно — в колонку пускаем
  // только код из нашего закрытого справочника, иначе произвольный текст
  // осел бы в статистике (в промпт он и так не попадал, см. buildScreenContext).
  const safeScreen = SCREEN_CODES.includes(screen) ? screen : null;
  const r = await db.query(
    `INSERT INTO ai_requests(user_id, screen, had_context, decision_type, status, latency_ms, prompt_version)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [uid, safeScreen, !!hadContext, decisionType || 'none', status, latencyMs ?? null, AI_ASSISTANT_VERSION],
  );
  return r.rows[0].id;
}

module.exports = {
  AI_ASSISTANT_VERSION, dailyLimit, QUOTA_STATUSES,
  aiEnabled, checkAiAccess, isOverDailyLimit, logAiRequest,
};
