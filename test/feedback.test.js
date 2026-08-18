const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

// Уведомление в Telegram (lib/telegram.js) уходит fire-and-forget уже после
// res.json — ждём тик цикла событий, чтобы .then/.catch успели отработать,
// прежде чем проверять global.fetch.
const flush = () => new Promise(r => setImmediate(r));

const ageUser = async (email, days) =>
  db.query("UPDATE users SET created_at = now() - ($1 || ' days')::interval WHERE email=lower($2)", [days, email]);

describe('GET /family/me — showFeedbackPrompt', () => {
  test('свежая регистрация — флаг false', async () => {
    const u = await registerUser();
    const res = await request.get('/family/me').set('Authorization', `Bearer ${u.token}`);
    expect(res.body.showFeedbackPrompt).toBe(false);
  });

  test('регистрация 14+ дней назад — флаг true', async () => {
    const u = await registerUser();
    await ageUser(u.email, 15);
    const res = await request.get('/family/me').set('Authorization', `Bearer ${u.token}`);
    expect(res.body.showFeedbackPrompt).toBe(true);
  });

  test('после отправки отзыва флаг больше не появляется', async () => {
    const u = await registerUser();
    await ageUser(u.email, 20);
    await request.post('/feedback').set('Authorization', `Bearer ${u.token}`).send({ text: 'Отличное приложение' });
    const res = await request.get('/family/me').set('Authorization', `Bearer ${u.token}`);
    expect(res.body.showFeedbackPrompt).toBe(false);
  });

  test('после отказа флаг больше не появляется', async () => {
    const u = await registerUser();
    await ageUser(u.email, 20);
    await request.post('/feedback/decline').set('Authorization', `Bearer ${u.token}`);
    const res = await request.get('/family/me').set('Authorization', `Bearer ${u.token}`);
    expect(res.body.showFeedbackPrompt).toBe(false);
  });
});

describe('POST /feedback', () => {
  test('без токена — 401', async () => {
    const res = await request.post('/feedback').send({ text: 'привет' });
    expect(res.status).toBe(401);
  });

  test('без текста — 400 bad_text', async () => {
    const u = await registerUser();
    const res = await request.post('/feedback').set('Authorization', `Bearer ${u.token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_text');
  });

  test('пустая строка — 400 bad_text', async () => {
    const u = await registerUser();
    const res = await request.post('/feedback').set('Authorization', `Bearer ${u.token}`).send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_text');
  });

  test('сохраняет отзыв и переводит статус в submitted', async () => {
    const u = await registerUser();
    const res = await request.post('/feedback').set('Authorization', `Bearer ${u.token}`).send({ text: 'Спасибо за приложение!' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.query(
      `SELECT uf.text, us.feedback_status, us.feedback_responded_at
         FROM user_feedback uf JOIN users us ON us.id=uf.user_id
        WHERE us.email=lower($1)`, [u.email]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].text).toBe('Спасибо за приложение!');
    expect(row.rows[0].feedback_status).toBe('submitted');
    expect(row.rows[0].feedback_responded_at).not.toBeNull();
  });

  describe('Telegram-уведомление', () => {
    const realFetch = global.fetch;
    const { TELEGRAM_BOT_TOKEN: origToken, TELEGRAM_CHAT_ID: origChat } = process.env;
    afterEach(() => {
      global.fetch = realFetch;
      if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = origToken;
      if (origChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = origChat;
    });

    test('TELEGRAM_BOT_TOKEN/CHAT_ID настроены — уходит уведомление с email и текстом отзыва', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
      process.env.TELEGRAM_CHAT_ID = '999';
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

      const u = await registerUser();
      const res = await request.post('/feedback').set('Authorization', `Bearer ${u.token}`).send({ text: 'Отличное приложение' });
      expect(res.status).toBe(200);
      await flush();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.telegram.org/botbot-token/sendMessage',
        expect.objectContaining({ method: 'POST' })
      );
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('999');
      expect(body.text).toContain(u.email.toLowerCase());
      expect(body.text).toContain('Отличное приложение');
    });

    test('без TELEGRAM_BOT_TOKEN/CHAT_ID — Telegram не вызывается, отзыв всё равно сохраняется', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      global.fetch = jest.fn();

      const u = await registerUser();
      const res = await request.post('/feedback').set('Authorization', `Bearer ${u.token}`).send({ text: 'Отзыв без Telegram' });
      expect(res.status).toBe(200);
      await flush();

      expect(global.fetch).not.toHaveBeenCalled();
      const row = await db.query('SELECT feedback_status FROM users WHERE email=lower($1)', [u.email]);
      expect(row.rows[0].feedback_status).toBe('submitted');
    });
  });
});

describe('POST /feedback/decline', () => {
  test('без токена — 401', async () => {
    const res = await request.post('/feedback/decline');
    expect(res.status).toBe(401);
  });

  test('переводит статус в declined без записи в user_feedback', async () => {
    const u = await registerUser();
    const res = await request.post('/feedback/decline').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.query('SELECT feedback_status FROM users WHERE email=lower($1)', [u.email]);
    expect(row.rows[0].feedback_status).toBe('declined');

    const fb = await db.query(
      `SELECT count(*)::int AS n FROM user_feedback uf JOIN users us ON us.id=uf.user_id WHERE us.email=lower($1)`,
      [u.email]);
    expect(fb.rows[0].n).toBe(0);
  });
});
