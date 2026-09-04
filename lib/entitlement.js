// Единственный источник правды о праве пользоваться платными возможностями.
//
// До этого модуля решение о доступе фактически принимал фронтенд: сервер умел
// посчитать план (computePlan в lib/billingLogic.js), но применял его только к
// приглашениям в семью — весь бюджет (routes/state.js) был открыт и после
// окончания триала. Здесь расчёт собран в одном месте, а применяет его
// middleware/requireCapability.js, чтобы проверки не расползались по роутам.
// Состав Free/Pro при этом задан отдельно — в lib/capabilities.js.
//
// Сам расчёт плана НЕ дублируется: computePlan остаётся в lib/billingLogic.js
// (он же используется планировщиком и /family), здесь только надстройка над ним.
const db = require('../db');
const { computePlan } = require('./billingLogic');
const { capabilitiesFor, hasCapability } = require('./capabilities');

// ── Длительность триала ──────────────────────────────────────────────────────
// Раньше срок был зашит литералом `interval '30 days'` в ДВУХ местах
// routes/auth.js (обычная регистрация и первый вход через Яндекс ID) — их легко
// было изменить по-разному и получить разный триал в зависимости от того, как
// человек зарегистрировался. Теперь значение одно на оба потока.
const DEFAULT_TRIAL_DAYS = 30;
const MIN_TRIAL_DAYS = 1;
const MAX_TRIAL_DAYS = 365;

// Срок, обещанный по СТАРОЙ политике. Это не то же самое, что DEFAULT_TRIAL_DAYS
// (дефолт на случай незаданной переменной): даже когда TRIAL_DAYS станет равен
// 14, зарегистрировавшиеся до порога должны получать именно 30.
const LEGACY_TRIAL_DAYS = 30;

// Читается на КАЖДЫЙ вызов, а не кешируется при загрузке модуля — та же логика,
// что у настроек AI (см. подробный комментарий в lib/aiAccess.js): менять
// значение можно без правок кода, но process.env наполняется один раз при старте
// процесса, поэтому новое значение увидит только перезапущенный процесс.
function trialDays() {
  const raw = process.env.TRIAL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_TRIAL_DAYS;
  const n = Number(raw);
  // Мусор в переменной не должен ни ронять API, ни молча выдавать 0 дней —
  // откатываемся к 30 (это щедрая сторона ошибки) и громко пишем в лог.
  if (!Number.isInteger(n) || n < MIN_TRIAL_DAYS || n > MAX_TRIAL_DAYS) {
    console.error(
      `TRIAL_DAYS=${JSON.stringify(raw)} — не целое число в диапазоне ` +
      `${MIN_TRIAL_DAYS}..${MAX_TRIAL_DAYS}, использую ${DEFAULT_TRIAL_DAYS}`
    );
    return DEFAULT_TRIAL_DAYS;
  }
  return n;
}

// ── Порог смены политики (TRIAL_POLICY_CUTOFF_AT) ───────────────────────────
// Момент, с которого новые регистрации переходят на TRIAL_DAYS. Зарегистрированные
// РАНЬШЕ порога получают LEGACY_TRIAL_DAYS — обещание, данное им при регистрации.
//
// Порог влияет ТОЛЬКО на назначение срока новой семье. Существующие
// trial_ends_at он не пересчитывает и не может: дата ставится один раз при
// INSERT (routes/auth.js) и дальше только читается.
//
// Требуем явную зону (Z или ±HH:MM). Без неё Date.parse трактует строку как
// ЛОКАЛЬНОЕ время процесса — тогда один и тот же конфиг давал бы разный момент
// перехода на машинах с разными TZ, и порог «сдвинулся» бы на часы.
const CUTOFF_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

// null — порог не задан; NaN — задан, но непригоден (об этом уже написано в лог).
function trialPolicyCutoffMs() {
  const raw = process.env.TRIAL_POLICY_CUTOFF_AT;
  if (raw === undefined || raw === '') return null;
  if (!CUTOFF_WITH_ZONE.test(String(raw).trim())) {
    console.error(
      `TRIAL_POLICY_CUTOFF_AT=${JSON.stringify(raw)} — нужен ISO-8601 с явной зоной ` +
      `(например 2026-09-15T10:00:00Z), использую старую политику ${LEGACY_TRIAL_DAYS} дн.`
    );
    return NaN;
  }
  const t = Date.parse(String(raw).trim());
  if (Number.isNaN(t)) {
    console.error(`TRIAL_POLICY_CUTOFF_AT=${JSON.stringify(raw)} — не разбирается как дата, ` +
      `использую старую политику ${LEGACY_TRIAL_DAYS} дн.`);
    return NaN;
  }
  return t;
}

/**
 * Сколько дней триала назначить регистрации, происходящей ПРЯМО СЕЙЧАС.
 *
 * Момент берётся из серверного времени процесса и никогда из запроса: ни тело,
 * ни заголовки, ни версия клиента на срок не влияют (см. тесты).
 *
 * @param {number} nowMs подменяется только в тестах
 */
