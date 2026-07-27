const { request, db, resetDb, registerUser, uniqueEmail } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

describe('POST /auth/register', () => {
  test('создаёт пользователя, его семью и пустой state', async () => {
    const email = uniqueEmail();
    const res = await request.post('/auth/register').send({ email, password: 'password123', pdnConsent: true });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.familyId).toEqual(expect.any(String));

    const u = await db.query('SELECT pdn_consent_at, token_version FROM users WHERE email=lower($1)', [email]);
    expect(u.rows[0].pdn_consent_at).not.toBeNull();
    expect(u.rows[0].token_version).toBe(1);

    const m = await db.query('SELECT role FROM family_members WHERE family_id=$1', [res.body.familyId]);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].role).toBe('owner');
  });

  test('без согласия на ПДн — 400', async () => {
    const res = await request.post('/auth/register').send({ email: uniqueEmail(), password: 'password123', pdnConsent: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pdn_consent_required');
  });

  test('повторная регистрация того же email — 409', async () => {
    const email = uniqueEmail();
    await request.post('/auth/register').send({ email, password: 'password123', pdnConsent: true });
    const res = await request.post('/auth/register').send({ email, password: 'password123', pdnConsent: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_taken');
  });
});

describe('POST /auth/login', () => {
  test('верный пароль — токен', async () => {
    const u = await registerUser();
    const res = await request.post('/auth/login').send({ email: u.email, password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  test('неверный пароль — 401, без утечки причины', async () => {
    const u = await registerUser();
    const res = await request.post('/auth/login').send({ email: u.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('bad_credentials');
  });
});

describe('ревокация токена (token_version)', () => {
  test('токен без tv (выданный до появления ревокации) остаётся рабочим', async () => {
    // Regression: до token_version токены подписывались без tv в payload.
    // schema.sql выставляет существующим пользователям token_version=1 по
    // умолчанию — отсутствующий tv должен трактоваться как 1, а не как
    // несовпадение, иначе деплой этой фичи разлогинил бы всех разом.
    const jwt = require('jsonwebtoken');
    const u = await registerUser();
    const legacyToken = jwt.sign({ uid: (await db.query('SELECT id FROM users WHERE email=lower($1)', [u.email])).rows[0].id }, process.env.JWT_SECRET, { expiresIn: '90d' });
    const res = await request.get('/auth/me').set('Authorization', `Bearer ${legacyToken}`);
    expect(res.status).toBe(200);
  });

  test('смена пароля отзывает старый токен, но выдаёт новый рабочий', async () => {
    const u = await registerUser();
    const changeRes = await request.post('/auth/change-password')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ oldPassword: u.password, newPassword: 'newpassword456' });
    expect(changeRes.status).toBe(200);
    const newToken = changeRes.body.token;
    expect(newToken).toEqual(expect.any(String));
    expect(newToken).not.toBe(u.token);

    // Старый токен больше не проходит проверку.
    const oldStill = await request.get('/auth/me').set('Authorization', `Bearer ${u.token}`);
    expect(oldStill.status).toBe(401);
    expect(oldStill.body.error).toBe('token_revoked');

    // Новый токен работает.
    const withNew = await request.get('/auth/me').set('Authorization', `Bearer ${newToken}`);
    expect(withNew.status).toBe(200);
  });

  test('сброс пароля (reset-confirm) тоже увеличивает token_version и отзывает старый токен', async () => {
    const u = await registerUser();
    // reset-request не тестируем целиком (требует настроенной почты) — сеем
    // reset_hash напрямую, как это сделал бы сам /auth/reset-request.
    const bcrypt = require('bcryptjs');
    const code = '123456';
    const hash = await bcrypt.hash(code, 10);
    await db.query(
      `UPDATE users SET reset_hash=$1, reset_expires=now() + interval '15 minutes' WHERE email=lower($2)`,
      [hash, u.email]
    );
    const res = await request.post('/auth/reset-confirm').send({ email: u.email, code, newPassword: 'anotherpass789' });
    expect(res.status).toBe(200);
    expect(res.body.token).not.toBe(u.token);

    const oldStill = await request.get('/auth/me').set('Authorization', `Bearer ${u.token}`);
    expect(oldStill.status).toBe(401);
    expect(oldStill.body.error).toBe('token_revoked');
  });
});

describe('POST /auth/delete-account', () => {
  test('неверный пароль — 401, аккаунт не тронут', async () => {
    const u = await registerUser();
    const res = await request.post('/auth/delete-account')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ password: 'wrong' });
    expect(res.status).toBe(401);
    const still = await db.query('SELECT 1 FROM users WHERE email=lower($1)', [u.email]);
    expect(still.rows).toHaveLength(1);
  });

  test('единственный участник семьи — семья и её state удаляются целиком', async () => {
    const u = await registerUser();
    const res = await request.post('/auth/delete-account')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ password: u.password });
    expect(res.status).toBe(200);

    const users = await db.query('SELECT 1 FROM users WHERE email=lower($1)', [u.email]);
    expect(users.rows).toHaveLength(0);
    const families = await db.query('SELECT 1 FROM families WHERE id=$1', [u.familyId]);
    expect(families.rows).toHaveLength(0);
    const states = await db.query('SELECT 1 FROM family_states WHERE family_id=$1', [u.familyId]);
    expect(states.rows).toHaveLength(0);
  });

  test('владелец с другими участниками — владение переходит следующему, семья остаётся', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    // Делаем семью владельца pro, чтобы можно было сгенерировать инвайт-код,
    // и переводим member во владельческую семью через /family/join.
    await db.query("UPDATE families SET plan='pro', pro_until=now() + interval '30 days' WHERE id=$1", [owner.familyId]);
    const inviteRes = await request.post('/family/invite').set('Authorization', `Bearer ${owner.token}`);
    expect(inviteRes.status).toBe(200);
    const joinRes = await request.post('/family/join')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ code: inviteRes.body.code });
    expect(joinRes.status).toBe(200);

    const delRes = await request.post('/auth/delete-account')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ password: owner.password });
    expect(delRes.status).toBe(200);

    const familyStillThere = await db.query('SELECT 1 FROM families WHERE id=$1', [owner.familyId]);
    expect(familyStillThere.rows).toHaveLength(1);
    const members = await db.query('SELECT user_id, role FROM family_members WHERE family_id=$1', [owner.familyId]);
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].role).toBe('owner');
  });
});
