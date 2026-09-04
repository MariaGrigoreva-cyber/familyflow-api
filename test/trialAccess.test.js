jest.mock('../lib/yookassa');

// Серверный шлюз платных возможностей (middleware/requireCapability.js) и
// тарифный шлюз AI (denyProReason в routes/ai.js).
//
// ЮKassa подменена: проверяем доступность /billing/checkout после окончания
// триала, а не саму оплату (та покрыта в test/billing.test.js). jest.mock —
// первой строкой, автохойстинга для CommonJS здесь нет.
//
// Главная проверка: состав тарифа применяет СЕРВЕР. Платные возможности
// недоступны прямым запросом к API — то есть paywall нельзя обойти, подменив
// состояние на клиенте или почистив localStorage; а бесплатные, наоборот,
// остаются доступными и после окончания триала. Клиент здесь не участвует
// вообще: тесты бьют по HTTP тем же токеном, что и приложение.
const yk = require('../lib/yookassa');
const { request, db, resetDb, registerUser } = require('./helpers');
const { PRO_CAPABILITIES, FREE_CAPABILITIES } = require('../lib/capabilities');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const auth = u => ({ Authorization: `Bearer ${u.token}` });

// Триал закончился, оплаченной подписки нет.
const expireTrial = familyId => db.query(
  `UPDATE families SET trial_ends_at = now() - interval '1 day', pro_until = NULL WHERE id=$1`,
  [familyId]
);
const activateSubscription = familyId => db.query(
  `UPDATE families SET pro_until = now() + interval '30 days' WHERE id=$1`,
  [familyId]
);

// ── AI как представитель Pro-возможностей ────────────────────────────────────
// Именно личный финансовый ответ, а не сам факт открытия помощника: шлюз
// смотрит на содержимое запроса (есть ли снимок бюджета), см. routes/ai.js.
const realFetch = global.fetch;
const { AI_API_KEY: origKey } = process.env;
afterEach(() => {
  global.fetch = realFetch;
  if (origKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = origKey;
});
const enableAi = () => {
  process.env.AI_API_KEY = 'test-key';
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, json: async () => ({ choices: [{ message: { content: 'ответ помощника' } }] }),
  });
};

const financialContext = () => ({
  version: 1,
  generatedAt: '2026-08-27',
  current: { balance: 120000, freeSpendableNow: 15000, savedInPiggy: 40000 },
  currentWeek: null,
  currentMonth: { month: '2026-08', planned: 52000, actual: 38000, variance: -14000, income: 240000 },
  budgetMetrics: {
    monthlyNetIncome: 240000, monthlyPlannedExpenses: 190000, monthlyPiggy: 20000,
    monthlyFreeCash: 70000, savingsRatePct: 37, isDeficit: false,
  },
  upcomingIncome: [], upcomingPayments: [], forecast: [],
  forecastCoverage: { from: '2026-08-24', through: '2026-09-30' },
  freeSpendableExplanation: {
    currentBalance: 120000, freeSpendableNow: 15000, limitedBy: 'balance', tightestWeek: null,
  },
  negativeWeek: null, riskTone: 'safe', planVsActual: [],
});

// Проверка покупки: тот самый сценарий «могу ли я потратить 18 000 ₽».
const spendingDecision = () => ({
  type: 'spending_check',
  requestedAmount: 18000,
  freeSpendableNow: 15000,
  fitsFreeSpendable: false,
  differenceAfterSpend: -3000,
});

const askAboutBudget = (u, extra = {}) => request.post('/ai/support-ask').set(auth(u)).send({
  question: 'Могу ли я потратить 18 000 на телефон?',
  screen: 'today',
  financialContext: financialContext(),
  ...extra,
});

const askAboutApp = u => request.post('/ai/support-ask').set(auth(u)).send({
  question: 'Как работает копилка в приложении?',
  screen: 'today',
});

