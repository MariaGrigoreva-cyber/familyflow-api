// Подменяем ЮKassa — тестам не нужны реальные ключи/сеть, важна только логика
// вокруг неё (дедуп чекаута, идемпотентность вебхука, окно возврата).
// jest.mock размещаем первой строкой файла, а не полагаемся на автохойстинг —
// в проекте нет babel-трансформа, который его обычно делает для CommonJS.
jest.mock('../lib/yookassa');

const yk = require('../lib/yookassa');
const { request, db, resetDb, registerUser } = require('./helpers');

beforeEach(() => {
  jest.clearAllMocks();
  return resetDb();
});
afterAll(async () => { await db.end(); });

let paymentSeq = 0;
function fakePayment(status = 'pending') {
  paymentSeq += 1;
  return {
    id: `test-payment-${paymentSeq}`,
    status,
    confirmation: { confirmation_url: `https://yookassa.ru/pay/${paymentSeq}` },
    payment_method: { saved: true, id: `test-method-${paymentSeq}` },
  };
}

describe('POST /billing/checkout', () => {
  test('без autoChargeConsent — 400', async () => {
    const u = await registerUser();
    const res = await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('auto_charge_consent_required');
  });

  test('успешный чекаут создаёт pending-платёж и фиксирует согласие', async () => {
    const u = await registerUser();
    yk.createPayment.mockResolvedValue(fakePayment('pending'));
    const res = await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });
    expect(res.status).toBe(200);
    expect(res.body.confirmationUrl).toEqual(expect.any(String));
    expect(yk.createPayment).toHaveBeenCalledTimes(1);

    const family = await db.query('SELECT auto_charge_consent_at FROM families WHERE id=$1', [u.familyId]);
    expect(family.rows[0].auto_charge_consent_at).not.toBeNull();
  });

  test('двойной клик: повторный чекаут того же периода переиспользует pending-платёж, не плодит дубли', async () => {
    const u = await registerUser();
    const pending = fakePayment('pending');
    yk.createPayment.mockResolvedValue(pending);
    const first = await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });
    expect(first.status).toBe(200);

    // Второй клик до того, как пользователь успел заплатить — платёж всё ещё pending у ЮKassa.
    yk.getPayment.mockResolvedValue(pending);
    const second = await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });
    expect(second.status).toBe(200);
    expect(second.body.confirmationUrl).toBe(first.body.confirmationUrl);
    expect(yk.createPayment).toHaveBeenCalledTimes(1); // не создали второй платёж в ЮKassa
    expect(yk.getPayment).toHaveBeenCalledTimes(1);

    const payments = await db.query('SELECT count(*)::int AS c FROM payments WHERE family_id=$1', [u.familyId]);
    expect(payments.rows[0].c).toBe(1);
  });

  test('чужой (уже завершённый) pending — создаёт новый платёж, а не переиспользует', async () => {
    const u = await registerUser();
    const firstPayment = fakePayment('pending');
    yk.createPayment.mockResolvedValueOnce(firstPayment);
    await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });

    // К моменту второго клика первый платёж уже отменён в ЮKassa (например, истёк) —
    // переиспользовать его нельзя, нужен новый.
    yk.getPayment.mockResolvedValue({ ...firstPayment, status: 'canceled', confirmation: undefined });
    const secondPayment = fakePayment('pending');
    yk.createPayment.mockResolvedValueOnce(secondPayment);
    const second = await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });
    expect(second.status).toBe(200);
    expect(yk.createPayment).toHaveBeenCalledTimes(2);
  });

  test('не владелец — 403', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    await db.query("UPDATE families SET plan='pro', pro_until=now() + interval '30 days' WHERE id=$1", [owner.familyId]);
    const invite = await request.post('/family/invite').set('Authorization', `Bearer ${owner.token}`);
    await request.post('/family/join').set('Authorization', `Bearer ${member.token}`).send({ code: invite.body.code });

    const res = await request.post('/billing/checkout')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ period: 'monthly', autoChargeConsent: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
  });
});

describe('POST /billing/webhook — идемпотентность', () => {
  test('повторное уведомление об уже обработанном платеже не продлевает подписку дважды', async () => {
    const u = await registerUser();
    const paymentId = 'wh-payment-1';
    await db.query(
      `INSERT INTO payments(family_id, yk_payment_id, amount, status, period) VALUES($1,$2,$3,'pending','monthly')`,
      [u.familyId, paymentId, 199]
    );
    yk.getPayment.mockResolvedValue({ id: paymentId, status: 'succeeded', payment_method: { saved: false } });

    const first = await request.post('/billing/webhook').send({ object: { id: paymentId } });
    expect(first.status).toBe(200);
    const afterFirst = await db.query('SELECT pro_until FROM families WHERE id=$1', [u.familyId]);
    expect(afterFirst.rows[0].pro_until).not.toBeNull();
    const proUntilAfterFirst = afterFirst.rows[0].pro_until;

    const second = await request.post('/billing/webhook').send({ object: { id: paymentId } });
    expect(second.status).toBe(200);
    const afterSecond = await db.query('SELECT pro_until FROM families WHERE id=$1', [u.familyId]);
    // Второе уведомление не должно продлить подписку ещё на месяц сверху.
    expect(new Date(afterSecond.rows[0].pro_until).getTime()).toBe(new Date(proUntilAfterFirst).getTime());
  });
});

describe('POST /billing/refund', () => {
  test('успешный платёж младше 7 дней — возврат проходит', async () => {
    const u = await registerUser();
    await db.query(
      `INSERT INTO payments(family_id, yk_payment_id, amount, status, period, created_at)
       VALUES($1,'refund-recent',199,'succeeded','monthly', now() - interval '1 day')`,
      [u.familyId]
    );
    yk.refundPayment.mockResolvedValue({ id: 'refund-1' });
    const res = await request.post('/billing/refund').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    expect(res.body.refundId).toBe('refund-1');

    const payment = await db.query("SELECT status FROM payments WHERE yk_payment_id='refund-recent'");
    expect(payment.rows[0].status).toBe('refunded');
  });

  test('платёж старше 7 дней — 400 refund_window_expired', async () => {
    const u = await registerUser();
    await db.query(
      `INSERT INTO payments(family_id, yk_payment_id, amount, status, period, created_at)
       VALUES($1,'refund-old',199,'succeeded','monthly', now() - interval '10 days')`,
      [u.familyId]
    );
    const res = await request.post('/billing/refund').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refund_window_expired');
    expect(yk.refundPayment).not.toHaveBeenCalled();
  });

  test('нет успешного платежа — 404', async () => {
    const u = await registerUser();
    const res = await request.post('/billing/refund').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_refundable_payment');
  });
});

describe('POST /billing/cancel-auto-renew', () => {
  test('отключает автопродление и отвязывает сохранённый способ оплаты', async () => {
    const u = await registerUser();
    await db.query(
      "UPDATE families SET auto_renew=true, yk_payment_method_id='saved-method-1' WHERE id=$1",
      [u.familyId]
    );
    const res = await request.post('/billing/cancel-auto-renew').set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(200);
    const family = await db.query('SELECT auto_renew, yk_payment_method_id FROM families WHERE id=$1', [u.familyId]);
    expect(family.rows[0].auto_renew).toBe(false);
    expect(family.rows[0].yk_payment_method_id).toBeNull();
  });
});
