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
});