// ════════════════════════════════════════════════════════════════════════════
// FREE: базовые возможности остаются
// ════════════════════════════════════════════════════════════════════════════
describe('после окончания триала базовый бюджет остаётся бесплатным', () => {
  let u;
  beforeEach(async () => { u = await registerUser(); await expireTrial(u.familyId); });

  test('PUT /state сохраняет бюджет — Free не режим «только чтение»', async () => {
    const res = await request.put('/state').set(auth(u))
      .send({ data: { appState: { members: [] } } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('отметить оплаченный платёж можно и на бесплатном тарифе', async () => {
    await request.put('/state').set(auth(u))
      .send({ data: { appState: { weekItems: { '2026-W36': [{ id: 'a', isDone: false }] } } } });
    const res = await request.put('/state').set(auth(u))
      .send({ data: { appState: { weekItems: { '2026-W36': [{ id: 'a', isDone: true }] } } } });
    expect(res.status).toBe(200);
    const read = await request.get('/state').set(auth(u));
    expect(read.body.data.appState.weekItems['2026-W36'][0].isDone).toBe(true);
  });

  test('GET /state отдаёт данные — их нельзя отобрать', async () => {
    const res = await request.get('/state').set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  test('POST /state/reset и restore-backup доступны — это свои данные', async () => {
    expect((await request.post('/state/reset').set(auth(u)).send({})).status).toBe(200);
    const restore = await request.post('/state/restore-backup').set(auth(u)).send({});
    expect(restore.status).not.toBe(402);
  });

  test('вопрос о работе приложения помощнику остаётся бесплатным', async () => {
    enableAi();
    const res = await askAboutApp(u);
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('ответ помощника');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FREE: платные возможности закрыты
// ════════════════════════════════════════════════════════════════════════════
describe('после окончания триала Pro-возможности закрыты', () => {
  let u;
  beforeEach(async () => { u = await registerUser(); await expireTrial(u.familyId); });

  test('вопрос про свой бюджет — 402 с указанием возможности', async () => {
    enableAi();
    const res = await askAboutBudget(u);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('subscription_required');
    expect(res.body.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(res.body.capability).toBe('aiAssistant');
    expect(res.body.plan).toBe('free');
  });

  test('проверка покупки без снимка бюджета тоже закрыта', async () => {
    enableAi();
    const res = await request.post('/ai/support-ask').set(auth(u)).send({
      question: 'Могу ли я потратить 18 000?',
      screen: 'today',
      decisionContext: spendingDecision(),
    });
    expect(res.status).toBe(402);
    expect(res.body.capability).toBe('aiAssistant');
  });

  test('отказ по тарифу не тратит дневную квоту и не идёт к провайдеру', async () => {
    enableAi();
    await askAboutBudget(u);
    expect(global.fetch).not.toHaveBeenCalled();
    const r = await db.query(
      "SELECT status FROM ai_requests ORDER BY created_at DESC LIMIT 1");
    expect(r.rows[0].status).toBe('subscription_required');
  });

  test('общий бюджет на нескольких участников — 403 pro_required', async () => {
    const res = await request.post('/family/invite').set(auth(u)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pro_required');
  });

  test('GET /ai/status честно говорит, что про бюджет спрашивать нельзя', async () => {
    enableAi();
    const res = await request.get('/ai/status').set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);       // помощник работает
    expect(res.body.canAskAboutBudget).toBe(false); // но не про личные деньги
    expect(res.body.plan).toBe('free');
  });

  test('отказ НЕ 401 — старый клиент не должен разлогинивать пользователя', async () => {
    enableAi();
    const res = await askAboutBudget(u);
    // В опубликованном RuStore v3 logout() срабатывает ровно на 401 и только на
    // него. Любой другой статус безопасен — эта проверка стережёт инвариант.
    expect(res.status).not.toBe(401);
  });

  test('данные пользователя не тронуты отказом', async () => {
    enableAi();
    await request.put('/state').set(auth(u)).send({ data: { appState: { marker: 'до отказа' } } });
    await askAboutBudget(u);
    const read = await request.get('/state').set(auth(u));
    expect(read.body.data.appState.marker).toBe('до отказа');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TRIAL и PRO: полный доступ
// ════════════════════════════════════════════════════════════════════════════
describe('активный триал даёт полную ценность Pro', () => {
  test('вопрос про свой бюджет работает', async () => {
    enableAi();
    const u = await registerUser();
    const res = await askAboutBudget(u);
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('ответ помощника');
  });

  test('проверка покупки работает — человек должен успеть увидеть WOW', async () => {
    enableAi();
    const u = await registerUser();
    const res = await askAboutBudget(u, { decisionContext: spendingDecision() });
    expect(res.status).toBe(200);
  });

  test('приглашение в семью работает', async () => {
    const u = await registerUser();
    const res = await request.post('/family/invite').set(auth(u)).send({});
    expect(res.status).toBe(200);
    expect(res.body.code).toEqual(expect.any(String));
  });

  test('GET /billing/status отдаёт полную карту возможностей', async () => {
    const u = await registerUser();
    const res = await request.get('/billing/status').set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('trial');
    for (const name of [...FREE_CAPABILITIES, ...PRO_CAPABILITIES]) {
      expect(res.body.capabilities[name]).toBe(true);
    }
  });
});

describe('оплаченная подписка перекрывает состояние триала', () => {
  test('истёкший триал + активная подписка — Pro-возможности вернулись', async () => {
    enableAi();
    const u = await registerUser();
    await expireTrial(u.familyId);
    expect((await askAboutBudget(u)).status).toBe(402);

    await activateSubscription(u.familyId);
    expect((await askAboutBudget(u)).status).toBe(200);
    expect((await request.post('/family/invite').set(auth(u)).send({})).status).toBe(200);
  });

  test('активная подписка при ещё живом триале — доступ есть', async () => {
    enableAi();
    const u = await registerUser();
    await activateSubscription(u.familyId);
    expect((await askAboutBudget(u)).status).toBe(200);
  });

  test('карта возможностей в /billing/status следует за планом', async () => {
    const u = await registerUser();
    await expireTrial(u.familyId);

    const free = await request.get('/billing/status').set(auth(u));
    expect(free.body.plan).toBe('free');
    for (const name of PRO_CAPABILITIES) expect(free.body.capabilities[name]).toBe(false);
    for (const name of FREE_CAPABILITIES) expect(free.body.capabilities[name]).toBe(true);

    await activateSubscription(u.familyId);
    const pro = await request.get('/billing/status').set(auth(u));
    expect(pro.body.plan).toBe('pro');
    for (const name of PRO_CAPABILITIES) expect(pro.body.capabilities[name]).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Всё, что должно остаться доступным, чтобы человек мог заплатить и уйти
// ════════════════════════════════════════════════════════════════════════════
describe('эндпоинты, намеренно доступные после окончания триала', () => {
  let u;
  beforeEach(async () => { u = await registerUser(); await expireTrial(u.familyId); });

  test('GET /billing/status доступен — иначе не узнать, что и почему закрыто', async () => {
    const res = await request.get('/billing/status').set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.access).toBe(false);
  });

  test('POST /billing/checkout доступен — иначе нельзя купить подписку', async () => {
    yk.createPayment.mockResolvedValue({
      id: 'test-payment-gate', status: 'pending',
      confirmation: { confirmation_url: 'https://yookassa.ru/pay/1' },
      payment_method: { saved: true, id: 'test-method-gate' },
    });
    const res = await request.post('/billing/checkout').set(auth(u))
      .send({ period: 'monthly', autoChargeConsent: true });
    expect(res.status).toBe(200);
    expect(res.body.confirmationUrl).toEqual(expect.any(String));
  });

  test('GET /auth/me и GET /family/me доступны — управление аккаунтом', async () => {
    expect((await request.get('/auth/me').set(auth(u))).status).toBe(200);
    expect((await request.get('/family/me').set(auth(u))).status).toBe(200);
  });

  test('смена пароля доступна', async () => {
    const res = await request.post('/auth/change-password').set(auth(u))
      .send({ oldPassword: u.password, newPassword: 'newpassword456' });
    expect(res.status).toBe(200);
  });

  test('push-отписка доступна — иначе человека нельзя отписать от уведомлений', async () => {
    const res = await request.post('/push/unsubscribe').set(auth(u))
      .send({ endpoint: 'https://example.com/endpoint' });
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Обход со стороны клиента
// ════════════════════════════════════════════════════════════════════════════
describe('шлюз нельзя обойти со стороны клиента', () => {
  test('подмена тарифа в теле запроса и заголовках ничего не даёт', async () => {
    enableAi();
    const u = await registerUser();
    await expireTrial(u.familyId);
    const res = await request.post('/ai/support-ask')
      .set(auth(u))
      .set('X-App-Version', '999')
      .send({
        question: 'Могу ли я потратить 18 000?',
        screen: 'today',
        financialContext: financialContext(),
        // Клиент «утверждает», что у него всё хорошо — разными способами сразу.
        plan: 'pro', access: true, isPro: true,
        capabilities: { aiAssistant: true, forecast: true },
      });
    expect(res.status).toBe(402);
  });

  test('повторная авторизация тем же аккаунтом не возвращает доступ', async () => {
    enableAi();
    const u = await registerUser();
    await expireTrial(u.familyId);
    const login = await request.post('/auth/login').send({ email: u.email, password: u.password });
    expect(login.status).toBe(200);
    const res = await request.post('/ai/support-ask')
      .set({ Authorization: `Bearer ${login.body.token}` })
      .send({ question: 'Хватит ли мне денег?', screen: 'today', financialContext: financialContext() });
    expect(res.status).toBe(402);
  });

  test('без токена платная возможность недоступна вовсе', async () => {
    enableAi();
    const res = await request.post('/ai/support-ask')
      .send({ question: 'Хватит ли мне денег?', screen: 'today', financialContext: financialContext() });
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Аварийный выключатель
// ════════════════════════════════════════════════════════════════════════════
describe('аварийный выключатель SUBSCRIPTION_GATE_ENABLED', () => {
  afterEach(() => { delete process.env.SUBSCRIPTION_GATE_ENABLED; });

  test('=false пропускает платный запрос и пишет предупреждение в лог', async () => {
    enableAi();
    const u = await registerUser();
    await expireTrial(u.familyId);
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.SUBSCRIPTION_GATE_ENABLED = 'false';
    const res = await askAboutBudget(u);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('по умолчанию шлюз включён', async () => {
    enableAi();
    const u = await registerUser();
    await expireTrial(u.familyId);
    expect((await askAboutBudget(u)).status).toBe(402);
  });
});
