// Zod-схемы тел запросов — раньше проверки были россыпью последовательных if()
// прямо в роутах. Схемы централизуют их в одном месте, но намеренно сохраняют
// тот же порядок проверок и те же коды ошибок (message у каждого issue — это и
// есть `error` в ответе), чтобы не менять контракт для уже существующих клиентов.
// Поля объявлены нестрого типизированными (z.any()/optional) — вся содержательная
// проверка идёт через superRefine с тем же if/else-if, что было раньше: так первым
// (и единственным) issue всегда оказывается нужный код, а не служебное сообщение
// zod о несовпадении типа.
const { z } = require('zod');

const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const registerSchema = z.object({
  email: z.any().optional(),
  password: z.any().optional(),
  familyName: z.any().optional(),
  pdnConsent: z.any().optional(),
  attribution: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email)) return ctx.addIssue({ code: 'custom', message: 'bad_email', path: ['email'] });
  if (!val.password || val.password.length < 6) return ctx.addIssue({ code: 'custom', message: 'short_password', path: ['password'] });
  if (val.pdnConsent !== true) return ctx.addIssue({ code: 'custom', message: 'pdn_consent_required', path: ['pdnConsent'] });
});

const loginSchema = z.object({
  email: z.any().optional(),
  password: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email) || !val.password) ctx.addIssue({ code: 'custom', message: 'bad_credentials', path: ['email'] });
});

const changePasswordSchema = z.object({
  oldPassword: z.any().optional(),
  newPassword: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!val.newPassword || val.newPassword.length < 6) ctx.addIssue({ code: 'custom', message: 'short_password', path: ['newPassword'] });
});

const resetRequestSchema = z.object({
  email: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email)) ctx.addIssue({ code: 'custom', message: 'bad_email', path: ['email'] });
});

const resetConfirmSchema = z.object({
  email: z.any().optional(),
  code: z.any().optional(),
  newPassword: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!emailOk(val.email) || !val.code) return ctx.addIssue({ code: 'custom', message: 'bad_request', path: ['email'] });
  if (!val.newPassword || val.newPassword.length < 6) return ctx.addIssue({ code: 'custom', message: 'short_password', path: ['newPassword'] });
});

const stateSchema = z.object({
  data: z.any().optional(),
  baseUpdatedAt: z.any().optional(),
  // Клиент подтверждает, что умеет принять результат слияния из ответа
  // (см. routes/state.js). Поле обязано быть объявлено здесь: zod по умолчанию
  // отбрасывает неизвестные ключи, и без строки ниже флаг молча терялся бы,
  // а каждый клиент считался бы старым.
  acceptsMerge: z.any().optional(),
}).superRefine((val, ctx) => {
  if (typeof val.data !== 'object' || val.data === null) ctx.addIssue({ code: 'custom', message: 'bad_data', path: ['data'] });
});

// code приходит в свободном виде (пробелы, строчные буквы) — нормализуем перед
// проверкой длины, как раньше делал сам роут.
const familyJoinSchema = z.object({
  code: z.any().optional(),
}).transform((val, ctx) => {
  const code = String(val.code || '').trim().toUpperCase();
  if (code.length !== 6) { ctx.addIssue({ code: 'custom', message: 'bad_code', path: ['code'] }); return z.NEVER; }
  return { code };
});

const billingCheckoutSchema = z.object({
  period: z.any().optional(),
  autoChargeConsent: z.any().optional(),
}).superRefine((val, ctx) => {
  if (val.period !== 'monthly' && val.period !== 'yearly') return ctx.addIssue({ code: 'custom', message: 'bad_period', path: ['period'] });
  if (val.autoChargeConsent !== true) return ctx.addIssue({ code: 'custom', message: 'auto_charge_consent_required', path: ['autoChargeConsent'] });
});

const pushSubscribeSchema = z.object({
  endpoint: z.any().optional(),
  keys: z.any().optional(),
}).superRefine((val, ctx) => {
  if (!val.endpoint || !val.keys?.p256dh || !val.keys?.auth) ctx.addIssue({ code: 'custom', message: 'bad_subscription', path: ['endpoint'] });
});

