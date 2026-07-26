const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

// Переводит семью в free-тариф (и триал, и pro истекли).
async function makeFamilyFree(familyId) {
  await db.query(
    `UPDATE families SET trial_ends_at = now() - interval '1 day', pro_until = now() - interval '1 day' WHERE id=$1`,
    [familyId]
  );
}

describe('GET /family/me', () => {
  test('без токена — 401', async () => {
    const res = await request.get('/family/me');
    expect(res.status).toBe(401);
  });

  test('возвращает семью с корректным числом участников', async () => {
    const u = await registerUser();
    const res = await request.get('/family/me').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.members).toBe(1);
    expect(res.body.role).toBe('owner');
  });
});

describe('POST /family/invite', () => {
  test('на free-тарифе недоступно — 403 pro_required', async () => {
    const u = await registerUser();
    await makeFamilyFree(u.familyId);
    const res = await request.post('/family/invite').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pro_required');
  });

  test('во время триала — доступно, код 6 символов', async () => {
    const u = await registerUser();
    const res = await request.post('/family/invite').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toHaveLength(6);
  });
});

describe('POST /family/join — лимит участников на free-тарифе (regression: routes/family.js FOR UPDATE)', () => {
  test('концентрированные одновременные join на free-семью никогда не превышают лимит', async () => {
    const owner = await registerUser();
    // Код генерируем, пока семья ещё на триале (иначе /invite сам вернёт pro_required),
    // а лимит участников проверяем уже после того, как семья скатилась на free —
    // это и есть реальный сценарий из комментария в routes/family.js: старый код
    // остался рабочим, но новых участников на free он принимать не должен.
    const inviteRes = await request.post('/family/invite').set('Authorization', `Bearer ${owner.token}`);
    expect(inviteRes.status).toBe(200);
    await makeFamilyFree(owner.familyId);

    const joiners = await Promise.all([registerUser(), registerUser(), registerUser()]);
    const results = await Promise.all(joiners.map(j =>
      request.post('/family/join').set('Authorization', `Bearer ${j.token}`).send({ code: inviteRes.body.code })
    ));

    // Ни один посторонний не должен присоединиться — free-тариф зарезервирован
    // за единственным владельцем (см. FREE_MEMBER_LIMIT в routes/family.js).
    for (const r of results) {
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('pro_required');
    }

    const members = await db.query('SELECT count(*)::int AS c FROM family_members WHERE family_id=$1', [owner.familyId]);
    expect(members.rows[0].c).toBe(1);
  });

  test('на pro-тарифе join отрабатывает и переносит участника из его старой семьи', async () => {
    const owner = await registerUser();
    await db.query("UPDATE families SET plan='pro', pro_until=now() + interval '30 days' WHERE id=$1", [owner.familyId]);
    const inviteRes = await request.post('/family/invite').set('Authorization', `Bearer ${owner.token}`);

    const joiner = await registerUser();
    const oldFamilyId = joiner.familyId;
    const joinRes = await request.post('/family/join')
      .set('Authorization', `Bearer ${joiner.token}`)
      .send({ code: inviteRes.body.code });
    expect(joinRes.status).toBe(200);
    expect(joinRes.body.familyId).toBe(owner.familyId);

    // Старая (теперь пустая) семья присоединившегося должна быть удалена.
    const oldFamily = await db.query('SELECT 1 FROM families WHERE id=$1', [oldFamilyId]);
    expect(oldFamily.rows).toHaveLength(0);

    const members = await db.query('SELECT role FROM family_members WHERE family_id=$1 AND user_id IS NOT NULL', [owner.familyId]);
    expect(members.rows).toHaveLength(2);
  });

  test('неверный код — 404', async () => {
    const u = await registerUser();
    const res = await request.post('/family/join').set('Authorization', `Bearer ${u.token}`).send({ code: 'ZZZZZZ' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('code_not_found');
  });
});
