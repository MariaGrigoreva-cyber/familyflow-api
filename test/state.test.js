const crypto = require('crypto');
const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const getUserId = async email =>
  (await db.query('SELECT id FROM users WHERE email=lower($1)', [email])).rows[0].id;

describe('GET /state', () => {
  test('без токена — 401', async () => {
    const res = await request.get('/state');
    expect(res.status).toBe(401);
  });

  test('пустой стейт для только что созданной семьи', async () => {
    // /auth/register уже создаёт строку family_states с data={} (routes/auth.js) —
    // так что updatedAt здесь не null, а момент регистрации.
    const u = await registerUser();
    const res = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
    expect(res.body.updatedAt).toBeTruthy();
  });

  test('404 no_family, если пользователь не состоит в семье', async () => {
    const u = await registerUser();
    const uid = await getUserId(u.email);
    await db.query('DELETE FROM family_members WHERE user_id=$1', [uid]);
    const res = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_family');
  });
});

describe('PUT /state — валидация', () => {
  test('bad_data при данных не-объекте', async () => {
    const u = await registerUser();
    const res = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: 'строка, не объект' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_data');
  });

  test('bad_data при data: null', async () => {
    const u = await registerUser();
    const res = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_data');
  });

  test('too_large — 413 при данных больше 2МБ', async () => {
    const u = await registerUser();
    const big = { blob: 'x'.repeat(2_100_000) };
    const res = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: big });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('too_large');
  });

  test('404 no_family, если пользователь не состоит в семье', async () => {
    const u = await registerUser();
    const uid = await getUserId(u.email);
    await db.query('DELETE FROM family_members WHERE user_id=$1', [uid]);
    const res = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: {} } });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_family');
  });
});

describe('PUT /state — сохранение и оптимистичная блокировка (409)', () => {
  test('сохраняет данные и отдаёт их обратно через GET', async () => {
    const u = await registerUser();
    const payload = { appState: { streak: 3 } };
    const putRes = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: payload });
    expect(putRes.status).toBe(200);
    expect(putRes.body.updatedAt).toBeTruthy();

    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data).toEqual(payload);
    expect(getRes.body.updatedAt).toBe(putRes.body.updatedAt);
  });

  test('устаревший baseUpdatedAt — 409, отдаёт актуальные данные и не перезаписывает их', async () => {
    const u = await registerUser();
    const first = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 'A' } } });
    expect(first.status).toBe(200);

    const second = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({
      data: { appState: { v: 'B' } },
      baseUpdatedAt: new Date(0).toISOString(), // заведомо старше сохранённого
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('conflict');
    expect(second.body.data).toEqual({ appState: { v: 'A' } });
    expect(second.body.updatedAt).toBe(first.body.updatedAt);

    // Данные на сервере действительно не перезаписались значением B
    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.body.data).toEqual({ appState: { v: 'A' } });
  });

  test('актуальный baseUpdatedAt — сохраняет без конфликта', async () => {
    const u = await registerUser();
    const first = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 'A' } } });

    const second = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({
      data: { appState: { v: 'C' } },
      baseUpdatedAt: first.body.updatedAt,
    });
    expect(second.status).toBe(200);

    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.body.data).toEqual({ appState: { v: 'C' } });
  });

  test('без baseUpdatedAt всегда перезаписывает (нет базы для сравнения)', async () => {
    const u = await registerUser();
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 'A' } } });
    const second = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 'D' } } });
    expect(second.status).toBe(200);
    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.body.data).toEqual({ appState: { v: 'D' } });
  });
});

// DATA_ENC_KEY не задан в тестовом окружении по умолчанию (см. globalSetup.js) —
// эти блоки явно включают/выключают его, чтобы проверить оба режима lib/crypto.js.
describe('PUT/GET /state — шифрование (DATA_ENC_KEY задан)', () => {
  const originalKey = process.env.DATA_ENC_KEY;
  const testKey = crypto.randomBytes(32).toString('hex');
  beforeAll(() => { process.env.DATA_ENC_KEY = testKey; });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.DATA_ENC_KEY;
    else process.env.DATA_ENC_KEY = originalKey;
  });

  test('в БД пишется шифротекст в data_enc, а не в открытом виде в data', async () => {
    const u = await registerUser();
    const payload = { appState: { secret: 'реальный бюджет семьи' } };
    const putRes = await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: payload });
    expect(putRes.status).toBe(200);

    const row = await db.query('SELECT data, data_enc FROM family_states WHERE family_id=$1', [u.familyId]);
    expect(row.rows[0].data).toEqual({}); // при включённом шифровании плоский столбец не хранит реальные данные
    expect(Buffer.isBuffer(row.rows[0].data_enc)).toBe(true);
    expect(row.rows[0].data_enc.length).toBeGreaterThan(0);
    // и уж тем более шифротекст не должен содержать наш plaintext как подстроку
    expect(row.rows[0].data_enc.toString('utf8')).not.toContain('секрет');

    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data).toEqual(payload); // расшифровка на чтении отдаёт исходные данные
  });

  test('старые нешифрованные строки (data_enc IS NULL) по-прежнему читаются из data', async () => {
    const u = await registerUser();
    const legacyPayload = { appState: { note: 'записано до включения шифрования' } };
    await db.query(
      `UPDATE family_states SET data=$2, data_enc=NULL, updated_at=now() WHERE family_id=$1`,
      [u.familyId, legacyPayload]
    );
    const res = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(legacyPayload);
  });

  test('расшифровка чужим ключом — 500 decrypt_failed, а не тихая порча данных', async () => {
    const u = await registerUser();
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { x: 1 } } });

    process.env.DATA_ENC_KEY = crypto.randomBytes(32).toString('hex'); // "потеряли" исходный ключ
    const res = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('decrypt_failed');

    process.env.DATA_ENC_KEY = testKey; // возвращаем для остальных тестов этого блока
  });
});