const feedbackSchema = z.object({
  text: z.any().optional(),
}).superRefine((val, ctx) => {
  if (typeof val.text !== 'string' || !val.text.trim() || val.text.length > 5000) {
    ctx.addIssue({ code: 'custom', message: 'bad_text', path: ['text'] });
  }
});

const aiOnboardingSchema = z.object({
  text: z.any().optional(),
}).superRefine((val, ctx) => {
  if (typeof val.text !== 'string' || !val.text.trim() || val.text.length > 5000) {
    ctx.addIssue({ code: 'custom', message: 'bad_text', path: ['text'] });
  }
});

// История диалога приходит с клиента (localStorage), поэтому проверяется здесь
// целиком, а не принимается на веру: роль строго user/assistant, content —
// непустая строка в тех же пределах, что и сам вопрос. Обрезка до последних
// AI_HISTORY_LIMIT сообщений делается в routes/ai.js — превышение лимита не
// ошибка клиента, а нормальная ситуация (у него могло накопиться больше).
const AI_HISTORY_LIMIT = 20;
const AI_MSG_MAX_LEN = 2000;

// ── Финансовый снимок для AI (Этап 3) ───────────────────────────────────────
// Строгий БЕЛЫЙ СПИСОК: всё, чего нет в схеме, zod отбрасывает (по умолчанию
// .strip()), поэтому uid/email/family_id/appState физически не могут доехать
// до модели, даже если клиент их пришлёт. Клиент считается недоверенным:
// собственные лимиты фронта (src/lib/aiFinancialContext.js) здесь проверяются
// заново.
const AI_CTX_LIMITS = { upcomingPayments: 20, upcomingIncome: 10, forecast: 8, planVsActual: 10 };
const AI_CTX_MAX_ABS = 1e12;          // разумный потолок суммы (защита от мусора)
const AI_CTX_LABEL_MAX = 60;          // название категории/типа

// Только конечные числа: NaN/Infinity/строки-числа не проходят.
const ctxMoney = z.number().finite().min(-AI_CTX_MAX_ABS).max(AI_CTX_MAX_ABS);
const ctxDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ctxLabel = z.string().min(1).max(AI_CTX_LABEL_MAX);

const aiFinancialContextSchema = z.object({
  version: z.literal(1),
  generatedAt: ctxDate,
  current: z.object({
    balance: ctxMoney,
    freeSpendableNow: ctxMoney,
    savedInPiggy: ctxMoney,
  }),
  currentWeek: z.object({
    dateFrom: ctxDate, dateTo: ctxDate,
    planned: ctxMoney, actual: ctxMoney, variance: ctxMoney, income: ctxMoney,
  }).nullable(),
  currentMonth: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    planned: ctxMoney, actual: ctxMoney, variance: ctxMoney, income: ctxMoney,
  }),
  budgetMetrics: z.object({
    monthlyNetIncome: ctxMoney,
    monthlyPlannedExpenses: ctxMoney,
    monthlyPiggy: ctxMoney,
    monthlyFreeCash: ctxMoney,
    savingsRatePct: ctxMoney,
    isDeficit: z.boolean(),
  }),
  // У поступлений — точная дата (date). У плановых трат её не существует:
  // недельный план знает только неделю, поэтому поле называется weekStart.
  // Разные имена полей — это и есть защита от того, чтобы модель выдала
  // понедельник недели за точный день платежа (одним правилом промпта
  // добиться этого не удалось, см. этап 5).
  upcomingIncome: z.array(z.object({
    date: ctxDate, type: ctxLabel, amount: ctxMoney,
  })).max(AI_CTX_LIMITS.upcomingIncome),
  upcomingPayments: z.array(z.object({
    weekStart: ctxDate, category: ctxLabel, amount: ctxMoney,
  })).max(AI_CTX_LIMITS.upcomingPayments),
  forecast: z.array(z.object({
    dateFrom: ctxDate, dateTo: ctxDate,
    projectedBalance: ctxMoney, plannedExpenses: ctxMoney, risk: z.boolean(),
  })).max(AI_CTX_LIMITS.forecast),
  // Явная граница прогноза: за её пределами модель не должна давать вердикт
  // «хватит / не хватит» (этап 5.1).
  forecastCoverage: z.object({ from: ctxDate, through: ctxDate }).nullable(),
  // Компоненты, объясняющие свободный остаток. Приходят из projectCashFlow —
  // это те же величины, что участвовали в формуле, а не второй расчёт.
  freeSpendableExplanation: z.object({
    currentBalance: ctxMoney,
    freeSpendableNow: ctxMoney,
    limitedBy: z.enum(['plan', 'balance', 'forecast']),
    tightestWeek: z.object({
      dateFrom: ctxDate, dateTo: ctxDate,
      balanceAfter: ctxMoney, nextWeekPlanned: ctxMoney,
    }).nullable(),
  }),
  negativeWeek: z.object({
    dateFrom: ctxDate, dateTo: ctxDate, projectedBalance: ctxMoney,
  }).nullable(),
  riskTone: z.enum(['safe', 'warn', 'risk']),
  planVsActual: z.array(z.object({
    category: ctxLabel, planned: ctxMoney, actual: ctxMoney, variance: ctxMoney,
  })).max(AI_CTX_LIMITS.planVsActual),
});

