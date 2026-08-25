const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const realFetch = global.fetch;
const { AI_API_KEY: origKey, AI_FOLDER_ID: origFolder, AI_OWNER_EMAIL: origOwner } = process.env;
afterEach(() => {
  global.fetch = realFetch;
  if (origKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = origKey;
  if (origFolder === undefined) delete process.env.AI_FOLDER_ID; else process.env.AI_FOLDER_ID = origFolder;
  if (origOwner === undefined) delete process.env.AI_OWNER_EMAIL; else process.env.AI_OWNER_EMAIL = origOwner;
});

const mockLLMReply = content => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
};

// Формат ответа Yandex Cloud Foundation Models — другой (result.alternatives),
// см. lib/llm.js askYandexGPT.
const mockYandexReply = text => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ result: { alternatives: [{ message: { role: 'assistant', text } }] } }),
  });
};

describe('POST /ai/onboarding-draft', () => {
  test('без токена — 401', async () => {
    const res = await request.post('/ai/onboarding-draft').send({ text: 'получаю 100000' });
    expect(res.status).toBe(401);
  });

  test('без текста — 400 bad_text', async () => {
    const u = await registerUser();
    const res = await request.post('/ai/onboarding-draft').set('Authorization', `Bearer ${u.token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_text');
  });

  test('без AI_API_KEY — 503 ai_not_configured', async () => {
    delete process.env.AI_API_KEY;
    const u = await registerUser();
    const res = await request.post('/ai/onboarding-draft').set('Authorization', `Bearer ${u.token}`).send({ text: 'получаю 100000 в месяц' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ai_not_configured');
  });

  test('валидный JSON от модели — возвращает draft', async () => {
    process.env.AI_API_KEY = 'test-key';
    mockLLMReply(JSON.stringify({
      income: [{ source: 'зарплата', amount: 100000 }],
      expenses: [{ category: 'продукты', amount: 30000 }],
    }));

    const u = await registerUser();
    const res = await request.post('/ai/onboarding-draft').set('Authorization', `Bearer ${u.token}`)
      .send({ text: 'получаю 100000 в месяц зарплата, трачу 30000 на продукты' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toEqual({
      income: [{ source: 'зарплата', amount: 100000 }],
      expenses: [{ category: 'продукты', amount: 30000 }],
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('модель оборачивает JSON в markdown — всё равно распознаётся', async () => {
    process.env.AI_API_KEY = 'test-key';
    mockLLMReply('Вот черновик:\n```json\n' + JSON.stringify({
      income: [], expenses: [{ category: 'связь', amount: 500 }],
    }) + '\n```');

    const u = await registerUser();
    const res = await request.post('/ai/onboarding-draft').set('Authorization', `Bearer ${u.token}`)
      .send({ text: 'плачу 500 за связь' });

    expect(res.status).toBe(200);
    expect(res.body.draft.expenses).toEqual([{ category: 'связь', amount: 500 }]);
  });

  test('модель возвращает не-JSON дважды подряд — 422 ai_parse_failed, LLM вызван дважды', async () => {
    process.env.AI_API_KEY = 'test-key';
    mockLLMReply('извините, не могу помочь');

    const u = await registerUser();
    const res = await request.post('/ai/onboarding-draft').set('Authorization', `Bearer ${u.token}`)
      .send({ text: 'непонятный текст' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('ai_parse_failed');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('POST /ai/support-ask', () => {
  test('без токена — 401', async () => {
    const res = await request.post('/ai/support-ask').send({ question: 'как пригласить семью?' });
    expect(res.status).toBe(401);
  });

  test('без вопроса — 400 bad_question', async () => {
    const u = await registerUser();
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_question');
  });

  test('без AI_API_KEY — 503 ai_not_configured', async () => {
    delete process.env.AI_API_KEY;
    const u = await registerUser();
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`).send({ question: 'как пригласить семью?' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ai_not_configured');
  });

  test('возвращает ответ модели как есть', async () => {
    process.env.AI_API_KEY = 'test-key';
    mockLLMReply('Пригласить участника можно 6-значным кодом из настроек семьи.');

    const u = await registerUser();
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`)
      .send({ question: 'как пригласить второго родителя?' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Пригласить участника можно 6-значным кодом из настроек семьи.');
  });
});

describe('провайдер YandexGPT (AI_FOLDER_ID задан)', () => {
  test('/ai/support-ask зовёт Foundation Models API с Api-Key/x-folder-id и разбирает result.alternatives', async () => {
    process.env.AI_API_KEY = 'test-yc-key';
    process.env.AI_FOLDER_ID = 'b1gtestfolder';
    mockYandexReply('Код приглашения — в настройках семьи.');

    const u = await registerUser();
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`)
      .send({ question: 'как пригласить второго родителя?' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Код приглашения — в настройках семьи.');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Api-Key test-yc-key', 'x-folder-id': 'b1gtestfolder' }),
      })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.modelUri).toBe('gpt://b1gtestfolder/yandexgpt/latest');
    expect(body.messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', text: 'как пригласить второго родителя?' },
    ]);
  });

  test('/ai/onboarding-draft разбирает JSON-черновик из ответа YandexGPT', async () => {
    process.env.AI_API_KEY = 'test-yc-key';
    process.env.AI_FOLDER_ID = 'b1gtestfolder';
    mockYandexReply(JSON.stringify({
      income: [{ source: 'зарплата', amount: 100000 }],
      expenses: [{ category: 'продукты', amount: 30000 }],
    }));

    const u = await registerUser();
    const res = await request.post('/ai/onboarding-draft').set('Authorization', `Bearer ${u.token}`)
      .send({ text: 'получаю 100000, трачу 30000 на продукты' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toEqual({
      income: [{ source: 'зарплата', amount: 100000 }],
      expenses: [{ category: 'продукты', amount: 30000 }],
    });
  });
});

describe('AI_OWNER_EMAIL — канареечный режим на одного пользователя', () => {
  test('не задан — доступно любому залогиненному', async () => {
    process.env.AI_API_KEY = 'test-key';
    delete process.env.AI_OWNER_EMAIL;
    mockLLMReply('Пригласить участника можно 6-значным кодом из настроек семьи.');

    const u = await registerUser();
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`).send({ question: 'вопрос' });
    expect(res.status).toBe(200);
  });

  test('задан и совпадает с email вызывающего — доступ есть', async () => {
    process.env.AI_API_KEY = 'test-key';
    mockLLMReply('Ответ для владельца.');

    const u = await registerUser();
    process.env.AI_OWNER_EMAIL = u.email;
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`).send({ question: 'вопрос' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Ответ для владельца.');
  });

  test('задан, но email вызывающего другой — 503 ai_not_configured, LLM не вызывается', async () => {
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_OWNER_EMAIL = 'owner@example.com';
    mockLLMReply('Не должно быть вызвано.');

    const u = await registerUser(); // случайный email, не совпадает с owner
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`).send({ question: 'вопрос' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ai_not_configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('сравнение регистронезависимое', async () => {
    process.env.AI_API_KEY = 'test-key';
    mockLLMReply('Ответ.');

    const u = await registerUser({ email: 'MixedCase@Example.com' });
    process.env.AI_OWNER_EMAIL = 'mixedcase@example.com';
    const res = await request.post('/ai/support-ask').set('Authorization', `Bearer ${u.token}`).send({ question: 'вопрос' });
    expect(res.status).toBe(200);
  });
});