describe('PUT /state — без DATA_ENC_KEY (шифрование выключено)', () => {
  const originalKey = process.env.DATA_ENC_KEY;
  beforeAll(() => { delete process.env.DATA_ENC_KEY; });
  afterAll(() => { if (originalKey !== undefined) process.env.DATA_ENC_KEY = originalKey; });

  test('данные пишутся в открытом виде в data, data_enc остаётся NULL', async () => {
    const u = await registerUser();
    const payload = { appState: { plain: 'без шифра' } };
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: payload });
    const row = await db.query('SELECT data, data_enc FROM family_states WHERE family_id=$1', [u.familyId]);
    expect(row.rows[0].data).toEqual(payload);
    expect(row.rows[0].data_enc).toBeNull();
  });
});

describe('POST /state/reset и /state/restore-backup — отложенное удаление', () => {
  test('без токена — 401', async () => {
    expect((await request.post('/state/reset')).status).toBe(401);
    expect((await request.post('/state/restore-backup')).status).toBe(401);
  });

  test('reset обнуляет data, но не теряет её — restore-backup возвращает как было', async () => {
    const u = await registerUser();
    const payload = { appState: { streak: 7, familyName: 'Реальный бюджет' } };
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: payload });

    const resetRes = await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.ok).toBe(true);

    // Сразу после сброса — данные пустые, но восстановление доступно
    const afterReset = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(afterReset.body.data).toEqual({});
    expect(afterReset.body.resetBackup).toBeTruthy();
    expect(afterReset.body.resetBackup.resetAt).toBeTruthy();
    expect(afterReset.body.resetBackup.expiresAt).toBeTruthy();

    const restoreRes = await request.post('/state/restore-backup').set('Authorization', `Bearer ${u.token}`);
    expect(restoreRes.status).toBe(200);

    const afterRestore = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(afterRestore.body.data).toEqual(payload);
    expect(afterRestore.body.resetBackup).toBeNull(); // бэкап потрачен, повторно не предлагается
  });

  test('повторный restore-backup без активного бэкапа — 404 no_backup', async () => {
    const u = await registerUser();
    const res = await request.post('/state/restore-backup').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_backup');
  });

  test('reset дважды подряд — второй раз бэкапится уже пустое состояние, но не падает', async () => {
    const u = await registerUser();
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 1 } } });
    await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`);
    const second = await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`);
    expect(second.status).toBe(200);
    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.body.data).toEqual({});
  });

  test('404 no_family, если пользователь не состоит в семье', async () => {
    const u = await registerUser();
    const uid = (await db.query('SELECT id FROM users WHERE email=lower($1)', [u.email])).rows[0].id;
    await db.query('DELETE FROM family_members WHERE user_id=$1', [uid]);
    expect((await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`)).status).toBe(404);
    expect((await request.post('/state/restore-backup').set('Authorization', `Bearer ${u.token}`)).status).toBe(404);
  });

  test('шифрование включено: reset/restore-backup работают через data_enc, не только data', async () => {
    const originalKey = process.env.DATA_ENC_KEY;
    process.env.DATA_ENC_KEY = crypto.randomBytes(32).toString('hex');
    try {
      const u = await registerUser();
      const payload = { appState: { secret: 'зашифрованный бюджет' } };
      await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: payload });

      await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`);
      const row = await db.query('SELECT data, data_enc, reset_backup, reset_backup_enc FROM family_states WHERE family_id=$1', [u.familyId]);
      expect(row.rows[0].data_enc).toBeNull(); // текущее состояние обнулено
      expect(Buffer.isBuffer(row.rows[0].reset_backup_enc)).toBe(true); // а бэкап зашифрован и сохранён

      await request.post('/state/restore-backup').set('Authorization', `Bearer ${u.token}`);
      const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
      expect(getRes.body.data).toEqual(payload);
    } finally {
      if (originalKey === undefined) delete process.env.DATA_ENC_KEY;
      else process.env.DATA_ENC_KEY = originalKey;
    }
  });
});