const aiSupportSchema = z.object({
  question: z.any().optional(),
  screen: z.any().optional(),
  history: z.any().optional(),
  // Валидируется отдельно ниже, чтобы вернуть свой код ошибки
  // (bad_financial_context) вместо служебного текста zod.
  financialContext: z.any().optional(),
  // Готовый вердикт приложения. В отличие от снимка, некорректный вердикт не
  // ошибка запроса, а повод его просто не использовать: у модели останется
  // financialContext, и она ответит без детерминированного вывода. Отбор
  // делает sanitizeDecisionContext в routes/ai.js.
  decisionContext: z.any().optional(),
}).superRefine((val, ctx) => {
  if (typeof val.question !== 'string' || !val.question.trim() || val.question.length > 2000) {
    return ctx.addIssue({ code: 'custom', message: 'bad_question', path: ['question'] });
  }
  if (val.history !== undefined && val.history !== null) {
    if (!Array.isArray(val.history)) {
      return ctx.addIssue({ code: 'custom', message: 'bad_history', path: ['history'] });
    }
    const badItem = val.history.some(m =>
      !m || typeof m !== 'object' ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string' || !m.content.trim() || m.content.length > AI_MSG_MAX_LEN);
    if (badItem) {
      return ctx.addIssue({ code: 'custom', message: 'bad_history', path: ['history'] });
    }
  }
  // Снимок бюджета либо отсутствует, либо валиден целиком — «частично
  // корректный» контекст не пропускаем: лучше явная ошибка, чем ответ модели
  // по наполовину разобранным цифрам чужого формата.
  if (val.financialContext !== undefined && val.financialContext !== null) {
    if (!aiFinancialContextSchema.safeParse(val.financialContext).success) {
      return ctx.addIssue({ code: 'custom', message: 'bad_financial_context', path: ['financialContext'] });
    }
  }
});

// Возвращает объект, собранный ТОЛЬКО из полей белого списка (zod по умолчанию
// отбрасывает неизвестные ключи), либо null. Именно результат этой функции —
// а не req.body.financialContext — уходит в модель.
// ── Детерминированный вердикт приложения (этап 5.1) ─────────────────────────
// Вердикт считает КОД клиента (src/lib/aiSpendingCheck.js), модель его только
// пересказывает. Здесь — белый список полей и пересчёт вердикта на сервере:
// клиенту в вопросе арифметики тоже не доверяем.
const aiSpendingCheckSchema = z.object({
  type: z.literal('spending_check'),
  requestedAmount: ctxMoney.positive(),
  freeSpendableNow: ctxMoney,
  fitsFreeSpendable: z.boolean(),
  differenceAfterSpend: ctxMoney,
}).superRefine((val, ctx) => {
  // Если клиент прислал вердикт, не сходящийся с собственными числами, —
  // отвергаем целиком, а не «чиним»: в модель не должно уйти противоречие.
  if (val.fitsFreeSpendable !== (val.requestedAmount <= val.freeSpendableNow)
    || val.differenceAfterSpend !== val.freeSpendableNow - val.requestedAmount) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent', path: ['fitsFreeSpendable'] });
  }
});

