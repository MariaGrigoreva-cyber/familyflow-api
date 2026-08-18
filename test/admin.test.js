const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

describe('GET /admin/feedback', () => {
  test('без ADMIN_SECRET в окружении — 503 admin_not_configured', async () => {
    const original = process.env.ADMIN_SECRET;
    delete process.env.ADMIN_SECRET;
    const res = await request.get('/admin/feedback').set('X-Admin-Key', 'anything');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('admin_not_configured');
    if (original !== undefined) process.env.ADMIN_SECRET = original;
  });

  test('без заголовка X-Admin-Key — 401', async () => {
    process.env.ADMIN_SECRET = 'test-admin-secret';
    const res = await request.get('/admin/feedback');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  test('с неверным секретом — 401', async () => {
    process.env.ADMIN_SECRET = 'test-admin-secret';
    const res = await request.get('/admin/feedback').set('X-Admin-Key', 'wrong-secret');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  test('с верным секретом — отдаёт отзывы новыми сверху', async () => {
    process.env.ADMIN_SECRET = 'test-admin-secret';
    const u1 = await registerUser();
    const u2 = await registerUser();
    await request.post('/feedback').set('Authorization', `Bearer ${u1.token}`).send({ text: 'первый отзыв' });
    await request.post('/feedback').set('Authorization', `Bearer ${u2.token}`).send({ text: 'второй отзыв' });

    const res = await request.get('/admin/feedback').set('X-Admin-Key', 'test-admin-secret');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe('второй отзыв');
    expect(res.body[0].email).toBe(u2.email.toLowerCase());
    expect(res.body[1].text).toBe('первый отзыв');
  });
});