function effectiveTrialDays(nowMs = Date.now()) {
  const cutoff = trialPolicyCutoffMs();
  // Порог задан с ошибкой — не угадываем. Отдаём старый (больший) срок:
  // ошибиться в сторону «дали больше дней» безопаснее, чем урезать обещание.
  if (Number.isNaN(cutoff)) return LEGACY_TRIAL_DAYS;
  // Порога нет — TRIAL_DAYS действует сразу. Сейчас это те же 30, так что
  // поведение не меняется; когда значение станет 14, порог задать обязательно —
  // без него не будет записан момент перехода, нужный для откатного SQL.
  if (cutoff === null) {
    if (trialDays() !== LEGACY_TRIAL_DAYS) {
      console.warn(
        `TRIAL_DAYS=${trialDays()} отличается от старой политики (${LEGACY_TRIAL_DAYS} дн.), ` +
        'а TRIAL_POLICY_CUTOFF_AT не задан: новая политика действует немедленно, ' +
        'и момент перехода нигде не зафиксирован — откат по когорте будет невозможен.'
      );
    }
    return trialDays();
  }
  return nowMs >= cutoff ? trialDays() : LEGACY_TRIAL_DAYS;
}

// Значение для INSERT в families.trial_ends_at. Отдаём готовый параметр, а не
// кусок SQL: срок подставляется через плейсхолдер ($2 || ' days')::interval,
// поэтому строку с числом дней невозможно превратить в инъекцию, даже если
// когда-нибудь TRIAL_DAYS начнёт приходить не из окружения.
//
// Саму ДАТУ окончания считает Postgres от своего now() — не JS и тем более не
// клиент. В JS решается только «сколько дней», и то по серверным часам.
const trialIntervalParam = () => `${effectiveTrialDays()} days`;

// ── Расчёт права доступа ─────────────────────────────────────────────────────
const daysLeftUntil = date =>
  Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / 86400000));

/**
 * Превращает строку families в полное описание права доступа.
 * Принимает { trial_ends_at, pro_until } — то же, что computePlan.
 */
function computeEntitlement(row) {
  const trialEndsAt = row?.trial_ends_at ?? null;
  const proUntil = row?.pro_until ?? null;
  const plan = computePlan({ trial_ends_at: trialEndsAt, pro_until: proUntil });

  return {
    // Главное поле: пускать ли к защищённым возможностям.
    access: plan !== 'free',
    plan,                                   // trial | pro | free
    subscriptionStatus: plan,               // читаемый алиас для фронта
    isTrial: plan === 'trial',
    // isExpired — это «доступа нет», а не «триал в прошлом»: у человека с
    // активной подпиской триал давно кончился, но истёкшим он не считается.
    isExpired: plan === 'free',
    trialEndsAt,
    trialDaysLeft: plan === 'trial' ? daysLeftUntil(trialEndsAt) : 0,
    // Отдельно от isExpired: триал был и закончился. Нужно, чтобы отличить
    // «триал кончился» от «триала не было вовсе» (семьи до введения тарифов).
    trialExpired: !!trialEndsAt && new Date(trialEndsAt).getTime() <= Date.now(),
    hasActiveSubscription: plan === 'pro',
    proUntil,
    // ── Состав тарифа ────────────────────────────────────────────────────
    // Карта { имя возможности: boolean } из lib/capabilities.js. Именно она
    // уходит клиенту (GET /billing/status) и проверяется на сервере
    // (middleware/requireCapability.js) — своей таблицы тарифов нет ни у
    // фронта, ни у отдельных роутов.
    capabilities: capabilitiesFor(plan),
    // Удобная форма той же проверки для кода на сервере: ent.can('forecast').
    can: name => hasCapability(plan, name),
  };
}

/**
 * Право доступа пользователя по его uid. Возвращает null, если семьи нет.
 * Заодно отдаёт familyId — вызывающему коду больше не нужен отдельный запрос
 * за family_id (см. routes/state.js, где так убран лишний round-trip).
 */
async function loadEntitlement(uid, client = db) {
  const r = await client.query(
    `SELECT m.family_id, f.trial_ends_at, f.pro_until
       FROM family_members m JOIN families f ON f.id = m.family_id
      WHERE m.user_id = $1`,
    [uid]
  );
  if (!r.rows.length) return null;
  return { familyId: r.rows[0].family_id, ...computeEntitlement(r.rows[0]) };
}

module.exports = {
  DEFAULT_TRIAL_DAYS, MIN_TRIAL_DAYS, MAX_TRIAL_DAYS, LEGACY_TRIAL_DAYS,
  trialDays, trialPolicyCutoffMs, effectiveTrialDays, trialIntervalParam,
  computeEntitlement, loadEntitlement,
};
