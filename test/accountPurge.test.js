const { db, resetDb, registerUser } = require('./helpers');
const { purgeDeletedAccounts } = require('../lib/accountPurgeScheduler');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

describe('lib/accountPurgeScheduler', () => {
  test('стирает аккаунты, мягко удалённые дольше грейс-периода', async () => {
    const u = await registerUser();
    await db.query(
      `UPDATE users SET deleted_at = now() - interval '31 days' WHERE email = lower($1)`,
      [u.email]
    );
    await purgeDeletedAccounts();
    const rows = await db.query('SELECT 1 FROM users WHERE email = lower($1)', [u.email]);
    expect(rows.rows).toHaveLength(0);
  });

  test('не трогает аккаунты внутри грейс-периода', async () => {
    const u = await registerUser();
    await db.query(
      `UPDATE users SET deleted_at = now() - interval '1 day' WHERE email = lower($1)`,
      [u.email]
    );
    await purgeDeletedAccounts();
    const rows = await db.query('SELECT 1 FROM users WHERE email = lower($1)', [u.email]);
    expect(rows.rows).toHaveLength(1);
  });

  test('не трогает живые (не удалённые) аккаунты', async () => {
    const u = await registerUser();
    await purgeDeletedAccounts();
    const rows = await db.query('SELECT 1 FROM users WHERE email = lower($1)', [u.email]);
    expect(rows.rows).toHaveLength(1);
  });
});
