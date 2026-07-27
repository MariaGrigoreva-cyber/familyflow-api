const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const getUserId = async email =>
  (await db.query('SELECT id FROM users WHERE email=lower($1)', [email])).rows[0].id;

describe('GET /push/vapid-public-key', () => {
  test('доступен без токена', async () => {
    const res = await request.get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('publicKey');
  });

  test('отдаёт текущее значение VAPID_PUBLIC_KEY', async () => {
    const original = process.env.VAPID_PUBLIC_KEY;
    process.env.VAPID_PUBLIC_KEY = 'test-vapid-public-key';
    const res = await request.get('/push/vapid-public-key');
    expect(res.body.publicKey).toBe('test-vapid-public-key');
    if (original === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = original;
  });

  test('без настроенного ключа отдаёт null, а не падает', async () => {
    const original = process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    const res = await request.get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBeNull();
    if (original !== undefined) process.env.VAPID_PUBLIC_KEY = original;
  });
});

describe('POST /push/subscribe', () => {
  test('без токена — 401', async () => {
    const res = await request.post('/push/subscribe').send({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(401);
  });

  test('без endpoint — 400 bad_subscription', async () => {
    const u = await registerUser();
    const res = await request.post('/push/subscribe').set('Authorization', `Bearer ${u.token}`)
      .send({ keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_subscription');
  });

  test('без keys.p256dh/keys.auth — 400 bad_subscription', async () => {
    const u = await registerUser();
    const res = await request.post('/push/subscribe').set('Authorization', `Bearer ${u.token}`)
      .send({ endpoint: 'https://push.example/x', keys: { p256dh: 'p' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_subscription');
  });

  test('создаёт подписку в push_subscriptions', async () => {
    const u = await registerUser();
    const uid = await getUserId(u.email);
    const res = await request.post('/push/subscribe').set('Authorization', `Bearer ${u.token}`)
      .send({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.query('SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint=$1', ['https://push.example/new']);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].user_id).toBe(uid);
    expect(row.rows[0].p256dh).toBe('p');
    expect(row.rows[0].auth).toBe('a');
  });

  test('повторная подписка с тем же endpoint обновляет владельца и ключи, не создавая дубликат (ON CONFLICT)', async () => {
    const u1 = await registerUser();
    const u2 = await registerUser();
    const u2id = await getUserId(u2.email);
    const endpoint = 'https://push.example/shared';

    const first = await request.post('/push/subscribe').set('Authorization', `Bearer ${u1.token}`)
      .send({ endpoint, keys: { p256dh: 'p1', auth: 'a1' } });
    expect(first.status).toBe(200);

    const second = await request.post('/push/subscribe').set('Authorization', `Bearer ${u2.token}`)
      .send({ endpoint, keys: { p256dh: 'p2', auth: 'a2' } });
    expect(second.status).toBe(200);

    const rows = await db.query('SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    expect(rows.rows).toHaveLength(1); // не задвоилось
    expect(rows.rows[0].user_id).toBe(u2id); // переехало на второго подписчика
    expect(rows.rows[0].p256dh).toBe('p2');
    expect(rows.rows[0].auth).toBe('a2');
  });
});

describe('POST /push/unsubscribe', () => {
  test('без токена — 401', async () => {
    const res = await request.post('/push/unsubscribe').send({ endpoint: 'https://push.example/x' });
    expect(res.status).toBe(401);
  });

  test('удаляет подписку по endpoint', async () => {
    const u = await registerUser();
    const endpoint = 'https://push.example/to-delete';
    await request.post('/push/subscribe').set('Authorization', `Bearer ${u.token}`)
      .send({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

    const res = await request.post('/push/unsubscribe').set('Authorization', `Bearer ${u.token}`).send({ endpoint });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.query('SELECT 1 FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    expect(row.rows).toHaveLength(0);
  });

  test('без endpoint — просто ok, ничего не удаляет и не падает', async () => {
    const u = await registerUser();
    const endpoint = 'https://push.example/untouched';
    await request.post('/push/subscribe').set('Authorization', `Bearer ${u.token}`)
      .send({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

    const res = await request.post('/push/unsubscribe').set('Authorization', `Bearer ${u.token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.query('SELECT 1 FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    expect(row.rows).toHaveLength(1); // чужая подписка не пострадала
  });

  test('несуществующий endpoint — тоже просто ok (идемпотентно)', async () => {
    const u = await registerUser();
    const res = await request.post('/push/unsubscribe').set('Authorization', `Bearer ${u.token}`)
      .send({ endpoint: 'https://push.example/never-existed' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
