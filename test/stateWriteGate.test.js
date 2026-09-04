// Аудит write-эндпоинтов, меняющих финансовое состояние семьи.
//
// Зачем отдельный файл. Состав тарифов меняется (basicBudget уже успел побывать
// и платным, и бесплатным), и при каждом таком изменении важно, чтобы НИ ОДИН
// путь записи в family_states не остался в обход реестра возможностей. Эти
// тесты проверяют не конкретную политику, а инвариант: все записи идут через
// шлюз, тело запроса не может подменить восстанавливаемые данные, и чужую
// семью восстановить нельзя.
const fs = require('fs');
const path = require('path');
const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const auth = u => ({ Authorization: `Bearer ${u.token}` });
const expireTrial = familyId => db.query(
  `UPDATE families SET trial_ends_at = now() - interval '1 day', pro_until = NULL WHERE id=$1`,
  [familyId]
);
const readState = async u => (await request.get('/state').set(auth(u))).body.data;

describe('POST /state/restore-backup — это ЗАПИСЬ, а не чтение', () => {
  test('восстанавливает собственный бэкап и снимает отметку сброса', async () => {
    const u = await registerUser();
    await request.put('/state').set(auth(u))
      .send({ data: { appState: { marker: 'мой бюджет' } } });
    await request.post('/state/reset').set(auth(u)).send({});
    expect((await readState(u)).appState).toBeUndefined(); // сброшено

    const res = await request.post('/state/restore-backup').set(auth(u)).send({});
    expect(res.status).toBe(200);
    expect((await readState(u)).appState.marker).toBe('мой бюджет');

    const row = await db.query('SELECT reset_at, reset_backup FROM family_states WHERE family_id=$1', [u.familyId]);
    expect(row.rows[0].reset_at).toBeNull();
  });

  test('тело запроса игнорируется — произвольный бэкап подсунуть нельзя', async () => {
    const u = await registerUser();
    await request.put('/state').set(auth(u))
      .send({ data: { appState: { marker: 'настоящие данные' } } });
    await request.post('/state/reset').set(auth(u)).send({});

    // Пытаемся записать своё содержимое через восстановление.
    const res = await request.post('/state/restore-backup').set(auth(u)).send({
      data: { appState: { marker: 'ПОДМЕНА' } },
      reset_backup: { appState: { marker: 'ПОДМЕНА' } },
      familyId: u.familyId,
    });
    expect(res.status).toBe(200);
    // Восстановился собственный бэкап, а не то, что прислал клиент.
    expect((await readState(u)).appState.marker).toBe('настоящие данные');
  });

  test('чужой бэкап восстановить нельзя', async () => {
    const a = await registerUser();
    const b = await registerUser();
    await request.put('/state').set(auth(a)).send({ data: { appState: { marker: 'семья A' } } });
    await request.post('/state/reset').set(auth(a)).send({});

    // У B своего сброса не было — восстанавливать нечего, и бэкап A ему недоступен.
    const res = await request.post('/state/restore-backup').set(auth(b)).send({ familyId: a.familyId });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_backup');

    // Бэкап A на месте и не тронут.
    const row = await db.query('SELECT reset_at FROM family_states WHERE family_id=$1', [a.familyId]);
    expect(row.rows[0].reset_at).not.toBeNull();
    expect((await readState(b)).appState).toBeUndefined();
  });

  test('без бэкапа — 404 no_backup, а не отказ по подписке', async () => {
    const u = await registerUser();
    await expireTrial(u.familyId);
    const res = await request.post('/state/restore-backup').set(auth(u)).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_backup');
  });
});

describe('истёкший триал: базовое ведение бюджета остаётся, обхода Pro нет', () => {
  let u;
  beforeEach(async () => { u = await registerUser(); await expireTrial(u.familyId); });

  test('весь цикл записи работает на бесплатном тарифе', async () => {
    // Осознанная политика (lib/capabilities.js: basicBudget = FREE) — человек
    // продолжает вести бюджет после окончания триала. Эти три эндпоинта не
    // должны отдавать 402, иначе Free снова станет режимом «только чтение».
    expect((await request.put('/state').set(auth(u))
      .send({ data: { appState: { marker: 'free-запись' } } })).status).toBe(200);
    expect((await request.post('/state/reset').set(auth(u)).send({})).status).toBe(200);
    expect((await request.post('/state/restore-backup').set(auth(u)).send({})).status).toBe(200);
    expect((await readState(u)).appState.marker).toBe('free-запись');
  });

  test('запись бюджета НЕ открывает платные возможности', async () => {
    await request.put('/state').set(auth(u)).send({ data: { appState: { marker: 'x' } } });
    const status = await request.get('/billing/status').set(auth(u));
    expect(status.body.plan).toBe('free');
    expect(status.body.capabilities.basicBudget).toBe(true);
    expect(status.body.capabilities.forecast).toBe(false);
    expect(status.body.capabilities.aiAssistant).toBe(false);
    expect(status.body.capabilities.familySharing).toBe(false);
  });

  test('приглашение в семью остаётся закрытым и после записи бюджета', async () => {
    await request.put('/state').set(auth(u)).send({ data: { appState: {} } });
    const res = await request.post('/family/invite').set(auth(u)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pro_required');
  });
});

// ── Статический инвариант ───────────────────────────────────────────────────
// Ловит появление НОВОГО пути записи в family_states без шлюза — то есть
// именно ту ошибку, которую по коду глазами не заметишь.
describe('инвариант: все записи в state идут через реестр возможностей', () => {
  const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'state.js'), 'utf8');

  test('каждый изменяющий маршрут routes/state.js обёрнут в requireCapability', () => {
    const routes = stateSrc.match(/^router\.(get|put|post|patch|delete)\([^\n]*/gm) || [];
    expect(routes.length).toBeGreaterThan(0);
    for (const line of routes) {
      const isRead = line.startsWith("router.get(");
      if (isRead) continue; // GET / — чтение, входит в бесплатный тариф
      expect(line).toContain('requireCapability(');
    }
  });

  test('family_states пишется только из routes/state.js и routes/auth.js', () => {
    // auth.js — создание семьи при регистрации и удаление аккаунта; это не
    // ведение бюджета и под тарифный шлюз попадать не должно.
    const routesDir = path.join(__dirname, '..', 'routes');
    const writers = [];
    for (const file of fs.readdirSync(routesDir)) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      // Комментарии вырезаем: в state.js устройство записи описано словами.
      const code = src.replace(/\/\/[^\n]*/g, '');
      if (/(INSERT INTO|UPDATE|DELETE FROM)\s+family_states/i.test(code)) writers.push(file);
    }
    expect(writers.sort()).toEqual(['auth.js', 'state.js']);
  });
});
