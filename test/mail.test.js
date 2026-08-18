// UNISENDER_API_KEY читается на верхнем уровне lib/mail.js — выставляем ДО
// require, иначе mailConfigured() будет false и sendMailUni не задействуется.
process.env.UNISENDER_API_KEY = 'test-key';
const { sendMail } = require('../lib/mail');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('sendMail / Unisender failed_emails', () => {
  test('failed_emails: "invalid" — бросает ошибку с rejectedReason', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', failed_emails: { 'bad@exampel.com': 'invalid' } }),
    });
    await expect(sendMail('bad@exampel.com', 'subj', 'text', '<p>html</p>'))
      .rejects.toMatchObject({ rejectedReason: 'invalid' });
  });

  test('успешная отправка без failed_emails — не бросает', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success' }),
    });
    await expect(sendMail('ok@example.com', 'subj', 'text', '<p>html</p>')).resolves.toBeUndefined();
  });

  test('unsubscribeUrl передан — в теле запроса к Unisender есть заголовок List-Unsubscribe', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success' }),
    });
    const url = 'https://myfamilyflow.ru/auth/unsubscribe?uid=1&token=abc';
    await sendMail('ok@example.com', 'subj', 'text', '<p>html</p>', url);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.message.headers).toEqual({ 'List-Unsubscribe': `<${url}>` });
  });

  test('unsubscribeUrl не передан — заголовков в теле запроса нет', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success' }),
    });
    await sendMail('ok@example.com', 'subj', 'text', '<p>html</p>');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.message.headers).toBeUndefined();
  });
});
