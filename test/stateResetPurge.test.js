const { db, resetDb, registerUser, request } = require('./helpers');
const { purgeStateResetBackups } = require('../lib/stateResetPurgeScheduler');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

describe('lib/stateResetPurgeScheduler', () => {
  test('стирает бэкап сброса старше грейс-периода (90 дней по умолчанию)', async () => {
    const u = await registerUser();
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 1 } } });
    await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`);
    await db.query(
      `UPDATE family_states SET reset_at = now() - interval '91 days' WHERE family_id=$1`,
      [u.familyId]
    );

    await purgeStateResetBackups();

    const row = await db.query('SELECT reset_backup, reset_backup_enc, reset_at FROM family_states WHERE family_id=$1', [u.familyId]);
    expect(row.rows[0].reset_backup).toBeNull();
    expect(row.rows[0].reset_backup_enc).toBeNull();
    expect(row.rows[0].reset_at).toBeNull();

    // и восстановить уже нельзя — бэкап действительно стёрт, а не просто скрыт
    const restoreRes = await request.post('/state/restore-backup').set('Authorization', `Bearer ${u.token}`);
    expect(restoreRes.status).toBe(404);
  });

  test('не трогает бэкап внутри грейс-периода', async () => {
    const u = await registerUser();
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 1 } } });
    await request.post('/state/reset').set('Authorization', `Bearer ${u.token}`);
    await db.query(
      `UPDATE family_states SET reset_at = now() - interval '1 day' WHERE family_id=$1`,
      [u.familyId]
    );

    await purgeStateResetBackups();

    const row = await db.query('SELECT reset_backup_enc, reset_at FROM family_states WHERE family_id=$1', [u.familyId]);
    expect(row.rows[0].reset_at).not.toBeNull();
  });

  test('не трогает семьи без активного сброса', async () => {
    const u = await registerUser();
    await request.put('/state').set('Authorization', `Bearer ${u.token}`).send({ data: { appState: { v: 1 } } });
    await purgeStateResetBackups();
    const getRes = await request.get('/state').set('Authorization', `Bearer ${u.token}`);
    expect(getRes.body.data).toEqual({ appState: { v: 1 } });
  });
});