// Покрыт ли спрошенный период прогнозом — тоже считается кодом, иначе модель
// распространяла «в покрытом периоде рисков нет» на месяцы вперёд.
const aiPeriodCheckSchema = z.discriminatedUnion('status', [
  // Дату периода определить удалось — сравниваем её с границей прогноза.
  z.object({
    type: z.literal('period_check'),
    status: z.literal('resolved'),
    askedPeriodEnd: ctxDate,
    forecastThrough: ctxDate.nullable(),
    coveredByForecast: z.boolean(),
  }).superRefine((val, ctx) => {
    const expected = !!val.forecastThrough && val.askedPeriodEnd <= val.forecastThrough;
    if (val.coveredByForecast !== expected) {
      ctx.addIssue({ code: 'custom', message: 'inconsistent', path: ['coveredByForecast'] });
    }
  }),
  // «Хватит ли до отпуска / до Пасхи» — конкретной даты нет. Никаких других
  // полей у этой формы быть не должно: гадать не о чем, надо спросить дату.
  z.object({
    type: z.literal('period_check'),
    status: z.literal('needs_date'),
  }),
]);

// Union по type нельзя сделать discriminated: у period_check внутри свой
// discriminated union по status. Обычный union решает это без потери строгости.
const aiDecisionContextSchema = z.union([aiSpendingCheckSchema, aiPeriodCheckSchema]);

function sanitizeDecisionContext(raw) {
  if (raw === undefined || raw === null) return null;
  const parsed = aiDecisionContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function sanitizeFinancialContext(raw) {
  if (raw === undefined || raw === null) return null;
  const parsed = aiFinancialContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// Оценка ответа помощника. requestId — UUID из ai_requests; комментарий
// необязателен и ограничен по длине.
const AI_FEEDBACK_ANSWER_MAX = 4000;

const aiFeedbackSchema = z.object({
  requestId: z.any().optional(),
  rating: z.any().optional(),
  comment: z.any().optional(),
  // Текст оценённого ответа — присылается только вместе с 👎 (см. routes/ai.js).
  answer: z.any().optional(),
}).superRefine((val, ctx) => {
  if (typeof val.requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val.requestId)) {
    return ctx.addIssue({ code: 'custom', message: 'bad_request_id', path: ['requestId'] });
  }
  if (val.rating !== 'up' && val.rating !== 'down') {
    return ctx.addIssue({ code: 'custom', message: 'bad_rating', path: ['rating'] });
  }
  if (val.comment !== undefined && val.comment !== null && val.comment !== ''
    && (typeof val.comment !== 'string' || val.comment.length > 1000)) {
    return ctx.addIssue({ code: 'custom', message: 'bad_comment', path: ['comment'] });
  }
  if (val.answer !== undefined && val.answer !== null && val.answer !== ''
    && (typeof val.answer !== 'string' || val.answer.length > AI_FEEDBACK_ANSWER_MAX)) {
    return ctx.addIssue({ code: 'custom', message: 'bad_answer', path: ['answer'] });
  }
});

module.exports = {
  aiFeedbackSchema,
  registerSchema, loginSchema, changePasswordSchema, resetRequestSchema, resetConfirmSchema,
  stateSchema, familyJoinSchema, billingCheckoutSchema, pushSubscribeSchema, feedbackSchema,
  aiOnboardingSchema, aiSupportSchema, AI_HISTORY_LIMIT,
  aiFinancialContextSchema, sanitizeFinancialContext, AI_CTX_LIMITS,
  aiDecisionContextSchema, sanitizeDecisionContext,
};
