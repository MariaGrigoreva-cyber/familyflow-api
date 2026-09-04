jest.mock('../lib/yookassa');

// Цена Pro при пересборке состава тарифов НЕ менялась и меняться не должна:
// 199 ₽ в месяц. Этот файл — страж именно этого факта.
//
// Проверяем три вещи, потому что сломаться может каждая по отдельности:
//   1. значение по умолчанию в коде;
//   2. то, что уходит клиенту в GET /billing/status (клиент нигде не хардкодит
//      суммы и берёт их только отсюда);
//   3. сумма, на которую реально создаётся платёж в ЮKassa.
const fs = require('fs');
const path = require('path');
const yk = require('../lib/yookassa');
const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(resetDb);
afterAll(async () => { await db.end(); });

const MONTHLY_RUB = 199;

describe('цена Pro', () => {
  test('значение по умолчанию — 199 ₽/мес', async () => {
    const u = await registerUser();
    const res = await request.get('/billing/status').set('Authorization', `Bearer ${u.token}`);
    expect(res.body.prices.monthly).toBe(MONTHLY_RUB);
  });

  test('цена не зависит от тарифа и не меняется после окончания триала', async () => {
    const u = await registerUser();
    await db.query(`UPDATE families SET trial_ends_at = now() - interval '1 day' WHERE id=$1`, [u.familyId]);
    const free = await request.get('/billing/status').set('Authorization', `Bearer ${u.token}`);
    expect(free.body.plan).toBe('free');
    expect(free.body.prices.monthly).toBe(MONTHLY_RUB);

    await db.query(`UPDATE families SET pro_until = now() + interval '30 days' WHERE id=$1`, [u.familyId]);
    const pro = await request.get('/billing/status').set('Authorization', `Bearer ${u.token}`);
    expect(pro.body.prices.monthly).toBe(MONTHLY_RUB);
  });

  test('месячный чекаут создаёт платёж ровно на 199 ₽', async () => {
    yk.createPayment.mockResolvedValue({
      id: 'price-check', status: 'pending',
      confirmation: { confirmation_url: 'https://yookassa.ru/pay/1' },
    });
    const u = await registerUser();
    await request.post('/billing/checkout').set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });

    expect(yk.createPayment).toHaveBeenCalledWith(expect.objectContaining({ amountRub: MONTHLY_RUB }));
    const p = await db.query('SELECT amount, period FROM payments WHERE family_id=$1', [u.familyId]);
    expect(Number(p.rows[0].amount)).toBe(MONTHLY_RUB);
    expect(p.rows[0].period).toBe('monthly');
  });

  test('сумма берётся с сервера, а не из тела запроса', async () => {
    yk.createPayment.mockResolvedValue({
      id: 'price-tamper', status: 'pending',
      confirmation: { confirmation_url: 'https://yookassa.ru/pay/1' },
    });
    const u = await registerUser();
    await request.post('/billing/checkout').set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true, amount: 1, amountRub: 1, price: 1 });
    expect(yk.createPayment).toHaveBeenCalledWith(expect.objectContaining({ amountRub: MONTHLY_RUB }));
  });
});

describe('цена задана в одном месте', () => {
  // Ловит самую вероятную ошибку при правке текстов и логики: кто-нибудь вписал
  // сумму подписки ещё куда-нибудь, и она разошлась с настоящей ценой. Именно
  // так здесь и жила вторая копия PRICE в lib/scheduler.js.
  const projectFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return projectFiles(full);
    return /\.(js|html|txt|sql)$/.test(e.name) ? [full] : [];
  });

  // Комментарии — не код и не текст для пользователя: цена в них ничего не
  // ломает, а объяснять решения без сумм невозможно.
  const stripComments = (src, file) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(file.endsWith('.sql') ? /--[^\n]*/g : /(?!)/g, '');

  const scan = (predicate, { skip = () => false } = {}) => {
    const root = path.join(__dirname, '..');
    const offenders = [];
    for (const file of projectFiles(root)) {
      const rel = path.relative(root, file);
      if (rel.startsWith('test' + path.sep) || skip(rel)) continue;
      stripComments(fs.readFileSync(file, 'utf8'), file).split('\n').forEach((line, i) => {
        if (predicate(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    return offenders;
  };

  test('число 199 не продублировано за пределами lib/pricing.js', () => {
    // Только «самостоятельное» число: 1990 или v1.99 ценой не считаются.
    const offenders = scan(
      line => /(^|[^\d.])199([^\d.]|$)/.test(line),
      { skip: rel => rel === path.join('lib', 'pricing.js') },
    );
    expect(offenders).toEqual([]);
  });

  test('нигде нет второй цены подписки в рублях', () => {
    // Сумма рядом со знаком рубля И словом про подписку — то есть строка,
    // которая выглядит как ценник. Примеры сумм в письмах («отпуск на
    // 100 000 ₽») под это не попадают и попадать не должны.
    const offenders = scan(line =>
      /\d[\d  ]*\s*(₽|руб)/i.test(line)
      && /(подписк|тариф|\bPro\b|\/мес|в месяц|\/год|в год)/i.test(line));
    expect(offenders).toEqual([]);
  });
});
